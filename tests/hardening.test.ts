/**
 * Production hardening: security headers, request ids, rate limits, body
 * limits, CORS, /api/metrics, /api/ready and the x402 pay-per-score route.
 * Runs against the real DB-backed harness; a second app is built with tiny
 * limits so the throttles can be hit in a test without 600 requests.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { requireNetwork } from 'hood402'
import { createApp } from '../src/api/app.js'
import { log } from '../src/log.js'
import { cleanupArms, cleanupTokens, createHarness, seedScoredLaunch, syntheticAddress, type Harness } from './api-helpers.js'

let h: Harness
const armIds: string[] = []
const tokens: string[] = []

const silent = () => {
  const l = log.child({ test: true })
  l.level = 'silent'
  return l
}

function appWith(overrides: { limits?: { writesPerMinute?: number; readsPerMinute?: number; bodyLimitBytes?: number }; trustProxy?: boolean; corsOrigins?: string[]; x402PayTo?: `0x${string}` | null }) {
  const config = {
    ...h.config,
    trustProxy: overrides.trustProxy ?? h.config.trustProxy,
    corsOrigins: overrides.corsOrigins ?? h.config.corsOrigins,
    x402: { ...h.config.x402, payTo: overrides.x402PayTo === undefined ? h.config.x402.payTo : overrides.x402PayTo },
  }
  return createApp({ config, db: h.db, log: silent(), engine: h.engine, model: h.model, bus: h.bus, limits: overrides.limits })
}

beforeAll(async () => {
  h = await createHarness()
})

afterAll(async () => {
  await cleanupArms(h, armIds)
  await cleanupTokens(h, tokens)
  await h.close()
})

describe('security headers', () => {
  it('ships a CSP that frames nobody, nosniff, referrer and permissions policies on every response', async () => {
    for (const path of ['/api/health', '/api/nope', '/api/arms']) {
      const res = await h.app.request(path)
      const csp = res.headers.get('content-security-policy') ?? ''
      expect(csp).toContain("frame-ancestors 'none'")
      expect(csp).toContain("default-src 'self'")
      expect(csp).toContain("connect-src 'self'")
      expect(csp).toContain("script-src 'self'")
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(res.headers.get('x-frame-options')).toBe('DENY')
      expect(res.headers.get('referrer-policy')).toBe('same-origin')
      expect(res.headers.get('permissions-policy')).toContain('camera=()')
      expect(res.headers.get('strict-transport-security')).toContain('max-age=')
    }
  })
})

describe('request ids', () => {
  it('mints an id and echoes a sane caller-supplied one', async () => {
    const minted = await h.app.request('/api/health')
    expect(minted.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/)
    const echoed = await h.app.request('/api/health', { headers: { 'x-request-id': 'trace-abc.123' } })
    expect(echoed.headers.get('x-request-id')).toBe('trace-abc.123')
    const junk = await h.app.request('/api/health', { headers: { 'x-request-id': 'bad id with spaces <script>' } })
    expect(junk.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('rate limiting', () => {
  it('throttles reads per client with a 429, Retry-After and rate-limit headers; probes are exempt', async () => {
    const app = appWith({ limits: { readsPerMinute: 3 } })
    const statuses: number[] = []
    let last: Response | null = null
    for (let i = 0; i < 5; i++) {
      last = await app.request('/api/kill')
      statuses.push(last.status)
    }
    expect(statuses).toEqual([200, 200, 200, 429, 429])
    expect(last!.headers.get('retry-after')).toMatch(/^\d+$/)
    expect(last!.headers.get('x-ratelimit-limit')).toBe('3')
    const body = (await last!.json()) as { error: string; message: string }
    expect(body.error).toBe('rate_limited')
    expect(body.message).toContain('3 per minute')
    for (const probe of ['/api/health', '/api/ready', '/api/metrics']) expect((await app.request(probe)).status).not.toBe(429)
  })

  it('keeps a separate, tighter bucket for writes', async () => {
    const app = appWith({ limits: { writesPerMinute: 2, readsPerMinute: 100 } })
    const post = () => app.request('/api/kill', { method: 'POST', headers: h.authHeaders, body: JSON.stringify({ reason: 'rate test' }) })
    expect((await post()).status).toBe(200)
    expect((await post()).status).toBe(200)
    expect((await post()).status).toBe(429)
    expect((await app.request('/api/kill')).status).toBe(200)
    await app.request('/api/kill', { method: 'DELETE', headers: h.authHeaders })
    h.engine.resetKill()
  })

  it('honours X-Forwarded-For only when TRUST_PROXY is set', async () => {
    const untrusted = appWith({ limits: { readsPerMinute: 2 }, trustProxy: false })
    const a = { 'x-forwarded-for': '203.0.113.7' }
    const b = { 'x-forwarded-for': '198.51.100.9' }
    expect((await untrusted.request('/api/kill', { headers: a })).status).toBe(200)
    expect((await untrusted.request('/api/kill', { headers: b })).status).toBe(200)
    expect((await untrusted.request('/api/kill', { headers: a })).status).toBe(429)

    const trusted = appWith({ limits: { readsPerMinute: 2 }, trustProxy: true })
    expect((await trusted.request('/api/kill', { headers: a })).status).toBe(200)
    expect((await trusted.request('/api/kill', { headers: a })).status).toBe(200)
    expect((await trusted.request('/api/kill', { headers: a })).status).toBe(429)
    expect((await trusted.request('/api/kill', { headers: b })).status).toBe(200)
  })
})

describe('body limit', () => {
  it('refuses an oversized JSON body with 413 before it is parsed', async () => {
    const app = appWith({ limits: { bodyLimitBytes: 200 } })
    const big = JSON.stringify({ label: 'x'.repeat(400) })
    const res = await app.request('/api/arms', { method: 'POST', headers: h.authHeaders, body: big })
    expect(res.status).toBe(413)
    const body = (await res.json()) as { error: string; detail: { maxBytes: number } }
    expect(body.error).toBe('payload_too_large')
    expect(body.detail.maxBytes).toBe(200)
    const small = await app.request('/api/kill', { method: 'POST', headers: h.authHeaders, body: JSON.stringify({ reason: 'small body' }) })
    expect(small.status).toBe(200)
    await app.request('/api/kill', { method: 'DELETE', headers: h.authHeaders })
    h.engine.resetKill()
  })
})

describe('cors', () => {
  it('is same-origin by default: a foreign origin gets no allow-origin header and its preflight is refused', async () => {
    const res = await h.app.request('/api/health', { headers: { origin: 'https://evil.example' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    const pre = await h.app.request('/api/arms', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } })
    expect(pre.status).toBe(403)
    expect(((await pre.json()) as { error: string }).error).toBe('cors_origin_not_allowed')
    const same = await h.app.request('http://localhost/api/health', { headers: { origin: 'http://localhost' } })
    expect(same.status).toBe(200)
  })

  it('opens named origins for every method and a wildcard for reads only', async () => {
    const named = appWith({ corsOrigins: ['https://dash.example'] })
    const pre = await named.request('/api/arms', { method: 'OPTIONS', headers: { origin: 'https://dash.example', 'access-control-request-method': 'POST' } })
    expect(pre.status).toBe(204)
    expect(pre.headers.get('access-control-allow-origin')).toBe('https://dash.example')
    expect(pre.headers.get('access-control-allow-methods')).toContain('POST')
    expect(pre.headers.get('access-control-allow-headers')).toContain('Authorization')
    expect(pre.headers.get('vary')).toContain('Origin')
    const get = await named.request('/api/health', { headers: { origin: 'https://dash.example' } })
    expect(get.headers.get('access-control-allow-origin')).toBe('https://dash.example')

    const wild = appWith({ corsOrigins: ['*'] })
    const read = await wild.request('/api/health', { headers: { origin: 'https://anyone.example' } })
    expect(read.headers.get('access-control-allow-origin')).toBe('https://anyone.example')
    const writePre = await wild.request('/api/kill', { method: 'OPTIONS', headers: { origin: 'https://anyone.example', 'access-control-request-method': 'POST' } })
    expect(writePre.status).toBe(403)
    const write = await wild.request('/api/kill', { method: 'POST', headers: { ...h.authHeaders, origin: 'https://anyone.example' }, body: JSON.stringify({ reason: 'cors' }) })
    expect(write.headers.get('access-control-allow-origin')).toBeNull()
    await wild.request('/api/kill', { method: 'DELETE', headers: h.authHeaders })
    h.engine.resetKill()
  })
})

describe('metrics and readiness', () => {
  it('GET /api/metrics is Prometheus text with process, http and engine series', async () => {
    const { token } = await seedScoredLaunch(h, { uniqueBuyers: 70 })
    tokens.push(token)
    await h.app.request('/api/arms')
    const res = await h.app.request('/api/metrics')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/plain; version=0.0.4')
    const text = await res.text()
    expect(text).toMatch(/^# TYPE process_uptime_seconds gauge$/m)
    expect(text).toMatch(/^process_resident_memory_bytes \d+$/m)
    expect(text).toMatch(/^# TYPE nodejs_eventloop_lag_seconds gauge$/m)
    expect(text).toMatch(/^http_requests_total\{method="GET",route="\/api\/arms",status="200"\} \d+$/m)
    expect(text).toMatch(/^http_request_duration_ms_bucket\{le="\+Inf",method="GET",route="\/api\/arms"\} \d+$/m)
    expect(text).toMatch(/^hood_feed_connected 0$/m)
    expect(text).toMatch(/^hood_killed 0$/m)
    expect(text).toMatch(/^hood_positions_open \d+$/m)
    expect(text).toMatch(/^hood_arms\{state="enabled"\} \d+$/m)
    expect(text).toMatch(/^hood_scores_total\{tier="[a-z]+"\} [1-9]\d*$/m)
    expect(text).toMatch(/^hood_engine_events_total\{kind="score"\} [1-9]\d*$/m)
    expect(text).toMatch(/^# TYPE hood_refusals_total counter$/m)
  })

  it('GET /api/ready is 503 with named checks while the data path is down, and distinct from /api/health', async () => {
    const res = await h.app.request('/api/ready')
    expect(res.status).toBe(503)
    const body = (await res.json()) as { ok: boolean; checks: Record<string, { ok: boolean; detail: string }> }
    expect(body.ok).toBe(false)
    expect(body.checks.db.ok).toBe(true)
    expect(body.checks.model.ok).toBe(true)
    expect(body.checks.model.detail).toContain('bootstrap-test')
    expect(body.checks.dataPath.ok).toBe(false)
    expect(body.checks.dataPath.detail).toContain('feed disconnected')
    expect((await h.app.request('/api/health')).status).toBe(200)
  })
})

describe('x402 pay-per-score', () => {
  const usdg = requireNetwork('robinhood')

  it('pricing is free and describes the paid route even when it is disabled; the paid route is 503 until X402_PAY_TO is set', async () => {
    const app = appWith({ x402PayTo: null })
    const pricing = await app.request('/api/x402/pricing')
    expect(pricing.status).toBe(200)
    const body = (await pricing.json()) as Record<string, any>
    expect(body.enabled).toBe(false)
    expect(body.network).toEqual({ id: 'robinhood', chainId: 4663 })
    expect(body.asset.symbol).toBe('USDG')
    expect(body.asset.address).toBe(usdg.usdg)
    expect(body.scheme).toBe('exact')
    expect(body.price).toEqual({ usdg: '0.05', atomic: '50000', decimals: 6 })
    expect(body.resource).toMatch(/\/api\/x402\/score\/:token$/)
    const paid = await app.request(`/api/x402/score/${syntheticAddress()}`)
    expect(paid.status).toBe(503)
    const err = (await paid.json()) as { error: string; message: string }
    expect(err.error).toBe('x402_not_configured')
    expect(err.message).toContain('X402_PAY_TO')
    expect(err.message).toContain('/api/oracle/feed')
  })

  it('a token that was never scored is a free 404 pointing at the feed, never a 402', async () => {
    const app = appWith({ x402PayTo: syntheticAddress() })
    const res = await app.request(`/api/x402/score/${syntheticAddress()}`)
    expect(res.status).toBe(404)
    const err = (await res.json()) as { error: string; message: string }
    expect(err.error).toBe('not_scored')
    expect(err.message).toContain('/api/oracle/feed')
    expect((await app.request('/api/x402/score/not-an-address')).status).toBe(400)
  })

  it('a scored token answers a spec-shaped 402 for USDG on 4663 from the real hood402 middleware', async () => {
    const payTo = syntheticAddress()
    const app = appWith({ x402PayTo: payTo })
    const { token } = await seedScoredLaunch(h, { uniqueBuyers: 40 })
    tokens.push(token)
    const res = await app.request(`http://hood.test/api/x402/score/${token}`)
    expect(res.status).toBe(402)
    const body = (await res.json()) as { x402Version: number; accepts: Record<string, any>[]; error?: string }
    expect(body.x402Version).toBe(1)
    expect(body.error).toBeUndefined()
    expect(body.accepts).toHaveLength(1)
    const req = body.accepts[0]
    expect(req.scheme).toBe('exact')
    expect(req.network).toBe('robinhood')
    expect(req.asset).toBe(usdg.usdg)
    expect(req.maxAmountRequired).toBe('50000')
    expect(req.payTo.toLowerCase()).toBe(payTo.toLowerCase())
    expect(req.resource).toBe(`http://hood.test/api/x402/score/${token}`)
    expect(req.extra).toEqual({ name: 'Global Dollar', version: '1' })
    expect(req.mimeType).toBe('application/json')
    expect(req.description).toContain('conviction verdict')

    const malformed = await app.request(`http://hood.test/api/x402/score/${token}`, { headers: { 'x-payment': 'not-base64-json' } })
    expect(malformed.status).toBe(402)
    const again = (await malformed.json()) as { error?: string; accepts: unknown[] }
    expect(again.error).toBeTruthy()
    expect(again.accepts).toHaveLength(1)
  })
})
