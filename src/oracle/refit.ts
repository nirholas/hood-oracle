/**
 * Oracle: the model learns from itself, on a clock.
 *
 * Every six hours (./jobs.ts):
 *
 *   1. Load the labeled set, oldest first, current label rule only, realized
 *      outcomes preferred over chart labels.
 *   2. Fit three heads with a time-split holdout the model has never seen.
 *   3. Put the candidate through a promotion gate that can, and does, say no.
 *   4. Promote or archive. Either way, record the decision and the numbers.
 *
 * The gate is what makes this safe to run unattended. An automated retrain
 * that always ships whatever it just fitted is not a learning loop, it is a
 * single point of failure on a timer. Every candidate has to clear an
 * absolute ranking floor, stay honest about its own tier claims, keep its
 * feature set intact, beat the incumbent by more than fit noise, and not
 * regress the other heads. A candidate that fails is stored with the reason,
 * so the record of what the machine tried is as durable as what it shipped.
 */
import { and, asc, eq, sql } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { schema } from '../db/client.js'
import type { Logger } from '../log.js'
import type { Head, Network, OracleGateCheck, OracleGateVerdict, OracleModelDocument } from '../types.js'
import { modelVersionLabel } from './conviction.js'
import { buildModel, LABEL_VERSION, MIN_TRAINING_ROWS, TIER_PROBABILITY_ANCHORS, type DroppedFeature, type FitRow, type FittedModel } from './fit.js'
import type { ModelStore } from './model-store.js'

/**
 * How much better a challenger has to be before it takes over. Not zero: two
 * fits on almost the same data differ by a few thousandths of AUC from SGD
 * ordering alone, and promoting on that noise would rewrite the live model
 * every six hours, making every track record unreproducible.
 */
export const MIN_AUC_GAIN = 0.004
/** A challenger may not be worse than this on any other head, even if `win` improved. */
export const MAX_HEAD_REGRESSION = 0.01
/** Below this the ranking is not good enough to publish at all. */
export const MIN_ABSOLUTE_AUC = 0.7
/** A reliability band needs this many holdout rows before its honesty is judged. */
export const MIN_BAND_ROWS = 20

const num = (v: unknown): number | null => (v == null || !Number.isFinite(Number(v)) ? null : Number(v))

/** Observed wins sit below 70% of the claim by more than two binomial standard errors. */
export function bandFallsShort(b: { lo: number; n: number; observed: number }): boolean {
  const wins = b.observed * b.n
  const floor = b.n * b.lo * 0.7 - 2 * Math.sqrt(b.n * b.lo * (1 - b.lo))
  return wins < floor
}

/** Checks whose failure marks a candidate 'rejected' rather than 'archived' (lost to the incumbent). */
const REJECTION_CHECKS = new Set(['fit_complete', 'absolute_auc', 'tier_honesty', 'feature_set'])

export type Candidate = OracleModelDocument & Partial<Pick<FittedModel, 'fit' | 'dropped_features'>>

/**
 * Decide whether a candidate replaces the incumbent. Returns the verdict plus
 * the sentence explaining it, because six months from now "why is the model
 * from the 14th still live" is a question somebody will ask and the answer
 * should be in the row, not in a log that has rolled over.
 */
