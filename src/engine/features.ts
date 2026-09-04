/**
 * Feature extraction: pure, no I/O. A tape (trades + transfers inside the
 * observation window) plus context becomes the 26 oracle features. Anything
 * whose input is absent is null AND named in `missing`; nothing is estimated.
 *
 * The oracle backfill script imports exactly this signature, so the shapes
 * below are a contract.
 */
import type { Address, Hash } from 'viem'
import type { Category, LaunchFeatures, LaunchRecord } from '../types.js'

export interface TapeTrade {
  block: bigint
  txIndex: number
  logIndex: number
  /** Wall-clock ms of the block. */
  at: number
  trader: Address
  isBuy: boolean
  tokenAmount: bigint
  /** ETH moved by the trader for this trade, wei (fee-inclusive on buys, net on sells). */
  quoteWei: bigint
  txHash: Hash
}

export interface TapeTransfer {
  block: bigint
  from: Address
  to: Address
  value: bigint
}

export interface TapeContext {
  launch: LaunchRecord
  totalSupply: bigint
  ethUsd: number | null
  creatorLaunches: number | null
  creatorWins: number | null
  /** Wallets with a zero nonce before the launch block. */
  freshWallets: Set<Address>
  smartWallets: Set<Address>
  deployerBalance: bigint | null
  windowSeconds: number
  category: Category
  narrativeConfidence: number | null
  /** wallet -> the wallet that first funded it (resolved for fresh wallets). */
  funderOf: Map<Address, Address>
}

