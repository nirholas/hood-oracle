/**
 * Bounded log reads. The public RPC does not cap the block range of
 * eth_getLogs; it caps the RESULT (measured 2026-09-03: "logs matched by query
 * exceeds limit of 10000", 50000 for single-block queries), times long
 * queries out ("log query timed out", also returned as -32602), and answers
 * HTTP 429 under a burst. So the chunker is adaptive: it starts at a
 * comfortable span, halves on a too-wide answer, backs off on a 429, and grows
 * again after clean chunks. Results come back ordered by (block, logIndex).
 */
import { type Abi, type AbiEvent, type Address, type Hash, type PublicClient, decodeEventLog, parseEventLogs, getAddress } from 'viem'
import { odysseyCurveAbi, uniswapV3PoolAbi, uniswapV3SwapEvent, uniswapV4PoolManagerAbi, uniswapV4SwapEvent, erc20TransferEvent } from './abis.js'
import { isLogRangeTooWide, isTransientRpcError, mapLimit, sleep, withRpcRetry } from './client.js'
import type { TapeTrade, TapeTransfer } from '../engine/features.js'

export interface ChunkOptions {
  /** Starting span per request. */
  chunk?: bigint
  minChunk?: bigint
  maxChunk?: bigint
  onChunk?: (info: { from: bigint; to: bigint; logs: number; ms: number }) => void
  onShrink?: (info: { from: bigint; chunk: bigint; reason: string }) => void
}

export interface LogQuery {
  address?: Address | Address[]
  event?: AbiEvent
  events?: readonly AbiEvent[]
  args?: Record<string, unknown>
  fromBlock: bigint
  toBlock: bigint
}

export type RawLog = Awaited<ReturnType<PublicClient['getLogs']>>[number]

const DEFAULT_CHUNK = 20_000n
const MIN_CHUNK = 64n
const MAX_CHUNK = 500_000n

/**
 * eth_getLogs over [fromBlock, toBlock] in adaptive chunks. Never returns a
 * partial range silently: a chunk that keeps failing below the minimum span
 * throws, so a caller building a feature snapshot can mark the input missing
 * instead of computing on a hole.
 */
export async function getLogsChunked(client: PublicClient, query: LogQuery, opts: ChunkOptions = {}): Promise<RawLog[]> {
  const minChunk = opts.minChunk ?? MIN_CHUNK
  const maxChunk = opts.maxChunk ?? MAX_CHUNK
  let chunk = opts.chunk ?? DEFAULT_CHUNK
  if (chunk < minChunk) chunk = minChunk
  const out: RawLog[] = []
  let from = query.fromBlock
  let clean = 0
  let backoff = 0
  while (from <= query.toBlock) {
    const to = from + chunk - 1n > query.toBlock ? query.toBlock : from + chunk - 1n
    const t = Date.now()
    try {
      const logs = await client.getLogs({
        ...(query.address ? { address: query.address } : {}),
        ...(query.event ? { event: query.event, ...(query.args ? { args: query.args } : {}) } : {}),
        ...(query.events ? { events: query.events } : {}),
        fromBlock: from,
        toBlock: to,
        strict: false,
      } as Parameters<PublicClient['getLogs']>[0])
      out.push(...logs)
      opts.onChunk?.({ from, to, logs: logs.length, ms: Date.now() - t })
      from = to + 1n
      backoff = 0
      clean++
      if (clean >= 3 && chunk < maxChunk) {
        chunk = chunk * 3n / 2n
        if (chunk > maxChunk) chunk = maxChunk
        clean = 0
      }
    } catch (err) {
      clean = 0
      if (isLogRangeTooWide(err) && chunk > minChunk) {
        chunk = chunk / 2n
        if (chunk < minChunk) chunk = minChunk
        opts.onShrink?.({ from, chunk, reason: 'range too wide' })
        continue
      }
      if (isTransientRpcError(err) && backoff < 6) {
        backoff++
        const delay = Math.round(300 * 2 ** (backoff - 1) * (1 + Math.random() * 0.4))
        opts.onShrink?.({ from, chunk, reason: `transient, retry in ${delay}ms` })
        await sleep(delay)
        continue
      }
      throw err
    }
  }
  out.sort(compareLogs)
  return out
}

