import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { schema } from '../src/db/client.js'
import { cleanupArms, cleanupTokens, createHarness, seedOpenPosition, seedScoredLaunch, scoreToken, syntheticAddress, type Harness } from './api-helpers.js'

let h: Harness
const armIds: string[] = []
const tokens: string[] = []

const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> })

async function createArm(overrides: Record<string, unknown> = {}) {
  const res = await h.app.request('/api/arms', {
    method: 'POST',
    headers: h.authHeaders,
    body: JSON.stringify({ label: 'api-test ' + Math.random().toString(36).slice(2, 8), perTradeEth: 0.01, dailyBudgetEth: 0.1, stopLossPct: 30, ...overrides }),
  })
  const out = await json(res)
  const arm = out.body.arm as Record<string, unknown> | undefined
  if (arm?.id) armIds.push(arm.id as string)
  return out
}

beforeAll(async () => {
  h = await createHarness()
})

afterAll(async () => {
  await cleanupArms(h, armIds)
  await cleanupTokens(h, tokens)
  await h.close()
})

describe('liveness', () => {
  it('GET /api/health answers without auth', async () => {
    const { status, body } = await json(await h.app.request('/api/health'))
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(typeof body.uptimeSeconds).toBe('number')
  })

  it('GET /api/status carries engine health, model provenance and counts', async () => {
    const { status, body } = await json(await h.app.request('/api/status'))
    expect(status).toBe(200)
    const engine = body.engine as Record<string, unknown>
    expect(engine.chainId).toBe(4663)
    const model = body.model as Record<string, unknown>
    expect(model.provenance).toContain('test prior')
    expect(['bootstrap', 'promoted']).toContain(model.source)
    const counts = body.counts as Record<string, unknown>
    expect(typeof (counts.arms as Record<string, number>).total).toBe('number')
    expect(body.operatorTokenSet).toBe(true)
  })

  it('unknown API routes are JSON 404s', async () => {
    const { status, body } = await json(await h.app.request('/api/nope'))
    expect(status).toBe(404)
    expect(body.error).toBe('not_found')
  })
})

