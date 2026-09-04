/**
 * Oracle conviction: the fitting library.
 *
 * One implementation of "turn labeled launches into a conviction model",
 * shared by the refit job (./refit.ts) and the CLI (scripts/fit.ts). PURE:
 * rows in, model out. No database, no filesystem, no clock beyond the
 * `fittedAt` the caller passes. That is what makes it testable and what lets
 * the same code run in a scheduled job and in a terminal.
 *
 * Three heads over one shared design matrix:
 *
 *   win  = it ran (2x from first sight) AND a first-sight holder is still up
 *   rug  = a first-sight holder is down more than half
 *   moon = it ran at all, whatever happened next
 *
 * The published conviction score anchors on `win`. `rug` is published beside
 * it rather than blended in, because "this will probably run" and "this will
 * probably take your money" are different questions and one number that
 * averages them answers neither. `moon` is kept so successive fits stay
 * comparable and a regression in either is visible.
 *
 * Labels arrive already resolved (see ./labels.ts): the row carries its three
 * booleans, realized outcomes already preferred over chart labels by the
 * loader. The fitter never re-derives them, so a label rule change is one
 * place, not two.
 *
 * Sizing for a young chain
 * ------------------------
 * three.ws fits on hundreds of thousands of pump.fun launches and can afford
 * to refuse anything under 5,000 rows. Robinhood Chain launches a few dozen
 * tokens a week. The thresholds below are the smallest that still let the
 * promotion gate mean something:
 *
 *   MIN_TRAINING_ROWS = 400: with MIN_HOLDOUT_ROWS = 100 held out, a 5% base
 *   rate leaves about five positives in the holdout. That is the floor at
 *   which an AUC of 0.70 is distinguishable from 0.50 at all; below it every
 *   candidate would be judged on noise and the gate's absolute floor would be
 *   theatre. The gate keeps the same AUC floors as the large corpus.
 *
 *   MIN_MINORITY_ROWS = 10: a feature is dropped only when its runner-up
 *   bucket cannot support a second weight. Deliberately NOT a share test:
 *   smart money is rare and is the strongest thing the pump.fun corpus knows.
 *
 *   SHRINK_PRIOR = 50: empirical-Bayes shrinkage n / (n + prior). A bucket
 *   with 50 rows keeps half its fitted weight, one with 500 keeps 91%, one
 *   with 5 keeps 9%. At 200 (the large-corpus value) a 400-row fit would mute
 *   nearly every bucket; at 50 the weights that survive are the ones the data
 *   actually supports.
 */
import type { Head, HoldoutMetrics, OracleModelDocument, OracleModelFeature, OracleTier } from '../types.js'
import { FEATURES, bucketLabel, type FeatureDef, type TrainingRow } from './features.js'

/** The labeling rule this fitter trains against. Rows stamped with another rule are excluded by the loader. */
export const LABEL_VERSION = 1

export const HEADS: readonly Head[] = Object.freeze(['win', 'rug', 'moon'])
/** The head the public 0-100 score is anchored on. */
export const SCORE_HEAD: Head = 'win'

export const MIN_TRAINING_ROWS = 400
export const MIN_HOLDOUT_ROWS = 100
export const MIN_MINORITY_ROWS = 10
export const SHRINK_PRIOR = 50

/** Public tier boundaries as the P(win) each one claims. Fixed across refits; see ./conviction.ts. */
export const TIER_PROBABILITY_ANCHORS: Readonly<Record<OracleTier, number>> = Object.freeze({
  avoid: 0, watch: 0.05, lean: 0.12, strong: 0.25, prime: 0.45,
})

/** A training row with its resolved labels. */
export interface FitRow extends TrainingRow {
  win: boolean
  rug: boolean
  moon: boolean
}

export const TARGETS: Readonly<Record<Head, (r: FitRow) => 0 | 1>> = Object.freeze({
  win: (r) => (r.win ? 1 : 0),
  rug: (r) => (r.rug ? 1 : 0),
  moon: (r) => (r.moon ? 1 : 0),
})

/** Column key for one feature/bucket pair. Space-separated; bucket labels never contain one. */
const colKey = (featureKey: string, label: string) => `${featureKey} ${label}`

export interface Encoded {
  X: Int32Array
  stride: number
  columns: Map<string, number>
}

/**
 * One-hot encode rows into a flat design matrix: `X[i * stride + f]` is the
 * column index of row i's bucket for feature f. Flat Int32Array rather than an
 * array of arrays so a large fit spends its time on arithmetic, not pointers.
 */
