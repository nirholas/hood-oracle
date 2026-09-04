/**
 * Wallet sign-in and the account-scoped authorization it unlocks, against the
 * real Hono app and the real Postgres. Signatures are real: a viem local
 * account signs the exact EIP-4361 string `buildSiweMessage` renders, which is
 * the same function the dashboard uses, so a drift between what the browser
 * signs and what the server parses fails here.
 *
 * These tests deliberately run with no `HOOD_ARM_FACTORY`, because that is the
 * state every server starts in: sign-in must work and the account routes must
 * say why they cannot, rather than 500.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getAddress } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { Hono } from 'hono'
import { buildSiweMessage } from '../src/accounts/siwe.js'
import { NONCE_COOKIE, SESSION_COOKIE } from '../src/accounts/session.js'
import { cleanupArms, createHarness, syntheticAddress, type Harness } from './api-helpers.js'
import { createApp } from '../src/api/app.js'
import { createChainClient } from '../src/chain/client.js'
import { createEngine } from '../src/engine/index.js'
import { EventBus } from '../src/engine/bus.js'
import { log } from '../src/log.js'
import { eq } from 'drizzle-orm'
import { schema } from '../src/db/client.js'

let h: Harness
const armIds: string[] = []

beforeAll(async () => {
  h = await createHarness()
})

afterAll(async () => {
  await cleanupArms(h, armIds)
  await h.close()
})

/** A cookie jar over `app.request`: the browser's half of the sign-in. */
class Jar {
  private readonly cookies = new Map<string, string>()

  absorb(res: Response): void {
    for (const raw of res.headers.getSetCookie()) {
      const pair = raw.split(';')[0]!
      const i = pair.indexOf('=')
      this.cookies.set(pair.slice(0, i), pair.slice(i + 1))
    }
  }

  get header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  has(name: string): boolean {
    return Boolean(this.cookies.get(name))
  }

  async fetch(app: Hono, path: string, init: RequestInit = {}): Promise<Response> {
    const headers = { ...(init.headers as Record<string, string>), cookie: this.header }
    const res = await app.request(path, { ...init, headers })
    this.absorb(res)
    return res
  }
}

interface NonceBody {
  nonce: string
  expiresAt: string
  domain: string
  uri: string
  chainId: number
  statement: string
}

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T

