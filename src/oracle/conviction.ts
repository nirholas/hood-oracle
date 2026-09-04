/**
 * Oracle: the fused conviction engine (three heads, learned continuously).
 *
 * Ported from three.ws's v3 engine. The maths and the reasoning are kept; the
 * Solana-specific inputs (proven-wallet labels, Helius funder graphs, pump.fun
 * curve constants) are gone, and the engine reads the EVM-native
 * {@link FeatureSnapshot} instead.
 *
 * Three heads over one design matrix:
 *
 *   win  = it ran (2x from first sight) AND a first-sight holder is still up
 *   rug  = a first-sight holder is down more than half
 *   moon = it ran at all, whatever happened next
 *
 * The published 0-100 score anchors on `win`. Rug risk is published beside it
 * as its own number rather than folded in, because "this will probably run"
 * and "this will probably take your money" are different questions and a
 * single number that averages them tells you neither.
 *
 * This module is PURE: a model document in, an engine out; a snapshot in, a
 * verdict out. No I/O, and the clock is an injectable option. The model store
 * (./model-store.ts) owns the swap; this file stays a function of its inputs,
 * which is what makes a promotion decision reproducible.
 */
import type {
  FeatureSnapshot, Head, OracleHit, OracleModelDocument, OracleModelFeature, OracleTier, OracleVerdict, Pillar,
} from '../types.js'
import { bucketLabel, bucketLabels, featureByKey, numOrNull, type TrainingRow } from './features.js'

// Tier thresholds on the final 0-100 score. The ladder is a public contract;
// what moves across refits is the probability each rung claims, never the
// number printed on the pill.
export const TIERS: readonly { min: number; tier: OracleTier }[] = Object.freeze([
  { min: 86, tier: 'prime' },
  { min: 72, tier: 'strong' },
  { min: 56, tier: 'lean' },
  { min: 34, tier: 'watch' },
  { min: 0, tier: 'avoid' },
])

export const HEADS: readonly Head[] = Object.freeze(['win', 'rug', 'moon'])
export const PILLARS: readonly Pillar[] = Object.freeze(['structure', 'momentum', 'pedigree', 'narrative'])

/**
 * Public tier boundaries, expressed as the P(win) each one claims. Absolute
 * probabilities, not lifts, so a score keeps its meaning as the market moves:
 * "Prime" is a claim that at least 45% of launches scored that way go on to
 * run without rugging, and it is checkable. Held fixed across refits; the
 * promotion gate refuses a candidate whose bands no longer clear their claim.
 */
export const TIER_PROBABILITY_ANCHORS: Readonly<Record<OracleTier, number>> = Object.freeze({
  avoid: 0, watch: 0.05, lean: 0.12, strong: 0.25, prime: 0.45,
})

/** Who launched it, as the scorer can know it beyond the snapshot itself. */
export interface Pedigree {
  creatorLaunches: number | null
  creatorWins: number | null
}

/** A fitted bucket. `rate` is the observed outcome rate behind the weight; older documents may omit it. */
export interface ModelBucket {
  n: number
  w: Record<Head, number>
  rate?: Record<Head, number>
}

export interface EvaluatedHit extends OracleHit {
  stats: ModelBucket | null
}

export interface Evaluation {
  /** Log-odds under the score head, before any overlay. */
  z: number
  /** P(score head) before any overlay. */
  p: number
  heads: Record<Head, number>
  headZ: Record<Head, number>
  pillarZ: Record<Pillar, number>
  hits: EvaluatedHit[]
}

/** Everything in an {@link OracleVerdict}, plus the card-level extras the port carries. */
export interface ConvictionDetail extends OracleVerdict {
  /** 0..100: P(moon) as a percentage. */
  upside: number
  /** 0..100: given it runs, how often a launch like this hands the run back. Null when P(moon) is 0. */
  giveBackRisk: number | null
  /** The pedigree ceiling applied to the score (100 = none). */
  pedigreeCap: number
  badges: string[]
  /** Which expert priors stood down because the model fits the same evidence. */
  suppressed: string[]
}