export function judgeCandidate(candidate: Candidate, incumbent: OracleModelDocument | null): OracleGateVerdict {
  const checks: OracleGateCheck[] = []
  const fail = (reason: string): OracleGateVerdict => ({ promote: false, reason, checks })

  const head = candidate.score_head
  const candAuc = num(candidate.holdout?.[head]?.auc)
  if (candAuc == null) return fail('candidate has no holdout AUC for its score head')

  // 1. Did the fit finish? A deadline-truncated fit is not wrong, it is
  //    under-trained, and under-trained weights should never quietly ship.
  const fit = candidate.fit
  const complete = fit ? fit.complete : true
  checks.push({ check: 'fit_complete', pass: complete, detail: fit ? `${fit.epochs_run}/${fit.epochs} epochs` : 'no fit report' })
  if (!complete) return fail(`fit ran out of time at ${fit?.epochs_run}/${fit?.epochs} epochs`)

  // 2. Is it good enough to publish at all, incumbent or not?
  checks.push({ check: 'absolute_auc', pass: candAuc >= MIN_ABSOLUTE_AUC, detail: `${head} AUC ${candAuc}` })
  if (candAuc < MIN_ABSOLUTE_AUC) return fail(`${head} AUC ${candAuc} is below the ${MIN_ABSOLUTE_AUC} publish floor`)

  // 3. Does every tier still earn the probability it claims? The ladder is a
  //    public promise. A model whose top band claims 45% and delivers 20% is
  //    accurate in aggregate and lying on every card that renders it.
  //    A band is dishonest when it falls short of its claim by 30% AND by
  //    more than two standard errors of a binomial at the claimed rate. The
  //    second clause is what makes the test usable on a young chain: a band
  //    of 30 launches claiming 5% expects 1.5 wins, and observing one is not
  //    evidence of anything. At large n the rule converges to "observed below
  //    0.7 x claim", the same bar the large-corpus gate applies.
  const bands = candidate.holdout?.[head]?.reliability ?? []
  const populated = bands.filter((b) => b.n >= MIN_BAND_ROWS && b.lo > 0)
  const dishonest = populated.filter((b) => bandFallsShort(b))
  checks.push({
    check: 'tier_honesty',
    pass: !dishonest.length,
    detail: dishonest.length
      ? dishonest.map((b) => `band ${b.lo}-${b.hi} claims ${b.lo} observed ${b.observed} (n=${b.n})`).join('; ')
      : `all ${populated.length} populated bands clear their claim`,
  })
  if (dishonest.length) return fail(`tier bands do not earn their claim: ${checks[checks.length - 1]!.detail}`)

  // 4. Did the feature set collapse? A schema change or a broken extractor
  //    shows up here as a model that suddenly fits on four signals.
  const featureCount = candidate.features.length
  const incumbentFeatures = incumbent?.features.length ?? 0
  const collapsed = incumbentFeatures > 0 && featureCount < incumbentFeatures - 3
  checks.push({ check: 'feature_set', pass: !collapsed, detail: `${featureCount} features (incumbent ${incumbentFeatures || 'none'})` })
  if (collapsed) return fail(`feature set collapsed from ${incumbentFeatures} to ${featureCount}; a signal source is probably broken`)

  if (!incumbent) {
    return { promote: true, reason: `first model fitted on this chain's labels: ${head} AUC ${candAuc}`, checks }
  }

  // 5. Beat the incumbent on the head we score, by more than fit noise.
  const baseAuc = num(incumbent.holdout?.[head]?.auc)
  if (baseAuc == null) {
    return { promote: true, reason: `incumbent has no comparable ${head} holdout; promoting the measured model`, checks }
  }
  const gain = Number((candAuc - baseAuc).toFixed(4))
  checks.push({ check: 'auc_gain', pass: gain >= MIN_AUC_GAIN, detail: `${head} ${baseAuc} -> ${candAuc} (${gain >= 0 ? '+' : ''}${gain})` })

  // 6. And do not go backwards anywhere else while doing it.
  for (const other of ['rug', 'moon'] as Head[]) {
    if (other === head) continue
    const a = num(candidate.holdout?.[other]?.auc)
    const b = num(incumbent.holdout?.[other]?.auc)
    if (a == null || b == null) continue
    const delta = Number((a - b).toFixed(4))
    const pass = delta >= -MAX_HEAD_REGRESSION
    checks.push({ check: `no_regression_${other}`, pass, detail: `${other} ${b} -> ${a} (${delta >= 0 ? '+' : ''}${delta})` })
    if (!pass) return fail(`${other} head regressed ${delta} (${b} -> ${a}), beyond the ${MAX_HEAD_REGRESSION} tolerance`)
  }

  if (gain < MIN_AUC_GAIN) {
    return fail(`no material gain: ${head} AUC ${baseAuc} -> ${candAuc} (+${gain}), below the ${MIN_AUC_GAIN} bar`)
  }
  return { promote: true, reason: `${head} AUC ${baseAuc} -> ${candAuc} (+${gain}) on ${candidate.training_rows.toLocaleString('en-US')} rows`, checks }
}