const post = (jar: Jar, path: string, body: unknown) =>
  jar.fetch(h.app, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

/** Nonce, message, signature, session. Overrides let a test bend exactly one field. */
async function signIn(overrides: Partial<Parameters<typeof buildSiweMessage>[0]> = {}, key = generatePrivateKey()) {
  const jar = new Jar()
  const account = privateKeyToAccount(key)
  const nonce = await json<NonceBody>(await jar.fetch(h.app, '/api/auth/nonce'))
  const message = buildSiweMessage({
    domain: nonce.domain,
    address: account.address,
    uri: nonce.uri,
    chainId: nonce.chainId,
    nonce: nonce.nonce,
    statement: nonce.statement,
    expirationTime: new Date(nonce.expiresAt),
    ...overrides,
  })
  const signature = await account.signMessage({ message })
  const res = await post(jar, '/api/auth/verify', { message, signature })
  return { jar, account, nonce, message, signature, res }
}

describe('wallet sign-in', () => {
  it('issues a nonce, accepts the signed message, and remembers the address', async () => {
    const { jar, account, nonce, res } = await signIn()
    expect(res.status).toBe(200)
    const body = await json<{ address: string; chainId: number; expiresAt: string }>(res)
    expect(body.address).toBe(account.address)
    expect(body.chainId).toBe(h.config.chainId)
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now())
    expect(jar.has(SESSION_COOKIE)).toBe(true)
    expect(nonce.statement).toMatch(/moves no funds/i)

    const me = await json<{ address: string | null; accounts: unknown[] }>(await jar.fetch(h.app, '/api/auth/me'))
    expect(me.address).toBe(account.address)
    expect(me.accounts).toEqual([])

    const out = await jar.fetch(h.app, '/api/auth/logout', { method: 'POST' })
    expect(out.status).toBe(200)
    const after = await json<{ address: string | null }>(await jar.fetch(h.app, '/api/auth/me'))
    expect(after.address).toBeNull()
  })

  it('answers /api/auth/me for a browser that has never signed in', async () => {
    const me = await json<{ address: string | null; factory: string | null; accounts: unknown[] }>(await h.app.request('/api/auth/me'))
    expect(me.address).toBeNull()
    expect(me.accounts).toEqual([])
  })

  it('burns the nonce: the same signed message cannot be replayed', async () => {
    const { jar, message, signature } = await signIn()
    const replay = await post(jar, '/api/auth/verify', { message, signature })
    expect(replay.status).toBe(401)
    expect((await json<{ error: string }>(replay)).error).toBe('nonce_invalid')
  })

  it('refuses a message addressed to another domain, chain or nonce', async () => {
    const wrongDomain = await signIn({ domain: 'evil.example' })
    expect(wrongDomain.res.status).toBe(401)
    expect((await json<{ error: string }>(wrongDomain.res)).error).toBe('siwe_rejected')

    const wrongChain = await signIn({ chainId: 1 })
    expect(wrongChain.res.status).toBe(401)
    expect((await json<{ error: string }>(wrongChain.res)).error).toBe('siwe_rejected')

    const wrongNonce = await signIn({ nonce: 'a'.repeat(32) })
    expect(wrongNonce.res.status).toBe(401)
    expect((await json<{ error: string }>(wrongNonce.res)).error).toBe('siwe_rejected')
  })

  it('reads the nonce positionally, so a statement that impersonates one changes nothing', async () => {
    const { res, account } = await signIn({ statement: 'Nonce: 0000attackercontrolled0000' })
    expect(res.status).toBe(200)
    expect((await json<{ address: string }>(res)).address).toBe(account.address)
  })

  it('refuses a signature from a different key than the message names', async () => {
    const jar = new Jar()
    const claimed = privateKeyToAccount(generatePrivateKey())
    const real = privateKeyToAccount(generatePrivateKey())
    const nonce = await json<NonceBody>(await jar.fetch(h.app, '/api/auth/nonce'))
    const message = buildSiweMessage({
      domain: nonce.domain, address: claimed.address, uri: nonce.uri,
      chainId: nonce.chainId, nonce: nonce.nonce, statement: nonce.statement,
    })
    const res = await post(jar, '/api/auth/verify', { message, signature: await real.signMessage({ message }) })
    expect(res.status).toBe(401)
    expect((await json<{ error: string }>(res)).error).toBe('signature_invalid')
  })

  it('refuses a message that is not EIP-4361 at all, and one carrying an unknown field', async () => {
    const jar = new Jar()
    const account = privateKeyToAccount(generatePrivateKey())
    const nonce = await json<NonceBody>(await jar.fetch(h.app, '/api/auth/nonce'))
    const garbage = 'sign this please'
    const first = await post(jar, '/api/auth/verify', { message: garbage, signature: await account.signMessage({ message: garbage }) })
    expect(first.status).toBe(400)
    expect((await json<{ error: string }>(first)).error).toBe('siwe_malformed')

    const jar2 = new Jar()
    const nonce2 = await json<NonceBody>(await jar2.fetch(h.app, '/api/auth/nonce'))
    const smuggled = buildSiweMessage({
      domain: nonce2.domain, address: account.address, uri: nonce2.uri,
      chainId: nonce2.chainId, nonce: nonce2.nonce, statement: nonce2.statement,
    }) + '\nWithdraw: everything'
    const second = await post(jar2, '/api/auth/verify', { message: smuggled, signature: await account.signMessage({ message: smuggled }) })
    expect(second.status).toBe(400)
    expect((await json<{ error: string }>(second)).error).toBe('siwe_malformed')
    expect(nonce.nonce).not.toBe(nonce2.nonce)
  })

  it('sets the nonce cookie on the nonce route and clears it on a good sign-in', async () => {
    const jar = new Jar()
    const res = await jar.fetch(h.app, '/api/auth/nonce')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(jar.has(NONCE_COOKIE)).toBe(true)
    const account = privateKeyToAccount(generatePrivateKey())
    const nonce = await json<NonceBody>(res)
    const message = buildSiweMessage({
      domain: nonce.domain, address: account.address, uri: nonce.uri,
      chainId: nonce.chainId, nonce: nonce.nonce, statement: nonce.statement,
    })
    await post(jar, '/api/auth/verify', { message, signature: await account.signMessage({ message }) })
    expect(jar.has(NONCE_COOKIE)).toBe(false)
  })
})

describe('account routes without a factory', () => {
  it('needs a wallet before it says anything about accounts', async () => {
    const read = await h.app.request('/api/accounts')
    expect(read.status).toBe(401)
    const body = await json<{ error: string; message: string }>(read)
    expect(body.error).toBe('wallet_unauthenticated')
    expect(body.message).toContain('/api/auth/nonce')

    // An anonymous write never even reaches the wallet check: the operator
    // gate refuses it first, which is the same answer every other write gets.
    for (const path of ['/api/accounts/prepare', '/api/accounts/register']) {
      const res = await h.app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      expect(res.status, path).toBe(401)
      expect((await json<{ error: string }>(res)).error).toBe('unauthorized')
    }
  })

  it('tells a signed-in wallet exactly what the server is missing', async () => {
    const { jar } = await signIn()
    const res = await jar.fetch(h.app, '/api/accounts')
    expect(res.status).toBe(503)
    const body = await json<{ error: string; message: string }>(res)
    expect(body.error).toBe('accounts_unavailable')
    expect(body.message).toContain('HOOD_ARM_FACTORY')
  })
})