export function compareLogs(a: { blockNumber: bigint | null; logIndex: number | null }, b: { blockNumber: bigint | null; logIndex: number | null }): number {
  const ab = a.blockNumber ?? 0n
  const bb = b.blockNumber ?? 0n
  if (ab !== bb) return ab < bb ? -1 : 1
  return (a.logIndex ?? 0) - (b.logIndex ?? 0)
}

// ── block timestamps ──────────────────────────────────────────────────────────

const blockTs = new Map<string, number>()
const BLOCK_TS_CACHE = 8_192

/** Wall-clock ms of each block, batched and cached (immutable once mined). */
export async function blockTimestamps(client: PublicClient, blocks: Iterable<bigint>): Promise<Map<bigint, number>> {
  const want = [...new Set([...blocks].map(String))].map(BigInt)
  const out = new Map<bigint, number>()
  const missing: bigint[] = []
  for (const b of want) {
    const hit = blockTs.get(String(b))
    if (hit !== undefined) out.set(b, hit)
    else missing.push(b)
  }
  await mapLimit(missing, 24, async (b) => {
    const block = await withRpcRetry(() => client.getBlock({ blockNumber: b, includeTransactions: false }))
    const ms = Number(block.timestamp) * 1000
    out.set(b, ms)
    blockTs.set(String(b), ms)
  })
  while (blockTs.size > BLOCK_TS_CACHE) blockTs.delete(blockTs.keys().next().value!)
  return out
}

// ── token history ─────────────────────────────────────────────────────────────

/** What the pool's other side is. USDG amounts (6 decimals) are converted to ETH wei with the caller's ethUsd. */
export type QuoteKind = 'eth' | 'usdg'

export interface PoolTradeSource {
  venue: 'pool'
  pool: Address
  /** true when the launch token is token0 of the pool. */
  tokenIsToken0: boolean
  quoteKind?: QuoteKind
}

export interface CurveTradeSource {
  venue: 'curve'
  /** The Odyssey factory that owns the curve. */
  factory: Address
}

export interface V4TradeSource {
  venue: 'v4'
  poolManager: Address
  poolId: Hash
  /** true when the launch token is currency0 of the v4 pool. */
  tokenIsCurrency0: boolean
  quoteKind: QuoteKind
}

export type TradeSource = PoolTradeSource | CurveTradeSource | V4TradeSource

/** Raw quote units to ETH wei. USDG needs a live ETH/USD; without one the tape cannot be denominated. */
export function quoteToWei(raw: bigint, kind: QuoteKind, ethUsd: number | null): bigint {
  if (kind === 'eth') return raw
  if (ethUsd == null || !(ethUsd > 0)) throw new Error('a USDG-quoted tape needs ethUsd to denominate in ETH')
  // raw is 6-decimal dollars; wei = raw / 1e6 / ethUsd * 1e18
  return (raw * 1_000_000_000_000n * 1_000_000n) / BigInt(Math.round(ethUsd * 1_000_000))
}

/** Read pool immutables once; the launch token must be one side of the pair. */
export async function resolvePoolSide(client: PublicClient, pool: Address, token: Address): Promise<{ tokenIsToken0: boolean; quote: Address; fee: number }> {
  const [t0, t1, fee] = await withRpcRetry(() => client.multicall({
    contracts: [
      { address: pool, abi: uniswapV3PoolAbi, functionName: 'token0' },
      { address: pool, abi: uniswapV3PoolAbi, functionName: 'token1' },
      { address: pool, abi: uniswapV3PoolAbi, functionName: 'fee' },
    ],
    allowFailure: false,
  }))
  const tok = token.toLowerCase()
  if (t0.toLowerCase() === tok) return { tokenIsToken0: true, quote: getAddress(t1), fee }
  if (t1.toLowerCase() === tok) return { tokenIsToken0: false, quote: getAddress(t0), fee }
  throw new Error(`pool ${pool} does not contain token ${token}`)
}

