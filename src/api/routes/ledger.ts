/** Trades, the hash-chained decision journal, and equity curves. */
import { Hono } from 'hono'
import type { AppDeps } from '../deps.js'
import { respond } from '../json.js'
import { equitySeries, listDecisions, listTrades } from '../handlers/ledger.js'

export { verifyDecisionChain } from '../handlers/ledger.js'

export function ledgerRoutes(deps: AppDeps): Hono {
  const app = new Hono()
  app.get('/trades', async (c) => respond(c, await listTrades(deps, { arm: c.req.query('arm'), token: c.req.query('token'), limit: c.req.query('limit') })))
  app.get('/decisions', async (c) => respond(c, await listDecisions(deps, { arm: c.req.query('arm'), token: c.req.query('token'), limit: c.req.query('limit') })))
  app.get('/equity', async (c) => respond(c, await equitySeries(deps, { arm: c.req.query('arm'), limit: c.req.query('limit') })))
  return app
}
