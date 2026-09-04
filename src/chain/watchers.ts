/**
 * Log watchers over one polling loop. Every 400ms the head is read and every
 * event class we care about is fetched for [lastScanned + 1, head]: NOXA
 * TokenLaunched, Odyssey TokenCreated (bonding + legacy), the reflection
 * factory's differently-shaped TokenCreated, InstantTokenCreated, Traded on
 * every curve factory, PoolMigrated / PoolMigratedV4, and Swap on every
 * tracked Uniswap pool. Because the scan always resumes from the last block
 * it covered, a stalled RPC or a slow tick is caught up on the next one; a
 * large gap goes through the adaptive chunker rather than one giant query.
 */
import { type AbiEvent, type Address, type Hash, getAddress, parseEventLogs } from 'viem'
import { noxaTokenLaunchedEvent } from 'hoodchain'
import { odysseyCurveAbi, odysseyInstantAbi, odysseyReflectionPoolAbi, uniswapV3PoolAbi, uniswapV3PoolCreatedEvent, uniswapV4InitializeEvent, uniswapV4SwapEvent } from './abis.js'
import { UNISWAP_V4 } from './launchpads.js'
import { errorText, isTransientRpcError, sleep, withRpcRetry } from './client.js'
import type { ChainClient } from './client.js'
import { getLogsChunked, type RawLog } from './history.js'
import type { Launchpad, Venue } from '../types.js'

export interface LaunchEvent {
  launchpad: Launchpad
  token: Address
  creator: Address
  /** Immediate Uniswap v3 pool (NOXA, Odyssey instant), null while on a curve. */
  pool: Address | null
  /** The factory contract that emitted the launch. */
  factory: Address
  blockNumber: bigint
  txHash: Hash
  logIndex: number
  /** ms when the log was seen by the watcher. */
  seenAt: number
  /** Where the token trades; derived from `pool` when absent. */
  venue?: Venue
  extra: Record<string, string | number | boolean | null>
}

/** A new Uniswap v3 pool or v4 pool initialization, before any launch classification. */
export interface DexPoolEvent {
  dex: 'v3' | 'v4'
  token0: Address
  token1: Address
  fee: number
  tickSpacing: number
  /** v3 pool contract; null for v4. */
  pool: Address | null
  /** v4 pool id; null for v3. */
  poolId: Hash | null
  hooks: Address | null
  blockNumber: bigint
  txHash: Hash
  logIndex: number
  seenAt: number
}

export interface V4SwapEvent {
  poolId: Hash
  token: Address
  log: RawLog
}

export interface CurveTradeEvent {
  factory: Address
  token: Address
  trader: Address
  isBuy: boolean
  tokenAmount: bigint
  quoteAmount: bigint
  fee: bigint
  virtualQuote: bigint
  virtualToken: bigint
  blockNumber: bigint
  txHash: Hash
  logIndex: number
}

export interface GraduationEvent {
  factory: Address
  token: Address
  /** Uniswap v3 pool for bonding/legacy graduations; null for a v4 (reflection) graduation. */
  pool: Address | null
  v4PoolId: Hash | null
  blockNumber: bigint
  txHash: Hash
}

export interface PoolSwapEvent {
  pool: Address
  token: Address
  log: RawLog
}

export interface WatcherHandlers {
  onLaunch: (e: LaunchEvent) => void
  onCurveTrade: (e: CurveTradeEvent) => void
  onGraduation: (e: GraduationEvent) => void
  onSwap: (e: PoolSwapEvent) => void
  onDexPool?: (e: DexPoolEvent) => void
  onV4Swap?: (e: V4SwapEvent) => void
  onStatus?: (level: 'info' | 'warn' | 'error', message: string) => void
}

export interface WatcherHealth {
  lastScannedBlock: bigint | null
  headBlock: bigint | null
  trackedPools: number
  lagBlocks: number | null
  lastTickMs: number
}