export interface ConvictionEngine {
  readonly model: OracleModelDocument
  /** Stable identity of the model, `v<version>-<fitted_at>`; stored on every score row. */
  readonly version: string
  readonly pillarWeights: Readonly<Record<Pillar, number>>
  scoreFromProbability(p: number): number
  probabilityFromScore(score: number): number
  evaluate(snapshot: FeatureSnapshot, pedigree?: Pedigree | null): Evaluation
  convict(snapshot: FeatureSnapshot, pedigree?: Pedigree | null, opts?: { now?: Date }): ConvictionDetail
  /** The measured hit rate behind a score, from the model's own holdout reliability curve. */
  hitRateFor(score: number): { rate: number | null; lift: number | null; band: string | null; n: number; baseRate: number | null }
}

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n))
const num = (v: unknown, d = 0): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z))
const logit = (p: number) => Math.log(p / (1 - p))

/** The public tier for a 0-100 conviction score. Single source of the ladder. */
export function tierForScore(score: number): OracleTier {
  const s = clamp(num(score))
  return (TIERS.find((t) => s >= t.min) ?? TIERS[TIERS.length - 1]!).tier
}

/** Stable identity string for a model document. */
export const modelVersionLabel = (model: Pick<OracleModelDocument, 'version' | 'fitted_at'>): string =>
  `v${model.version}-${model.fitted_at}`

/**
 * Validate a raw document (a JSON file, a database row) into an
 * {@link OracleModelDocument}. Throws on a malformed one so the caller keeps
 * the model it already has: a scoring engine that accepts a bad model produces
 * silently wrong numbers, which is worse than a loud refusal.
 */
export function normalizeModel(raw: unknown): OracleModelDocument {
  if (!raw || typeof raw !== 'object') throw new Error('conviction: model must be an object')
  const m = raw as Record<string, unknown>
  const version = Number(m.version)
  if (!Number.isFinite(version) || version < 3) throw new Error(`conviction: unsupported model version ${String(m.version)}`)
  if (!Array.isArray(m.features) || !m.features.length) throw new Error('conviction: model has no features')
  const scoreHead = (m.score_head as Head | undefined) ?? 'win'
  const heads = m.heads as Record<string, { intercept: number; base_rate: number }> | undefined
  if (!heads || !heads[scoreHead]) throw new Error('conviction: model is missing its score head')
  for (const h of HEADS) {
    if (!heads[h] || !Number.isFinite(Number(heads[h]!.intercept))) throw new Error(`conviction: head ${h} has no intercept`)
  }
  const features = (m.features as unknown[]).map((f, i) => {
    const feature = f as Partial<OracleModelFeature>
    if (!feature.key || !feature.pillar) throw new Error(`conviction: feature ${i} has no key or pillar`)
    if (!feature.buckets || typeof feature.buckets !== 'object') throw new Error(`conviction: feature ${feature.key} has no buckets`)
    return {
      key: feature.key,
      pillar: feature.pillar,
      categorical: !!feature.categorical,
      edges: Array.isArray(feature.edges) ? feature.edges.map(Number) : [],
      buckets: feature.buckets,
    }
  })
  const anchorsRaw = (m.tier_probability_anchors as Partial<Record<OracleTier, number>> | undefined) ?? {}
  const anchors: Record<OracleTier, number> = {
    avoid: num(anchorsRaw.avoid, TIER_PROBABILITY_ANCHORS.avoid),
    watch: num(anchorsRaw.watch, TIER_PROBABILITY_ANCHORS.watch),
    lean: num(anchorsRaw.lean, TIER_PROBABILITY_ANCHORS.lean),
    strong: num(anchorsRaw.strong, TIER_PROBABILITY_ANCHORS.strong),
    prime: num(anchorsRaw.prime, TIER_PROBABILITY_ANCHORS.prime),
  }
  return {
    version,
    fitted_at: String(m.fitted_at ?? ''),
    training_rows: Number(m.training_rows) || 0,
    score_head: scoreHead,
    heads: {
      win: { intercept: Number(heads.win!.intercept), base_rate: Number(heads.win!.base_rate) || 0 },
      rug: { intercept: Number(heads.rug!.intercept), base_rate: Number(heads.rug!.base_rate) || 0 },
      moon: { intercept: Number(heads.moon!.intercept), base_rate: Number(heads.moon!.base_rate) || 0 },
    },
    tier_probability_anchors: anchors,
    features,
    holdout: (m.holdout as OracleModelDocument['holdout']) ?? null,
    provenance: String(m.provenance ?? ''),
  }
}

