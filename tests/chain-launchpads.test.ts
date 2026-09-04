/**
 * The launchpad registry (pure), sequencer pre-signal matching (pure), and a
 * live check that the pool-creation intake turns the newest direct v3
 * launches into complete momentum features through history.ts and
 * computeFeatures, plus the v4 PoolManager classification. Live tests skip
 * with a logged reason when the RPC is unreachable.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { encodeFunctionData, getAddress, parseAbi, type Address } from 'viem'
import { MAINNET_ADDRESSES, NOXA_ADDRESSES, ODYSSEY_ADDRESSES } from 'hoodchain'
import { createChainClient, mapLimit, probeRpcUrls, withRpcRetry, type ChainClient } from '../src/chain/client.js'
import { getTokenTrades, getTokenTransfers, resolvePoolSide } from '../src/chain/history.js'
import { ALL_LAUNCHPADS, LAUNCHPAD_REGISTRY, UNISWAP_V4, launchpadEntry, launchpadNameFor, matchesLaunchSignal } from '../src/chain/launchpads.js'
import { uniswapV3PoolCreatedEvent, uniswapV4InitializeEvent } from '../src/chain/abis.js'
import { Prices } from '../src/chain/prices.js'
import { DirectLaunchIntake } from '../src/engine/intake.js'
import { computeFeatures } from '../src/engine/features.js'
import type { LaunchEvent } from '../src/chain/watchers.js'
import { PUBLIC_RPC } from '../src/config.js'
import { log } from '../src/log.js'
import { withLiveLock } from './live-lock.js'
import type { LaunchRecord } from '../src/types.js'

describe('launchpad registry', () => {
  it('maps every registered creating contract to a Launchpad literal covered by the schema default', () => {
    for (const e of LAUNCHPAD_REGISTRY) {
      expect(e.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
      expect(ALL_LAUNCHPADS).toContain(e.kind === 'launchpad' ? e.name : 'direct')
    }
    expect(launchpadNameFor(NOXA_ADDRESSES.launchFactory)).toBe('noxa')
    expect(launchpadNameFor(ODYSSEY_ADDRESSES.bondingCurveFactory)).toBe('odyssey')
    expect(launchpadNameFor('0xf4fc0cd27fc8ecf17e55ee4c3f7201897df3eb75')).toBe('pons')
    expect(launchpadNameFor('0x4a3e797b2e4dd1cf96b352513ea91b2f6449e74a')).toBe('launcher-4a3e797b')
    expect(launchpadNameFor(MAINNET_ADDRESSES.nonfungiblePositionManager)).toBe('direct')
    expect(launchpadNameFor('0x4e1ae23de6f44571203477c96014e159420f2c44')).toBe('direct')
    expect(launchpadNameFor(null)).toBe('direct')
    expect(launchpadNameFor(UNISWAP_V4.positionManager, '0xf7521cf0bb7c11e2d2794189412614cf2e29a0cc')).toBe('lunch')
    expect(launchpadNameFor(UNISWAP_V4.positionManager, '0x0310cFEbE1D7A69f2414f6595bBe9d17c5342aCc')).toBe('rwa-launchpad')
    expect(launchpadEntry(MAINNET_ADDRESSES.swapRouter02)?.kind).toBe('router')
  })

  it('matches sequencer pre-signals by contract and selector', () => {
    const npm = parseAbi(['function multicall(bytes[] data) payable returns (bytes[])', 'function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) payable returns (address)', 'function collect((uint256,address,uint128,uint128)) returns (uint256, uint256)'])
    const create = encodeFunctionData({ abi: npm, functionName: 'createAndInitializePoolIfNecessary', args: [MAINNET_ADDRESSES.weth, MAINNET_ADDRESSES.usdg, 10_000, 0n] })
    const inner = encodeFunctionData({ abi: npm, functionName: 'multicall', args: [[create]] })
    expect(matchesLaunchSignal(MAINNET_ADDRESSES.nonfungiblePositionManager, inner)?.kind).toBe('position-manager')
    expect(matchesLaunchSignal(MAINNET_ADDRESSES.nonfungiblePositionManager, create)?.selectorNames?.['0x13ead562']).toBe('createAndInitializePoolIfNecessary')
    const collect = encodeFunctionData({ abi: npm, functionName: 'collect', args: [[1n, MAINNET_ADDRESSES.weth, 0n, 0n]] })
    expect(matchesLaunchSignal(MAINNET_ADDRESSES.nonfungiblePositionManager, collect)).toBeNull()
    expect(matchesLaunchSignal('0x1fae6f162355cf77bf7f23cb919130962dad4ecb', '0x026f2bf0deadbeef')?.name).toBe('rialto')
    expect(matchesLaunchSignal('0x1fae6f162355cf77bf7f23cb919130962dad4ecb', '0xdeadbeef')).toBeNull()
    expect(matchesLaunchSignal(NOXA_ADDRESSES.launchFactory, '0x12345678')?.name).toBe('noxa')
    expect(matchesLaunchSignal(MAINNET_ADDRESSES.swapRouter02, '0xac9650d8')).toBeNull()
    expect(matchesLaunchSignal('0x0000000000000000000000000000000000000001', '0x')).toBeNull()
  })
})

let chain: ChainClient | null = null
let reason = ''
beforeAll(async () => {
  const c = createChainClient({ network: 'mainnet', rpcUrls: [PUBLIC_RPC.mainnet], traderPrivateKey: null })
  const [probe] = await probeRpcUrls(c.rpcUrls)
  if (!probe?.ok) {
    reason = `RPC unreachable: ${probe?.error ?? 'no probe'}`
    log.warn({ reason }, 'launchpad integration tests skipped')
    return
  }
  chain = c
}, 30_000)
const live = (fn: (c: ChainClient) => Promise<void>) => async () => {
  if (!chain) {
    log.warn({ reason }, 'skipped')
    return
  }
  await withLiveLock(() => fn(chain!))
}

describe('direct launch intake (live)', () => {
  it('classifies pairs by quote side and ignores quote/quote and unknown/unknown pairs', live(async (c) => {
    const intake = new DirectLaunchIntake(c, new Prices(c), log, { onLaunch: () => undefined, isKnownToken: () => false })
    const t: Address = '0x1111111111111111111111111111111111111111'
    expect(intake.classifyPair({ dex: 'v3', token0: c.addresses.weth, token1: t })).toEqual({ token: t, quote: c.addresses.weth, quoteSide: 'WETH', tokenIsToken0: false })
    expect(intake.classifyPair({ dex: 'v3', token0: t, token1: c.addresses.usdg })?.quoteSide).toBe('USDG')
    expect(intake.classifyPair({ dex: 'v4', token0: '0x0000000000000000000000000000000000000000', token1: t })?.quoteSide).toBe('ETH')
    expect(intake.classifyPair({ dex: 'v3', token0: '0x0000000000000000000000000000000000000000', token1: t })).toBeNull()
    expect(intake.classifyPair({ dex: 'v3', token0: c.addresses.weth, token1: c.addresses.usdg })).toBeNull()
    expect(intake.classifyPair({ dex: 'v3', token0: t, token1: '0x2222222222222222222222222222222222222222' })).toBeNull()
  }), 300_000)

  it('turns the newest 3 direct v3 launches of the last 50k blocks into complete momentum features', live(async (c) => {
    const head = await c.publicClient.getBlockNumber()
    const prices = new Prices(c)
    const launches: LaunchEvent[] = []
    const intake = new DirectLaunchIntake(c, prices, log, { onLaunch: (e) => launches.push(e), isKnownToken: () => false })
    // Direct launches arrive a few times a day; walk back in 50k-block chunks (about 1.5 hours each) until the newest three are in hand.
    let scanned = 0
    for (let to = head; launches.length < 3 && scanned < 8; to -= 50_000n, scanned++) {
      const created = await withRpcRetry(() => c.publicClient.getLogs({ address: c.addresses.uniswapV3Factory, event: uniswapV3PoolCreatedEvent, fromBlock: to - 50_000n + 1n, toBlock: to }))
      for (const l of [...created].reverse()) {
        if (launches.length >= 3) break
        const a = l.args
        if (!a.token0 || !a.token1 || !a.pool) continue
        await intake.onDexPool({ dex: 'v3', token0: a.token0, token1: a.token1, fee: a.fee ?? 0, tickSpacing: a.tickSpacing ?? 0, pool: a.pool, poolId: null, hooks: null, blockNumber: l.blockNumber, txHash: l.transactionHash, logIndex: l.logIndex, seenAt: Date.now() })
      }
    }
    log.info({ chunksScanned: scanned, stats: intake.health(), launches: launches.map((e) => ({ token: e.token, launchpad: e.launchpad, creator: e.creator, creatorSource: e.extra.creatorSource, ageBlocks: e.extra.tokenAgeBlocks, seedWei: e.extra.seedLiquidityWei, to: e.extra.creatingTo })) }, 'direct launches')
    expect(launches.length).toBe(3)
    const ethUsd = await prices.ethUsd()
    let withTrades = 0
    await mapLimit(launches, 1, async (e) => {
      expect(e.venue).toBe('pool')
      expect(e.pool).toBeTruthy()
      expect(ALL_LAUNCHPADS).toContain(e.launchpad)
      expect(Number(e.extra.tokenAgeBlocks)).toBeLessThanOrEqual(2000)
      const side = await resolvePoolSide(c.publicClient, e.pool!, e.token)
      const quoteKind = side.quote.toLowerCase() === c.addresses.usdg.toLowerCase() ? 'usdg' : 'eth'
      const to = e.blockNumber + 900n > head ? head : e.blockNumber + 900n
      const [trades, transfers] = await Promise.all([
        getTokenTrades(c.publicClient, e.token, { venue: 'pool', pool: e.pool!, tokenIsToken0: side.tokenIsToken0, quoteKind }, e.blockNumber, to, { chunk: 1_000n, ethUsd }),
        getTokenTransfers(c.publicClient, e.token, e.blockNumber, to, { chunk: 1_000n }),
      ])
      const supply = await withRpcRetry(() => c.publicClient.readContract({ address: e.token, abi: parseAbi(['function totalSupply() view returns (uint256)']), functionName: 'totalSupply' }))
      const launch: LaunchRecord = {
        token: e.token, network: 'mainnet', launchpad: e.launchpad, creator: e.creator, pool: e.pool, venue: 'pool', blockNumber: e.blockNumber, txHash: e.txHash,
        firstSeenAt: new Date(), feedLeadMs: null, name: null, symbol: null, decimals: 18, metadata: { factory: e.factory, ...e.extra }, graduatedAt: null,
      }
      const { features: f, missing } = computeFeatures(trades, transfers, {
        launch, totalSupply: supply, ethUsd, creatorLaunches: 0, creatorWins: 0, freshWallets: new Set(), smartWallets: new Set(), deployerBalance: null,
        windowSeconds: 90, category: 'unknown', narrativeConfidence: null, funderOf: new Map(),
      })
      log.info({ token: e.token, trades: trades.length, transfers: transfers.length, buyers: f.unique_buyers, buyVol: f.buy_volume_eth, mc: f.mc_eth_first_seen, missing }, 'direct launch tape')
      for (const k of ['unique_buyers', 'unique_sellers', 'buy_sell_ratio', 'buy_volume_eth', 'sell_volume_eth', 'net_volume_eth', 'trade_count'] as const) expect(f[k], k).not.toBeNull()
      expect(transfers.length).toBeGreaterThan(0)
      if (trades.length) {
        withTrades++
        for (const k of ['largest_buy_eth', 'avg_buy_eth', 'median_buy_eth', 'mc_eth_first_seen'] as const) expect(f[k], k).not.toBeNull()
        // Holder concentration exists exactly when a wallet outside the venues still holds at window end;
        // buyers who round-tripped inside the window leave nothing to concentrate and the feature is missing, not fabricated.
        const venues = new Set(['0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead', e.pool!.toLowerCase(), e.factory.toLowerCase()])
        const ledger = new Map<string, bigint>()
        for (const t of transfers) {
          if (t.from !== '0x0000000000000000000000000000000000000000') ledger.set(t.from.toLowerCase(), (ledger.get(t.from.toLowerCase()) ?? 0n) - t.value)
          ledger.set(t.to.toLowerCase(), (ledger.get(t.to.toLowerCase()) ?? 0n) + t.value)
        }
        const heldOutside = [...ledger.entries()].some(([a, v]) => v > 0n && !venues.has(a))
        if (heldOutside) expect(f.concentration_top1).not.toBeNull()
        else expect(missing).toContain('concentration_top1')
      }
    })
    expect(withTrades).toBeGreaterThan(0)
  }), 300_000)

  it('sees the Uniswap v4 PoolManager and classifies its recent initializations', live(async (c) => {
    const head = await c.publicClient.getBlockNumber()
    const code = await c.publicClient.getCode({ address: UNISWAP_V4.poolManager })
    expect((code ?? '0x').length).toBeGreaterThan(2)
    const inits = await c.publicClient.getLogs({ address: UNISWAP_V4.poolManager, event: uniswapV4InitializeEvent, fromBlock: head - 5_000n, toBlock: head })
    const intake = new DirectLaunchIntake(c, new Prices(c), log, { onLaunch: () => undefined, isKnownToken: () => false })
    let quotePairs = 0
    for (const l of inits) {
      const a = l.args
      expect(a.id).toMatch(/^0x[0-9a-f]{64}$/)
      expect(getAddress(a.currency0!)).toBeTruthy()
      if (intake.classifyPair({ dex: 'v4', token0: a.currency0!, token1: a.currency1! })) quotePairs++
    }
    log.info({ inits: inits.length, quotePairs }, 'v4 initializations in the last 5k blocks')
    expect(inits.length).toBeGreaterThan(0)
  }), 300_000)
})
