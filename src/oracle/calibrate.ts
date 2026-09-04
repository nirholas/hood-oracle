/**
 * Oracle: does the conviction score actually predict wins?
 *
 * Joins every scored launch that has since resolved to its outcome, buckets by
 * 10-point score band, and computes the observed win rate per band next to
 * what the band CLAIMS. The claim is probabilityFromScore(mean score), not
 * score / 100: the score line is not a percentage (86 claims P = 0.45, not
 * 0.86), and comparing a probability to a score reports drift that is really a
 * unit mismatch.
 *
 * Realized outcomes (our own closed positions) are preferred over chart labels
 * where we have them, the same preference the fitter applies, so the table
 * grades the model on the question the trader actually asked.
 *
 * The result is stored in `settings` under 'oracle:calibration' and read by
 * the API and the dashboard. It is deliberately NOT written back onto the
 * score: the calibration is measured against the score, so mutating it would
 * feed back into its own measurement.
 */
import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { schema } from '../db/client.js'
import type { Logger } from '../log.js'
import type { Network, OracleCalibration, OracleCalibrationBand } from '../types.js'
import type { ModelStore } from './model-store.js'

export const CALIBRATION_KEY = 'oracle:calibration'
export const CALIBRATION_VERSION = 1

const BANDS: readonly [number, number][] = Object.freeze([
  [0, 10], [10, 20], [20, 30], [30, 40], [40, 50], [50, 60], [60, 70], [70, 80], [80, 90], [90, 101],
])

interface ScoredOutcome {
  score: number
  win: boolean
}

/** Pure: band the rows and compute observed vs claimed rates. */
export function calibrationTable(
  rows: readonly ScoredOutcome[],
  probabilityFromScore: (score: number) => number,
): { bands: OracleCalibrationBand[]; baseRate: number | null; winsN: number } {
  const winsN = rows.filter((r) => r.win).length
  const baseRate = rows.length ? winsN / rows.length : null
  const bands = BANDS.map(([lo, hi]) => {
    const inBand = rows.filter((r) => r.score >= lo && r.score < hi)
    const n = inBand.length
    const wins = inBand.filter((r) => r.win).length
    const observed = n ? Number((wins / n).toFixed(4)) : null
    const meanScore = n ? inBand.reduce((s, r) => s + r.score, 0) / n : null
    const predicted = meanScore != null ? Number(probabilityFromScore(meanScore).toFixed(4)) : null
    const lift = observed != null && baseRate ? Number((observed / baseRate).toFixed(2)) : null
    return { lo, hi: Math.min(100, hi), n, wins, observed, predicted, lift }
  })
  return { bands, baseRate: baseRate == null ? null : Number(baseRate.toFixed(4)), winsN }
}

/**
 * Compute and store the calibration for one network. Reads the latest score
 * per token (a token is scored once per observation window, but a rescore
 * under a promoted model must not double-count it).
 */
export async function runCalibration({
  db, log, network, model, now = new Date(),
}: { db: Db; log: Logger; network: Network; model: ModelStore; now?: Date }): Promise<OracleCalibration> {
  const rows = await db.execute(sql`
    select s.score::double precision as score,
           coalesce(o.realized_win, o.win) as win
    from (
      select distinct on (token) token, score
      from ${schema.oracleScores}
      where network = ${network}
      order by token, scored_at desc
    ) s
    join ${schema.oracleOutcomes} o on o.token = s.token and o.network = ${network}
  `)
  const scored: ScoredOutcome[] = (rows as unknown as { score: number; win: boolean }[]).map((r) => ({
    score: Number(r.score),
    win: r.win === true,
  }))
  const engine = model.engine()
  const { bands, baseRate, winsN } = calibrationTable(scored, engine.probabilityFromScore)
  const doc: OracleCalibration = {
    version: CALIBRATION_VERSION,
    network,
    computedAt: now.toISOString(),
    modelVersion: engine.version,
    resolvedN: scored.length,
    winsN,
    baseRate,
    bands,
  }
  await db
    .insert(schema.settings)
    .values({ key: CALIBRATION_KEY, value: doc, updatedAt: now })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: doc, updatedAt: now } })
  log.info({ network, resolved: scored.length, wins: winsN, baseRate }, 'oracle: calibration stored')
  return doc
}

/** Read the stored calibration, or null before the first run. */
export async function readCalibration(db: Db): Promise<OracleCalibration | null> {
  const rows = await db.select({ value: schema.settings.value }).from(schema.settings).where(and(eq(schema.settings.key, CALIBRATION_KEY))).limit(1)
  return (rows[0]?.value as OracleCalibration | undefined) ?? null
}
