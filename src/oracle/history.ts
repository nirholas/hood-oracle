/**
 * Oracle: the chain reads the learning loop needs that the live engine does
 * not. Everything generic (chunked logs, trade decoding, pool orientation,
 * block timestamps, transaction senders) lives in src/chain/history.ts and is
 * reused here; this module only adds what labels and the backfill need on
 * top: launch discovery over a historical block range through the engine's
 * own watchers and intake (so a backfilled launch is classified exactly as a
 * live one), block-at-time lookup, a price path in ETH per token, pool
 * liquidity, historical nonces, and Blockscout funder lookups.
 *
 * Read-only. Nothing here writes to the chain.
 */
import { type Address, type Hash, erc20Abi, formatUnits, getAddress } from 'viem'
import { NOXA_ADDRESSES, ODYSSEY_ADDRESSES, noxaTokenLaunchedEvent, uniswapV3PoolAbi } from 'hoodchain'
import type { ChainClient } from '../chain/client.js'
import { errorText, mapLimit, withRpcRetry } from '../chain/client.js'
import { odysseyCurveAbi, odysseyInstantAbi, odysseyReflectionPoolAbi, uniswapV3PoolCreatedEvent } from '../chain/abis.js'
import { blockTimestamps, getLogsChunked, getTokenTrades, resolvePoolSide, type QuoteKind, type TradeSource } from '../chain/history.js'
import { UNISWAP_V4 } from '../chain/launchpads.js'
import type { Prices } from '../chain/prices.js'
import { Watchers, type DexPoolEvent, type GraduationEvent, type LaunchEvent } from '../chain/watchers.js'
import { DirectLaunchIntake } from '../engine/intake.js'
import type { TapeTrade } from '../engine/features.js'
import type { Logger } from '../log.js'
import type { LaunchRecord } from '../types.js'

export interface PricePoint {
  block: bigint
  /** Wall-clock ms of the block. */
  at: number
  /** ETH per whole token. */
  priceEth: number
  isBuy: boolean
  quoteWei: bigint
}

export interface LaunchScan {
  launches: LaunchEvent[]
  graduations: GraduationEvent[]
  /** Pool creations the intake rejected, by reason, for the progress log. */
  intake: { seen: number; accepted: number; skippedQuote: number; skippedStale: number; skippedKnown: number; errors: number }
}

const BLOCKSCOUT = 'https://robinhoodchain.blockscout.com'
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
/** Robinhood Chain blocks per second, measured 2026-09-03 (0.1045 s per block). */
export const BLOCKS_PER_SECOND = 1 / 0.1045

const ev = (abi: readonly unknown[], name: string) => abi.find((x) => (x as { type: string; name: string }).type === 'event' && (x as { name: string }).name === name) as never

export interface OracleHistory {
  readonly chain: ChainClient
  headBlock(): Promise<bigint>
  /** Wall-clock ms of a block. */
  blockTimeMs(block: bigint): Promise<number>
  /** The first block at or after a wall-clock ms, clamped to the head. */
  blockAtTime(atMs: number): Promise<bigint>
  /**
   * Every launch in a block range through the engine's own watchers and
   * intake: NOXA, the four Odyssey factories, and every Uniswap v3 PoolCreated
   * / v4 Initialize pairing a fresh token with WETH, USDG or ETH.
   */
  scanLaunches(fromBlock: bigint, toBlock: bigint, opts?: { isKnownToken?: (token: Address) => boolean; onProgress?: (info: { from: bigint; to: bigint; launches: number }) => void }): Promise<LaunchScan>
  /** Where a recorded launch trades, mirroring the observer's resolution. Null when the pool side cannot be read. */
  tradeSourceFor(launch: LaunchRecord): Promise<TradeSource | null>
  /** Every trade between two blocks, denominated in ETH; curve trades and pool swaps merged for a graduated token. */
  trades(launch: LaunchRecord, fromBlock: bigint, toBlock: bigint): Promise<TapeTrade[]>
  pricePath(launch: LaunchRecord, fromBlock: bigint, toBlock: bigint): Promise<PricePoint[]>
  poolLiquidity(pool: Address): Promise<bigint | null>
  /** Nonce of each address at a block. Addresses whose state is unavailable are absent from the map. */
  txCounts(addresses: readonly Address[], block: bigint): Promise<Map<Address, number>>
  /** Token balance of a holder at a block, falling back to the latest state when the historical state is pruned. */
  balanceAt(token: Address, holder: Address, block: bigint): Promise<{ balance: bigint; historical: boolean } | null>
  /** The wallet that first funded each fresh wallet, from Blockscout. Missing entries could not be resolved. */
  funderOf(wallets: readonly Address[], max?: number): Promise<{ funders: Map<Address, Address>; failed: boolean }>
  /** Locate a token's launch anywhere in chain history. */
  findLaunch(token: Address): Promise<LaunchEvent | null>
  /** ETH/USD from the on-chain WETH/USDG pool, or null when it cannot be quoted. */
  ethUsd(): Promise<number | null>
}

