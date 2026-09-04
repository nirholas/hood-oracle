/**
 * Convert the three.ws pump.fun conviction model into hood-oracle's bootstrap
 * prior.
 *
 * Run once, by hand, whenever the upstream model or the price basis changes:
 *
 *   npx tsx scripts/convert-bootstrap.ts [path/to/conviction-model.json]
 *
 * What it does, and why each step exists:
 *
 * 1. Fetches the live SOL/USD and ETH/USD prices from CoinGecko's keyless
 *    simple-price endpoint. The upstream model bucketed every volume feature
 *    in SOL; on Robinhood Chain the same features are measured in ETH, and a
 *    0.5 SOL edge only means "0.5 SOL worth of buying" if it is re-denominated
 *    at a real exchange rate. The rate, its source and the fetch time are
 *    written into the model's provenance string so the prior is auditable.
 * 2. Rewrites every `_sol` feature key to `_eth` and multiplies its edges by
 *    solUsd / ethUsd, rounded to three significant figures. Bucket labels are
 *    regenerated from the new edges, in the same order, so the fitted weight
 *    of "0.5-8 SOL bought early" becomes the weight of the equivalent ETH band.
 *    `mc_sol_first_seen` (pump.fun's fixed 28/30/35 SOL curve start) is
 *    converted the same way: the same USD values, expressed in ETH.
 * 3. Writes two files that MUST agree with each other:
 *      src/oracle/eth-edges.json      the converted edges, read by FEATURES
 *      src/oracle/bootstrap-model.json the OracleModelDocument the store
 *                                      installs on a cold boot
 *    tests/oracle-bootstrap.test.ts asserts that every feature in the model
 *    matches FEATURES in key and edges, so a drift between the two fails CI
 *    instead of scoring production against buckets that were never fitted.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const DEFAULT_SOURCE = resolve(here, '../../three.ws/api/_lib/oracle/conviction-model.json')
const OUT_MODEL = join(here, '../src/oracle/bootstrap-model.json')
const OUT_EDGES = join(here, '../src/oracle/eth-edges.json')
const PRICE_SOURCE = 'https://api.coingecko.com/api/v3/simple/price?ids=solana,ethereum&vs_currencies=usd'

/** Upstream SOL-denominated keys and the EVM-native key each becomes. */
const RENAME: Record<string, string> = {
  buy_volume_sol: 'buy_volume_eth',
  sell_volume_sol: 'sell_volume_eth',
  net_volume_sol: 'net_volume_eth',
  largest_buy_sol: 'largest_buy_eth',
  avg_buy_sol: 'avg_buy_eth',
  median_buy_sol: 'median_buy_eth',
  mc_sol_first_seen: 'mc_eth_first_seen',
  dev_buy_sol: 'dev_buy_eth',
  dev_sell_sol: 'dev_sell_eth',
}

type Head = 'win' | 'rug' | 'moon'
interface UpstreamBucket { n: number; w: Record<Head, number>; rate: Record<Head, number> }
interface UpstreamFeature { key: string; pillar: string; categorical: boolean; edges: number[] | null; buckets: Record<string, UpstreamBucket> }
interface UpstreamModel {
  version: number
  fitted_at: string
  training_rows: number
  score_head: Head
  heads: Record<Head, { intercept: number; base_rate: number }>
  tier_probability_anchors: Record<string, number>
  features: UpstreamFeature[]
  dropped_features: unknown[]
  holdout: Record<string, unknown>
  fit: { epochs: number; shrink_prior: number; epochs_run: number; columns: number; features: number; complete: boolean }
}

const sig3 = (x: number): number => (x === 0 ? 0 : Number(x.toPrecision(3)))

/** The bucket label a value falls in. Byte-identical to src/oracle/features.ts bucketLabel. */
function bucketLabel(edges: number[], value: number | null): string {
  if (value == null) return 'null'
  for (let i = 0; i < edges.length; i++) {
    if (value < edges[i]!) return i === 0 ? `<${edges[0]}` : `${edges[i - 1]}-${edges[i]}`
  }
  return `>=${edges[edges.length - 1]}`
}

/** The ordered list of labels a numeric feature can produce, `null` excluded. */
function labelsFor(edges: number[]): string[] {
  const out: string[] = []
  for (let i = 0; i < edges.length; i++) out.push(i === 0 ? `<${edges[0]}` : `${edges[i - 1]}-${edges[i]}`)
  out.push(`>=${edges[edges.length - 1]}`)
  return out
}

