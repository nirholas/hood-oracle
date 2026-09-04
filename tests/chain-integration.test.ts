/**
 * Read-only integration tests against Robinhood Chain mainnet. Every test
 * skips with a logged reason when the public RPC is unreachable from the
 * machine running the suite; nothing here signs or broadcasts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getRecentLaunches, NOXA_ADDRESSES, noxaTokenLaunchedEvent } from 'hoodchain'
import { getAddress, parseEther } from 'viem'
import { createChainClient, probeRpcUrls, withRpcRetry, type ChainClient } from '../src/chain/client.js'
import { SequencerFeed } from '../src/chain/feed.js'
import { getLogsChunked, getTokenTrades, resolvePoolSide } from '../src/chain/history.js'
import { Prices } from '../src/chain/prices.js'
import { assessTradeSafety, supportsSimulateV1 } from '../src/guards/firewall.js'
import { FEED_URL, PUBLIC_RPC } from '../src/config.js'
import { log } from '../src/log.js'
import { withLiveLock } from './live-lock.js'

let chain: ChainClient | null = null
let reason = ''

beforeAll(async () => {
  const c = createChainClient({ network: 'mainnet', rpcUrls: [PUBLIC_RPC.mainnet], traderPrivateKey: null })
  const [probe] = await probeRpcUrls(c.rpcUrls)
  if (!probe?.ok) {
    reason = `RPC unreachable: ${probe?.error ?? 'no probe'}`
    log.warn({ reason }, 'chain integration tests skipped')
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

describe('chain client', () => {
  it('boots against chain 4663 and reads the head', live(async (c) => {
    expect(c.chainId).toBe(4663)
    expect(c.addresses.router).toMatch(/^0x/)
    const head = await withRpcRetry(() => c.publicClient.getBlockNumber())
    expect(head).toBeGreaterThan(50_000_000n)
    const chainId = await withRpcRetry(() => c.publicClient.getChainId())
    expect(chainId).toBe(4663)
  }), 300_000)

  it('lists launches over the last 2000 blocks without error (the launchpads may be quiet)', live(async (c) => {
    const launches = await withRpcRetry(() => getRecentLaunches(c.hood, { lookbackBlocks: 2_000n, chunkSize: 2_000n }))
    expect(Array.isArray(launches)).toBe(true)
    for (const l of launches) {
      expect(['noxa', 'odyssey']).toContain(l.launchpad)
      expect(l.token).toMatch(/^0x[0-9a-fA-F]{40}$/)
    }
  }), 300_000)
})

describe('prices', () => {
  it('reads ETH/USD from the WETH/USDG pool and caches it', live(async (c) => {
    const prices = new Prices(c)
    const usd = await prices.ethUsd()
    expect(usd).not.toBeNull()
    expect(usd!).toBeGreaterThan(100)
    expect(usd!).toBeLessThan(100_000)
    const again = await prices.ethUsd()
    expect(again).toBe(usd)
    // USDG is the reference dollar: its spot in ETH must be 1 / ethUsd
    const pool = await (async () => {
      const { uniswapV3FactoryAbi } = await import('../src/chain/abis.js')
      return withRpcRetry(() => c.publicClient.readContract({ address: c.addresses.uniswapV3Factory, abi: uniswapV3FactoryAbi, functionName: 'getPool', args: [c.addresses.weth, c.addresses.usdg, 100] }))
    })()
    const spot = await prices.poolSpotEth(pool, c.addresses.usdg, 6)
    expect(spot).not.toBeNull()
    expect(spot! * usd!).toBeCloseTo(1, 1)
    const sellOut = await prices.poolQuoteSell(pool, c.addresses.usdg, 1_000_000n)
    expect(sellOut).not.toBeNull()
    expect(Number(sellOut!) / 1e18 * usd!).toBeCloseTo(1, 1)
  }), 300_000)
})

describe('history', () => {
  it('chunks a wide log range adaptively and returns ordered results', live(async (c) => {
    // The first NOXA launches sit just above the factory deploy block; the range below is 600k blocks wide
    // and covers thousands of launches, which is exactly what forces the chunker to shrink and grow.
    const from = NOXA_ADDRESSES.deployBlock
    const to = from + 600_000n
    const shrinks: string[] = []
    const chunks: number[] = []
    const logs = await getLogsChunked(c.publicClient, { address: NOXA_ADDRESSES.launchFactory, event: noxaTokenLaunchedEvent, fromBlock: from, toBlock: to }, {
      chunk: 300_000n, onShrink: (i) => shrinks.push(i.reason), onChunk: (i) => chunks.push(i.logs),
    })
    expect(logs.length).toBeGreaterThan(100)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    for (let i = 1; i < logs.length; i++) {
      const a = logs[i - 1]!; const b = logs[i]!
      expect(a.blockNumber! < b.blockNumber! || (a.blockNumber === b.blockNumber && a.logIndex! < b.logIndex!)).toBe(true)
    }
    log.info({ logs: logs.length, chunks: chunks.length, shrinks }, 'history chunking')
  }), 300_000)

  it('decodes pool swaps for a NOXA launch into tape trades', live(async (c) => {
    const [first] = await getLogsChunked(c.publicClient, { address: NOXA_ADDRESSES.launchFactory, event: noxaTokenLaunchedEvent, fromBlock: NOXA_ADDRESSES.deployBlock, toBlock: NOXA_ADDRESSES.deployBlock + 50_000n }, { chunk: 50_000n })
    expect(first).toBeTruthy()
    const { decodeEventLog } = await import('viem')
    const d = decodeEventLog({ abi: [noxaTokenLaunchedEvent], data: first!.data, topics: first!.topics })
    const args = d.args as { token: `0x${string}`; pool: `0x${string}` }
    const side = await resolvePoolSide(c.publicClient, getAddress(args.pool), getAddress(args.token))
    const trades = await getTokenTrades(c.publicClient, getAddress(args.token), { venue: 'pool', pool: getAddress(args.pool), tokenIsToken0: side.tokenIsToken0 }, first!.blockNumber!, first!.blockNumber! + 5_000n, { chunk: 5_000n })
    expect(Array.isArray(trades)).toBe(true)
    for (const t of trades) {
      expect(t.tokenAmount).toBeGreaterThan(0n)
      expect(t.at).toBeGreaterThan(1_600_000_000_000)
      expect(typeof t.isBuy).toBe('boolean')
    }
    log.info({ token: args.token, trades: trades.length, buys: trades.filter((t) => t.isBuy).length }, 'first NOXA launch tape')
  }), 300_000)
})

describe('firewall', () => {
  it('runs a real simulated round trip through SwapRouter02 on the WETH/USDG pool', live(async (c) => {
    expect(await supportsSimulateV1(c)).toBe(true)
    const prices = new Prices(c)
    const { uniswapV3FactoryAbi } = await import('../src/chain/abis.js')
    const pool = await withRpcRetry(() => c.publicClient.readContract({ address: c.addresses.uniswapV3Factory, abi: uniswapV3FactoryAbi, functionName: 'getPool', args: [c.addresses.weth, c.addresses.usdg, 100] }))
    const a = await assessTradeSafety({ chain: c, prices, log, network: 'mainnet', token: c.addresses.usdg, venue: 'pool', pool, factory: null, amountWei: parseEther('0.01'), deployer: null })
    log.info({ verdict: a.verdict, score: a.score, loss: a.roundTripLossPct, checks: a.checks.map((x) => `${x.check}:${x.status} ${x.reason}`) }, 'firewall on WETH/USDG')
    const rt = a.checks.find((x) => x.check === 'round_trip')
    expect(rt?.status).toBe('pass')
    expect(a.roundTripLossPct).not.toBeNull()
    expect(a.roundTripLossPct!).toBeLessThan(0.02)
    expect(a.roundTripLossPct!).toBeGreaterThanOrEqual(0)
    expect(['allow', 'warn']).toContain(a.verdict)
    expect(a.latencyMs).toBeLessThan(15_000)
  }), 300_000)
})

describe('sequencer feed', () => {
  let feed: SequencerFeed | null = null
  afterAll(() => feed?.stop())
  it('connects and receives at least one frame within 20s', live(async (c) => {
    feed = new SequencerFeed({ url: FEED_URL.mainnet, addresses: c.addresses, log, onSignal: () => undefined })
    await feed.start()
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline && feed.health().lastSequence == null) await new Promise((r) => setTimeout(r, 100))
    const h = feed.health()
    expect(h.connected).toBe(true)
    expect(h.lastSequence).not.toBeNull()
    expect(h.secondsSinceFrame).not.toBeNull()
    expect(h.secondsSinceFrame!).toBeLessThanOrEqual(20)
    log.info({ ...h }, 'feed health')
  }), 300_000)
})