describe('arms seen through a wallet session', () => {
  it('hides nothing public, refuses to let a session touch an operator arm, and demands an account to create one', async () => {
    const created = await h.app.request('/api/arms', {
      method: 'POST',
      headers: h.authHeaders,
      body: JSON.stringify({ label: 'operator-owned ' + syntheticAddress().slice(0, 8), perTradeEth: 0.01, dailyBudgetEth: 0.05, stopLossPct: 30 }),
    })
    expect(created.status).toBe(201)
    const arm = (await json<{ arm: { id: string; accountId: string | null } }>(created)).arm
    armIds.push(arm.id)
    expect(arm.accountId).toBeNull()

    const { jar } = await signIn()
    // Operator-owned arms stay publicly readable: that is what the dashboard shows a visitor.
    const list = await json<{ arms: { id: string }[] }>(await jar.fetch(h.app, '/api/arms'))
    expect(list.arms.some((a) => a.id === arm.id)).toBe(true)

    const patch = await jar.fetch(h.app, `/api/arms/${arm.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ perTradeEth: 1 }),
    })
    expect(patch.status).toBe(403)
    expect((await json<{ error: string }>(patch)).error).toBe('operator_only')

    const create = await post(jar, '/api/arms', { label: 'wallet arm', perTradeEth: 0.01, dailyBudgetEth: 0.05, stopLossPct: 30 })
    expect(create.status).toBe(403)
    const refusal = await json<{ error: string; message: string }>(create)
    expect(refusal.error).toBe('account_required')
    expect(refusal.message).toContain('accountId')

    const bogus = await post(jar, '/api/arms', {
      label: 'wallet arm', perTradeEth: 0.01, dailyBudgetEth: 0.05, stopLossPct: 30,
      accountId: '00000000-0000-4000-8000-000000000000',
    })
    expect([400, 403, 404, 503]).toContain(bogus.status)

    // The arm the operator made is untouched by any of it.
    const [row] = await h.db.select().from(schema.arms).where(eq(schema.arms.id, arm.id)).limit(1)
    expect(row?.accountId ?? null).toBeNull()
  })
})

describe('engine wiring', () => {
  /**
   * The multi-tenant layer is only real if something instantiates it. It
   * shipped once with every module written and nothing constructing them, so
   * `/api/accounts` answered 503 on a server that had a factory configured
   * and no arm ever routed through an account. This is the test that would
   * have caught it.
   */
  it('builds the registry exactly when a factory is configured, and hands it to the API', async () => {
    const silent = log.child({ test: true })
    silent.level = 'silent'
    const factory = getAddress(syntheticAddress())

    const singleTenant = createEngine({ config: h.config, db: h.db, log: silent, model: h.model, bus: new EventBus() })
    expect(singleTenant.accounts).toBeNull()

    const config = { ...h.config, accounts: { ...h.config.accounts, factory } }
    const multiTenant = createEngine({ config, db: h.db, log: silent, model: h.model, bus: new EventBus() })
    expect(multiTenant.accounts).not.toBeNull()
    expect(multiTenant.accounts!.factory).toBe(factory)
    expect(multiTenant.accounts!.chainId).toBe(h.config.chainId)

    // An app given that registry stops answering "not configured". The chain
    // read behind it fails (nothing is deployed at a synthetic address) and
    // the handler degrades to the cached rows rather than a 500.
    const app = createApp({
      config, db: h.db, log: silent, engine: h.engine, model: h.model, bus: h.bus,
      limits: { readsPerMinute: 1_000_000, writesPerMinute: 1_000_000, authReadsPerMinute: 1_000_000, authWritesPerMinute: 1_000_000 },
      accounts: { registry: multiTenant.accounts!, publicClient: createChainClient(config).publicClient },
    })

    const jar = new Jar()
    const account = privateKeyToAccount(generatePrivateKey())
    const nonce = await json<NonceBody>(await jar.fetch(app, '/api/auth/nonce'))
    const message = buildSiweMessage({
      domain: nonce.domain, address: account.address, uri: nonce.uri,
      chainId: nonce.chainId, nonce: nonce.nonce, statement: nonce.statement,
    })
    await jar.fetch(app, '/api/auth/verify', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, signature: await account.signMessage({ message }) }),
    })
    const res = await jar.fetch(app, '/api/accounts')
    expect(res.status).toBe(200)
    const body = await json<{ accounts: unknown[]; factory: string; chainId: number }>(res)
    expect(body.factory).toBe(factory)
    expect(body.chainId).toBe(h.config.chainId)
    expect(body.accounts).toEqual([])
  }, 60_000)
})
