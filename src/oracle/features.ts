/**
 * Oracle feature definitions: the one list every other oracle module reads.
 *
 * Each entry names a feature, the pillar it reports under, and how to read its
 * raw value from a training row. `edges` bucket a numeric value into one-hot
 * columns; a `categorical` feature uses its string value as the bucket. Buckets
 * rather than slopes because several of these signals are genuinely
 * non-monotone (mid-range snipe ratios and top-10 concentration both beat their
 * own extremes on the pump.fun corpus) and a linear term would fight the data
 * at both ends.
 *
 * The fitter (./fit.ts) and the scorer (./conviction.ts) both go through
 * {@link bucketLabel}. That is deliberate: a scorer that reproduced the
 * bucketing with its own copy of the code would, on the first divergence, score
 * production against buckets that were never fitted, silently.
 *
 * Denomination. The bootstrap prior was fitted on pump.fun where volumes are in
 * SOL. On Robinhood Chain the same features are measured in ETH, so the SOL
 * edges are re-denominated once at conversion time (scripts/convert-bootstrap.ts)
 * at a live SOL/ETH rate and stored in ./eth-edges.json, which this file reads.
 * The rate, its source and its date travel with the bootstrap model's
 * provenance string. A refit on Robinhood Chain data keeps these edges, so a
 * weight fitted here and a weight inherited from the prior describe the same
 * band of ETH.
 */
import type { LaunchFeatures, Pillar } from '../types.js'
import ethEdges from './eth-edges.json' with { type: 'json' }

/**
 * One row of the training set, and also what the scorer builds from a
 * FeatureSnapshot. `creator_launches` / `creator_wins` sit beside the features
 * so the pedigree read can come from creator_stats when the extractor did not
 * carry it, and `category` likewise from the launch row.
 */
export interface TrainingRow {
  features: Partial<LaunchFeatures> & Record<string, unknown>
  creator_launches: number | null
  creator_wins: number | null
  category: string | null
}

export type FeatureValue = number | string | null

export interface FeatureDef {
  key: string
  pillar: Pillar
  categorical: boolean
  edges: number[]
  get: (row: TrainingRow) => FeatureValue
}

