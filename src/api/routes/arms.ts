import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppDeps } from '../deps.js'
import { respond } from '../json.js'
import { badRequest } from '../errors.js'
import { createArm, deleteArm, disableArm, enableArm, getArm, killArm, listArms, patchArm } from '../handlers/arms.js'
import { currentSession, isOperatorCall } from '../auth-siwe.js'
import type { ArmCaller } from '../handlers/accounts.js'

async function readJson(c: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    throw badRequest('request body must be JSON')
  }
}

export function armRoutes(deps: AppDeps): Hono {
  const app = new Hono()
  /**
   * Who is asking: the operator token is the admin path over every arm, a
   * wallet session reaches only the arms bound to its own on-chain accounts,
   * and an anonymous reader sees the public operator-owned arms exactly as
   * this API has always served them.
   */
  const caller = (c: Context): ArmCaller => ({
    session: currentSession(c),
    isOperator: isOperatorCall(c, deps),
  })
  app.get('/', async (c) => respond(c, await listArms(deps, caller(c))))
  app.post('/', async (c) => respond(c, await createArm(deps, await readJson(c), caller(c)), 201))
  app.get('/:id', async (c) => respond(c, await getArm(deps, c.req.param('id'), caller(c))))
  app.patch('/:id', async (c) => respond(c, await patchArm(deps, c.req.param('id'), await readJson(c), caller(c))))
  app.delete('/:id', async (c) => respond(c, await deleteArm(deps, c.req.param('id'), caller(c))))
  app.post('/:id/arm', async (c) => respond(c, await enableArm(deps, c.req.param('id'), caller(c))))
  app.post('/:id/disarm', async (c) => respond(c, await disableArm(deps, c.req.param('id'), caller(c))))
  app.post('/:id/kill', async (c) => respond(c, await killArm(deps, c.req.param('id'), caller(c))))
  return app
}
