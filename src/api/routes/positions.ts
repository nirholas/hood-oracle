import { Hono } from 'hono'
import type { AppDeps } from '../deps.js'
import { respond } from '../json.js'
import { closePosition, listPositions } from '../handlers/positions.js'

export function positionRoutes(deps: AppDeps): Hono {
  const app = new Hono()
  app.get('/', async (c) => respond(c, await listPositions(deps, { status: c.req.query('status'), arm: c.req.query('arm'), limit: c.req.query('limit') })))
  app.post('/:id/close', async (c) => respond(c, await closePosition(deps, c.req.param('id'))))
  return app
}
