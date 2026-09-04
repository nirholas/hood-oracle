/**
 * @hood-oracle/sdk against the real app: fetch is injected as `app.request`
 * so every call goes through the actual Hono middleware chain and handlers.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient, HoodOracleError, parseSse } from '../packages/sdk/src/index.js'
import { cleanupArms, cleanupTokens, createHarness, scoreToken, seedScoredLaunch, syntheticAddress, type Harness } from './api-helpers.js'
import { schema } from '../src/db/client.js'

let h: Harness
const armIds: string[] = []
const tokens: string[] = []

const clientFor = (token: string | null) =>
  createClient({ baseUrl: 'http://hood.test', operatorToken: token, fetch: (input, init) => h.app.request(input, init) })

beforeAll(async () => {
  h = await createHarness()
})

afterAll(async () => {
  await cleanupArms(h, armIds)
  await cleanupTokens(h, tokens)
  await h.close()
})

describe('typed routes', () => {
  it('reads health, status, ready, metrics and the x402 pricing', async () => {
    const sdk = clientFor(null)
    expect((await sdk.health()).ok).toBe(true)
    const status = await sdk.status()
    expect(status.chainId).toBe(4663)
    expect(status.model.source).toBe('bootstrap')
    const ready = await sdk.ready()
    expect(ready.ok).toBe(false)
    expect(ready.checks.db.ok).toBe(true)
    expect(await sdk.metrics()).toContain('process_uptime_seconds')
    const pricing = await sdk.x402.pricing()
    expect(pricing.network.chainId).toBe(4663)
    expect(pricing.asset.symbol).toBe('USDG')
  })

  it('arms: create, get, update, enable, disable, delete, with server errors surfaced as HoodOracleError', async () => {
    const sdk = clientFor(h.config.operatorToken)
    const { arm } = await sdk.arms.create({ label: 'sdk-arm', perTradeEth: 0.01, dailyBudgetEth: 0.1, stopLossPct: 20 })
    armIds.push(arm.id)
    expect(arm.perTradeWei).toBe('10000000000000000')
    const got = await sdk.arms.get(arm.id)
    expect(got.arm.summary.open).toBe(0)
    const updated = await sdk.arms.update(arm.id, { minOracleScore: 70 })
    expect(updated.arm.minOracleScore).toBe(70)
    expect((await sdk.arms.enable(arm.id)).arm.enabled).toBe(true)
    expect((await sdk.arms.disable(arm.id)).arm.enabled).toBe(false)
    expect((await sdk.arms.list()).arms.some((a) => a.id === arm.id)).toBe(true)

    const err = await sdk.arms.get('00000000-0000-4000-8000-000000000000').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HoodOracleError)
    expect((err as HoodOracleError).status).toBe(404)
    expect((err as HoodOracleError).code).toBe('not_found')
    expect((err as HoodOracleError).requestId).toMatch(/^[0-9a-f-]{36}$/)

    const anon = clientFor(null)
    const denied = await anon.arms.enable(arm.id).catch((e: unknown) => e)
    expect((denied as HoodOracleError).status).toBe(401)

    const invalid = await sdk.arms.update(arm.id, { perTradeWei: '1.5' }).catch((e: unknown) => e)
    expect((invalid as HoodOracleError).code).toBe('validation')
    expect((invalid as HoodOracleError).detail?.issues).toBeDefined()

    expect((await sdk.arms.delete(arm.id)).ok).toBe(true)
    armIds.splice(armIds.indexOf(arm.id), 1)
  })

  it('kill switch, oracle, positions and the ledger', async () => {
    const sdk = clientFor(h.config.operatorToken)
    expect((await sdk.kill.trip('sdk test')).reason).toBe('operator: sdk test')
    expect((await sdk.kill.clear()).cleared).toBe(true)
    const { token } = await seedScoredLaunch(h, { uniqueBuyers: 80, symbol: 'SDK' })
    tokens.push(token)
    const feed = await sdk.oracle.feed({ limit: 3 })
    expect(feed.filters.limit).toBe(3)
    expect(feed.items.length).toBeGreaterThanOrEqual(1)
    const coin = await sdk.oracle.coin(token)
    expect(coin.launch.symbol).toBe('SDK')
    expect(coin.latest?.tier).toBeDefined()
    expect((await sdk.oracle.model()).features.length).toBeGreaterThan(0)
    expect((await sdk.oracle.models()).active.version).toBe('bootstrap-test')
    expect((await sdk.oracle.calibration()).key).toBe('oracle:calibration')
    expect((await sdk.positions.list({ status: 'open' })).positions).toBeInstanceOf(Array)
    expect((await sdk.trades({ limit: 2 })).trades).toBeInstanceOf(Array)
    expect((await sdk.decisions({ limit: 2 })).chain).toHaveProperty('ok')
    expect((await sdk.equity()).series).toBeInstanceOf(Array)
  })
})

describe('streams', () => {
  it('stream() yields hello, the replay and live events until aborted', async () => {
    const sdk = clientFor(null)
    h.bus.emit({ kind: 'status', at: Date.now(), level: 'info', source: 'sdk-test', message: 'replayed for the sdk' })
    const controller = new AbortController()
    const seen: string[] = []
    let hello: { chainId: number; replay: number } | null = null
    for await (const e of sdk.stream({ signal: controller.signal })) {
      if (e.kind === 'hello') hello = e
      seen.push(e.kind)
      if (e.kind === 'status' && e.message === 'replayed for the sdk') break
    }
    controller.abort()
    expect(seen[0]).toBe('hello')
    expect(hello!.chainId).toBe(4663)
    expect(hello!.replay).toBeGreaterThanOrEqual(1)
    expect(seen).toContain('status')
  })

  it('waitForScore resolves immediately for a scored token and on the score event for a new one', async () => {
    const sdk = clientFor(null)
    const { token, verdict } = await seedScoredLaunch(h, { uniqueBuyers: 30 })
    tokens.push(token)
    const already = await sdk.waitForScore(token, { timeoutMs: 5_000 })
    expect(already.score).toBe(verdict.score)

    const fresh = syntheticAddress()
    tokens.push(fresh)
    await h.db.insert(schema.launches).values({
      token: fresh, network: h.config.network, launchpad: 'noxa', creator: syntheticAddress(), pool: syntheticAddress(), venue: 'pool',
      blockNumber: '1', txHash: ('0x' + '2'.repeat(64)) as `0x${string}`, firstSeenAt: new Date(), feedLeadMs: 100, name: 'Fresh', symbol: 'FRESH', decimals: 18, metadata: {},
    })
    const waiting = sdk.waitForScore(fresh, { timeoutMs: 10_000 })
    setTimeout(() => void scoreToken(h, fresh, { unique_buyers: 90, bundle_score: 0.05, category: 'ai' }, []), 150)
    const scored = await waiting
    expect(scored.token.toLowerCase()).toBe(fresh.toLowerCase())
    expect(scored.score).toBeGreaterThan(0)

    const never = syntheticAddress()
    const timeout = await sdk.waitForScore(never, { timeoutMs: 400 }).catch((e: unknown) => e)
    expect(timeout).toBeInstanceOf(HoodOracleError)
    expect((timeout as HoodOracleError).code).toBe('timeout')
  })

  it('parseSse handles multi-line data, comments and ids', async () => {
    const text = ': comment\nevent: score\nid: 7\ndata: {"a":\ndata: 1}\n\ndata: plain\n\n'
    const body = new Blob([text]).stream() as ReadableStream<Uint8Array>
    const frames = []
    for await (const f of parseSse(body)) frames.push(f)
    expect(frames).toEqual([
      { event: 'score', data: '{"a":\n1}', id: '7' },
      { event: 'message', data: 'plain', id: null },
    ])
  })
})

describe('x402 helper', () => {
  it('drives the real 402 handshake with an injected signer up to settlement', async () => {
    const { privateKeyToAccount } = await import('viem/accounts')
    const payTo = syntheticAddress()
    const { createApp } = await import('../src/api/app.js')
    const { log } = await import('../src/log.js')
    const silent = log.child({ test: true })
    silent.level = 'silent'
    const app = createApp({ config: { ...h.config, x402: { ...h.config.x402, payTo, facilitatorUrl: 'http://facilitator.invalid' } }, db: h.db, log: silent, engine: h.engine, model: h.model, bus: h.bus })
    const sdk = createClient({ baseUrl: 'http://hood.test', fetch: (input, init) => app.request(input, init) })
    const { token } = await seedScoredLaunch(h, { uniqueBuyers: 50 })
    tokens.push(token)
    // A throwaway key: the payment is signed for real, then refused by the
    // unreachable facilitator, which is exactly the boundary we can prove offline.
    const account = privateKeyToAccount(('0x' + 'ab'.repeat(32)) as `0x${string}`)
    const result = await sdk.x402.score(token, { account, maxSpendUsdg: '0.10' }).catch((e: unknown) => e)
    expect(result).toBeInstanceOf(HoodOracleError)
    expect((result as HoodOracleError).status).toBe(502)
    expect((result as HoodOracleError).code).toBe('facilitator_unreachable')
    expect((result as HoodOracleError).message).toContain('X402_FACILITATOR_URL')
  })
})