function derivePillarWeights(model: OracleModelDocument): Record<Pillar, number> {
  const head = model.score_head
  const span: Record<Pillar, number> = { structure: 0, momentum: 0, pedigree: 0, narrative: 0 }
  for (const f of model.features) {
    const ws = Object.values(f.buckets).map((b) => num(b.w?.[head]))
    if (!ws.length) continue
    span[f.pillar] += Math.max(...ws) - Math.min(...ws)
  }
  const total = Object.values(span).reduce((a, b) => a + b, 0) || 1
  const out = { ...span }
  for (const k of PILLARS) out[k] = Number((span[k] / total).toFixed(2))
  return out
}

function deriveAnchors(model: OracleModelDocument): [number, number][] {
  const a = model.tier_probability_anchors
  return [[0, 0], [a.watch, 34], [a.lean, 56], [a.strong, 72], [a.prime, 86], [1, 100]]
}

/** Build the training-row view of a snapshot, so the scorer bucket-reads exactly as the fitter did. */
export function rowFromSnapshot(snapshot: FeatureSnapshot, pedigree?: Pedigree | null): TrainingRow {
  const f = snapshot.features
  return {
    features: { ...f },
    creator_launches: pedigree?.creatorLaunches ?? f.creator_launches ?? null,
    creator_wins: pedigree?.creatorWins ?? f.creator_wins ?? null,
    category: f.category ?? null,
  }
}

// ── Plain-language reasons ────────────────────────────────────────────────────
// Each reason reads as a fact about the launch, in the units a trader already
// thinks in, and quotes the observed rate from the model itself: the engine
// cites its own training data instead of asserting vibes.

const FEATURE_TEXT: Record<string, string> = {
  organic_score: 'organic demand',
  bundle_score: 'launch coordination',
  snipe_ratio: 'open sniped',
  coordination_score: 'buy coordination',
  timing_entropy: 'buy-timing spread',
  concentration_top1: 'top-holder share',
  concentration_top5: 'top-5 holder share',
  concentration_top10: 'top-10 holder share',
  fresh_wallet_ratio: 'fresh-wallet share',
  bubblemap_connectivity: 'funder clustering',
  unique_buyers: 'unique early buyers',
  unique_sellers: 'unique early sellers',
  buy_sell_ratio: 'buy/sell pressure',
  buy_volume_eth: 'early buy volume (ETH)',
  sell_volume_eth: 'early sell volume (ETH)',
  net_volume_eth: 'net early flow (ETH)',
  trade_count: 'trades in the window',
  largest_buy_eth: 'largest single buy (ETH)',
  avg_buy_eth: 'average buy size (ETH)',
  median_buy_eth: 'median buy size (ETH)',
  mc_eth_first_seen: 'market cap at first sight (ETH)',
  dev_buy_eth: 'dev buy size (ETH)',
  dev_sell_eth: 'dev sell size (ETH)',
  dev_sold: 'dev selling in the window',
  smart_money_count: 'proven wallets in the book',
  deployer_holding_pct: 'deployer supply share',
  creator_record: 'creator launch history',
  category: 'narrative category',
  narrative_confidence: 'narrative read confidence',
}

const CREATOR_TEXT: Record<string, string> = {
  has_wins: 'creator has shipped a winning launch before',
  serial_no_wins: 'creator has 5+ prior launches, none won',
  repeat_no_wins: 'creator relaunches without a single win',
  first_launch: 'first launch from this creator',
  unknown: 'creator history unknown',
}