export interface TrainingRowRecord {
  features: Record<string, unknown>
  category: string | null
  win: boolean
  rug: boolean
  moon: boolean
  realized_win: boolean | null
  realized_pnl_pct: number | null
  realized_samples: number
}

/**
 * Pure: fold a joined row into a FitRow, preferring the realized result.
 * Realized says whether the trade made money (win) and how badly it lost
 * (rug at -50% or worse); it says nothing about the peak, so moon stays the
 * chart label.
 */
export function toFitRow(r: TrainingRowRecord): FitRow {
  const realized = r.realized_samples > 0 && r.realized_win != null
  const pct = r.realized_pnl_pct
  return {
    features: r.features,
    creator_launches: num(r.features.creator_launches),
    creator_wins: num(r.features.creator_wins),
    category: r.category ?? (typeof r.features.category === 'string' ? r.features.category : null),
    win: realized ? r.realized_win === true : r.win,
    rug: realized && pct != null ? pct <= -50 : r.rug,
    moon: r.moon,
  }
}

/**
 * Labeled launches, oldest first: launch_features joined to oracle_outcomes
 * on the current label rule. Creator pedigree comes from the feature row
 * (what was known at launch time), never from today's creator_stats, which
 * would leak the outcome into its own predictor.
 */
export async function buildTrainingRows({ db, network, maxRows = 200_000 }: { db: Db; network: Network; maxRows?: number }): Promise<FitRow[]> {
  const rows = await db
    .select({
      features: schema.launchFeatures.features,
      category: sql<string | null>`${schema.launchFeatures.features} ->> 'category'`,
      win: schema.oracleOutcomes.win,
      rug: schema.oracleOutcomes.rug,
      moon: schema.oracleOutcomes.moon,
      realized_win: schema.oracleOutcomes.realizedWin,
      realized_pnl_pct: schema.oracleOutcomes.realizedPnlPct,
      realized_samples: schema.oracleOutcomes.realizedSamples,
    })
    .from(schema.launchFeatures)
    .innerJoin(schema.launches, and(eq(schema.launches.token, schema.launchFeatures.token), eq(schema.launches.network, schema.launchFeatures.network)))
    .innerJoin(schema.oracleOutcomes, and(eq(schema.oracleOutcomes.token, schema.launchFeatures.token), eq(schema.oracleOutcomes.network, schema.launchFeatures.network)))
    .where(and(eq(schema.launchFeatures.network, network), eq(schema.oracleOutcomes.labelVersion, LABEL_VERSION)))
    .orderBy(asc(schema.launches.firstSeenAt), asc(schema.launches.token))
    .limit(maxRows)
  return rows.map(toFitRow)
}

export interface RefitResult {
  fitted: boolean
  promoted: boolean
  reason: string
  rows: number
  version: string | null
  rowId: string | null
  status: 'active' | 'archived' | 'rejected' | null
  checks: OracleGateCheck[]
  holdout: Record<Head, number | null> | null
  dropped: DroppedFeature[]
  tookMs: number
}

/**
 * Run one refit end to end: load, fit, judge, persist, promote, reload.
 *
 * The bootstrap prior is never an incumbent for the AUC comparison: its
 * holdout was measured on pump.fun launches and is not comparable to a
 * Robinhood Chain holdout. The first candidate that clears the absolute
 * gate becomes the first model fitted on this chain's own labels.
 */
