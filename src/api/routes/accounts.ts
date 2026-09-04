/**
 * /api/accounts: the wallet-authenticated surface for on-chain arm accounts.
 * Every route is bound to the SIWE session, not the operator token; the
 * operator token still works as the admin path over all of them, which is how
 * support and the MCP tools reach a user's account when they have to.
 */
import { Hono } from 'hono'
import type { AppDeps } from '../deps.js'
import { respond } from '../json.js'
import { badRequest } from '../errors.js'
import { currentSession, isOperatorCall, requireSession } from '../auth-siwe.js'
import { getAccount, listAccounts, prepareCreate, preparePolicyUpdate, refreshAccount, registerAccount } from '../handlers/accounts.js'

async function readJson(c: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    throw badRequest('request body must be JSON')
  }
}

/** Some routes accept an empty body; an absent one is `{}`, a malformed one is still a 400. */
async function readOptionalJson(c: { req: { json(): Promise<unknown>; header(name: string): string | undefined } }): Promise<unknown> {
  const length = c.req.header('content-length')
  if (!length || length === '0') return {}
  return readJson(c)
}

export function accountRoutes(deps: AppDeps): Hono {
  const app = new Hono()

  app.get('/', async (c) => respond(c, await listAccounts(deps, requireSession(c))))

  app.post('/prepare', async (c) => respond(c, await prepareCreate(deps, requireSession(c), await readOptionalJson(c))))

  app.post('/register', async (c) => respond(c, await registerAccount(deps, requireSession(c), await readJson(c)), 201))

  app.get('/:address', async (c) =>
    respond(c, await getAccount(deps, currentSession(c), c.req.param('address'), isOperatorCall(c, deps))))

  app.post('/:address/policy/prepare', async (c) =>
    respond(c, await preparePolicyUpdate(deps, currentSession(c), c.req.param('address'), await readJson(c), isOperatorCall(c, deps))))

  app.post('/:address/refresh', async (c) =>
    respond(c, await refreshAccount(deps, currentSession(c), c.req.param('address'), isOperatorCall(c, deps))))

  return app
}