const PHRASE: Record<string, Record<string, string>> = {
  organic_score: {
    '<0.2': 'almost no organic demand', '0.2-0.4': 'weak organic demand',
    '0.4-0.6': 'middling organic demand', '0.6-0.8': 'solid organic demand', '>=0.8': 'strong organic demand',
  },
  bundle_score: {
    '<0.1': 'no sign of a bundled launch', '0.1-0.3': 'faint bundling', '0.3-0.5': 'partly bundled', '>=0.5': 'heavily bundled',
  },
  snipe_ratio: {
    '<0.1': 'barely sniped at open', '0.1-0.3': 'lightly sniped at open',
    '0.3-0.7': 'heavily sniped at open', '>=0.7': 'almost entirely sniped at open',
  },
  coordination_score: {
    '<0.1': 'buyers acting independently', '0.1-0.3': 'some coordinated buying', '>=0.3': 'coordinated buying',
  },
  timing_entropy: {
    '<0.2': 'buys landing in one burst', '0.2-0.4': 'buys clustered in time', '0.4-0.6': 'buys moderately spread out',
    '0.6-0.8': 'buys well spread in time', '>=0.8': 'buys evenly spread in time',
  },
  concentration_top1: {
    '<0.05': 'no holder above 5%', '0.05-0.15': 'top holder at 5-15%', '0.15-0.3': 'top holder at 15-30%', '>=0.3': 'top holder above 30%',
  },
  concentration_top5: {
    '<0.3': 'top 5 under 30% of supply', '0.3-0.6': 'top 5 holding 30-60%', '0.6-0.9': 'top 5 holding 60-90%', '>=0.9': 'top 5 holding over 90%',
  },
  concentration_top10: {
    '<0.3': 'top 10 under 30% of supply', '0.3-0.9': 'top 10 holding 30-90%', '>=0.9': 'top 10 holding over 90%',
  },
  fresh_wallet_ratio: {
    '<0.2': 'mostly seasoned wallets buying', '0.2-0.5': 'some fresh wallets buying',
    '0.5-0.8': 'mostly fresh wallets buying', '>=0.8': 'almost every buyer is a fresh wallet',
  },
  bubblemap_connectivity: {
    '<0.1': 'buyers funded independently', '0.1-0.3': 'a few buyers share a funder',
    '0.3-0.6': 'many buyers share a funder', '>=0.6': 'buyers largely funded from one source',
  },
  unique_buyers: {
    '<1': 'no buyers yet', '1-5': 'under 5 early buyers', '5-15': '5-15 early buyers', '15-40': '15-40 early buyers', '>=40': '40+ early buyers',
  },
  unique_sellers: {
    '<1': 'nobody has sold yet', '1-3': '1-3 sellers already out', '3-10': '3-10 sellers already out', '>=10': '10+ sellers already out',
  },
  buy_sell_ratio: {
    '<0.5': 'more sellers than buyers', '0.5-1': 'sells keeping pace with buys', '1-2': 'buys leading sells',
    '2-4': 'buys 2-4x the sells', '>=4': 'buys 4x+ the sells', null: 'nobody has sold yet',
  },
  trade_count: {
    '<3': 'under 3 trades in the window', '3-12': '3-12 trades in the window', '12-40': '12-40 trades in the window', '>=40': '40+ trades in the window',
  },
  smart_money_count: {
    '<1': 'no proven wallet in the book', '1-2': 'one proven wallet already in',
    '2-4': '2-3 proven wallets already in', '>=4': '4+ proven wallets already in',
  },
  dev_sold: { '<0.5': 'dev held through the window', '>=0.5': 'dev sold inside the window' },
  deployer_holding_pct: {
    '<0.02': 'deployer holds under 2% of supply', '0.02-0.1': 'deployer holds 2-10% of supply',
    '0.1-0.3': 'deployer holds 10-30% of supply', '>=0.3': 'deployer still holds over 30% of supply',
  },
  narrative_confidence: {
    '<0.3': 'narrative barely readable', '0.3-0.6': 'narrative read with modest confidence',
    '0.6-0.85': 'narrative read confidently', '>=0.85': 'narrative unmistakable',
  },
}

/** "<0.021" becomes "under 0.021 ETH", "0.021-0.335" becomes "0.021-0.335 ETH", ">=1.05" becomes "1.05+ ETH". */
function ethBand(label: string): string {
  if (label.startsWith('<')) return `under ${label.slice(1)} ETH`
  if (label.startsWith('>=')) return `${label.slice(2)}+ ETH`
  return `${label} ETH`
}

const ETH_PHRASE: Record<string, (label: string) => string> = {
  buy_volume_eth: (l) => `${ethBand(l)} bought early`,
  sell_volume_eth: (l) => (l.startsWith('<') ? 'almost nothing sold back' : `${ethBand(l)} sold back`),
  net_volume_eth: (l) => (l === '<0' ? 'more ETH left than arrived' : `${ethBand(l)} of net inflow`),
  largest_buy_eth: (l) => `biggest single buy ${ethBand(l)}`,
  avg_buy_eth: (l) => `average buy ${ethBand(l)}`,
  median_buy_eth: (l) => `median buy ${ethBand(l)}`,
  mc_eth_first_seen: (l) => `spotted at a ${ethBand(l)} market cap`,
  dev_buy_eth: (l) => (l.startsWith('<') ? 'dev barely bought their own launch' : `dev bought ${ethBand(l)} of their own launch`),
  dev_sell_eth: (l) => (l.startsWith('<') ? 'dev has not sold a wei' : `dev sold ${ethBand(l)}`),
}