/**
 * Decode a Uniswap v3 Swap log into a tape trade. amount0/amount1 are the
 * pool's deltas (positive = into the pool), so the launch token leaving the
 * pool is a buy. `trader` is the swap recipient (the router's msg.sender for
 * router swaps, since SwapRouter02 forwards the user as recipient).
 */
export function swapLogToTrade(log: RawLog, source: PoolTradeSource, at: number, ethUsd: number | null = null): TapeTrade | null {
  let decoded
  try {
    decoded = decodeEventLog({ abi: uniswapV3PoolAbi, data: log.data, topics: log.topics, eventName: 'Swap' })
  } catch {
    return null
  }
  const a = decoded.args as { sender: Address; recipient: Address; amount0: bigint; amount1: bigint }
  const tokenDelta = source.tokenIsToken0 ? a.amount0 : a.amount1
  const quoteDelta = source.tokenIsToken0 ? a.amount1 : a.amount0
  if (tokenDelta === 0n) return null
  const isBuy = tokenDelta < 0n
  const trader = isBuy ? a.recipient : a.sender
  return {
    block: log.blockNumber ?? 0n,
    txIndex: log.transactionIndex ?? 0,
    logIndex: log.logIndex ?? 0,
    at,
    trader: getAddress(trader),
    isBuy,
    tokenAmount: tokenDelta < 0n ? -tokenDelta : tokenDelta,
    quoteWei: quoteToWei(quoteDelta < 0n ? -quoteDelta : quoteDelta, source.quoteKind ?? 'eth', ethUsd),
    txHash: log.transactionHash as Hash,
  }
}

/**
 * Decode a Uniswap v4 PoolManager Swap for one pool. v4 deltas are from the
 * swapper's perspective (positive = the swapper receives), so the launch
 * token arriving at the swapper is a buy. The event's `sender` is the router
 * that unlocked the PoolManager, not the person; `trader` is supplied by the
 * caller from the transaction sender.
 */
export function v4SwapLogToTrade(log: RawLog, source: V4TradeSource, at: number, trader: Address, ethUsd: number | null = null): TapeTrade | null {
  let decoded
  try {
    decoded = decodeEventLog({ abi: uniswapV4PoolManagerAbi, data: log.data, topics: log.topics, eventName: 'Swap' })
  } catch {
    return null
  }
  const a = decoded.args as { amount0: bigint; amount1: bigint }
  const tokenDelta = source.tokenIsCurrency0 ? a.amount0 : a.amount1
  const quoteDelta = source.tokenIsCurrency0 ? a.amount1 : a.amount0
  if (tokenDelta === 0n) return null
  return {
    block: log.blockNumber ?? 0n,
    txIndex: log.transactionIndex ?? 0,
    logIndex: log.logIndex ?? 0,
    at,
    trader,
    isBuy: tokenDelta > 0n,
    tokenAmount: tokenDelta < 0n ? -tokenDelta : tokenDelta,
    quoteWei: quoteToWei(quoteDelta < 0n ? -quoteDelta : quoteDelta, source.quoteKind, ethUsd),
    txHash: log.transactionHash as Hash,
  }
}

/** Decode an Odyssey `Traded` log for one token into a tape trade. */
export function curveLogToTrade(log: RawLog, at: number): TapeTrade | null {
  let decoded
  try {
    decoded = decodeEventLog({ abi: odysseyCurveAbi, data: log.data, topics: log.topics, eventName: 'Traded' })
  } catch {
    return null
  }
  const a = decoded.args as { token: Address; trader: Address; isBuy: boolean; tokenAmount: bigint; quoteAmount: bigint; fee: bigint }
  return {
    block: log.blockNumber ?? 0n,
    txIndex: log.transactionIndex ?? 0,
    logIndex: log.logIndex ?? 0,
    at,
    trader: getAddress(a.trader),
    isBuy: a.isBuy,
    tokenAmount: a.tokenAmount,
    // A buy pays cost + fee; a sell receives gross - fee. The tape carries what
    // the trader actually moved in ETH terms.
    quoteWei: a.isBuy ? a.quoteAmount + a.fee : a.quoteAmount - a.fee,
    txHash: log.transactionHash as Hash,
  }
}

