/**
 * The HTTP control plane. Reads are public, writes need the operator bearer
 * token, every error is `{ error, message }`, wei serializes as decimal
 * strings and dates as ISO. `serveApp` in ./server.ts binds it.
 *
 * Middleware order is load-bearing: the request id comes first so every
 * later log line and error carries it; security headers next so even a 429
 * or a 413 ships them; the access log wraps everything below it; CORS answers
 * preflights before they can be rate-limited; the rate limiter runs before
 * the body is read so a flood costs nothing to buffer; the body limit runs
 * before auth so an oversized body is refused before the token is checked;
 * auth is last, immediately before the routes.
 */
import { Hono } from 'hono'
import { ApiError } from './errors.js'
import { operatorAuth } from './auth.js'
import { respond } from './json.js'
import type { AppDeps } from './deps.js'
import { createMetrics } from './metrics.js'
import { accessLog, cors, createRateLimiter, jsonBodyLimit, requestId, securityHeaders } from './middleware/index.js'
import { armRoutes } from './routes/arms.js'
import { statusRoutes } from './routes/status.js'
import { killRoutes } from './routes/kill.js'
import { oracleRoutes } from './routes/oracle.js'
import { positionRoutes } from './routes/positions.js'
import { ledgerRoutes } from './routes/ledger.js'
import { streamRoutes } from './routes/stream.js'
import { metricsRoutes } from './routes/metrics.js'
import { x402Routes } from './routes/x402.js'
import { mcpRoutes } from './routes/mcp.js'
import { mountStatic } from './static.js'

export type { AppDeps } from './deps.js'

export function createApp(deps: AppDeps): Hono {
  const app = new Hono()
  const log = deps.log.child({ module: 'api' })
  const metrics = deps.metrics ?? createMetrics({ engine: deps.engine, bus: deps.bus })
  const scoped: AppDeps = { ...deps, log, metrics }
  const startedAt = new Date()
  const limiter = createRateLimiter({
    trustProxy: deps.config.trustProxy,
    writesPerMinute: deps.limits?.writesPerMinute,
    readsPerMinute: deps.limits?.readsPerMinute,
  })

  app.onError((err, c) => {
    if (err instanceof ApiError) return respond(c, err.toJSON(), err.status)
    log.error({ reqId: c.get('requestId'), err: err.message, stack: err.stack, path: c.req.path, method: c.req.method }, 'unhandled API error')
    return respond(c, { error: 'internal', message: err.message || 'internal error', detail: { requestId: c.get('requestId') } }, 500)
  })

  app.notFound((c) => respond(c, { error: 'not_found', message: `${c.req.method} ${c.req.path} is not a route` }, 404))

  app.use('*', requestId())
  app.use('*', securityHeaders())
  app.use('*', accessLog({ log, trustProxy: deps.config.trustProxy }))
  app.use('*', metrics.httpMiddleware)
  app.use('*', cors({ origins: deps.config.corsOrigins }))
  app.use('/api/*', limiter.middleware)
  app.use('/mcp', limiter.middleware)
  app.use('/api/*', jsonBodyLimit(deps.limits?.bodyLimitBytes))
  app.use('/mcp', jsonBodyLimit(deps.limits?.bodyLimitBytes))
  app.use('/api/*', operatorAuth(deps.config))

  app.route('/api', statusRoutes(scoped, startedAt))
  app.route('/api', metricsRoutes(scoped, metrics))
  app.route('/api/arms', armRoutes(scoped))
  app.route('/api/kill', killRoutes(scoped))
  app.route('/api/oracle', oracleRoutes(scoped))
  app.route('/api/positions', positionRoutes(scoped))
  app.route('/api', ledgerRoutes(scoped))
  app.route('/api', streamRoutes(scoped))
  app.route('/api/x402', x402Routes(scoped))
  app.route('/mcp', mcpRoutes(scoped))
  app.all('/api/*', (c) => respond(c, { error: 'not_found', message: `${c.req.method} ${c.req.path} is not an API route` }, 404))

  mountStatic(app, scoped)
  return app
}