// Features whose reason reads as a fact about the launch rather than a
// measurement of it, so the sentence says "such launches" instead of "similar".
const SUCH = new Set(['creator_record', 'category', 'dev_sold', 'smart_money_count'])

/** The subject half of a reason: what the model saw, with no outcome statistics attached. */
export function reasonSubject(key: string, label: string): string {
  if (key === 'creator_record') return CREATOR_TEXT[label] ?? label
  if (key === 'category') return `${label} narrative`
  const phrased = PHRASE[key]?.[label]
  if (phrased) return phrased
  const ethPhrase = ETH_PHRASE[key]
  if (ethPhrase && label !== 'null') return ethPhrase(label)
  return `${FEATURE_TEXT[key] ?? key} ${label}`
}

function reasonText(model: OracleModelDocument, key: string, label: string, stats: ModelBucket, w: number): string {
  const head = model.score_head
  const subject = reasonSubject(key, label)
  const observed = stats.rate ? numOrNull(stats.rate[head]) : null
  if (observed == null) {
    return `${subject}: ${w >= 0 ? 'lifts' : 'cuts'} the odds (${w >= 0 ? '+' : ''}${w.toFixed(2)} log-odds, n=${stats.n})`
  }
  const base = model.heads[head]?.base_rate || 0
  const rate = Math.round(observed * 100)
  const rel = base > 0 ? observed / base : 0
  const vs = rel >= 1.15 || rel <= 0.85 ? `${rel.toFixed(1)}x base rate` : 'near base rate'
  const kind = SUCH.has(key) ? 'such' : 'similar'
  return `${subject}: ${rate}% of ${kind} launches worked (${vs})`
}

// ── Expert priors, for the evidence the model cannot fit ─────────────────────
// Everything the active model fits is left to the model. What survives here is
// the serial-rugger ceiling (a product guarantee, not a probability estimate)
// and a smart-money nudge that only applies while no model fits that column.
// Magnitudes are log-odds and stay conservative: 0.7 is roughly a 2x odds move.

interface Overlay {
  z: number
  cap: number
  reasons: string[]
  suppressed: string[]
}

export function pedigreeOverlay(row: TrainingRow, isFitted: (key: string) => boolean): Overlay {
  const reasons: string[] = []
  const suppressed: string[] = []
  let z = 0
  let cap = 100

  // Presence of smart money is a fitted feature once a model carries it. Adding
  // a hand-picked bonus on top would count the same wallets twice, which is how
  // a 0.35 prior turns into a systematically inflated score.
  const smart = numOrNull(row.features.smart_money_count) ?? 0
  if (isFitted('smart_money_count')) {
    if (smart >= 1) suppressed.push('smart_money_count')
  } else if (smart >= 5) {
    z += 0.75
    reasons.push(`${smart} smart-money wallets already in`)
  } else if (smart >= 3) {
    z += 0.55
    reasons.push(`${smart} smart-money wallets in`)
  } else if (smart >= 1) {
    z += 0.35
    reasons.push(`${smart} smart-money wallet in`)
  }

  // The one hard cap. `creator_record` is a fitted feature, so the log-odds
  // nudge stands down when the model carries it, but the CEILING stays either
  // way: a dev with a graveyard behind them can never present as Strong,
  // whatever the tape says.
  const launches = numOrNull(row.creator_launches)
  const wins = numOrNull(row.creator_wins) ?? 0
  if (launches != null && launches >= 3 && wins === 0) {
    cap = 45
    if (isFitted('creator_record')) suppressed.push('creator_record')
    else z -= 1.2
    reasons.push(`creator has ${launches} prior launches, none won: rug pattern`)
  }

  return { z, cap, reasons, suppressed }
}

// ── The engine ────────────────────────────────────────────────────────────────

