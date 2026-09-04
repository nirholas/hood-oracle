import { Hono } from 'hono'
import type { AppDeps } from '../deps.js'
import { respond } from '../json.js'
import { healthBody, statusBody } from '../handlers/status.js'

export { modelSource } from '../handlers/status.js'

export function statusRoutes(deps: AppDeps, startedAt: Date): Hono {
  const app = new Hono()
  app.get('/health', (c) => respond(c, healthBody(startedAt)))
  app.get('/status', async (c) => respond(c, await statusBody(deps, startedAt)))
  return app
}