const reflectionTokenCreated = odysseyReflectionPoolAbi.find((x) => x.type === 'event' && x.name === 'TokenCreated') as AbiEvent
const reflectionMigratedV4 = odysseyReflectionPoolAbi.find((x) => x.type === 'event' && x.name === 'PoolMigratedV4') as AbiEvent
const instantTokenCreated = odysseyInstantAbi.find((x) => x.type === 'event' && x.name === 'InstantTokenCreated') as AbiEvent
const curveTokenCreated = odysseyCurveAbi.find((x) => x.type === 'event' && x.name === 'TokenCreated') as AbiEvent
const curveTraded = odysseyCurveAbi.find((x) => x.type === 'event' && x.name === 'Traded') as AbiEvent
const curveMigrated = odysseyCurveAbi.find((x) => x.type === 'event' && x.name === 'PoolMigrated') as AbiEvent
const swapEvent = uniswapV3PoolAbi.find((x) => x.type === 'event' && x.name === 'Swap') as AbiEvent

export class Watchers {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private ticking = false
  private lastScanned: bigint | null = null
  private head: bigint | null = null
  private lastTickMs = 0
  private readonly pools = new Map<string, Address>() // pool(lower) -> token
  private readonly v4Pools = new Map<string, Address>() // poolId(lower) -> token
  private readonly seen = new Map<string, true>()
  private consecutiveErrors = 0

  constructor(private readonly chain: ChainClient, private readonly handlers: WatcherHandlers, private readonly pollMs = 400, private readonly maxTrackedPools = 500) {}

  async start(fromBlock?: bigint): Promise<void> {
    this.running = true
    if (fromBlock != null) this.lastScanned = fromBlock
    else {
      const head = await withRpcRetry(() => this.chain.publicClient.getBlockNumber())
      this.lastScanned = head
      this.head = head
    }
    this.timer = setInterval(() => { void this.tick() }, this.pollMs)
    this.timer.unref?.()
  }