export function encode(rows: readonly TrainingRow[], features: readonly FeatureDef[] = FEATURES): Encoded {
  const columns = new Map<string, number>()
  const stride = features.length
  const X = new Int32Array(rows.length * stride)
  for (let i = 0; i < rows.length; i++) {
    for (let f = 0; f < stride; f++) {
      const feature = features[f]!
      const key = colKey(feature.key, bucketLabel(feature, feature.get(rows[i]!)))
      let col = columns.get(key)
      if (col === undefined) {
        col = columns.size
        columns.set(key, col)
      }
      X[i * stride + f] = col
    }
  }
  return { X, stride, columns }
}

export interface DroppedFeature {
  key: string
  bucket: string
  share: number
  runner_up: { bucket: string; n: number } | null
}

/**
 * Drop features that carry no information in this dataset, and say which.
 *
 * A feature whose modal bucket covers essentially every row (an always-null
 * signal, a constant) contributes a fixed offset the intercept already
 * absorbs. Keeping it costs a column, a weight, and a line of UI that claims
 * evidence where there is none. If the signal's source is wired up later the
 * feature returns on the next fit with no code change.
 */
export function pruneDegenerate(
  rows: readonly TrainingRow[],
  features: readonly FeatureDef[] = FEATURES,
  minMinorityRows = MIN_MINORITY_ROWS,
): { features: FeatureDef[]; dropped: DroppedFeature[] } {
  const kept: FeatureDef[] = []
  const dropped: DroppedFeature[] = []
  for (const feature of features) {
    const counts = new Map<string, number>()
    for (const row of rows) {
      const label = bucketLabel(feature, feature.get(row))
      counts.set(label, (counts.get(label) ?? 0) + 1)
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1])
    const top = ranked[0] ?? ['null', rows.length]
    const runnerUp = ranked[1] ?? null
    if (!runnerUp || runnerUp[1] < minMinorityRows) {
      dropped.push({
        key: feature.key,
        bucket: top[0],
        share: Number((rows.length ? top[1] / rows.length : 1).toFixed(4)),
        runner_up: runnerUp ? { bucket: runnerUp[0], n: runnerUp[1] } : null,
      })
    } else {
      kept.push(feature)
    }
  }
  return { features: kept, dropped }
}

export interface LogisticModel {
  intercept: number
  w: Float64Array
  epochs: number
}

/**
 * Logistic regression by SGD over a one-hot design matrix.
 *
 * Deterministic: the shuffle runs off a seeded LCG, so the same rows always
 * produce the same weights and a promotion decision is reproducible. Honours a
 * wall-clock deadline by stopping between epochs, because a job killed mid-fit
 * produces nothing at all, while one that stops a few epochs short produces a
 * candidate the gate can still judge on its merits.
 */
