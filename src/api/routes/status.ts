import { Hono } from 'hono'
import { sql } from 'drizzle-orm'
import type { AppDeps } from '../deps.js'
import { EXPLORER_URL } from '../deps.js'
import { respond } from '../json.js'
import type { HealthResponse, StatusResponse } from '../contract.js'
import { schema } from '../../db/client.js'
import { and, eq } from 'drizzle-orm'
import { ALL_LAUNCHPADS } from '../../chain/launchpads.js'

interface CountRow {
  arms_total: string
  arms_enabled: string
  arms_live: string
  positions_open: string
  positions_closed: string
  launches: string
  launches_24h: string
  scores: string
  scores_24h: string
  trades: string
  decisions: string
}

export async function modelSource(deps: AppDeps): Promise<'bootstrap' | 'promoted'> {
  const prov = deps.model.provenance()
  const doc = deps.model.active()
  const rows = await deps.db
    .select({ version: schema.oracleModels.version })
    .from(schema.oracleModels)
    .where(and(eq(schema.oracleModels.network, deps.config.network), eq(schema.oracleModels.status, 'active')))
  const versions = new Set(rows.map((r) => r.version))
  return versions.has(prov.version) || versions.has(String(doc.version)) ? 'promoted' : 'bootstrap'
}

export function statusRoutes(deps: AppDeps, startedAt: Date): Hono {
  const app = new Hono()
  const { db, config, engine, model } = deps

  app.get('/health', (c) => {
    const body: HealthResponse = {
      ok: true,
      uptimeSeconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
      startedAt: startedAt.toISOString(),
      now: new Date().toISOString(),
    }
    return respond(c, body)
  })

  app.get('/status', async (c) => {
    const net = config.network
    const [counts] = (await db.execute(sql`
      select
        (select count(*) from arms where network = ${net})::text as arms_total,
        (select count(*) from arms where network = ${net} and enabled)::text as arms_enabled,
        (select count(*) from arms where network = ${net} and enabled and mode = 'live')::text as arms_live,
        (select count(*) from positions where network = ${net} and status = 'open')::text as positions_open,
        (select count(*) from positions where network = ${net} and status = 'closed')::text as positions_closed,
        (select count(*) from launches where network = ${net})::text as launches,
        (select count(*) from launches where network = ${net} and first_seen_at > now() - interval '24 hours')::text as launches_24h,
        (select count(*) from oracle_scores where network = ${net})::text as scores,
        (select count(*) from oracle_scores where network = ${net} and scored_at > now() - interval '24 hours')::text as scores_24h,
        (select count(*) from trades where network = ${net})::text as trades,
        (select count(*) from decisions)::text as decisions
    `)) as unknown as CountRow[]
    const source = await modelSource(deps)
    const body: StatusResponse = {
      ok: true,
      now: new Date().toISOString(),
      uptimeSeconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
      network: net,
      chainId: config.chainId,
      explorerUrl: EXPLORER_URL[net],
      launchpads: [...ALL_LAUNCHPADS],
      operatorTokenSet: config.operatorToken != null,
      engine: engine.health() as unknown as StatusResponse['engine'],
      model: { ...model.provenance(), source },
      counts: {
        arms: { total: Number(counts.arms_total), enabled: Number(counts.arms_enabled), live: Number(counts.arms_live) },
        positions: { open: Number(counts.positions_open), closed: Number(counts.positions_closed) },
        launches: Number(counts.launches),
        launches24h: Number(counts.launches_24h),
        scores: Number(counts.scores),
        scores24h: Number(counts.scores_24h),
        trades: Number(counts.trades),
        decisions: Number(counts.decisions),
      },
    }
    return respond(c, body)
  })

  return app
}