  stop(): void {
    this.running = false
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  health(): WatcherHealth {
    return {
      lastScannedBlock: this.lastScanned,
      headBlock: this.head,
      trackedPools: this.pools.size + this.v4Pools.size,
      lagBlocks: this.head != null && this.lastScanned != null ? Number(this.head - this.lastScanned) : null,
      lastTickMs: this.lastTickMs,
    }
  }

  /** Watch a Uniswap pool's Swap logs. Insertion-ordered so the oldest pool is evicted at the cap. */
  trackPool(pool: Address, token: Address): void {
    const key = pool.toLowerCase()
    if (this.pools.has(key)) return
    this.pools.set(key, token)
    while (this.pools.size > this.maxTrackedPools) this.pools.delete(this.pools.keys().next().value!)
  }

  untrackPool(pool: Address): void {
    this.pools.delete(pool.toLowerCase())
  }

  /** Watch a Uniswap v4 pool's Swap logs on the PoolManager by pool id. */
  trackV4Pool(poolId: Hash, token: Address): void {
    const key = poolId.toLowerCase()
    if (this.v4Pools.has(key)) return
    this.v4Pools.set(key, token)
    while (this.v4Pools.size > this.maxTrackedPools) this.v4Pools.delete(this.v4Pools.keys().next().value!)
  }

  untrackV4Pool(poolId: Hash): void {
    this.v4Pools.delete(poolId.toLowerCase())
  }

  trackedPools(): Address[] {
    return [...this.pools.keys()].map((p) => getAddress(p))
  }

  private once(key: string): boolean {
    if (this.seen.has(key)) return false
    this.seen.set(key, true)
    if (this.seen.size > 20_000) {
      const it = this.seen.keys()
      for (let i = 0; i < 5_000; i++) this.seen.delete(it.next().value!)
    }
    return true
  }

  private async tick(): Promise<void> {
    if (!this.running || this.ticking || this.lastScanned == null) return
    this.ticking = true
    const t = Date.now()
    try {
      const head = await this.chain.publicClient.getBlockNumber()
      this.head = head
      if (head <= this.lastScanned) return
      const from = this.lastScanned + 1n
      await this.scan(from, head)
      this.lastScanned = head
      this.consecutiveErrors = 0
    } catch (err) {
      this.consecutiveErrors++
      const level = this.consecutiveErrors >= 5 ? 'error' : 'warn'
      this.handlers.onStatus?.(level, `watcher tick failed (${this.consecutiveErrors}x): ${errorText(err)}`)
      if (isTransientRpcError(err)) await sleep(Math.min(5_000, 200 * 2 ** Math.min(this.consecutiveErrors, 5)))
    } finally {
      this.lastTickMs = Date.now() - t
      this.ticking = false
    }
  }

  /** Fetch every event class for a block range; a wide range goes through the chunker. */
  async scan(from: bigint, to: bigint): Promise<void> {
    const a = this.chain.addresses
    const wide = to - from > 2_000n
    const pull = (address: Address | Address[], event: AbiEvent): Promise<RawLog[]> =>
      wide
        ? getLogsChunked(this.chain.publicClient, { address, event, fromBlock: from, toBlock: to }, { chunk: 2_000n })
        : this.chain.publicClient.getLogs({ address, event, fromBlock: from, toBlock: to, strict: false })
    const trackedPools = this.trackedPools()
    const v4Ids = [...this.v4Pools.keys()] as Hash[]
    const [noxaLogs, curveCreated, reflCreated, instantCreated, traded, migrated, migratedV4, swaps, poolsCreated, v4Inits, v4Swaps] = await Promise.all([
      pull(a.noxaFactory, noxaTokenLaunchedEvent),
      pull([a.odysseyBonding, a.odysseyLegacy], curveTokenCreated),
      pull(a.odysseyReflection, reflectionTokenCreated),
      pull(a.odysseyInstant, instantTokenCreated),
      pull([a.odysseyBonding, a.odysseyReflection, a.odysseyLegacy], curveTraded),
      pull([a.odysseyBonding, a.odysseyLegacy], curveMigrated),
      pull(a.odysseyReflection, reflectionMigratedV4),
      trackedPools.length ? pull(trackedPools, swapEvent) : Promise.resolve([] as RawLog[]),
      this.handlers.onDexPool ? pull(a.uniswapV3Factory, uniswapV3PoolCreatedEvent as AbiEvent) : Promise.resolve([] as RawLog[]),
      this.handlers.onDexPool ? pull(UNISWAP_V4.poolManager, uniswapV4InitializeEvent as AbiEvent) : Promise.resolve([] as RawLog[]),
      v4Ids.length
        ? (wide
          ? getLogsChunked(this.chain.publicClient, { address: UNISWAP_V4.poolManager, event: uniswapV4SwapEvent as AbiEvent, args: { id: v4Ids }, fromBlock: from, toBlock: to }, { chunk: 2_000n })
          : this.chain.publicClient.getLogs({ address: UNISWAP_V4.poolManager, event: uniswapV4SwapEvent, args: { id: v4Ids }, fromBlock: from, toBlock: to, strict: false }))
        : Promise.resolve([] as RawLog[]),
    ])
    const now = Date.now()
    for (const log of parseEventLogs({ abi: [noxaTokenLaunchedEvent], logs: noxaLogs, strict: false })) {
      const g = log.args as { token?: Address; deployer?: Address; pool?: Address; restrictionsEndBlock?: bigint; initialBuyAmount?: bigint; pairToken?: Address }
      if (!g.token || !g.deployer || !this.once(`launch:${log.transactionHash}:${log.logIndex}`)) continue
      this.handlers.onLaunch({
        launchpad: 'noxa', token: getAddress(g.token), creator: getAddress(g.deployer), pool: g.pool ? getAddress(g.pool) : null, factory: getAddress(log.address),
        blockNumber: log.blockNumber, txHash: log.transactionHash, logIndex: log.logIndex, seenAt: now,
        extra: { restrictionsEndBlock: g.restrictionsEndBlock != null ? g.restrictionsEndBlock.toString() : null, initialBuyAmount: g.initialBuyAmount != null ? g.initialBuyAmount.toString() : null, pairToken: g.pairToken ?? null },
      })
    }
    for (const log of parseEventLogs({ abi: [curveTokenCreated], logs: curveCreated, strict: false })) {
      const g = log.args as { token?: Address; creator?: Address; backingWallet?: Address; isMarginBacked?: boolean; threshold?: bigint }
      if (!g.token || !g.creator || !this.once(`launch:${log.transactionHash}:${log.logIndex}`)) continue
      this.handlers.onLaunch({
        launchpad: 'odyssey', token: getAddress(g.token), creator: getAddress(g.creator), pool: null, factory: getAddress(log.address),
        blockNumber: log.blockNumber, txHash: log.transactionHash, logIndex: log.logIndex, seenAt: now,
        extra: { backingWallet: g.backingWallet ?? null, isMarginBacked: g.isMarginBacked ?? null, threshold: g.threshold != null ? g.threshold.toString() : null, curveKind: 'bonding' },
      })
    }
    for (const log of parseEventLogs({ abi: [reflectionTokenCreated], logs: reflCreated, strict: false })) {
      const g = log.args as { token?: Address; creator?: Address; rewardToken?: Address; threshold?: bigint }
      if (!g.token || !g.creator || !this.once(`launch:${log.transactionHash}:${log.logIndex}`)) continue
      this.handlers.onLaunch({
        launchpad: 'odyssey', token: getAddress(g.token), creator: getAddress(g.creator), pool: null, factory: getAddress(log.address),
        blockNumber: log.blockNumber, txHash: log.transactionHash, logIndex: log.logIndex, seenAt: now,
        extra: { rewardToken: g.rewardToken ?? null, threshold: g.threshold != null ? g.threshold.toString() : null, curveKind: 'reflection' },
      })
    }
    for (const log of parseEventLogs({ abi: [instantTokenCreated], logs: instantCreated, strict: false })) {
      const g = log.args as { token?: Address; creator?: Address; backingWallet?: Address; isMeme?: boolean; isMargin?: boolean; isRwa?: boolean; pool?: Address; dexId?: number }
      if (!g.token || !g.creator || !this.once(`launch:${log.transactionHash}:${log.logIndex}`)) continue
      this.handlers.onLaunch({
        launchpad: 'odyssey', token: getAddress(g.token), creator: getAddress(g.creator), pool: g.pool ? getAddress(g.pool) : null, factory: getAddress(log.address),
        blockNumber: log.blockNumber, txHash: log.transactionHash, logIndex: log.logIndex, seenAt: now,
        extra: { backingWallet: g.backingWallet ?? null, isMeme: g.isMeme ?? null, isMargin: g.isMargin ?? null, isRwa: g.isRwa ?? null, dexId: g.dexId ?? null, curveKind: 'instant' },
      })
    }
    for (const log of parseEventLogs({ abi: [curveTraded], logs: traded, strict: false })) {
      const g = log.args as { token?: Address; trader?: Address; isBuy?: boolean; tokenAmount?: bigint; quoteAmount?: bigint; fee?: bigint; virtualQuote?: bigint; virtualToken?: bigint }
      if (!g.token || !g.trader || g.isBuy == null || !this.once(`trade:${log.transactionHash}:${log.logIndex}`)) continue
      this.handlers.onCurveTrade({
        factory: getAddress(log.address), token: getAddress(g.token), trader: getAddress(g.trader), isBuy: g.isBuy,
        tokenAmount: g.tokenAmount ?? 0n, quoteAmount: g.quoteAmount ?? 0n, fee: g.fee ?? 0n, virtualQuote: g.virtualQuote ?? 0n, virtualToken: g.virtualToken ?? 0n,
        blockNumber: log.blockNumber, txHash: log.transactionHash, logIndex: log.logIndex,
      })
    }
    for (const log of parseEventLogs({ abi: [curveMigrated], logs: migrated, strict: false })) {
      const g = log.args as { token?: Address; pool?: Address }
      if (!g.token || !g.pool || !this.once(`grad:${log.transactionHash}:${log.logIndex}`)) continue
      this.handlers.onGraduation({ factory: getAddress(log.address), token: getAddress(g.token), pool: getAddress(g.pool), v4PoolId: null, blockNumber: log.blockNumber, txHash: log.transactionHash })
    }
    for (const log of parseEventLogs({ abi: [reflectionMigratedV4], logs: migratedV4, strict: false })) {
      const g = log.args as { token?: Address; poolId?: Hash }
      if (!g.token || !this.once(`grad:${log.transactionHash}:${log.logIndex}`)) continue
      this.handlers.onGraduation({ factory: getAddress(log.address), token: getAddress(g.token), pool: null, v4PoolId: g.poolId ?? null, blockNumber: log.blockNumber, txHash: log.transactionHash })
    }
    for (const log of swaps) {
      const token = this.pools.get(log.address.toLowerCase())
      if (!token || !this.once(`swap:${log.transactionHash}:${log.logIndex}`)) continue
      this.handlers.onSwap({ pool: getAddress(log.address), token, log })
    }
    for (const log of parseEventLogs({ abi: [uniswapV4SwapEvent], logs: v4Swaps, strict: false })) {
      const id = (log.args as { id?: Hash }).id
      const token = id ? this.v4Pools.get(id.toLowerCase()) : undefined
      if (!id || !token || !this.once(`v4swap:${log.transactionHash}:${log.logIndex}`)) continue
      this.handlers.onV4Swap?.({ poolId: id, token, log })
    }
    // Pool creations are dispatched after the launchpad events of the same range so a
    // launch the factory announced itself is recorded under its launchpad, not as 'direct'.
    for (const log of parseEventLogs({ abi: [uniswapV3PoolCreatedEvent], logs: poolsCreated, strict: false })) {
      const g = log.args as { token0?: Address; token1?: Address; fee?: number; tickSpacing?: number; pool?: Address }
      if (!g.token0 || !g.token1 || !g.pool || !this.once(`pool:${log.transactionHash}:${log.logIndex}`)) continue
      this.handlers.onDexPool?.({ dex: 'v3', token0: getAddress(g.token0), token1: getAddress(g.token1), fee: g.fee ?? 0, tickSpacing: g.tickSpacing ?? 0, pool: getAddress(g.pool), poolId: null, hooks: null, blockNumber: log.blockNumber, txHash: log.transactionHash, logIndex: log.logIndex, seenAt: now })
    }
    for (const log of parseEventLogs({ abi: [uniswapV4InitializeEvent], logs: v4Inits, strict: false })) {
      const g = log.args as { id?: Hash; currency0?: Address; currency1?: Address; fee?: number; tickSpacing?: number; hooks?: Address }
      if (!g.id || !g.currency0 || !g.currency1 || !this.once(`v4init:${log.transactionHash}:${log.logIndex}`)) continue
      this.handlers.onDexPool?.({ dex: 'v4', token0: getAddress(g.currency0), token1: getAddress(g.currency1), fee: g.fee ?? 0, tickSpacing: g.tickSpacing ?? 0, pool: null, poolId: g.id, hooks: g.hooks ? getAddress(g.hooks) : null, blockNumber: log.blockNumber, txHash: log.transactionHash, logIndex: log.logIndex, seenAt: now })
    }
  }
}