/** Coerce a raw JSON value to a finite number, or null. Number(null) is 0, which is why this exists. */
export const numOrNull = (v: unknown): number | null => {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const sig = (key: keyof LaunchFeatures) => (row: TrainingRow) => numOrNull(row.features?.[key])

const eth = (key: string): number[] => {
  const edges = (ethEdges.edges as Record<string, number[]>)[key]
  if (!edges) throw new Error(`features: eth-edges.json carries no edges for ${key}; rerun scripts/convert-bootstrap.ts`)
  return edges
}

/** The SOL to ETH conversion the ETH-denominated edges were derived with. */
export const ETH_EDGE_BASIS = Object.freeze({
  solUsd: ethEdges.sol_usd,
  ethUsd: ethEdges.eth_usd,
  factor: ethEdges.factor,
  fetchedAt: ethEdges.fetched_at,
  source: ethEdges.source,
})

/**
 * Creator pedigree as one categorical read. `unknown` when nothing is known
 * about the creator at all, which is a different fact from "first launch".
 */
export function creatorRecord(launches: number | null, wins: number | null): string {
  if (launches == null) return 'unknown'
  if (wins != null && wins >= 1) return 'has_wins'
  if (launches >= 5) return 'serial_no_wins'
  if (launches >= 2) return 'repeat_no_wins'
  return 'first_launch'
}

export const FEATURES: readonly FeatureDef[] = Object.freeze([
  // structure: how the launch is put together
  { key: 'organic_score', pillar: 'structure', categorical: false, get: sig('organic_score'), edges: [0.2, 0.4, 0.6, 0.8] },
  { key: 'bundle_score', pillar: 'structure', categorical: false, get: sig('bundle_score'), edges: [0.1, 0.3, 0.5] },
  { key: 'snipe_ratio', pillar: 'structure', categorical: false, get: sig('snipe_ratio'), edges: [0.1, 0.3, 0.7] },
  { key: 'coordination_score', pillar: 'structure', categorical: false, get: sig('coordination_score'), edges: [0.1, 0.3] },
  { key: 'timing_entropy', pillar: 'structure', categorical: false, get: sig('timing_entropy'), edges: [0.2, 0.4, 0.6, 0.8] },
  { key: 'concentration_top1', pillar: 'structure', categorical: false, get: sig('concentration_top1'), edges: [0.05, 0.15, 0.3] },
  { key: 'concentration_top5', pillar: 'structure', categorical: false, get: sig('concentration_top5'), edges: [0.3, 0.6, 0.9] },
  { key: 'concentration_top10', pillar: 'structure', categorical: false, get: sig('concentration_top10'), edges: [0.3, 0.9] },
  { key: 'fresh_wallet_ratio', pillar: 'structure', categorical: false, get: sig('fresh_wallet_ratio'), edges: [0.2, 0.5, 0.8] },
  { key: 'bubblemap_connectivity', pillar: 'structure', categorical: false, get: sig('bubblemap_connectivity'), edges: [0.1, 0.3, 0.6] },

  // momentum: what the first 90 seconds of tape actually did
  { key: 'unique_buyers', pillar: 'momentum', categorical: false, get: sig('unique_buyers'), edges: [1, 5, 15, 40] },
  { key: 'unique_sellers', pillar: 'momentum', categorical: false, get: sig('unique_sellers'), edges: [1, 3, 10] },
  { key: 'buy_sell_ratio', pillar: 'momentum', categorical: false, get: sig('buy_sell_ratio'), edges: [0.5, 1, 2, 4] },
  { key: 'buy_volume_eth', pillar: 'momentum', categorical: false, get: sig('buy_volume_eth'), edges: eth('buy_volume_eth') },
  { key: 'sell_volume_eth', pillar: 'momentum', categorical: false, get: sig('sell_volume_eth'), edges: eth('sell_volume_eth') },
  { key: 'net_volume_eth', pillar: 'momentum', categorical: false, get: sig('net_volume_eth'), edges: eth('net_volume_eth') },
  { key: 'trade_count', pillar: 'momentum', categorical: false, get: sig('trade_count'), edges: [3, 12, 40] },
  { key: 'largest_buy_eth', pillar: 'momentum', categorical: false, get: sig('largest_buy_eth'), edges: eth('largest_buy_eth') },
  { key: 'avg_buy_eth', pillar: 'momentum', categorical: false, get: sig('avg_buy_eth'), edges: eth('avg_buy_eth') },
  { key: 'median_buy_eth', pillar: 'momentum', categorical: false, get: sig('median_buy_eth'), edges: eth('median_buy_eth') },
  // pump.fun's fixed curve start (28/30/35 SOL) expressed in ETH at the same USD values.
  { key: 'mc_eth_first_seen', pillar: 'momentum', categorical: false, get: sig('mc_eth_first_seen'), edges: eth('mc_eth_first_seen') },

  // pedigree: who launched it, and what the wallets on it are worth
  { key: 'dev_buy_eth', pillar: 'pedigree', categorical: false, get: sig('dev_buy_eth'), edges: eth('dev_buy_eth') },
  { key: 'dev_sell_eth', pillar: 'pedigree', categorical: false, get: sig('dev_sell_eth'), edges: eth('dev_sell_eth') },
  {
    key: 'dev_sold', pillar: 'pedigree', categorical: false, edges: [0.5],
    get: (r) => (r.features?.dev_sold === true ? 1 : r.features?.dev_sold === false ? 0 : null),
  },
  // Fitted, not assumed: on the pump.fun corpus 2-4 proven wallets in the first
  // 90 seconds meant a 55% survivable-win rate against a 3% base. It belongs in
  // the model, measured, next to its own sample size.
  { key: 'smart_money_count', pillar: 'pedigree', categorical: false, get: sig('smart_money_count'), edges: [1, 2, 4] },
  // EVM-native: NOXA locks the LP forever, so the deployer's remaining supply
  // share is the cleanest dump-capacity read on this chain. Not in the prior;
  // it enters the model on the first Robinhood Chain refit.
  { key: 'deployer_holding_pct', pillar: 'pedigree', categorical: false, get: sig('deployer_holding_pct'), edges: [0.02, 0.1, 0.3] },
  {
    key: 'creator_record', pillar: 'pedigree', categorical: true, edges: [],
    get: (r) => creatorRecord(
      numOrNull(r.creator_launches ?? r.features?.creator_launches),
      numOrNull(r.creator_wins ?? r.features?.creator_wins),
    ),
  },

  // narrative: what the coin says it is
  {
    key: 'category', pillar: 'narrative', categorical: true, edges: [],
    get: (r) => String(r.category ?? r.features?.category ?? 'unknown').toLowerCase(),
  },
  // How sure the classifier was. A confident 'meme' and a guessed 'meme' are
  // different observations; not in the prior, fitted on the first refit.
  { key: 'narrative_confidence', pillar: 'narrative', categorical: false, get: sig('narrative_confidence'), edges: [0.3, 0.6, 0.85] },
])

const BY_KEY: ReadonlyMap<string, FeatureDef> = new Map(FEATURES.map((f) => [f.key, f]))

/** Look a feature definition up by key, or null for a key no definition carries. */
export const featureByKey = (key: string): FeatureDef | null => BY_KEY.get(key) ?? null

/**
 * The bucket label a value falls in, for one feature. The fitter and the scorer
 * MUST share this function: a mismatch would score production against buckets
 * that were never fitted, silently.
 */
export function bucketLabel(feature: Pick<FeatureDef, 'categorical' | 'edges'>, value: FeatureValue): string {
  if (feature.categorical) return String(value ?? 'unknown')
  if (value == null || typeof value !== 'number') return 'null'
  const edges = feature.edges
  for (let i = 0; i < edges.length; i++) {
    if (value < edges[i]!) return i === 0 ? `<${edges[0]}` : `${edges[i - 1]}-${edges[i]}`
  }
  return `>=${edges[edges.length - 1]}`
}

/** Every non-null label a numeric feature can produce, in ascending order. */
export function bucketLabels(feature: Pick<FeatureDef, 'categorical' | 'edges'>): string[] {
  if (feature.categorical) return []
  const out: string[] = []
  const edges = feature.edges
  for (let i = 0; i < edges.length; i++) out.push(i === 0 ? `<${edges[0]}` : `${edges[i - 1]}-${edges[i]}`)
  out.push(`>=${edges[edges.length - 1]}`)
  return out
}