async function fetchRate(): Promise<{ solUsd: number; ethUsd: number; factor: number; fetchedAt: string }> {
  const res = await fetch(PRICE_SOURCE, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`price fetch failed: HTTP ${res.status} from ${PRICE_SOURCE}`)
  const body = (await res.json()) as { solana?: { usd?: number }; ethereum?: { usd?: number } }
  const solUsd = Number(body.solana?.usd)
  const ethUsd = Number(body.ethereum?.usd)
  if (!Number.isFinite(solUsd) || !Number.isFinite(ethUsd) || solUsd <= 0 || ethUsd <= 0) {
    throw new Error(`price response unusable: ${JSON.stringify(body)}`)
  }
  return { solUsd, ethUsd, factor: solUsd / ethUsd, fetchedAt: new Date().toISOString() }
}

async function main() {
  const sourcePath = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_SOURCE
  const upstream = JSON.parse(readFileSync(sourcePath, 'utf8')) as UpstreamModel
  if (upstream.version !== 3 || upstream.score_head !== 'win') {
    throw new Error(`expected a v3 win-headed model, got version ${upstream.version} head ${upstream.score_head}`)
  }
  const rate = await fetchRate()
  const day = rate.fetchedAt.slice(0, 10)
  const factor = Number(rate.factor.toPrecision(6))

  const ethEdges: Record<string, number[]> = {}
  const features = upstream.features.map((f) => {
    const target = RENAME[f.key]
    if (!target) {
      return { key: f.key, pillar: f.pillar, categorical: f.categorical, edges: f.edges ?? [], buckets: f.buckets }
    }
    const solEdges = f.edges ?? []
    const edges = solEdges.map((e) => sig3(e * rate.factor))
    for (let i = 1; i < edges.length; i++) {
      if (edges[i]! <= edges[i - 1]!) throw new Error(`${target}: converted edges are not strictly increasing: ${edges.join(',')}`)
    }
    ethEdges[target] = edges
    const oldLabels = labelsFor(solEdges)
    const newLabels = labelsFor(edges)
    const buckets: Record<string, UpstreamBucket> = {}
    for (const [label, bucket] of Object.entries(f.buckets)) {
      const idx = oldLabels.indexOf(label)
      const renamed = label === 'null' ? 'null' : idx >= 0 ? newLabels[idx]! : null
      if (renamed == null) throw new Error(`${f.key}: bucket ${label} does not match its own edges ${solEdges.join(',')}`)
      buckets[renamed] = bucket
    }
    // Every label the new edges can produce must round-trip through bucketLabel
    // with a value inside the band, otherwise a live value would land on a
    // bucket the model does not carry.
    for (let i = 0; i < newLabels.length; i++) {
      const probe = i === 0 ? edges[0]! - 1 : i < edges.length ? (edges[i - 1]! + edges[i]!) / 2 : edges[edges.length - 1]! + 1
      if (bucketLabel(edges, probe) !== newLabels[i]) throw new Error(`${target}: label ${newLabels[i]} does not round-trip`)
    }
    return { key: target, pillar: f.pillar, categorical: f.categorical, edges, buckets }
  })

  const provenance =
    `bootstrap:three.ws pump.fun corpus ${upstream.training_rows.toLocaleString('en-US')} rows, fitted ${upstream.fitted_at.slice(0, 10)}, ` +
    `SOL to ETH edge factor ${factor} (SOL ${rate.solUsd} USD, ETH ${rate.ethUsd} USD) at ${day} via CoinGecko simple/price`

  const model = {
    version: upstream.version,
    fitted_at: upstream.fitted_at,
    training_rows: upstream.training_rows,
    score_head: upstream.score_head,
    heads: upstream.heads,
    tier_probability_anchors: upstream.tier_probability_anchors,
    features,
    holdout: upstream.holdout,
    provenance,
    dropped_features: upstream.dropped_features,
    fit: upstream.fit,
    conversion: {
      source: 'three.ws api/_lib/oracle/conviction-model.json',
      sol_usd: rate.solUsd,
      eth_usd: rate.ethUsd,
      factor,
      fetched_at: rate.fetchedAt,
      price_source: PRICE_SOURCE,
      renamed: RENAME,
    },
  }

  writeFileSync(OUT_EDGES, JSON.stringify({
    sol_usd: rate.solUsd,
    eth_usd: rate.ethUsd,
    factor,
    fetched_at: rate.fetchedAt,
    source: PRICE_SOURCE,
    edges: ethEdges,
  }, null, 2) + '\n')
  writeFileSync(OUT_MODEL, JSON.stringify(model, null, 1) + '\n')

  console.log(`rate: SOL ${rate.solUsd} USD, ETH ${rate.ethUsd} USD, factor ${factor} (${rate.fetchedAt})`)
  for (const [key, edges] of Object.entries(ethEdges)) console.log(`  ${key}: [${edges.join(', ')}]`)
  console.log(`wrote ${OUT_EDGES}`)
  console.log(`wrote ${OUT_MODEL} (${features.length} features, ${upstream.training_rows} rows)`)
  console.log(`provenance: ${provenance}`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
