import { Hono } from 'hono'
import type { AppDeps } from '../deps.js'
import { respond } from '../json.js'
import { oracleCalibration, oracleCoin, oracleFeed, oracleModel, oracleModels } from '../handlers/oracle.js'

export function oracleRoutes(deps: AppDeps): Hono {
  const app = new Hono()
  app.get('/feed', async (c) =>
    respond(c, await oracleFeed(deps, { limit: c.req.query('limit'), tier: c.req.query('tier'), launchpad: c.req.query('launchpad'), since: c.req.query('since') })),
  )
  app.get('/coin/:token', async (c) => respond(c, await oracleCoin(deps, c.req.param('token'))))
  app.get('/model', async (c) => respond(c, await oracleModel(deps)))
  app.get('/calibration', async (c) => respond(c, await oracleCalibration(deps)))
  app.get('/models', async (c) => respond(c, await oracleModels(deps, c.req.query('limit'))))
  return app
}