export interface FeatureResult {
  features: LaunchFeatures
  missing: string[]
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const DEAD_ADDRESS = '0x000000000000000000000000000000000000dead'
const WEI = 1e18

const eth = (wei: bigint): number => Number(wei) / WEI
const lower = (a: string) => a.toLowerCase()

export function computeFeatures(trades: TapeTrade[], transfers: TapeTransfer[], ctx: TapeContext): FeatureResult {
  const missing = new Set<string>()
  const f: LaunchFeatures = emptyFeatures(ctx.category)
  const tape = [...trades].sort(compareTrades)
  const buys = tape.filter((t) => t.isBuy)
  const sells = tape.filter((t) => !t.isBuy)
  const creator = lower(ctx.launch.creator)
  const fresh = new Set([...ctx.freshWallets].map(lower))
  const smart = new Set([...ctx.smartWallets].map(lower))
  const funder = new Map<string, string>()
  for (const [w, fnd] of ctx.funderOf) funder.set(lower(w), lower(fnd))

  // ── momentum ────────────────────────────────────────────────────────────────
  const buyers = new Set(buys.map((t) => lower(t.trader)))
  const sellers = new Set(sells.map((t) => lower(t.trader)))
  const buyVol = buys.reduce((s, t) => s + t.quoteWei, 0n)
  const sellVol = sells.reduce((s, t) => s + t.quoteWei, 0n)
  f.unique_buyers = buyers.size
  f.unique_sellers = sellers.size
  f.buy_sell_ratio = buys.length / Math.max(sells.length, 1)
  f.buy_volume_eth = eth(buyVol)
  f.sell_volume_eth = eth(sellVol)
  f.net_volume_eth = eth(buyVol - sellVol)
  f.trade_count = tape.length
  if (buys.length) {
    const sizes = buys.map((t) => eth(t.quoteWei)).sort((a, b) => a - b)
    f.largest_buy_eth = sizes[sizes.length - 1]!
    f.avg_buy_eth = sizes.reduce((s, x) => s + x, 0) / sizes.length
    f.median_buy_eth = median(sizes)
  } else {
    missing.add('largest_buy_eth'); missing.add('avg_buy_eth'); missing.add('median_buy_eth')
  }
  const first = tape[0]
  if (first && first.tokenAmount > 0n && ctx.totalSupply > 0n) {
    f.mc_eth_first_seen = eth((ctx.totalSupply * first.quoteWei) / first.tokenAmount)
  } else {
    missing.add('mc_eth_first_seen')
  }

  // ── structure ───────────────────────────────────────────────────────────────
  const launchBlock = ctx.launch.blockNumber
  if (buys.length) {
    f.snipe_ratio = buys.filter((t) => t.block <= launchBlock + 2n).length / buys.length
    f.fresh_wallet_ratio = [...buyers].filter((b) => fresh.has(b)).length / buyers.size
    f.timing_entropy = timingEntropy(buys.map((t) => t.at), ctx.windowSeconds)
  } else {
    missing.add('snipe_ratio'); missing.add('fresh_wallet_ratio'); missing.add('timing_entropy')
  }

  // Funder data is only meaningful when fresh buyers exist; an empty map with
  // fresh buyers on the tape means the resolver could not answer.
  const freshBuyers = [...buyers].filter((b) => fresh.has(b))
  const funderKnown = funder.size > 0 || freshBuyers.length === 0
  if (buys.length && funderKnown) {
    const groups = new Map<string, Set<string>>() // funder -> buyers
    for (const b of buyers) {
      const fnd = funder.get(b)
      if (!fnd) continue
      if (!groups.has(fnd)) groups.set(fnd, new Set())
      groups.get(fnd)!.add(b)
    }
    // Buyers that are themselves the funder of another buyer belong to that group too.
    for (const [fnd, members] of groups) if (buyers.has(fnd)) members.add(fnd)
    const connected = new Set<string>()
    for (const members of groups.values()) if (members.size >= 2) for (const m of members) connected.add(m)
    f.bubblemap_connectivity = connected.size / buyers.size
    f.coordination_score = pairOverlap([...buyers], groups)

    const buysByBlock = new Map<string, TapeTrade[]>()
    for (const t of buys) {
      const k = String(t.block)
      if (!buysByBlock.has(k)) buysByBlock.set(k, [])
      buysByBlock.get(k)!.push(t)
    }
    // A buyer's group is its funder; a buyer that funded other buyers heads its own group.
    const groupOf = (wallet: string): string | null => funder.get(wallet) ?? (groups.has(wallet) ? wallet : null)
    const bundled = new Set<TapeTrade>()
    for (const t of buys) {
      if (t.block === launchBlock) { bundled.add(t); continue }
      const same = buysByBlock.get(String(t.block))!
      if (same.length < 2) continue
      const me = lower(t.trader)
      const myGroup = groupOf(me)
      if (!myGroup) continue
      for (const o of same) {
        if (o === t) continue
        const other = lower(o.trader)
        if (other === me) continue
        if (groupOf(other) === myGroup) { bundled.add(t); break }
      }
    }
    f.bundle_score = bundled.size / buys.length
    const bundlerWallets = new Set([...bundled].map((t) => lower(t.trader)))
    const organicVol = buys.filter((t) => !fresh.has(lower(t.trader)) && !bundlerWallets.has(lower(t.trader))).reduce((s, t) => s + t.quoteWei, 0n)
    f.organic_score = buyVol > 0n ? Number((organicVol * 1_000_000n) / buyVol) / 1_000_000 : 0
  } else {
    missing.add('bubblemap_connectivity'); missing.add('coordination_score'); missing.add('bundle_score'); missing.add('organic_score')
  }

  // Holder concentration from the transfer ledger at window end. Venue
  // contracts (pool, curve factory) and burn addresses are not holders.
  if (transfers.length && ctx.totalSupply > 0n) {
    const venue = new Set<string>([ZERO_ADDRESS, DEAD_ADDRESS])
    if (ctx.launch.pool) venue.add(lower(ctx.launch.pool))
    const factory = ctx.launch.metadata.factory
    if (typeof factory === 'string') venue.add(lower(factory))
    const locker = ctx.launch.metadata.locker
    if (typeof locker === 'string') venue.add(lower(locker))
    const bal = new Map<string, bigint>()
    for (const tr of transfers) {
      const from = lower(tr.from); const to = lower(tr.to)
      if (from !== ZERO_ADDRESS) bal.set(from, (bal.get(from) ?? 0n) - tr.value)
      bal.set(to, (bal.get(to) ?? 0n) + tr.value)
    }
    const holders = [...bal.entries()].filter(([a, v]) => v > 0n && !venue.has(a)).map(([, v]) => v).sort((a, b) => (a > b ? -1 : a < b ? 1 : 0))
    const circulating = holders.reduce((s, v) => s + v, 0n)
    if (circulating > 0n) {
      const share = (n: number) => Number((holders.slice(0, n).reduce((s, v) => s + v, 0n) * 1_000_000n) / circulating) / 1_000_000
      f.concentration_top1 = share(1)
      f.concentration_top5 = share(5)
      f.concentration_top10 = share(10)
    } else {
      missing.add('concentration_top1'); missing.add('concentration_top5'); missing.add('concentration_top10')
    }
  } else {
    missing.add('concentration_top1'); missing.add('concentration_top5'); missing.add('concentration_top10')
  }

  // ── pedigree ────────────────────────────────────────────────────────────────
  const devBuys = buys.filter((t) => lower(t.trader) === creator)
  const devSells = sells.filter((t) => lower(t.trader) === creator)
  f.dev_buy_eth = eth(devBuys.reduce((s, t) => s + t.quoteWei, 0n))
  f.dev_sell_eth = eth(devSells.reduce((s, t) => s + t.quoteWei, 0n))
  const devTransferredOut = transfers.some((tr) => lower(tr.from) === creator && lower(tr.to) !== ZERO_ADDRESS && lower(tr.to) !== lower(ctx.launch.pool ?? '') && tr.value > 0n)
  f.dev_sold = devSells.length > 0 || devTransferredOut
  f.smart_money_count = [...buyers].filter((b) => smart.has(b)).length
  if (ctx.creatorLaunches === null) missing.add('creator_launches'); else f.creator_launches = ctx.creatorLaunches
  if (ctx.creatorWins === null) missing.add('creator_wins'); else f.creator_wins = ctx.creatorWins
  if (ctx.deployerBalance === null || ctx.totalSupply <= 0n) missing.add('deployer_holding_pct')
  else f.deployer_holding_pct = Number((ctx.deployerBalance * 1_000_000n) / ctx.totalSupply) / 1_000_000

  // ── narrative ───────────────────────────────────────────────────────────────
  f.category = ctx.category
  if (ctx.narrativeConfidence === null) missing.add('narrative_confidence'); else f.narrative_confidence = ctx.narrativeConfidence

  return { features: f, missing: [...missing] }
}

/** Null the named features and record them as missing (used when a resolver failed after the tape was built). */
export function markMissing(result: FeatureResult, keys: (keyof LaunchFeatures)[]): FeatureResult {
  const features = { ...result.features }
  const missing = new Set(result.missing)
  for (const k of keys) {
    if (k === 'category') continue
    ;(features as Record<string, unknown>)[k] = null
    missing.add(k)
  }
  return { features, missing: [...missing] }
}

export const FEATURE_KEYS: (keyof LaunchFeatures)[] = [
  'organic_score', 'bundle_score', 'snipe_ratio', 'coordination_score', 'timing_entropy',
  'concentration_top1', 'concentration_top5', 'concentration_top10', 'fresh_wallet_ratio', 'bubblemap_connectivity',
  'unique_buyers', 'unique_sellers', 'buy_sell_ratio', 'buy_volume_eth', 'sell_volume_eth', 'net_volume_eth', 'trade_count',
  'largest_buy_eth', 'avg_buy_eth', 'median_buy_eth', 'mc_eth_first_seen',
  'dev_buy_eth', 'dev_sell_eth', 'dev_sold', 'smart_money_count', 'creator_launches', 'creator_wins', 'deployer_holding_pct',
  'category', 'narrative_confidence',
]

export function emptyFeatures(category: Category = 'unknown'): LaunchFeatures {
  return {
    organic_score: null, bundle_score: null, snipe_ratio: null, coordination_score: null, timing_entropy: null,
    concentration_top1: null, concentration_top5: null, concentration_top10: null, fresh_wallet_ratio: null, bubblemap_connectivity: null,
    unique_buyers: null, unique_sellers: null, buy_sell_ratio: null, buy_volume_eth: null, sell_volume_eth: null, net_volume_eth: null, trade_count: null,
    largest_buy_eth: null, avg_buy_eth: null, median_buy_eth: null, mc_eth_first_seen: null,
    dev_buy_eth: null, dev_sell_eth: null, dev_sold: null, smart_money_count: null, creator_launches: null, creator_wins: null, deployer_holding_pct: null,
    category, narrative_confidence: null,
  }
}

export function compareTrades(a: TapeTrade, b: TapeTrade): number {
  if (a.block !== b.block) return a.block < b.block ? -1 : 1
  if (a.txIndex !== b.txIndex) return a.txIndex - b.txIndex
  return a.logIndex - b.logIndex
}

function median(sorted: number[]): number {
  const n = sorted.length
  if (!n) return 0
  return n % 2 ? sorted[(n - 1) / 2]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2
}

/** Normalized Shannon entropy of timestamps over 10 equal bins spanning the window from the first buy. */
export function timingEntropy(timestamps: number[], windowSeconds: number): number {
  if (timestamps.length < 2) return 0
  const start = Math.min(...timestamps)
  const span = Math.max(windowSeconds * 1000, 1)
  const bins = new Array<number>(10).fill(0)
  for (const t of timestamps) {
    const i = Math.min(9, Math.max(0, Math.floor(((t - start) / span) * 10)))
    bins[i]!++
  }
  let h = 0
  for (const c of bins) {
    if (!c) continue
    const p = c / timestamps.length
    h -= p * Math.log2(p)
  }
  return h / Math.log2(10)
}

/** Share of buyer pairs that share a funder (0 when fewer than two buyers). */
function pairOverlap(buyers: string[], groups: Map<string, Set<string>>): number {
  const n = buyers.length
  if (n < 2) return 0
  let shared = 0
  for (const members of groups.values()) {
    const k = members.size
    if (k >= 2) shared += (k * (k - 1)) / 2
  }
  return shared / ((n * (n - 1)) / 2)
}