export function fitLogistic(
  X: Int32Array,
  stride: number,
  y: Float64Array,
  nCols: number,
  { epochs = 24, lr = 0.05, l2 = 1e-4, seed = 42, deadlineAt = Infinity, rowCount = null as number | null } = {},
): LogisticModel {
  const n = rowCount ?? y.length
  let pos = 0
  for (let i = 0; i < n; i++) pos += y[i]!
  let intercept = Math.log((pos + 1) / (n - pos + 1))
  const w = new Float64Array(nCols)
  const idx = new Int32Array(n)
  for (let i = 0; i < n; i++) idx[i] = i

  let state = seed >>> 0
  const rand = () => ((state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff)

  let done = 0
  for (let e = 0; e < epochs; e++) {
    if (Date.now() > deadlineAt) break
    for (let i = n - 1; i > 0; i--) {
      const j = (rand() * (i + 1)) | 0
      const t = idx[i]!
      idx[i] = idx[j]!
      idx[j] = t
    }
    const step = lr / (1 + e * 0.15)
    for (let k = 0; k < n; k++) {
      const r = idx[k]!
      const row = r * stride
      let z = intercept
      for (let f = 0; f < stride; f++) z += w[X[row + f]!]!
      const err = y[r]! - 1 / (1 + Math.exp(-z))
      intercept += step * err
      for (let f = 0; f < stride; f++) {
        const c = X[row + f]!
        w[c] = w[c]! + step * (err - l2 * w[c]!)
      }
    }
    done = e + 1
  }
  return { intercept, w, epochs: done }
}

/** How many rows landed in each one-hot column, on the exact slice a model was fitted on. */
export function columnCounts(X: Int32Array, stride: number, nCols: number, rowCount?: number): Int32Array {
  const counts = new Int32Array(nCols)
  const end = (rowCount ?? X.length / stride) * stride
  for (let i = 0; i < end; i++) counts[X[i]!] = counts[X[i]!]! + 1
  return counts
}

/**
 * Pull thinly-evidenced weights toward zero, in proportion to their sample
 * size: the standard empirical-Bayes `n / (n + prior)`. Without this a bucket
 * holding a handful of launches can emit a large log-odds opinion that
 * survives into production and reverses the verdict on a launch. Applied
 * before evaluation, never after, so the holdout numbers describe the weights
 * that actually ship.
 */
export function shrinkWeights(model: LogisticModel, counts: Int32Array, prior = SHRINK_PRIOR): LogisticModel {
  const w = new Float64Array(model.w.length)
  for (let c = 0; c < w.length; c++) {
    const n = counts[c] ?? 0
    w[c] = model.w[c]! * (n / (n + prior))
  }
  return { ...model, w }
}

/** Predicted probability for one row of the flat design matrix. */
export function predictRow(model: LogisticModel, X: Int32Array, stride: number, i: number): number {
  let z = model.intercept
  const row = i * stride
  for (let f = 0; f < stride; f++) z += model.w[X[row + f]!]!
  return 1 / (1 + Math.exp(-z))
}

/** Area under the ROC curve, tie-corrected (Mann-Whitney U). */
export function auc(scores: readonly number[], labels: readonly number[]): number {
  const order = [...scores.keys()].sort((a, b) => scores[a]! - scores[b]!)
  let sumPosRanks = 0
  let nPos = 0
  let nNeg = 0
  for (let i = 0; i < order.length;) {
    let j = i
    while (j < order.length && scores[order[j]!] === scores[order[i]!]) j++
    const avgRank = (i + j + 1) / 2
    for (let k = i; k < j; k++) {
      if (labels[order[k]!] === 1) {
        sumPosRanks += avgRank
        nPos++
      } else nNeg++
    }
    i = j
  }
  if (!nPos || !nNeg) return 0.5
  return (sumPosRanks - (nPos * (nPos + 1)) / 2) / (nPos * nNeg)
}

/** Positive rate among the top `frac` of rows by predicted probability. */
export function precisionAt(scores: readonly number[], labels: readonly number[], frac: number): { n: number; rate: number } {
  const order = [...scores.keys()].sort((a, b) => scores[b]! - scores[a]!)
  const n = Math.max(1, Math.round(order.length * frac))
  let good = 0
  for (let i = 0; i < n; i++) good += labels[order[i]!]!
  return { n, rate: good / n }
}

/** Mean squared error of the probability against the outcome. Lower is better. */
export function brier(scores: readonly number[], labels: readonly number[]): number {
  let sum = 0
  for (let i = 0; i < scores.length; i++) sum += (scores[i]! - labels[i]!) ** 2
  return scores.length ? sum / scores.length : 0
}

/** The probability bands the tier anchors carve out, for reliability tables. */
export const RELIABILITY_EDGES: readonly number[] = Object.freeze([
  TIER_PROBABILITY_ANCHORS.avoid, TIER_PROBABILITY_ANCHORS.watch, TIER_PROBABILITY_ANCHORS.lean,
  TIER_PROBABILITY_ANCHORS.strong, TIER_PROBABILITY_ANCHORS.prime, 1.0001,
])

/**
 * Observed rate per predicted-probability band: does a claim of 45% happen 45%
 * of the time? This is the table the promotion gate reads. An empty band
 * reports 0 for both rates with n = 0; readers key on n.
 */
export function reliability(
  scores: readonly number[],
  labels: readonly number[],
  edges: readonly number[] = RELIABILITY_EDGES,
): HoldoutMetrics['reliability'] {
  const out: HoldoutMetrics['reliability'] = []
  for (let i = 0; i + 1 < edges.length; i++) {
    let n = 0
    let good = 0
    let sumP = 0
    for (let k = 0; k < scores.length; k++) {
      if (scores[k]! >= edges[i]! && scores[k]! < edges[i + 1]!) {
        n++
        good += labels[k]!
        sumP += scores[k]!
      }
    }
    out.push({
      lo: edges[i]!,
      hi: Math.min(1, edges[i + 1]!),
      n,
      observed: n ? Number((good / n).toFixed(4)) : 0,
      predicted: n ? Number((sumP / n).toFixed(4)) : 0,
    })
  }
  return out
}

export interface PrecisionBand { n: number; rate: number; lift: number }

/** The per-head holdout report, a superset of the contract's HoldoutMetrics. */
export interface HoldoutReport extends HoldoutMetrics {
  n: number
  base_rate: number
  precision: Record<'top1' | 'top5' | 'top10' | 'top25', PrecisionBand>
}

function evaluate(scores: number[], labels: number[], base: number): HoldoutReport {
  const at = (frac: number): PrecisionBand => {
    const p = precisionAt(scores, labels, frac)
    return { n: p.n, rate: Number(p.rate.toFixed(4)), lift: Number((p.rate / (base || 1)).toFixed(2)) }
  }
  const precision = { top1: at(0.01), top5: at(0.05), top10: at(0.1), top25: at(0.25) }
  return {
    n: scores.length,
    auc: Number(auc(scores, labels).toFixed(4)),
    brier: Number(brier(scores, labels).toFixed(5)),
    base_rate: Number(base.toFixed(4)),
    precision_at_5: precision.top5.rate,
    precision,
    reliability: reliability(scores, labels),
  }
}

export interface FittedBucket {
  n: number
  w: Record<Head, number>
  rate: Record<Head, number>
}

export interface FittedFeature extends OracleModelFeature {
  buckets: Record<string, FittedBucket>
}

export interface FitReport {
  epochs: number
  epochs_run: number
  complete: boolean
  shrink_prior: number
  columns: number
  features: number
  holdout_n: number
  split_at: number
}

/** The document buildModel produces: the contract's shape plus its own audit trail. */
export interface FittedModel extends OracleModelDocument {
  features: FittedFeature[]
  holdout: Record<Head, HoldoutReport>
  dropped_features: DroppedFeature[]
  fit: FitReport
}

export interface BuildReport {
  rows: number
  base_rates: Record<Head, number>
  dropped: DroppedFeature[]
  holdout: Record<Head, HoldoutReport>
  complete: boolean
}

export interface BuildOptions {
  /** ISO timestamp to stamp on the model. */
  fittedAt?: string
  /** Share of the newest rows held out for evaluation. */
  holdoutFrac?: number
  /** SGD passes per head. */
  epochs?: number
  /** Epoch-millis wall clock to stop fitting by. */
  deadlineAt?: number
  provenance?: string
  shrinkPrior?: number
  minMinorityRows?: number
  features?: readonly FeatureDef[]
}

/**
 * Fit a full three-head conviction model from labeled rows.
 *
 * Rows MUST arrive oldest-first: the holdout is the newest slice, so the
 * evaluation answers "would this model have worked on launches it had never
 * seen", which is the only question worth asking about a model that runs on a
 * live feed.
 */
export function buildModel(rows: readonly FitRow[], opts: BuildOptions = {}): { model: FittedModel; report: BuildReport } {
  const {
    fittedAt = new Date().toISOString(),
    holdoutFrac = 0.25,
    epochs = 24,
    deadlineAt = Infinity,
    provenance = `refit: ${rows.length} labeled launches, fitted ${fittedAt}`,
    shrinkPrior = SHRINK_PRIOR,
    minMinorityRows = MIN_MINORITY_ROWS,
    features: candidateFeatures = FEATURES,
  } = opts

  if (rows.length < MIN_TRAINING_ROWS) {
    throw new Error(`need at least ${MIN_TRAINING_ROWS} labeled rows to fit, got ${rows.length}`)
  }

  const { features, dropped } = pruneDegenerate(rows, candidateFeatures, minMinorityRows)
  if (!features.length) throw new Error('every feature is degenerate on this dataset; nothing to fit')

  const { X, stride, columns } = encode(rows, features)
  const holdoutN = Math.max(MIN_HOLDOUT_ROWS, Math.floor(rows.length * holdoutFrac))
  const cut = rows.length - holdoutN

  const ys = {} as Record<Head, Float64Array>
  const baseRates = {} as Record<Head, number>
  for (const head of HEADS) {
    const y = new Float64Array(rows.length)
    let pos = 0
    for (let i = 0; i < rows.length; i++) {
      y[i] = TARGETS[head](rows[i]!)
      pos += y[i]!
    }
    ys[head] = y
    baseRates[head] = pos / rows.length
  }

  // Per head: fit on the older slice to earn an honest holdout number, then
  // refit on everything for the weights that actually ship. The holdout model
  // is thrown away; wasting the newest quarter of the data in production would
  // be paying for the evaluation twice.
  const holdout = {} as Record<Head, HoldoutReport>
  const heads = {} as Record<Head, { intercept: number; base_rate: number; w: Float64Array }>
  let epochsRun = 0
  const trainCounts = columnCounts(X, stride, columns.size, cut)
  const allCounts = columnCounts(X, stride, columns.size, rows.length)

  for (const head of HEADS) {
    const trained = shrinkWeights(
      fitLogistic(X, stride, ys[head], columns.size, { epochs, deadlineAt, rowCount: cut }),
      trainCounts,
      shrinkPrior,
    )
    const scores = new Array<number>(holdoutN)
    const labels = new Array<number>(holdoutN)
    let holdoutPos = 0
    for (let i = 0; i < holdoutN; i++) {
      scores[i] = predictRow(trained, X, stride, cut + i)
      labels[i] = ys[head][cut + i]!
      holdoutPos += labels[i]!
    }
    holdout[head] = evaluate(scores, labels, holdoutPos / Math.max(1, holdoutN))

    const full = shrinkWeights(fitLogistic(X, stride, ys[head], columns.size, { epochs, deadlineAt }), allCounts, shrinkPrior)
    epochsRun = Math.max(epochsRun, full.epochs)
    heads[head] = {
      intercept: Number(full.intercept.toFixed(4)),
      base_rate: Number(baseRates[head].toFixed(4)),
      w: full.w,
    }
  }

  // Emit per-feature, per-bucket weights with their provenance: sample size and
  // the observed rate of all three outcomes. Anyone can read why a launch
  // scored what it scored, and check the claim against the count behind it.
  const bucketCounts = new Map<number, { n: number; win: number; rug: number; moon: number }>()
  for (let i = 0; i < rows.length; i++) {
    for (let f = 0; f < stride; f++) {
      const col = X[i * stride + f]!
      let agg = bucketCounts.get(col)
      if (!agg) {
        agg = { n: 0, win: 0, rug: 0, moon: 0 }
        bucketCounts.set(col, agg)
      }
      agg.n++
      for (const head of HEADS) agg[head] += ys[head][i]!
    }
  }

  const modelFeatures: FittedFeature[] = features.map((feature) => {
    const buckets: Record<string, FittedBucket> = {}
    for (const [key, col] of columns) {
      const sep = key.indexOf(' ')
      if (key.slice(0, sep) !== feature.key) continue
      const agg = bucketCounts.get(col) ?? { n: 0, win: 0, rug: 0, moon: 0 }
      buckets[key.slice(sep + 1)] = {
        n: agg.n,
        w: { win: Number(heads.win.w[col]!.toFixed(4)), rug: Number(heads.rug.w[col]!.toFixed(4)), moon: Number(heads.moon.w[col]!.toFixed(4)) },
        rate: {
          win: Number((agg.win / Math.max(1, agg.n)).toFixed(4)),
          rug: Number((agg.rug / Math.max(1, agg.n)).toFixed(4)),
          moon: Number((agg.moon / Math.max(1, agg.n)).toFixed(4)),
        },
      }
    }
    return { key: feature.key, pillar: feature.pillar, categorical: feature.categorical, edges: feature.edges, buckets }
  })

  const model: FittedModel = {
    version: 3,
    fitted_at: fittedAt,
    training_rows: rows.length,
    score_head: SCORE_HEAD,
    heads: {
      win: { intercept: heads.win.intercept, base_rate: heads.win.base_rate },
      rug: { intercept: heads.rug.intercept, base_rate: heads.rug.base_rate },
      moon: { intercept: heads.moon.intercept, base_rate: heads.moon.base_rate },
    },
    tier_probability_anchors: { ...TIER_PROBABILITY_ANCHORS },
    features: modelFeatures,
    holdout,
    provenance,
    dropped_features: dropped,
    fit: {
      epochs,
      epochs_run: epochsRun,
      complete: epochsRun >= epochs,
      shrink_prior: shrinkPrior,
      columns: columns.size,
      features: features.length,
      holdout_n: holdoutN,
      split_at: cut,
    },
  }

  return {
    model,
    report: {
      rows: rows.length,
      base_rates: { win: Number(baseRates.win.toFixed(4)), rug: Number(baseRates.rug.toFixed(4)), moon: Number(baseRates.moon.toFixed(4)) },
      dropped,
      holdout,
      complete: model.fit.complete,
    },
  }
}
