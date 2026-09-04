/**
 * GET /api/metrics: Prometheus text exposition.
 * GET /api/ready:   readiness, distinct from /api/health (liveness). A live
 *                   process that cannot reach its database, has lost both
 *                   the sequencer feed and the log watchers, or has no model
 *                   loaded should be taken out of rotation, not restarted.
 */
import { Hono } from 'hono'
import { sql } from 'drizzle-orm'
import type { AppDeps } from '../deps.js'
import { ENGINE_RUNNING } from '../deps.js'
import { respond } from '../json.js'
import { METRICS_CONTENT_TYPE, type Metrics } from '../metrics.js'
import type { ReadyCheck, ReadyResponse } from '../contract.js'

export const DATA_PATH_WINDOW_MS = 60_000

export async function readiness(deps: AppDeps, metrics: Metrics): Promise<ReadyResponse> {
  const startup = deps.engineStartup?.() ?? ENGINE_RUNNING
  const running = startup.phase === 'running'
  const engine: ReadyCheck = running
    ? { ok: true, detail: `engine running since ${startup.since}` }
    : startup.phase === 'starting'
      ? {
          ok: false,
          detail: `engine is still starting: attempt ${startup.attempt} of ${startup.attempts}${startup.error ? ` last failed with ${startup.error}` : ''}. The API answers reads meanwhile; no launch is being scored yet.`,
        }
      : {
          ok: false,
          detail: `engine could not start after ${startup.attempt} attempts (${startup.error ?? 'unknown error'}); it keeps retrying in the background. No launch is being scored.`,
        }
  const db = await deps.db
    .execute(sql`select 1 as ok`)
    .then(() => ({ ok: true, detail: 'database answered' }))
    .catch((err: unknown) => ({ ok: false, detail: `database ping failed: ${err instanceof Error ? err.message : String(err)}` }))
  const path = metrics.dataPathHealthy(DATA_PATH_WINDOW_MS)
  // Nothing to measure until the engine owns a feed and watchers; the engine check carries the reason.
  const dataPath: ReadyCheck = !running
    ? { ok: false, detail: 'not checked: the engine is not running yet' }
    : path.ok
    ? { ok: true, detail: path.feedConnected ? 'sequencer feed connected' : `log watchers advanced the head block ${Math.round((path.headAdvancedAgoMs ?? 0) / 1000)}s ago` }
    : {
        ok: false,
        detail:
          path.headBlock == null
            ? 'sequencer feed disconnected and the log watchers have not seen a block yet'
            : `sequencer feed disconnected and the head block last advanced ${Math.round((path.headAdvancedAgoMs ?? 0) / 1000)}s ago (limit ${DATA_PATH_WINDOW_MS / 1000}s)`,
      }
  const prov = deps.model.provenance()
  const doc = deps.model.active()
  const model: ReadyCheck =
    prov.version && doc.features.length > 0
      ? { ok: true, detail: `model ${prov.version} with ${doc.features.length} features` }
      : { ok: false, detail: 'no oracle model is loaded' }
  return { ok: engine.ok && db.ok && dataPath.ok && model.ok, checks: { engine, db, dataPath, model }, now: new Date().toISOString() }
}

export function metricsRoutes(deps: AppDeps, metrics: Metrics): Hono {
  const app = new Hono()
  app.get('/metrics', (c) => c.body(metrics.registry.render(), 200, { 'content-type': METRICS_CONTENT_TYPE, 'cache-control': 'no-store' }))
  app.get('/ready', async (c) => {
    const body = await readiness(deps, metrics)
    c.header('Cache-Control', 'no-store')
    return respond(c, body, body.ok ? 200 : 503)
  })
  return app
}
