import type { MiddlewareHandler } from 'hono'
import { respond } from '../json.js'
import { clientIp } from './client-ip.js'

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
/** Probes and scrapes are never throttled: a throttled readiness probe would take the instance out of rotation. */
const EXEMPT_PATHS = new Set(['/api/health', '/api/ready', '/api/metrics'])

export interface RateLimitOptions {
  /** Writes (POST/PUT/PATCH/DELETE) per client per minute. */
  writesPerMinute?: number
  /** Reads (everything else, an SSE connect counts once) per client per minute. */
  readsPerMinute?: number
  trustProxy: boolean
  /** Injectable clock (ms) for tests. */
  now?: () => number
}

interface Bucket {
  tokens: number
  updatedAt: number
}

export interface RateLimiter {
  middleware: MiddlewareHandler
  /** Drop every bucket (tests). */
  reset(): void
  /** Stop the idle-bucket sweeper. */
  stop(): void
}

export const DEFAULT_WRITES_PER_MINUTE = 30
export const DEFAULT_READS_PER_MINUTE = 600

/**
 * Token bucket per client address, one bucket for reads and one for writes.
 * The store is in-process: with several instances each one enforces the
 * limit on its own share of the traffic, which is exactly what the single
 * always-on Cloud Run instance needs and is documented as such. A rejected
 * request answers 429 with `Retry-After` in whole seconds.
 */
export function createRateLimiter(opts: RateLimitOptions): RateLimiter {
  const writesPerMinute = opts.writesPerMinute ?? DEFAULT_WRITES_PER_MINUTE
  const readsPerMinute = opts.readsPerMinute ?? DEFAULT_READS_PER_MINUTE
  const now = opts.now ?? (() => Date.now())
  const buckets = new Map<string, Bucket>()
  const MAX_BUCKETS = 50_000
  const IDLE_MS = 2 * 60_000

  const sweep = () => {
    const cutoff = now() - IDLE_MS
    for (const [key, b] of buckets) if (b.updatedAt < cutoff) buckets.delete(key)
  }
  const sweeper = setInterval(sweep, 60_000)
  sweeper.unref()

  function take(key: string, capacity: number): { ok: boolean; remaining: number; retryAfterSeconds: number } {
    const t = now()
    const ratePerMs = capacity / 60_000
    let b = buckets.get(key)
    if (!b) {
      if (buckets.size >= MAX_BUCKETS) sweep()
      if (buckets.size >= MAX_BUCKETS) buckets.delete(buckets.keys().next().value as string)
      b = { tokens: capacity, updatedAt: t }
      buckets.set(key, b)
    } else {
      b.tokens = Math.min(capacity, b.tokens + (t - b.updatedAt) * ratePerMs)
      b.updatedAt = t
    }
    if (b.tokens >= 1) {
      b.tokens -= 1
      return { ok: true, remaining: Math.floor(b.tokens), retryAfterSeconds: 0 }
    }
    return { ok: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil((1 - b.tokens) / ratePerMs / 1000)) }
  }

  const middleware: MiddlewareHandler = async (c, next) => {
    if (EXEMPT_PATHS.has(c.req.path) || c.req.method === 'OPTIONS') return next()
    const write = WRITE_METHODS.has(c.req.method)
    const capacity = write ? writesPerMinute : readsPerMinute
    const key = `${clientIp(c, opts.trustProxy)}:${write ? 'w' : 'r'}`
    const r = take(key, capacity)
    c.header('X-RateLimit-Limit', String(capacity))
    c.header('X-RateLimit-Remaining', String(r.remaining))
    if (!r.ok) {
      c.header('Retry-After', String(r.retryAfterSeconds))
      return respond(
        c,
        {
          error: 'rate_limited',
          message: `Too many ${write ? 'write' : 'read'} requests from this address: the limit is ${capacity} per minute. Retry in ${r.retryAfterSeconds}s.`,
          detail: { limitPerMinute: capacity, retryAfterSeconds: r.retryAfterSeconds },
        },
        429,
      )
    }
    return next()
  }

  return {
    middleware,
    reset: () => buckets.clear(),
    stop: () => clearInterval(sweeper),
  }
}
