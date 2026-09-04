/**
 * The HTTP control plane. Reads are public, writes need the operator bearer
 * token, every error is `{ error, message }`, wei serializes as decimal
 * strings and dates as ISO. `serveApp` in ./server.ts binds it.
 */
import { Hono } from 'hono'
import { ApiError } from './errors.js'
import { operatorAuth } from './auth.js'
import { respond } from './json.js'
import type { AppDeps } from './deps.js'
import { armRoutes } from './routes/arms.js'
import { statusRoutes } from './routes/status.js'
import { killRoutes } from './routes/kill.js'
import { oracleRoutes } from './routes/oracle.js'
import { positionRoutes } from './routes/positions.js'
import { ledgerRoutes } from './routes/ledger.js'
import { streamRoutes } from './routes/stream.js'
import { mountStatic } from './static.js'

export type { AppDeps } from './deps.js'

export function createApp(deps: AppDeps): Hono {
  const app = new Hono()
  const log = deps.log.child({ module: 'api' })
  const scoped: AppDeps = { ...deps, log }
  const startedAt = new Date()

  app.onError((err, c) => {
    if (err instanceof ApiError) return respond(c, err.toJSON(), err.status)
    log.error({ err: err.message, stack: err.stack, path: c.req.path, method: c.req.method }, 'unhandled API error')
    return respond(c, { error: 'internal', message: err.message || 'internal error' }, 500)
  })

  app.notFound((c) => respond(c, { error: 'not_found', message: `${c.req.method} ${c.req.path} is not a route` }, 404))

  app.use('*', async (c, next) => {
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Referrer-Policy', 'same-origin')
    c.header('X-Frame-Options', 'DENY')
    await next()
  })

  app.use('/api/*', async (c, next) => {
    const started = performance.now()
    await next()
    if (!c.req.path.endsWith('/stream')) {
      log.debug({ method: c.req.method, path: c.req.path, status: c.res.status, ms: Math.round(performance.now() - started) }, 'request')
    }
  })
  app.use('/api/*', operatorAuth(deps.config))

  app.route('/api', statusRoutes(scoped, startedAt))
  app.route('/api/arms', armRoutes(scoped))
  app.route('/api/kill', killRoutes(scoped))
  app.route('/api/oracle', oracleRoutes(scoped))
  app.route('/api/positions', positionRoutes(scoped))
  app.route('/api', ledgerRoutes(scoped))
  app.route('/api', streamRoutes(scoped))
  app.all('/api/*', (c) => respond(c, { error: 'not_found', message: `${c.req.method} ${c.req.path} is not an API route` }, 404))

  mountStatic(app, scoped)
  return app
}
