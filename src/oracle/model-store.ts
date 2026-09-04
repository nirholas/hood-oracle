/**
 * Oracle: the bridge between the learned model in the database and the pure
 * scoring engine in memory.
 *
 * ./conviction.ts is deliberately pure, so something has to fetch the current
 * weights and install them. That is this module, and keeping it separate is
 * what lets the scorer stay a function of its inputs while the model behind it
 * changes underneath a running engine without a restart.
 *
 * Failure policy: never stop scoring. A database hiccup leaves whatever model
 * is already installed in force (the bootstrap prior on a cold boot, the last
 * good promotion on a warm one) and the next reload retries. A scoring engine
 * that returns nothing because it could not check for a newer opinion is
 * strictly worse than one that keeps using a slightly older one.
 */
import { and, desc, eq } from 'drizzle-orm'
import type { Logger } from '../log.js'
import type { Db } from '../db/client.js'
import { schema } from '../db/client.js'
import type { FeatureSnapshot, ModelStoreApi, Network, OracleModelDocument } from '../types.js'
import bootstrapJson from './bootstrap-model.json' with { type: 'json' }
import { createConviction, normalizeModel, type ConvictionDetail, type ConvictionEngine, type Pedigree } from './conviction.js'

/** The prior compiled into this build, validated once at import. */
export const BOOTSTRAP_MODEL: OracleModelDocument = normalizeModel(bootstrapJson)

export interface ModelStore extends ModelStoreApi {
  convict(snapshot: FeatureSnapshot, pedigree?: Pedigree | null): ConvictionDetail
  /** The engine built for the active model, for callers that need score/probability mapping. */
  engine(): ConvictionEngine
  /** 'bootstrap' until a promoted row has been installed from the database. */
  source(): 'bootstrap' | 'database'
  /** The oracle_models row id serving traffic, or null on the bootstrap prior. */
  activeRowId(): string | null
  /** The last reload failure, or null. Surfaced on the dashboard so a stale model is never silently current. */
  lastError(): string | null
}

export function createModelStore({ db, log, network }: { db: Db; log: Logger; network: Network }): ModelStore {
  let engine = createConviction(BOOTSTRAP_MODEL)
  let source: 'bootstrap' | 'database' = 'bootstrap'
  let rowId: string | null = null
  let lastError: string | null = null
  let inflight: Promise<void> | null = null

  async function fetchActive() {
    const rows = await db
      .select({ id: schema.oracleModels.id, model: schema.oracleModels.model, fittedAt: schema.oracleModels.fittedAt })
      .from(schema.oracleModels)
      .where(and(eq(schema.oracleModels.network, network), eq(schema.oracleModels.status, 'active')))
      .orderBy(desc(schema.oracleModels.fittedAt))
      .limit(1)
    return rows[0] ?? null
  }

  /**
   * Install the newest promoted model. Concurrency-safe: parallel callers
   * share one in-flight query rather than each opening their own.
   */
  async function reload(): Promise<void> {
    if (inflight) return inflight
    inflight = (async () => {
      try {
        const row = await fetchActive()
        if (!row) {
          if (source !== 'bootstrap') log.warn({ network }, 'oracle: no active model row; scoring on the bootstrap prior')
          engine = createConviction(BOOTSTRAP_MODEL)
          source = 'bootstrap'
          rowId = null
        } else if (row.id !== rowId) {
          // Validated before it is installed, and installed atomically: a
          // malformed document throws here and the previous engine keeps serving.
          const next = createConviction(normalizeModel(row.model))
          engine = next
          source = 'database'
          rowId = row.id
          log.info({ network, id: row.id, version: next.version, rows: next.model.training_rows }, 'oracle: model installed')
        }
        lastError = null
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
        log.warn({ network, err: lastError }, 'oracle: model reload failed, keeping the installed model')
      } finally {
        inflight = null
      }
    })()
    return inflight
  }

  return {
    active: () => engine.model,
    engine: () => engine,
    source: () => source,
    activeRowId: () => rowId,
    lastError: () => lastError,
    provenance: () => ({
      version: engine.version,
      provenance: engine.model.provenance,
      trainingRows: engine.model.training_rows,
      fittedAt: engine.model.fitted_at || null,
    }),
    reload,
    convict: (snapshot, pedigree) => engine.convict(snapshot, pedigree ?? null),
  }
}
