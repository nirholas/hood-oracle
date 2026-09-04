/**
 * The generic pool intake against mainnet history: the newest direct
 * launches (fresh token + WETH/USDG pool) from the last 50,000 blocks are
 * classified, their tapes are read through history.ts, and the momentum
 * block of computeFeatures comes out populated. Skips with a logged reason
 * when the RPC is unreachable.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { erc20Abi, getAddress, parseAbiItem, type Address, type Hash } from 'viem'
import { createChainClient, mapLimit, probeRpcUrls, withRpcRetry, type ChainClient } from '../src/chain/client.js'
import { getLogsChunked, getTokenTrades, getTokenTransfers, resolvePoolSide } from '../src/chain/history.js'
import { launchpadNameFor } from '../src/chain/launchpads.js'
import { Prices } from '../src/chain/prices.js'
import type { DexPoolEvent, LaunchEvent } from '../src/chain/watchers.js'
import { PUBLIC_RPC } from '../src/config.js'
import { computeFeatures } from '../src/engine/features.js'
import { DirectLaunchIntake } from '../src/engine/intake.js'
import { WINDOW_SECONDS } from '../src/engine/context.js'
import { log } from '../src/log.js'
import type { LaunchRecord } from '../src/types.js'

let chain: ChainClient | null = null
let reason = ''
const poolCreated = parseAbiItem('event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)')

beforeAll(async () => {
  const c = createChainClient({ network: 'mainnet', rpcUrls: [PUBLIC_RPC.mainnet], traderPrivateKey: null })
  const [probe] = await probeRpcUrls(c.rpcUrls)
  if (!probe?.ok) {
    reason = `RPC unreachable: ${probe?.error ?? 'no probe'}`
    log.warn({ reason }, 'intake integration test skipped')
    return
  }
  chain = c
}, 30_000)

describe('direct launch intake', () => {
  it('classifies the newest 3 direct launches of the last 50k blocks and produces a momentum block from their tapes', async () => {
    if (!chain) {
      log.warn({ reason }, 'skipped')
      return
    }
    const c = chain
    const prices = new Prices(c)
    const head = await c.publicClient.getBlockNumber()
    const logs = await getLogsChunked(c.publicClient, { address: c.addresses.uniswapV3Factory, event: poolCreated, fromBlock: head - 50_000n, toBlock: head }, { chunk: 50_000n })
    expect(logs.length).toBeGreaterThan(0)
    const launches: LaunchEvent[] = []
    const intake = new DirectLaunchIntake(c, prices, log, { onLaunch: (e) => launches.push(e), isKnownToken: () => false })
    const { decodeEventLog } = await import('viem')
    // newest first; stop after three accepted launches
    for (const l of [...logs].reverse()) {
      const d = decodeEventLog({ abi: [poolCreated], data: l.data, topics: l.topics })
      const a = d.args as { token0: Address; token1: Address; fee: number; tickSpacing: number; pool: Address }
      const ev: DexPoolEvent = { dex: 'v3', token0: getAddress(a.token0), token1: getAddress(a.token1), fee: a.fee, tickSpacing: a.tickSpacing, pool: getAddress(a.pool), poolId: null, hooks: null, blockNumber: l.blockNumber!, txHash: l.transactionHash as Hash, logIndex: l.logIndex!, seenAt: Date.now() }
      await intake.onDexPool(ev)
      if (launches.length >= 3) break
    }
    const stats = intake.health()
    log.info({ stats, launches: launches.map((e) => ({ token: e.token, launchpad: e.launchpad, creator: e.creator, seed: e.extra.seedLiquidityWei, creatingTo: e.extra.creatingTo })) }, 'intake sample')
    expect(launches.length).toBe(3)
    expect(stats.errors).toBe(0)
    for (const e of launches) {
      expect(e.venue).toBe('pool')
      expect(e.pool).toMatch(/^0x/)
      expect(e.creator).toMatch(/^0x[0-9a-fA-F]{40}$/)
      expect(e.launchpad).toBe(launchpadNameFor(e.extra.creatingTo as Address | null, null))
      // the token really is new: dated inside the window, and not one log of it exists before the window
      expect(Number(e.extra.tokenAgeBlocks)).toBeLessThanOrEqual(2_000)
      const earlier = await withRpcRetry(() => c.publicClient.getLogs({ address: e.token, fromBlock: 0n, toBlock: e.blockNumber - 2_001n }))
      expect(earlier.length).toBe(0)
    }
    const ethUsd = await prices.ethUsd()
    await mapLimit(launches, 1, async (e) => {
      const side = await resolvePoolSide(c.publicClient, e.pool!, e.token)
      const quoteKind = side.quote.toLowerCase() === c.addresses.usdg.toLowerCase() ? 'usdg' as const : 'eth' as const
      const to = e.blockNumber + BigInt(WINDOW_SECONDS * 10) // ~90s of 100ms blocks
      const [trades, transfers] = await Promise.all([
        getTokenTrades(c.publicClient, e.token, { venue: 'pool', pool: e.pool!, tokenIsToken0: side.tokenIsToken0, quoteKind }, e.blockNumber, to, { chunk: 1_000n, ethUsd }),
        getTokenTransfers(c.publicClient, e.token, e.blockNumber, to, { chunk: 1_000n }),
      ])
      const launch: LaunchRecord = { token: e.token, network: 'mainnet', launchpad: e.launchpad, creator: e.creator, pool: e.pool, venue: 'pool', blockNumber: e.blockNumber, txHash: e.txHash, firstSeenAt: new Date(), feedLeadMs: null, name: null, symbol: null, decimals: 18, metadata: { ...e.extra }, graduatedAt: null }
      const totalSupply = await withRpcRetry(() => c.publicClient.readContract({ address: e.token, abi: erc20Abi, functionName: 'totalSupply' }))
      const { features: f, missing } = computeFeatures(trades, transfers, { launch, totalSupply, ethUsd, creatorLaunches: null, creatorWins: null, freshWallets: new Set(), smartWallets: new Set(), deployerBalance: null, windowSeconds: WINDOW_SECONDS, category: 'unknown', narrativeConfidence: null, funderOf: new Map() })
      log.info({ token: e.token, launchpad: e.launchpad, trades: trades.length, transfers: transfers.length, unique_buyers: f.unique_buyers, buy_volume_eth: f.buy_volume_eth, mc: f.mc_eth_first_seen, missing }, 'direct launch tape')
      for (const k of ['unique_buyers', 'unique_sellers', 'buy_sell_ratio', 'buy_volume_eth', 'sell_volume_eth', 'net_volume_eth', 'trade_count'] as const) expect(f[k], k).not.toBeNull()
      expect(transfers.length).toBeGreaterThan(0)
      if (trades.length) {
        for (const k of ['largest_buy_eth', 'avg_buy_eth', 'median_buy_eth', 'mc_eth_first_seen'] as const) expect(f[k], k).not.toBeNull()
      }
    })
  }, 180_000)
})