export function createConviction(model: OracleModelDocument): ConvictionEngine {
  const anchors = deriveAnchors(model)
  const pillarWeights = Object.freeze(derivePillarWeights(model))
  const fitted = new Set(model.features.map((f) => f.key))
  const isFitted = (key: string) => fitted.has(key)
  const head = model.score_head
  const version = modelVersionLabel(model)

  /** Map a probability to the 0-100 score line through the tier anchors. */
  const scoreFromProbability = (p: number): number => {
    const x = Math.max(0, Math.min(1, num(p)))
    for (let i = 1; i < anchors.length; i++) {
      const [p0, s0] = anchors[i - 1]!
      const [p1, s1] = anchors[i]!
      if (x <= p1) return clamp(Math.round(s0 + ((x - p0) / (p1 - p0)) * (s1 - s0)))
    }
    return 100
  }

  /**
   * Inverse of scoreFromProbability: the probability a score actually claims.
   * The score line is not a percentage (86 claims 45%, not 86%), so any surface
   * comparing a score to a realized rate has to convert first.
   */
  const probabilityFromScore = (score: number): number => {
    const s = clamp(num(score))
    for (let i = 1; i < anchors.length; i++) {
      const [p0, s0] = anchors[i - 1]!
      const [p1, s1] = anchors[i]!
      if (s <= s1) return s1 === s0 ? p1 : p0 + ((s - s0) / (s1 - s0)) * (p1 - p0)
    }
    return 1
  }

  const evaluate = (snapshot: FeatureSnapshot, pedigree?: Pedigree | null): Evaluation => {
    const row = rowFromSnapshot(snapshot, pedigree)
    const z: Record<Head, number> = { win: 0, rug: 0, moon: 0 }
    for (const h of HEADS) z[h] = num(model.heads[h]?.intercept)
    const pillarZ: Record<Pillar, number> = { structure: 0, momentum: 0, pedigree: 0, narrative: 0 }
    const hits: EvaluatedHit[] = []

    for (const feature of model.features) {
      const def = featureByKey(feature.key)
      const value = def ? def.get(row) : null
      const bucket = bucketLabel(feature, value)
      const stats = (feature.buckets as Record<string, ModelBucket>)[bucket]
      if (!stats) {
        // A bucket never seen in training (a category the classifier invented
        // this week) contributes nothing rather than inventing a weight for it.
        hits.push({ key: feature.key, pillar: feature.pillar, bucket, w: 0, present: value != null, n: null, stats: null })
        continue
      }
      for (const h of HEADS) z[h] += num(stats.w?.[h])
      pillarZ[feature.pillar] += num(stats.w?.[head])
      hits.push({
        key: feature.key,
        pillar: feature.pillar,
        bucket,
        w: num(stats.w?.[head]),
        // A categorical that fell back to 'unknown' is a default, not an
        // observation: counting it inflated the confidence of a launch we knew
        // nothing about.
        present: value != null && bucket !== 'null' && bucket !== 'unknown',
        n: stats.n ?? null,
        stats,
      })
    }

    return {
      z: z[head],
      p: sigmoid(z[head]),
      heads: { win: sigmoid(z.win), rug: sigmoid(z.rug), moon: sigmoid(z.moon) },
      headZ: z,
      pillarZ,
      hits,
    }
  }

  const convict = (snapshot: FeatureSnapshot, pedigree?: Pedigree | null, opts: { now?: Date } = {}): ConvictionDetail => {
    const evaled = evaluate(snapshot, pedigree)
    const overlay = pedigreeOverlay(rowFromSnapshot(snapshot, pedigree), isFitted)

    const z = evaled.z + overlay.z
    const p = sigmoid(z)
    const cap = overlay.cap
    const score = clamp(Math.min(scoreFromProbability(p), cap))
    const tier = tierForScore(score)

    // The overlay is evidence about this launch, not about its upside
    // specifically, so it shifts every head it can. A book full of ruggers
    // makes a run less likely AND a collapse more likely.
    const probabilities: Record<Head, number> = { win: 0, rug: 0, moon: 0 }
    for (const h of HEADS) {
      const hp = evaled.heads[h]
      const shift = h === 'rug' ? -overlay.z : overlay.z
      probabilities[h] = Number(sigmoid(logit(hp) + shift).toFixed(4))
    }
    probabilities[head] = Number(p.toFixed(4))

    // Coherence. `win` is "it ran AND the holder kept it", so a win is a subset
    // of a run and P(win) can never exceed P(moon). The heads are fitted
    // independently, so nothing in the arithmetic enforces that; on thin
    // launches it genuinely inverts. Raise the weaker claim rather than lower
    // the stronger one: the run head is the one with less at stake here.
    if (probabilities.win > probabilities.moon) probabilities.moon = probabilities.win

    const rugRisk = probabilities.rug
    const upside = clamp(Math.round(probabilities.moon * 100))

    // GIVEN this launch runs, how often does a launch like it hand the run
    // straight back? P(runs) and P(runs and holds) are both estimated, so their
    // ratio is the share of runs that survive, and one minus that is the trap.
    const giveBackRisk = probabilities.moon > 0
      ? clamp(Math.round((1 - Math.min(1, probabilities.win / probabilities.moon)) * 100))
      : null

    // Pillar sub-scores: what each pillar's own evidence (plus, for pedigree,
    // the overlay) would imply alone, on the same probability-to-score map.
    const intercept = num(model.heads[head]?.intercept)
    const pillarScore = (key: Pillar, extraZ = 0) => scoreFromProbability(sigmoid(intercept + evaled.pillarZ[key] + extraZ))
    const pillars: Record<Pillar, number> = {
      pedigree: pillarScore('pedigree', overlay.z),
      structure: pillarScore('structure'),
      narrative: pillarScore('narrative'),
      momentum: pillarScore('momentum'),
    }

    // Confidence: share of model features actually observed. Fitted null
    // buckets DO carry signal (no sells yet is informative), so this is a
    // presentation aid, not a prior.
    const present = evaled.hits.filter((h) => h.present).length
    const confidence = Number((present / Math.max(1, evaled.hits.length)).toFixed(4))

    // Reasons: strongest model evidence first (by absolute log-odds), each
    // quoting the observed outcome rate for its bucket, after the overlay's.
    const modelReasons = evaled.hits
      .filter((h): h is EvaluatedHit & { stats: ModelBucket } => h.stats != null && Math.abs(h.w) >= 0.08)
      .sort((a, b) => Math.abs(b.w) - Math.abs(a.w))
      .slice(0, 7)
      .map((h) => reasonText(model, h.key, h.bucket, h.stats, h.w))
    const reasons = [...overlay.reasons, ...modelReasons]
    if (!reasons.length) reasons.push('no decisive evidence either way yet')

    const badges: string[] = []
    if ((numOrNull(snapshot.features.smart_money_count) ?? 0) >= 3) badges.push('smart-money')
    if (evaled.hits.some((h) => h.pillar === 'structure' && h.w <= -0.5)) badges.push('structure-flag')
    if (cap < 100) badges.push('pedigree-flag')
    if (String(snapshot.features.category).toLowerCase() === 'news') badges.push('news')
    // Momentum earns a badge only when that pillar's evidence ALONE would carry
    // the launch to prime; at 72 it fired on nearly every card.
    if (pillars.momentum >= 86) badges.push('momentum')
    if (confidence < 0.45) badges.push('thin-data')
    // A launch can rank well on upside and still be the wrong thing to hold,
    // and the card has to say so out loud.
    if (rugRisk >= 0.6) badges.push('rug-risk')
    if (giveBackRisk != null && giveBackRisk >= 70 && upside >= 25) badges.push('give-back')

    return {
      token: snapshot.token,
      score,
      tier,
      probabilities,
      rugRisk,
      pillars,
      hits: evaled.hits.map(({ key, pillar, bucket, w, present: isPresent, n }) => ({ key, pillar, bucket, w, present: isPresent, n })),
      reasons,
      confidence,
      modelVersion: version,
      scoredAt: opts.now ?? new Date(),
      upside,
      giveBackRisk,
      pedigreeCap: cap,
      badges,
      suppressed: overlay.suppressed,
    }
  }

  const hitRateFor = (score: number) => {
    const holdout = model.holdout?.[head]
    const base = model.heads[head]?.base_rate ?? null
    const p = probabilityFromScore(score)
    const bands = holdout?.reliability ?? []
    const band = bands.find((b) => p >= b.lo && p < b.hi) ?? bands[bands.length - 1] ?? null
    const rate = band && band.n > 0 ? band.observed : null
    return {
      rate,
      lift: rate != null && base ? Number((rate / base).toFixed(2)) : null,
      band: band ? `${band.lo}-${band.hi}` : null,
      n: band?.n ?? 0,
      baseRate: base,
    }
  }

  return { model, version, pillarWeights, scoreFromProbability, probabilityFromScore, evaluate, convict, hitRateFor }
}

/** Every bucket label a model feature can emit, for tests and the dashboard legend. */
export function modelBucketLabels(feature: OracleModelFeature): string[] {
  return feature.categorical ? Object.keys(feature.buckets) : [...bucketLabels(feature), 'null']
}
