import { Hono } from 'hono'
import type { AppDeps } from '../deps.js'
import { respond } from '../json.js'
import { badRequest } from '../errors.js'
import { clearKill, killState, tripKill } from '../handlers/kill.js'

export function killRoutes(deps: AppDeps): Hono {
  const app = new Hono()
  app.get('/', (c) => respond(c, killState(deps)))
  app.post('/', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      throw badRequest('request body must be JSON: { "reason": "..." }')
    }
    return respond(c, tripKill(deps, body))
  })
  app.delete('/', (c) => respond(c, clearKill(deps)))
  return app
}