const tradedEvent = odysseyCurveAbi.find((x) => x.type === 'event' && x.name === 'Traded') as AbiEvent

const txSenders = new Map<string, Address>()

/** Transaction senders for a set of hashes, batched and cached (v4 swaps need them for trader attribution). */
export async function transactionSenders(client: PublicClient, hashes: Iterable<Hash>): Promise<Map<string, Address>> {
  const want = [...new Set([...hashes].map((h) => h.toLowerCase()))]
  const out = new Map<string, Address>()
  const missing: string[] = []
  for (const h of want) {
    const hit = txSenders.get(h)
    if (hit) out.set(h, hit)
    else missing.push(h)
  }
  await mapLimit(missing, 8, async (h) => {
    const tx = await withRpcRetry(() => client.getTransaction({ hash: h as Hash }))
    out.set(h, getAddress(tx.from))
    txSenders.set(h, getAddress(tx.from))
  })
  while (txSenders.size > 20_000) txSenders.delete(txSenders.keys().next().value!)
  return out
}

/** Every trade of `token` between two blocks, decoded and time-stamped. `ethUsd` denominates USDG-quoted pools. */
export async function getTokenTrades(client: PublicClient, token: Address, source: TradeSource, fromBlock: bigint, toBlock: bigint, opts: ChunkOptions & { ethUsd?: number | null } = {}): Promise<TapeTrade[]> {
  const ethUsd = opts.ethUsd ?? null
  const logs = source.venue === 'pool'
    ? await getLogsChunked(client, { address: source.pool, event: uniswapV3SwapEvent, fromBlock, toBlock }, opts)
    : source.venue === 'v4'
      ? await getLogsChunked(client, { address: source.poolManager, event: uniswapV4SwapEvent, args: { id: source.poolId }, fromBlock, toBlock }, opts)
      : await getLogsChunked(client, { address: source.factory, event: tradedEvent, args: { token }, fromBlock, toBlock }, opts)
  const [ts, senders] = await Promise.all([
    blockTimestamps(client, logs.map((l) => l.blockNumber ?? 0n)),
    source.venue === 'v4' ? transactionSenders(client, logs.map((l) => l.transactionHash as Hash)) : Promise.resolve(new Map<string, Address>()),
  ])
  const out: TapeTrade[] = []
  for (const log of logs) {
    const at = ts.get(log.blockNumber ?? 0n) ?? 0
    const t = source.venue === 'pool'
      ? swapLogToTrade(log, source, at, ethUsd)
      : source.venue === 'v4'
        ? v4SwapLogToTrade(log, source, at, senders.get((log.transactionHash as string).toLowerCase()) ?? getAddress(log.address), ethUsd)
        : curveLogToTrade(log, at)
    if (t) out.push(t)
  }
  return out
}

/** Every ERC-20 Transfer of `token` between two blocks. */
export async function getTokenTransfers(client: PublicClient, token: Address, fromBlock: bigint, toBlock: bigint, opts: ChunkOptions = {}): Promise<TapeTransfer[]> {
  const logs = await getLogsChunked(client, { address: token, event: erc20TransferEvent as AbiEvent, fromBlock, toBlock }, opts)
  const out: TapeTransfer[] = []
  for (const log of logs) {
    try {
      const d = decodeEventLog({ abi: [erc20TransferEvent] as Abi, data: log.data, topics: log.topics })
      const a = d.args as unknown as { from: Address; to: Address; value: bigint }
      out.push({ block: log.blockNumber ?? 0n, from: getAddress(a.from), to: getAddress(a.to), value: a.value })
    } catch {
      // a non-standard Transfer (indexed value, ERC-721 style) carries no balance information
    }
  }
  return out
}

/** Typed decode helper for callers that already hold raw logs of one event set. */
export function decodeLogs<const TAbi extends Abi>(abi: TAbi, logs: RawLog[]) {
  return parseEventLogs({ abi, logs, strict: false })
}