export async function runRefit({
  db, log, network, model, now = new Date(), epochs = 14, budgetMs = 210_000, maxRows,
}: { db: Db; log: Logger; network: Network; model: ModelStore; now?: Date; epochs?: number; budgetMs?: number; maxRows?: number }): Promise<RefitResult> {
  const startedAt = Date.now()
  const base: Omit<RefitResult, 'reason' | 'rows'> = {
    fitted: false, promoted: false, version: null, rowId: null, status: null, checks: [], holdout: null, dropped: [], tookMs: 0,
  }

  const rows = await buildTrainingRows({ db, network, maxRows })
  if (rows.length < MIN_TRAINING_ROWS) {
    // Not an error. A young chain legitimately has too few labeled rows for a
    // while, and the right behaviour is to keep the current model and wait.
    const reason = `only ${rows.length} labeled rows carry label_version ${LABEL_VERSION}; need ${MIN_TRAINING_ROWS}`
    log.info({ network, rows: rows.length }, `oracle refit: ${reason}`)
    return { ...base, reason, rows: rows.length, tookMs: Date.now() - startedAt }
  }

  await model.reload()
  const incumbent = model.source() === 'database' ? model.active() : null

  const fittedAt = now.toISOString()
  const { model: candidate, report } = buildModel(rows, {
    epochs,
    deadlineAt: startedAt + budgetMs,
    fittedAt,
    provenance: `refit:robinhood-chain ${network}, ${rows.length.toLocaleString('en-US')} labeled launches, fitted ${fittedAt.slice(0, 10)}, label v${LABEL_VERSION}`,
  })
  // Anchors are a platform constant, not a per-fit choice: stamp the current
  // ones so a stored model is self-describing even if the constant later moves.
  candidate.tier_probability_anchors = { ...TIER_PROBABILITY_ANCHORS }

  const verdict = judgeCandidate(candidate, incumbent)
  const version = modelVersionLabel(candidate)
  const status: 'active' | 'archived' | 'rejected' = verdict.promote
    ? 'active'
    : verdict.checks.some((c) => !c.pass && REJECTION_CHECKS.has(c.check)) ? 'rejected' : 'archived'
  const holdout: Record<Head, number | null> = {
    win: num(candidate.holdout.win.auc), rug: num(candidate.holdout.rug.auc), moon: num(candidate.holdout.moon.auc),
  }

  const rowId = await db.transaction(async (tx) => {
    if (verdict.promote) {
      // Demote first, in the same transaction, so there is exactly one active
      // model per network and a half-applied promotion cannot leave none.
      await tx
        .update(schema.oracleModels)
        .set({ status: 'archived', reason: sql`coalesce(${schema.oracleModels.reason}, '') || ${` | superseded by ${version}`}` })
        .where(and(eq(schema.oracleModels.network, network), eq(schema.oracleModels.status, 'active')))
    }
    const [inserted] = await tx
      .insert(schema.oracleModels)
      .values({
        network,
        version,
        status,
        reason: verdict.reason,
        trainingRows: candidate.training_rows,
        fittedAt: now,
        model: candidate as unknown as Record<string, unknown>,
        holdout: candidate.holdout as unknown as Record<string, unknown>,
        checks: verdict.checks,
      })
      .returning({ id: schema.oracleModels.id })
    return inserted!.id
  })

  if (verdict.promote) await model.reload()

  log.info(
    { network, rows: rows.length, version, status, holdout, dropped: report.dropped.map((d) => d.key), reason: verdict.reason },
    verdict.promote ? 'oracle refit: candidate promoted' : 'oracle refit: candidate not promoted',
  )
  return {
    fitted: true, promoted: verdict.promote, reason: verdict.reason, rows: rows.length, version, rowId, status,
    checks: verdict.checks, holdout, dropped: report.dropped, tookMs: Date.now() - startedAt,
  }
}