export function createOracleHistory({ chain, prices, log }: { chain: ChainClient; prices: Prices; log: Logger }): OracleHistory {
  const client = chain.publicClient
  const usdg = chain.addresses.usdg.toLowerCase()

  const headBlock = () => withRpcRetry(() => client.getBlockNumber())

  async function blockTimeMs(block: bigint): Promise<number> {
    const ts = await blockTimestamps(client, [block])
    const ms = ts.get(block)
    if (ms == null) throw new Error(`no timestamp for block ${block}`)
    return ms
  }

  async function blockAtTime(atMs: number): Promise<bigint> {
    const head = await headBlock()
    const headMs = await blockTimeMs(head)
    if (atMs >= headMs) return head
    let lo = 0n
    let hi = head
    let guess = head - BigInt(Math.max(0, Math.round(((headMs - atMs) / 1000) * BLOCKS_PER_SECOND)))
    if (guess < 1n) guess = 1n
    let guessMs = await blockTimeMs(guess)
    // Secant steps on a near-constant block clock converge in a handful of headers.
    for (let i = 0; i < 14 && hi - lo > 1n; i++) {
      if (guessMs >= atMs) hi = guess
      else lo = guess
      if (hi - lo <= 1n) break
      let next = guess + BigInt(Math.round(((atMs - guessMs) / 1000) * BLOCKS_PER_SECOND))
      if (next <= lo) next = lo + 1n
      if (next >= hi) next = hi - 1n
      if (next === guess) next = guessMs >= atMs ? guess - 1n : guess + 1n
      guess = next
      guessMs = await blockTimeMs(guess)
    }
    return hi
  }

  async function scanLaunches(fromBlock: bigint, toBlock: bigint, opts: { isKnownToken?: (token: Address) => boolean; onProgress?: (info: { from: bigint; to: bigint; launches: number }) => void } = {}): Promise<LaunchScan> {
    const launches: LaunchEvent[] = []
    const graduations: GraduationEvent[] = []
    const seen = new Set<string>()
    const pending: Promise<void>[] = []
    const known = (token: Address) => seen.has(token.toLowerCase()) || (opts.isKnownToken?.(token) ?? false)
    const intake = new DirectLaunchIntake(chain, prices, log, {
      onLaunch: (e) => {
        if (seen.has(e.token.toLowerCase())) return
        seen.add(e.token.toLowerCase())
        launches.push(e)
      },
      isKnownToken: known,
    })
    const watchers = new Watchers(chain, {
      onLaunch: (e) => {
        if (seen.has(e.token.toLowerCase())) return
        seen.add(e.token.toLowerCase())
        launches.push(e)
      },
      onCurveTrade: () => {},
      onGraduation: (g) => graduations.push(g),
      onSwap: () => {},
      onDexPool: (e: DexPoolEvent) => { pending.push(intake.onDexPool(e)) },
      onStatus: (level, message) => log[level === 'error' ? 'warn' : level]({ message }, 'history: watcher status'),
    })
    // Scan in slices so a multi-day range reports progress and a failed slice
    // does not discard the ones before it.
    const SLICE = 200_000n
    for (let from = fromBlock; from <= toBlock; from += SLICE) {
      const to = from + SLICE - 1n > toBlock ? toBlock : from + SLICE - 1n
      const before = launches.length
      await watchers.scan(from, to)
      await Promise.all(pending.splice(0))
      opts.onProgress?.({ from, to, launches: launches.length - before })
    }
    launches.sort((a, b) => (a.blockNumber !== b.blockNumber ? (a.blockNumber < b.blockNumber ? -1 : 1) : a.logIndex - b.logIndex))
    return { launches, graduations, intake: intake.health() }
  }

  async function tradeSourceFor(launch: LaunchRecord): Promise<TradeSource | null> {
    const meta = launch.metadata
    if (launch.venue === 'v4' && typeof meta.poolId === 'string') {
      const quote = typeof meta.quote === 'string' ? meta.quote : null
      const quoteKind: QuoteKind = quote && quote.toLowerCase() === usdg ? 'usdg' : 'eth'
      const tokenIsCurrency0 = quote ? BigInt(launch.token) < BigInt(quote) : true
      return { venue: 'v4', poolManager: UNISWAP_V4.poolManager, poolId: meta.poolId as Hash, tokenIsCurrency0, quoteKind }
    }
    if (launch.pool) {
      try {
        const side = await resolvePoolSide(client, launch.pool, launch.token)
        return { venue: 'pool', pool: launch.pool, tokenIsToken0: side.tokenIsToken0, quoteKind: side.quote.toLowerCase() === usdg ? 'usdg' : 'eth' }
      } catch (err) {
        log.warn({ token: launch.token, pool: launch.pool, err: errorText(err) }, 'history: pool side unresolved')
        return null
      }
    }
    if (typeof meta.factory === 'string') return { venue: 'curve', factory: meta.factory as Address }
    return null
  }

  /** A curve launch that graduated trades on its factory first and its pool after; both legs are read. */
  async function sourcesFor(launch: LaunchRecord): Promise<TradeSource[]> {
    const out: TradeSource[] = []
    const primary = await tradeSourceFor(launch)
    if (primary) out.push(primary)
    if (launch.launchpad === 'odyssey' && primary && primary.venue !== 'curve' && typeof launch.metadata.factory === 'string') {
      out.push({ venue: 'curve', factory: launch.metadata.factory as Address })
    }
    return out
  }

  async function trades(launch: LaunchRecord, fromBlock: bigint, toBlock: bigint): Promise<TapeTrade[]> {
    if (toBlock < fromBlock) return []
    const sources = await sourcesFor(launch)
    const needsUsd = sources.some((s) => s.venue !== 'curve' && s.quoteKind === 'usdg')
    const ethUsd = needsUsd ? await prices.ethUsd() : null
    const all: TapeTrade[] = []
    for (const source of sources) {
      all.push(...(await getTokenTrades(client, launch.token, source, fromBlock, toBlock, { chunk: 5_000n, ethUsd })))
    }
    return all.sort((a, b) => (a.block !== b.block ? (a.block < b.block ? -1 : 1) : a.txIndex !== b.txIndex ? a.txIndex - b.txIndex : a.logIndex - b.logIndex))
  }

  async function pricePath(launch: LaunchRecord, fromBlock: bigint, toBlock: bigint): Promise<PricePoint[]> {
    const tape = await trades(launch, fromBlock, toBlock)
    const out: PricePoint[] = []
    for (const t of tape) {
      if (t.tokenAmount === 0n || t.quoteWei === 0n) continue
      const tokens = Number(formatUnits(t.tokenAmount, launch.decimals))
      const eth = Number(formatUnits(t.quoteWei, 18))
      if (!(tokens > 0) || !(eth > 0)) continue
      out.push({ block: t.block, at: t.at, priceEth: eth / tokens, isBuy: t.isBuy, quoteWei: t.quoteWei })
    }
    return out
  }

  async function poolLiquidity(pool: Address): Promise<bigint | null> {
    try {
      return await withRpcRetry(() => client.readContract({ address: pool, abi: uniswapV3PoolAbi, functionName: 'liquidity' }))
    } catch (err) {
      log.warn({ pool, err: errorText(err) }, 'history: liquidity read failed')
      return null
    }
  }

  async function txCounts(addresses: readonly Address[], block: bigint): Promise<Map<Address, number>> {
    const out = new Map<Address, number>()
    const unique = [...new Set(addresses.map((a) => getAddress(a)))]
    await mapLimit(unique, 12, async (a) => {
      try {
        out.set(a, await withRpcRetry(() => client.getTransactionCount({ address: a, blockNumber: block })))
      } catch (err) {
        log.debug({ address: a, block: block.toString(), err: errorText(err) }, 'history: historical nonce unavailable')
      }
    })
    return out
  }

  async function balanceAt(token: Address, holder: Address, block: bigint): Promise<{ balance: bigint; historical: boolean } | null> {
    try {
      const balance = await withRpcRetry(() => client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [holder], blockNumber: block }))
      return { balance, historical: true }
    } catch {
      try {
        const balance = await withRpcRetry(() => client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [holder] }))
        return { balance, historical: false }
      } catch (err) {
        log.debug({ token, holder, err: errorText(err) }, 'history: balance unavailable')
        return null
      }
    }
  }

  async function funderOf(wallets: readonly Address[], max = 40): Promise<{ funders: Map<Address, Address>; failed: boolean }> {
    const funders = new Map<Address, Address>()
    const todo = wallets.slice(0, max)
    let failures = 0
    await mapLimit(todo, 4, async (w) => {
      try {
        const res = await fetch(`${BLOCKSCOUT}/api/v2/addresses/${w}/transactions?filter=to`, { headers: { accept: 'application/json', 'user-agent': BROWSER_UA }, signal: AbortSignal.timeout(4_000) })
        if (!res.ok) throw new Error(`blockscout ${res.status}`)
        const body = (await res.json()) as { items?: { from?: { hash?: string }; value?: string }[] }
        const funded = [...(body.items ?? [])].reverse().find((i) => i.from?.hash && i.value && BigInt(i.value) > 0n)
        if (funded?.from?.hash) funders.set(w, getAddress(funded.from.hash))
      } catch {
        failures++
      }
    })
    return { funders, failed: todo.length > 0 && failures === todo.length }
  }

  async function findLaunch(token: Address): Promise<LaunchEvent | null> {
    const head = await headBlock()
    const from = NOXA_ADDRESSES.deployBlock
    const a = chain.addresses
    const opts = { chunk: 2_000_000n, maxChunk: 4_000_000n }
    const [noxa, curve, refl, instant] = await Promise.all([
      getLogsChunked(client, { address: a.noxaFactory, event: noxaTokenLaunchedEvent, args: { token }, fromBlock: from, toBlock: head }, opts),
      getLogsChunked(client, { address: [a.odysseyBonding, a.odysseyLegacy], event: ev(odysseyCurveAbi, 'TokenCreated'), args: { token }, fromBlock: from, toBlock: head }, opts),
      getLogsChunked(client, { address: a.odysseyReflection, event: ev(odysseyReflectionPoolAbi, 'TokenCreated'), args: { token }, fromBlock: from, toBlock: head }, opts),
      getLogsChunked(client, { address: a.odysseyInstant, event: ev(odysseyInstantAbi, 'InstantTokenCreated'), args: { token }, fromBlock: from, toBlock: head }, opts),
    ])
    const hit = noxa[0] ?? curve[0] ?? refl[0] ?? instant[0]
    if (hit) {
      // Re-run the watcher's own decoder on the block that holds the event so
      // the record is shaped exactly as a live launch.
      const scan = await scanLaunches(hit.blockNumber ?? 0n, hit.blockNumber ?? 0n)
      return scan.launches.find((l) => l.token.toLowerCase() === token.toLowerCase()) ?? null
    }
    const [as0, as1] = await Promise.all([
      getLogsChunked(client, { address: a.uniswapV3Factory, event: uniswapV3PoolCreatedEvent as never, args: { token0: token }, fromBlock: from, toBlock: head }, opts),
      getLogsChunked(client, { address: a.uniswapV3Factory, event: uniswapV3PoolCreatedEvent as never, args: { token1: token }, fromBlock: from, toBlock: head }, opts),
    ])
    const created = as0[0] ?? as1[0]
    if (!created) return null
    const scan = await scanLaunches(created.blockNumber ?? 0n, created.blockNumber ?? 0n)
    return scan.launches.find((l) => l.token.toLowerCase() === token.toLowerCase()) ?? null
  }

  async function ethUsd(): Promise<number | null> {
    try {
      return await prices.ethUsd()
    } catch (err) {
      log.warn({ err: errorText(err) }, 'history: ETH/USD unavailable')
      return null
    }
  }

  return { chain, headBlock, blockTimeMs, blockAtTime, scanLaunches, tradeSourceFor, trades, pricePath, poolLiquidity, txCounts, balanceAt, funderOf, findLaunch, ethUsd }
}

/** The Odyssey factories, for callers that filter curve events. */
export const ODYSSEY_FACTORIES: readonly Address[] = [
  ODYSSEY_ADDRESSES.bondingCurveFactory, ODYSSEY_ADDRESSES.reflectionFactory, ODYSSEY_ADDRESSES.instantFactory, ODYSSEY_ADDRESSES.legacyFactory,
]
