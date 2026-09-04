import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps } from '../deps.js'
import { respond } from '../json.js'
import { badRequest, conflict } from '../errors.js'

const KILL_BODY = z.object({ reason: z.string().trim().min(1, 'give a reason').max(500) })

export function killRoutes(deps: AppDeps): Hono {
  const app = new Hono()
  const { engine, log } = deps

  app.get('/', (c) => {
    const h = engine.health()
    return respond(c, { killed: h.killed, reason: h.killReason })
  })

  app.post('/', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      throw badRequest('request body must be JSON: { "reason": "..." }')
    }
    const parsed = KILL_BODY.safeParse(body)
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'invalid body')
    engine.kill(`operator: ${parsed.data.reason}`)
    log.warn({ reason: parsed.data.reason }, 'kill switch tripped from the API')
    const h = engine.health()
    return respond(c, { killed: h.killed, reason: h.killReason })
  })

  app.delete('/', (c) => {
    const before = engine.health()
    if (!before.killed) return respond(c, { killed: false, reason: null, cleared: false })
    const cleared = engine.unkill()
    if (!cleared) {
      throw conflict(
        'kill_not_clearable',
        `This kill did not come from the API (${before.killReason ?? 'signal or KILL file'}); clear it at the source (remove the KILL file, unset GLOBAL_KILL) and restart.`,
      )
    }
    log.warn('kill switch cleared from the API')
    const h = engine.health()
    return respond(c, { killed: h.killed, reason: h.killReason, cleared: true })
  })

  return app
}