describe('operator auth', () => {
  it('writes without a bearer token are 401', async () => {
    const { status, body } = await json(
      await h.app.request('/api/arms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'x' }) }),
    )
    expect(status).toBe(401)
    expect(body.error).toBe('unauthorized')
  })

  it('writes with the wrong token are 401', async () => {
    const { status } = await json(
      await h.app.request('/api/kill', {
        method: 'POST',
        headers: { authorization: 'Bearer nope', 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'x' }),
      }),
    )
    expect(status).toBe(401)
  })

  it('writes are 503 when OPERATOR_TOKEN is unset, and never open by default', async () => {
    const { status, body } = await json(
      await h.appWithoutToken.request('/api/arms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'x' }) }),
    )
    expect(status).toBe(503)
    expect(body.error).toBe('operator_token_unset')
    expect(String(body.message)).toContain('OPERATOR_TOKEN')
    const read = await h.appWithoutToken.request('/api/arms')
    expect(read.status).toBe(200)
  })
})

describe('arms', () => {
  it('creates an arm from ETH amounts and stores exact wei', async () => {
    const { status, body } = await createArm()
    expect(status).toBe(201)
    const arm = body.arm as Record<string, unknown>
    expect(arm.perTradeWei).toBe('10000000000000000')
    expect(arm.dailyBudgetWei).toBe('100000000000000000')
    expect(arm.enabled).toBe(false)
    expect(arm.mode).toBe('simulate')
    expect(arm.launchpads).toEqual(expect.arrayContaining(['noxa', 'odyssey']))
    expect(typeof arm.createdAt).toBe('string')
  })

  it('rejects unknown keys, malformed wei, and both spellings of a sizing field', async () => {
    const unknown = await createArm({ bogus: 1 })
    expect(unknown.status).toBe(400)
    expect(unknown.body.error).toBe('validation')
    const badWei = await createArm({ perTradeWei: '1.5' })
    expect(badWei.status).toBe(400)
    const both = await createArm({ perTradeWei: '1', perTradeEth: 0.01 })
    expect(both.status).toBe(400)
    expect(String(both.body.message)).toContain('not both')
  })

  it('refuses to arm without a stop loss, then arms once one is set and refreshes the engine', async () => {
    // Through the API a zero stop loss is clamped up to the tier floor and reported.
    const created = await createArm({ stopLossPct: 0 })
    expect(created.status).toBe(201)
    const clampedOnCreate = created.body.clamped as { knob: string; to: number }[]
    expect(clampedOnCreate.find((x) => x.knob === 'stopLossPct')?.to).toBeGreaterThan(0)
    const id = (created.body.arm as Record<string, unknown>).id as string
    // A row written outside the API (no clamp) still meets the arming gate.
    await h.db.update(schema.arms).set({ stopLossPct: 0 }).where(eq(schema.arms.id, id))
    const refused = await json(await h.app.request(`/api/arms/${id}/arm`, { method: 'POST', headers: h.authHeaders }))
    expect(refused.status).toBe(409)
    expect(refused.body.error).toBe('unarmable')
    const problems = (refused.body.detail as { problems: { code: string }[] }).problems
    expect(problems.map((p) => p.code)).toContain('stop_loss_required')

    const patched = await json(
      await h.app.request(`/api/arms/${id}`, { method: 'PATCH', headers: h.authHeaders, body: JSON.stringify({ stopLossPct: 25 }) }),
    )
    expect(patched.status).toBe(200)
    const armed = await json(await h.app.request(`/api/arms/${id}/arm`, { method: 'POST', headers: h.authHeaders }))
    expect(armed.status).toBe(200)
    expect((armed.body.arm as Record<string, unknown>).enabled).toBe(true)
    expect(h.engine.health().arms.enabled).toBeGreaterThanOrEqual(1)

    // While armed, a patch to 0 is clamped to the floor rather than stored: the arm keeps a stop loss.
    const weakened = await json(
      await h.app.request(`/api/arms/${id}`, { method: 'PATCH', headers: h.authHeaders, body: JSON.stringify({ stopLossPct: 0 }) }),
    )
    expect(weakened.status).toBe(200)
    expect((weakened.body.arm as Record<string, number>).stopLossPct).toBeGreaterThan(0)
    expect((weakened.body.clamped as { knob: string }[]).some((x) => x.knob === 'stopLossPct')).toBe(true)

    const disarmed = await json(await h.app.request(`/api/arms/${id}/disarm`, { method: 'POST', headers: h.authHeaders }))
    expect((disarmed.body.arm as Record<string, unknown>).enabled).toBe(false)
  })

  it('refuses a daily budget smaller than one trade', async () => {
    const created = await createArm({ perTradeEth: 0.5, dailyBudgetEth: 0.1 })
    const id = (created.body.arm as Record<string, unknown>).id as string
    // The clamp keeps per-trade within the budget on the way in; a row written outside the API is caught at the gate.
    expect(BigInt((created.body.arm as Record<string, string>).perTradeWei)).toBeLessThanOrEqual(100000000000000000n)
    await h.db.update(schema.arms).set({ dailyBudgetWei: '1000000000000000', perTradeWei: '10000000000000000' }).where(eq(schema.arms.id, id))
    const refused = await json(await h.app.request(`/api/arms/${id}/arm`, { method: 'POST', headers: h.authHeaders }))
    expect(refused.status).toBe(409)
    const problems = (refused.body.detail as { problems: { code: string }[] }).problems
    expect(problems.map((p) => p.code)).toContain('daily_budget_too_small')
  })

  it('refuses to arm live while the wallet is not live, and allows it once it is', async () => {
    const created = await createArm({ mode: 'live' })
    const id = (created.body.arm as Record<string, unknown>).id as string
    h.engine.setWallet({ address: null, ethWei: null, live: false })
    const refused = await json(await h.app.request(`/api/arms/${id}/arm`, { method: 'POST', headers: h.authHeaders }))
    expect(refused.status).toBe(409)
    expect(refused.body.error).toBe('wallet_not_live')
    expect(String(refused.body.message)).toContain('TRADER_PRIVATE_KEY')

    h.engine.setWallet({ address: syntheticAddress(), ethWei: 10n ** 17n, live: true })
    const armed = await json(await h.app.request(`/api/arms/${id}/arm`, { method: 'POST', headers: h.authHeaders }))
    expect(armed.status).toBe(200)
    expect((armed.body.arm as Record<string, unknown>).mode).toBe('live')
    expect(h.engine.health().arms.live).toBeGreaterThanOrEqual(1)
    h.engine.setWallet({ address: null, ethWei: null, live: false })
    await h.app.request(`/api/arms/${id}/disarm`, { method: 'POST', headers: h.authHeaders })
  })

  it('kill trips the per-arm switch and disables it; null clears an optional filter', async () => {
    const created = await createArm({ minOracleScore: 70, maxBundleScore: 40, allowedCategories: ['meme', 'ai'] })
    const id = (created.body.arm as Record<string, unknown>).id as string
    await h.app.request(`/api/arms/${id}/arm`, { method: 'POST', headers: h.authHeaders })
    const killed = await json(await h.app.request(`/api/arms/${id}/kill`, { method: 'POST', headers: h.authHeaders }))
    const arm = killed.body.arm as Record<string, unknown>
    expect(arm.enabled).toBe(false)
    expect(arm.killSwitch).toBe(true)
    const cleared = await json(
      await h.app.request(`/api/arms/${id}`, { method: 'PATCH', headers: h.authHeaders, body: JSON.stringify({ minOracleScore: null, maxBundleScore: null, allowedCategories: null }) }),
    )
    // Unbounded filters clear; the oracle gate has a tier floor, so null becomes the floor and is reported as clamped.
    expect((cleared.body.arm as Record<string, unknown>).maxBundleScore).toBeNull()
    expect((cleared.body.arm as Record<string, unknown>).allowedCategories).toBeNull()
    const floor = (cleared.body.clamped as { knob: string; from: unknown; to: number }[]).find((x) => x.knob === 'minOracleScore')
    expect(floor?.from).toBeNull()
    expect((cleared.body.arm as Record<string, unknown>).minOracleScore).toBe(floor?.to)
    const rearmed = await json(await h.app.request(`/api/arms/${id}/arm`, { method: 'POST', headers: h.authHeaders }))
    expect((rearmed.body.arm as Record<string, unknown>).killSwitch).toBe(false)
    await h.app.request(`/api/arms/${id}/disarm`, { method: 'POST', headers: h.authHeaders })
  })

  it('lists arms with summaries, reads one, and 404s a missing or malformed id', async () => {
    const list = await json(await h.app.request('/api/arms'))
    expect(list.status).toBe(200)
    const arms = list.body.arms as Record<string, unknown>[]
    expect(arms.length).toBeGreaterThanOrEqual(1)
    expect(arms[0].summary).toMatchObject({ open: expect.any(Number), realizedPnlWei: expect.any(String) })
    const one = await json(await h.app.request(`/api/arms/${armIds[0]}`))
    expect(one.status).toBe(200)
    expect((one.body.arm as Record<string, unknown>).id).toBe(armIds[0])
    expect((await h.app.request('/api/arms/00000000-0000-4000-8000-000000000000')).status).toBe(404)
    expect((await h.app.request('/api/arms/not-a-uuid')).status).toBe(400)
  })

  it('clamps operator writes to the autonomy tier and reports what moved', async () => {
    const created = await createArm({ autonomyTier: 'probation', perTradeEth: 0.5, dailyBudgetEth: 1 })
    expect(created.status).toBe(201)
    const arm = created.body.arm as Record<string, unknown>
    const clamped = created.body.clamped as { knob: string; from: unknown; to: unknown }[]
    expect(Array.isArray(clamped)).toBe(true)
    expect(clamped.some((x) => x.knob === 'perTradeWei')).toBe(true)
    expect(BigInt(arm.perTradeWei as string)).toBeLessThan(500000000000000000n)
    expect(Array.isArray(created.body.refused)).toBe(true)
    const id = arm.id as string
    const patched = await json(
      await h.app.request(`/api/arms/${id}`, { method: 'PATCH', headers: h.authHeaders, body: JSON.stringify({ perTradeEth: 5 }) }),
    )
    expect(patched.status).toBe(200)
    const again = patched.body.clamped as { knob: string }[]
    expect(again.some((x) => x.knob === 'perTradeWei')).toBe(true)
    expect(BigInt((patched.body.arm as Record<string, string>).perTradeWei)).toBeLessThan(5000000000000000000n)
    const unclamped = await json(
      await h.app.request(`/api/arms/${id}`, { method: 'PATCH', headers: h.authHeaders, body: JSON.stringify({ label: 'renamed by clamp test' }) }),
    )
    expect(unclamped.body.clamped).toEqual([])
    expect((unclamped.body.arm as Record<string, unknown>).label).toBe('renamed by clamp test')
  })

  it('deletes an arm', async () => {
    const created = await createArm()
    const id = (created.body.arm as Record<string, unknown>).id as string
    const del = await json(await h.app.request(`/api/arms/${id}`, { method: 'DELETE', headers: h.authHeaders }))
    expect(del.status).toBe(200)
    expect((await h.app.request(`/api/arms/${id}`)).status).toBe(404)
  })
})

describe('kill switch', () => {
  it('kills, reports, clears an API kill, and refuses to clear an external one', async () => {
    const killed = await json(await h.app.request('/api/kill', { method: 'POST', headers: h.authHeaders, body: JSON.stringify({ reason: 'drill' }) }))
    expect(killed.status).toBe(200)
    expect(killed.body.killed).toBe(true)
    expect(String(killed.body.reason)).toContain('drill')
    const status = await json(await h.app.request('/api/status'))
    expect((status.body.engine as Record<string, unknown>).killed).toBe(true)

    const cleared = await json(await h.app.request('/api/kill', { method: 'DELETE', headers: h.authHeaders }))
    expect(cleared.body).toMatchObject({ killed: false, cleared: true })
    const again = await json(await h.app.request('/api/kill', { method: 'DELETE', headers: h.authHeaders }))
    expect(again.body).toMatchObject({ killed: false, cleared: false })

    h.engine.killExternally('SIGTERM')
    const refused = await json(await h.app.request('/api/kill', { method: 'DELETE', headers: h.authHeaders }))
    expect(refused.status).toBe(409)
    expect(refused.body.error).toBe('kill_not_clearable')
    h.engine.resetKill()

    const missingReason = await json(await h.app.request('/api/kill', { method: 'POST', headers: h.authHeaders, body: JSON.stringify({}) }))
    expect(missingReason.status).toBe(400)
  })
})

describe('oracle', () => {
  let token: string
  let secondToken: string

  beforeAll(async () => {
    const strong = await seedScoredLaunch(h, { uniqueBuyers: 80, bundleScore: 0.05, category: 'ai', symbol: 'STRONG' })
    token = strong.token
    tokens.push(token)
    const weak = await seedScoredLaunch(h, { launchpad: 'odyssey', uniqueBuyers: 2, bundleScore: null, category: 'unknown', symbol: 'WEAK' })
    secondToken = weak.token
    tokens.push(secondToken)
  })

  it('feed returns the latest score per token joined to launch and features, newest first', async () => {
    await scoreToken(h, token as `0x${string}`, { unique_buyers: 90, bundle_score: 0.02, category: 'ai' }, [])
    const { status, body } = await json(await h.app.request('/api/oracle/feed?limit=50&since=1h'))
    expect(status).toBe(200)
    const items = body.items as Record<string, unknown>[]
    const mine = items.find((i) => i.token === token)
    expect(mine).toBeDefined()
    const score = mine!.score as Record<string, unknown>
    expect(score.tier).toBeDefined()
    expect(typeof score.score).toBe('number')
    expect(typeof score.rugRisk).toBe('number')
    expect(score.pillars).toMatchObject({ structure: expect.any(Number), momentum: expect.any(Number) })
    expect(Array.isArray(score.hits)).toBe(true)
    expect((mine!.features as Record<string, unknown>).unique_buyers).toBe(80)
    expect(mine!.launchpad).toBe('noxa')
    expect(mine!.symbol).toBe('STRONG')
    expect(items.filter((i) => i.token === token).length).toBe(1)
    const idx = items.findIndex((i) => i.token === token)
    const idx2 = items.findIndex((i) => i.token === secondToken)
    expect(idx).toBeLessThan(idx2)
    const weak = items[idx2]
    expect(weak.missing).toEqual(['bundle_score'])
    expect(body.filters).toMatchObject({ limit: 50 })
  })

  it('feed filters by tier and launchpad and validates inputs', async () => {
    const odyssey = await json(await h.app.request('/api/oracle/feed?launchpad=odyssey&since=1h'))
    const items = odyssey.body.items as Record<string, unknown>[]
    expect(items.some((i) => i.token === secondToken)).toBe(true)
    expect(items.every((i) => i.launchpad === 'odyssey')).toBe(true)
    const badTier = await h.app.request('/api/oracle/feed?tier=galactic')
    expect(badTier.status).toBe(400)
    const badLimit = await h.app.request('/api/oracle/feed?limit=0')
    expect(badLimit.status).toBe(400)
    const anyTier = await json(await h.app.request('/api/oracle/feed?tier=avoid'))
    expect((anyTier.body.items as Record<string, unknown>[]).every((i) => (i.score as Record<string, unknown>).tier === 'avoid')).toBe(true)
  })

  it('coin detail carries the launch, features with missing keys, score history and empty ledgers', async () => {
    const { status, body } = await json(await h.app.request(`/api/oracle/coin/${secondToken}`))
    expect(status).toBe(200)
    expect((body.launch as Record<string, unknown>).token).toBe(secondToken)
    expect((body.features as Record<string, unknown>).missing).toEqual(['bundle_score'])
    expect((body.scores as unknown[]).length).toBe(1)
    expect(body.latest).not.toBeNull()
    expect(body.firewall).toEqual([])
    expect(body.positions).toEqual([])
    const history = await json(await h.app.request(`/api/oracle/coin/${token.toUpperCase().replace('0X', '0x')}`))
    expect(history.status).toBe(200)
    expect((history.body.scores as unknown[]).length).toBe(2)
    expect((await h.app.request('/api/oracle/coin/' + syntheticAddress())).status).toBe(404)
    expect((await h.app.request('/api/oracle/coin/nope')).status).toBe(400)
  })

  it('model, calibration and model history describe the active prior', async () => {
    const model = await json(await h.app.request('/api/oracle/model'))
    expect(model.status).toBe(200)
    expect(model.body.provenance).toContain('test prior')
    expect(model.body.tierAnchors).toMatchObject({ prime: 0.5 })
    const features = model.body.features as Record<string, unknown>[]
    expect(features.find((f) => f.key === 'unique_buyers')).toMatchObject({ bucketCount: 4, pillar: 'momentum' })
    const cal = await json(await h.app.request('/api/oracle/calibration'))
    expect(cal.status).toBe(200)
    expect(cal.body.key).toBe('oracle:calibration')
    const models = await json(await h.app.request('/api/oracle/models'))
    expect(models.status).toBe(200)
    expect(Array.isArray(models.body.items)).toBe(true)
  })
})

describe('positions, trades, decisions, equity', () => {
  it('lists an open position, closes it through the engine, then refuses a second close', async () => {
    const created = await createArm()
    const armId = (created.body.arm as Record<string, unknown>).id as string
    const { token } = await seedScoredLaunch(h, { symbol: 'POS' })
    tokens.push(token)
    const positionId = await seedOpenPosition(h, armId, token, 10n ** 16n, 15n * 10n ** 15n)

    const open = await json(await h.app.request(`/api/positions?status=open&arm=${armId}`))
    expect(open.status).toBe(200)
    const positions = open.body.positions as Record<string, unknown>[]
    expect(positions.length).toBe(1)
    expect(positions[0]).toMatchObject({ id: positionId, symbol: 'POS', entryWei: '10000000000000000', lastValueWei: '15000000000000000' })
    expect((await json(await h.app.request('/api/status'))).body.engine).toMatchObject({ positions: { open: expect.any(Number) } })

    const closed = await json(await h.app.request(`/api/positions/${positionId}/close`, { method: 'POST', headers: h.authHeaders }))
    expect(closed.status).toBe(200)
    const trade = closed.body.trade as Record<string, unknown>
    expect(trade.side).toBe('sell')
    expect(trade.amountOut).toBe('15000000000000000')
    expect((closed.body.position as Record<string, unknown>).exitReason).toBe('manual')
    expect((closed.body.position as Record<string, unknown>).realizedPnlWei).toBe('5000000000000000')

    const again = await json(await h.app.request(`/api/positions/${positionId}/close`, { method: 'POST', headers: h.authHeaders }))
    expect(again.status).toBe(409)
    expect(again.body.error).toBe('position_not_open')

    const trades = await json(await h.app.request(`/api/trades?arm=${armId}`))
    expect((trades.body.trades as Record<string, unknown>[]).some((t) => t.id === trade.id)).toBe(true)

    const list = await json(await h.app.request(`/api/arms/${armId}`))
    expect((list.body.arm as { summary: { closed: number; wins: number } }).summary).toMatchObject({ closed: 1, wins: 1 })

    const equity = await json(await h.app.request(`/api/equity?arm=${armId}`))
    expect(equity.status).toBe(200)
    const series = equity.body.series as { armId: string; points: unknown[] }[]
    expect(series.length).toBe(1)
    expect(series[0].armId).toBe(armId)
  })

  it('decisions come with a chain verification block', async () => {
    const { status, body } = await json(await h.app.request('/api/decisions?limit=5'))
    expect(status).toBe(200)
    expect(Array.isArray(body.items)).toBe(true)
    expect(body.chain).toMatchObject({ ok: expect.any(Boolean), rows: expect.any(Number), breaks: expect.any(Array) })
  })
})

describe('sse', () => {
  it('replays the bus ring buffer after hello, then closes cleanly on cancel', async () => {
    h.bus.emit({ kind: 'status', at: Date.now(), level: 'info', source: 'api-test', message: 'replay me' })
    const res = await h.app.request('/api/stream')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    while (!text.includes('replay me')) {
      const { value, done } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
    await reader.cancel()
    const frames = text.split('\n\n').filter(Boolean)
    expect(frames[0]).toMatch(/^event: hello\n/)
    const hello = JSON.parse(frames[0].split('\n').find((l) => l.startsWith('data: '))!.slice(6))
    expect(hello.chainId).toBe(4663)
    expect(hello.replay).toBeGreaterThanOrEqual(1)
    const statusFrame = frames.find((f) => f.startsWith('event: status'))
    expect(statusFrame).toBeDefined()
    expect(statusFrame).toContain('replay me')
  })

  it('the oracle stream only replays launch, features and score events', async () => {
    h.bus.emit({ kind: 'status', at: Date.now(), level: 'info', source: 'api-test', message: 'filtered out' })
    const res = await h.app.request('/api/oracle/stream')
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    while (!text.includes('event: score') && !text.includes('event: ping')) {
      const { value, done } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
      if (text.includes('"replay":0')) break
    }
    await reader.cancel()
    expect(text).not.toContain('filtered out')
    expect(text).toMatch(/^event: hello\n/)
  })
})
