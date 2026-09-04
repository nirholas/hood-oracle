import { Hono } from 'hono'
import type { AppDeps } from '../deps.js'
import { respond } from '../json.js'
import { badRequest } from '../errors.js'
import { createArm, deleteArm, disableArm, enableArm, getArm, killArm, listArms, patchArm } from '../handlers/arms.js'

async function readJson(c: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    throw badRequest('request body must be JSON')
  }
}

export function armRoutes(deps: AppDeps): Hono {
  const app = new Hono()
  app.get('/', async (c) => respond(c, await listArms(deps)))
  app.post('/', async (c) => respond(c, await createArm(deps, await readJson(c)), 201))
  app.get('/:id', async (c) => respond(c, await getArm(deps, c.req.param('id'))))
  app.patch('/:id', async (c) => respond(c, await patchArm(deps, c.req.param('id'), await readJson(c))))
  app.delete('/:id', async (c) => respond(c, await deleteArm(deps, c.req.param('id'))))
  app.post('/:id/arm', async (c) => respond(c, await enableArm(deps, c.req.param('id'))))
  app.post('/:id/disarm', async (c) => respond(c, await disableArm(deps, c.req.param('id'))))
  app.post('/:id/kill', async (c) => respond(c, await killArm(deps, c.req.param('id'))))
  return app
}
