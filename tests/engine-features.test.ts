import { describe, expect, it } from 'vitest'
import type { Address, Hash } from 'viem'
import { computeFeatures, markMissing, timingEntropy, type TapeContext, type TapeTrade, type TapeTransfer } from '../src/engine/features.js'
import type { LaunchRecord } from '../src/types.js'

const A = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}` as Address
const H = (n: number): Hash => `0x${n.toString(16).padStart(64, '0')}` as Hash
const ETH = 10n ** 18n
const POOL = A(0xf00)
const CREATOR = A(0xc0)
const TOKEN = A(0x70)
const T0 = 1_700_000_000_000

const launch: LaunchRecord = {
  token: TOKEN, network: 'mainnet', launchpad: 'noxa', creator: CREATOR, pool: POOL, venue: 'pool', blockNumber: 1000n, txHash: H(1),
  firstSeenAt: new Date(T0), feedLeadMs: 120, name: 'Test', symbol: 'TST', decimals: 18, metadata: {}, graduatedAt: null,
}

function trade(i: number, block: bigint, trader: Address, isBuy: boolean, eth: number, tokens: number, at = T0 + Number(block - 1000n) * 100): TapeTrade {
  return { block, txIndex: i, logIndex: i, at, trader, isBuy, tokenAmount: BigInt(tokens) * ETH, quoteWei: BigInt(Math.round(eth * 1e6)) * ETH / 1_000_000n, txHash: H(100 + i) }
}

function ctx(over: Partial<TapeContext> = {}): TapeContext {
  return {
    launch, totalSupply: 1_000_000n * ETH, ethUsd: 2500, creatorLaunches: 2, creatorWins: 1, freshWallets: new Set(), smartWallets: new Set(),
    deployerBalance: 50_000n * ETH, windowSeconds: 90, category: 'meme', narrativeConfidence: 0.8, funderOf: new Map(), ...over,
  }
}

describe('computeFeatures', () => {
  it('reports every momentum feature from a plain tape with known answers', () => {
    const trades = [
      trade(0, 1000n, A(1), true, 1, 1000), // launch block, 1 ETH
      trade(1, 1001n, A(2), true, 2, 1800),
      trade(2, 1003n, A(3), true, 4, 3000),
      trade(3, 1010n, A(1), false, 0.5, 400),
    ]
    const transfers: TapeTransfer[] = [
      { block: 999n, from: A(0), to: POOL, value: 900_000n * ETH },
      { block: 999n, from: A(0), to: CREATOR, value: 100_000n * ETH },
      { block: 1000n, from: POOL, to: A(1), value: 1000n * ETH },
      { block: 1001n, from: POOL, to: A(2), value: 1800n * ETH },
      { block: 1003n, from: POOL, to: A(3), value: 3000n * ETH },
      { block: 1010n, from: A(1), to: POOL, value: 400n * ETH },
    ]
    const { features: f, missing } = computeFeatures(trades, transfers, ctx())
    expect(f.unique_buyers).toBe(3)
    expect(f.unique_sellers).toBe(1)
    expect(f.trade_count).toBe(4)
    expect(f.buy_sell_ratio).toBe(3)
    expect(f.buy_volume_eth).toBeCloseTo(7)
    expect(f.sell_volume_eth).toBeCloseTo(0.5)
    expect(f.net_volume_eth).toBeCloseTo(6.5)
    expect(f.largest_buy_eth).toBeCloseTo(4)
    expect(f.avg_buy_eth).toBeCloseTo(7 / 3)
    expect(f.median_buy_eth).toBeCloseTo(2)
    // first trade: 1 ETH for 1000 tokens => 0.001 ETH/token * 1M supply = 1000 ETH
    expect(f.mc_eth_first_seen).toBeCloseTo(1000)
    // snipe: buys at blocks 1000 and 1001 are within launch+2; 1003 is not
    expect(f.snipe_ratio).toBeCloseTo(2 / 3)
    expect(f.fresh_wallet_ratio).toBe(0)
    // holders at window end (pool excluded): creator 100000, A1 600, A2 1800, A3 3000 => circulating 105400
    expect(f.concentration_top1).toBeCloseTo(100_000 / 105_400, 5)
    expect(f.concentration_top5).toBeCloseTo(1, 5)
    expect(f.dev_buy_eth).toBe(0)
    expect(f.dev_sold).toBe(false)
    expect(f.deployer_holding_pct).toBeCloseTo(0.05)
    expect(f.creator_launches).toBe(2)
    expect(f.creator_wins).toBe(1)
    expect(f.category).toBe('meme')
    expect(f.narrative_confidence).toBe(0.8)
    // no fresh buyers, so funder data is trivially complete: coordination features are computed, not missing
    expect(f.bundle_score).toBeCloseTo(1 / 3) // only the launch-block buy is bundled
    expect(f.coordination_score).toBe(0)
    expect(f.bubblemap_connectivity).toBe(0)
    expect(f.organic_score).toBeCloseTo(6 / 7) // launch-block bundler's 1 ETH is not organic
    expect(missing).toEqual([])
  })

  it('measures bundling, coordination and connectivity through shared funders', () => {
    const funder = A(0xff)
    const trades = [
      trade(0, 1005n, A(1), true, 1, 100),
      trade(1, 1005n, A(2), true, 1, 100),
      trade(2, 1007n, A(3), true, 1, 100),
      trade(3, 1009n, A(4), true, 1, 100),
    ]
    const c = ctx({ freshWallets: new Set([A(1), A(2), A(3)]), funderOf: new Map([[A(1), funder], [A(2), funder], [A(3), funder]]) })
    const { features: f, missing } = computeFeatures(trades, [], c)
    // A1 and A2 bought in the same block from the same funder: both bundled; A3 alone in its block; A4 unrelated.
    expect(f.bundle_score).toBeCloseTo(0.5)
    // funder group of 3 among 4 buyers: 3 pairs of 6 share a funder
    expect(f.coordination_score).toBeCloseTo(0.5)
    expect(f.bubblemap_connectivity).toBeCloseTo(0.75)
    expect(f.fresh_wallet_ratio).toBeCloseTo(0.75)
    // organic: only A4's 1 ETH of 4
    expect(f.organic_score).toBeCloseTo(0.25)
    expect(missing).toContain('concentration_top1')
  })

  it('marks funder-dependent features missing when fresh buyers exist but no funder could be resolved', () => {
    const trades = [trade(0, 1005n, A(1), true, 1, 100), trade(1, 1006n, A(2), true, 1, 100)]
    const { features: f, missing } = computeFeatures(trades, [], ctx({ freshWallets: new Set([A(1)]) }))
    expect(f.bundle_score).toBeNull()
    expect(f.coordination_score).toBeNull()
    expect(missing).toEqual(expect.arrayContaining(['bundle_score', 'coordination_score', 'bubblemap_connectivity', 'organic_score']))
    expect(f.fresh_wallet_ratio).toBeCloseTo(0.5)
  })

  it('never fabricates: an empty tape yields zero counts, null ratios and a full missing list', () => {
    const { features: f, missing } = computeFeatures([], [], ctx({ creatorLaunches: null, creatorWins: null, deployerBalance: null, narrativeConfidence: null }))
    expect(f.trade_count).toBe(0)
    expect(f.unique_buyers).toBe(0)
    expect(f.buy_volume_eth).toBe(0)
    expect(f.avg_buy_eth).toBeNull()
    expect(f.mc_eth_first_seen).toBeNull()
    expect(f.snipe_ratio).toBeNull()
    expect(f.creator_launches).toBeNull()
    expect(f.deployer_holding_pct).toBeNull()
    expect(missing).toEqual(expect.arrayContaining(['largest_buy_eth', 'avg_buy_eth', 'median_buy_eth', 'mc_eth_first_seen', 'snipe_ratio', 'fresh_wallet_ratio', 'timing_entropy', 'bundle_score', 'concentration_top1', 'creator_launches', 'creator_wins', 'deployer_holding_pct', 'narrative_confidence']))
  })

  it('flags a creator who sells or moves tokens inside the window', () => {
    const trades = [trade(0, 1002n, A(1), true, 1, 100), trade(1, 1004n, CREATOR, false, 0.3, 50)]
    const { features: f } = computeFeatures(trades, [], ctx())
    expect(f.dev_sold).toBe(true)
    expect(f.dev_sell_eth).toBeCloseTo(0.3)
    const moved: TapeTransfer[] = [{ block: 1003n, from: CREATOR, to: A(9), value: 10n * ETH }]
    expect(computeFeatures([trade(0, 1002n, A(1), true, 1, 100)], moved, ctx()).features.dev_sold).toBe(true)
  })

  it('counts smart-money buyers', () => {
    const trades = [trade(0, 1002n, A(1), true, 1, 100), trade(1, 1003n, A(2), true, 1, 100)]
    expect(computeFeatures(trades, [], ctx({ smartWallets: new Set([A(2)]) })).features.smart_money_count).toBe(1)
  })

  it('markMissing nulls features and records them', () => {
    const r = computeFeatures([trade(0, 1002n, A(1), true, 1, 100)], [], ctx())
    const m = markMissing(r, ['fresh_wallet_ratio'])
    expect(m.features.fresh_wallet_ratio).toBeNull()
    expect(m.missing).toContain('fresh_wallet_ratio')
  })
})

describe('timingEntropy', () => {
  it('is 0 for a single burst and 1 for a perfectly even spread', () => {
    expect(timingEntropy([T0, T0, T0], 90)).toBe(0)
    const even = Array.from({ length: 10 }, (_, i) => T0 + i * 9_000)
    expect(timingEntropy(even, 90)).toBeCloseTo(1)
  })
})
