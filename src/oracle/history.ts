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
import { type AbiEvent, type Address, type Hash, erc20Abi, formatUnits, getAddress, parseEventLogs } from 'viem'
import { NOXA_ADDRESSES, ODYSSEY_ADDRESSES, noxaTokenLaunchedEvent, uniswapV3PoolAbi } from 'hoodchain'
import type { ChainClient } from '../chain/client.js'
import { errorText, mapLimit, withRpcRetry } from '../chain/client.js'
import { erc20TransferEvent, odysseyCurveAbi, odysseyInstantAbi, odysseyReflectionPoolAbi, uniswapV3PoolCreatedEvent } from '../chain/abis.js'
import { blockTimestamps, getLogsChunked, getTokenTrades, resolvePoolSide, type QuoteKind, type TradeSource } from '../chain/history.js'
import { UNISWAP_V4, launchpadEntry, launchpadNameFor } from '../chain/launchpads.js'
import type { Prices } from '../chain/prices.js'
import type { GraduationEvent, LaunchEvent } from '../chain/watchers.js'
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

const ZERO = '0x0000000000000000000000000000000000000000' as Address
/** A token is a launch only if it was minted this many blocks (about 3.5 minutes) before its pool; mirrors the live intake. */
const FRESH_BLOCKS = 2_000n
const RATE_LIMIT_RESET_MS = 61_000

/** The public RPC's quota answer, at any depth of viem's error chain. */
export function isRateLimited(err: unknown): boolean {
  let e: unknown = err
  for (let depth = 0; e && typeof e === 'object' && depth < 6; depth++) {
    const o = e as { code?: unknown; status?: unknown; message?: unknown; details?: unknown; cause?: unknown }
    // A 403 from the public RPC is its edge blocking a burst, not a permissions problem; it clears with the quota.
    if (o.code === 429 || o.status === 429 || o.status === 403) return true
    const text = `${typeof o.message === 'string' ? o.message : ''} ${typeof o.details === 'string' ? o.details : ''}`
    if (/rate limit|too many requests/i.test(text)) return true
    e = o.cause
  }
  return false
}

const ev = (abi: readonly unknown[], name: string): AbiEvent => abi.find((x) => (x as { type: string; name: string }).type === 'event' && (x as { name: string }).name === name) as AbiEvent
const curveTokenCreated = ev(odysseyCurveAbi, 'TokenCreated')
const reflectionTokenCreated = ev(odysseyReflectionPoolAbi, 'TokenCreated')
const instantTokenCreated = ev(odysseyInstantAbi, 'InstantTokenCreated')
const curveMigrated = ev(odysseyCurveAbi, 'PoolMigrated')
const reflectionMigratedV4 = ev(odysseyReflectionPoolAbi, 'PoolMigratedV4')

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
  /** Run a chain read, waiting out the RPC's rate-limit window when a burst exhausts it. */
  patient<T>(label: string, fn: () => Promise<T>): Promise<T>
}

export function createOracleHistory({ chain, prices, log }: { chain: ChainClient; prices: Prices; log: Logger }): OracleHistory {
  const client = chain.publicClient
  const usdg = chain.addresses.usdg.toLowerCase()

  const headBlock = () => patient('head', () => withRpcRetry(() => client.getBlockNumber()))

  async function blockTimeMs(block: bigint): Promise<number> {
    const ts = await patient('block time', () => blockTimestamps(client, [block]))
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

  /**
   * Retry a chain read across the public RPC's rate-limit window. The
   * chunker's own backoff totals about 19 s; the RPC resets its quota after
   * 60 s, so a burst that exhausts it must wait the full window once before
   * the read can succeed. The wait timer is ref'd on purpose (a script has
   * nothing else keeping the loop alive).
   */
  async function patient<T>(label: string, fn: () => Promise<T>, attempts = 6): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn()
      } catch (err) {
        if (attempt >= attempts || !isRateLimited(err)) throw err
        log.warn({ label, attempt, waitMs: RATE_LIMIT_RESET_MS }, 'history: rate limited, waiting for the quota to reset')
        await new Promise<void>((r) => setTimeout(r, RATE_LIMIT_RESET_MS))
      }
    }
  }

  const chunkOpts = { chunk: 250_000n, minChunk: 2_000n, maxChunk: 2_000_000n }
  const pull = (label: string, address: Address | Address[], event: AbiEvent, fromBlock: bigint, toBlock: bigint, args?: Record<string, unknown>) =>
    patient(label, () => getLogsChunked(client, { address, event, ...(args ? { args } : {}), fromBlock, toBlock }, chunkOpts))

  async function scanLaunches(fromBlock: bigint, toBlock: bigint, opts: { isKnownToken?: (token: Address) => boolean; onProgress?: (info: { from: bigint; to: bigint; launches: number }) => void } = {}): Promise<LaunchScan> {
    const a = chain.addresses
    const launches: LaunchEvent[] = []
    const graduations: GraduationEvent[] = []
    const seen = new Set<string>()
    const stats = { seen: 0, accepted: 0, skippedQuote: 0, skippedStale: 0, skippedKnown: 0, errors: 0 }
    const known = (token: Address) => seen.has(token.toLowerCase()) || (opts.isKnownToken?.(token) ?? false)
    const now = Date.now()
    const add = (e: LaunchEvent) => {
      if (seen.has(e.token.toLowerCase())) return
      seen.add(e.token.toLowerCase())
      launches.push(e)
    }

    // Launchpad events first, so a launch the factory announced itself is
    // recorded under its launchpad and never re-classified as 'direct'.
    // Sequential on purpose: the public RPC's quota is per minute and a
    // burst of parallel pulls is what exhausts it.
    const noxaLogs = await pull('noxa launches', a.noxaFactory, noxaTokenLaunchedEvent as AbiEvent, fromBlock, toBlock)
    for (const log of parseEventLogs({ abi: [noxaTokenLaunchedEvent], logs: noxaLogs, strict: false })) {
      const g = log.args as { token?: Address; deployer?: Address; pool?: Address; restrictionsEndBlock?: bigint; initialBuyAmount?: bigint; pairToken?: Address }
      if (!g.token || !g.deployer) continue
      add({
        launchpad: 'noxa', token: getAddress(g.token), creator: getAddress(g.deployer), pool: g.pool ? getAddress(g.pool) : null, factory: getAddress(log.address),
        blockNumber: log.blockNumber, txHash: log.transactionHash, logIndex: log.logIndex, seenAt: now,
        extra: { restrictionsEndBlock: g.restrictionsEndBlock != null ? g.restrictionsEndBlock.toString() : null, initialBuyAmount: g.initialBuyAmount != null ? g.initialBuyAmount.toString() : null, pairToken: g.pairToken ?? null },
      })
    }
    const curveCreated = await pull('odyssey curve launches', [a.odysseyBonding, a.odysseyLegacy], curveTokenCreated, fromBlock, toBlock)
    for (const log of parseEventLogs({ abi: [curveTokenCreated], logs: curveCreated, strict: false })) {
      const g = log.args as { token?: Address; creator?: Address; backingWallet?: Address; isMarginBacked?: boolean; threshold?: bigint }
      if (!g.token || !g.creator) continue
      add({
        launchpad: 'odyssey', token: getAddress(g.token), creator: getAddress(g.creator), pool: null, factory: getAddress(log.address),
        blockNumber: log.blockNumber, txHash: log.transactionHash, logIndex: log.logIndex, seenAt: now,
        extra: { backingWallet: g.backingWallet ?? null, isMarginBacked: g.isMarginBacked ?? null, threshold: g.threshold != null ? g.threshold.toString() : null, curveKind: 'bonding' },
      })
    }
    const reflCreated = await pull('odyssey reflection launches', a.odysseyReflection, reflectionTokenCreated, fromBlock, toBlock)
    for (const log of parseEventLogs({ abi: [reflectionTokenCreated], logs: reflCreated, strict: false })) {
      const g = log.args as { token?: Address; creator?: Address; rewardToken?: Address; threshold?: bigint }
      if (!g.token || !g.creator) continue
      add({
        launchpad: 'odyssey', token: getAddress(g.token), creator: getAddress(g.creator), pool: null, factory: getAddress(log.address),
        blockNumber: log.blockNumber, txHash: log.transactionHash, logIndex: log.logIndex, seenAt: now,
        extra: { rewardToken: g.rewardToken ?? null, threshold: g.threshold != null ? g.threshold.toString() : null, curveKind: 'reflection' },
      })
    }
    const instantCreated = await pull('odyssey instant launches', a.odysseyInstant, instantTokenCreated, fromBlock, toBlock)
    for (const log of parseEventLogs({ abi: [instantTokenCreated], logs: instantCreated, strict: false })) {
      const g = log.args as { token?: Address; creator?: Address; backingWallet?: Address; isMeme?: boolean; isMargin?: boolean; isRwa?: boolean; pool?: Address; dexId?: number }
      if (!g.token || !g.creator) continue
      add({
        launchpad: 'odyssey', token: getAddress(g.token), creator: getAddress(g.creator), pool: g.pool ? getAddress(g.pool) : null, factory: getAddress(log.address),
        blockNumber: log.blockNumber, txHash: log.transactionHash, logIndex: log.logIndex, seenAt: now,
        extra: { backingWallet: g.backingWallet ?? null, isMeme: g.isMeme ?? null, isMargin: g.isMargin ?? null, isRwa: g.isRwa ?? null, dexId: g.dexId ?? null, curveKind: 'instant' },
      })
    }
    const migrated = await pull('odyssey graduations', [a.odysseyBonding, a.odysseyLegacy], curveMigrated, fromBlock, toBlock)
    for (const log of parseEventLogs({ abi: [curveMigrated], logs: migrated, strict: false })) {
      const g = log.args as { token?: Address; pool?: Address }
      if (!g.token || !g.pool) continue
      graduations.push({ factory: getAddress(log.address), token: getAddress(g.token), pool: getAddress(g.pool), v4PoolId: null, blockNumber: log.blockNumber, txHash: log.transactionHash })
    }
    const migratedV4 = await pull('odyssey v4 graduations', a.odysseyReflection, reflectionMigratedV4, fromBlock, toBlock)
    for (const log of parseEventLogs({ abi: [reflectionMigratedV4], logs: migratedV4, strict: false })) {
      const g = log.args as { token?: Address; poolId?: Hash }
      if (!g.token) continue
      graduations.push({ factory: getAddress(log.address), token: getAddress(g.token), pool: null, v4PoolId: g.poolId ?? null, blockNumber: log.blockNumber, txHash: log.transactionHash })
    }

    // Direct launches: every Uniswap v3 PoolCreated pairing WETH or USDG with
    // a token minted inside the freshness window before the pool. The live
    // intake tests freshness with getCode at an earlier block; the public RPC
    // prunes that state after about an hour, so history uses the intake's own
    // fallback signal instead: a mint (Transfer from the zero address) inside
    // the window. v4 Initialize is left to the live engine: it is ~5k events
    // per day, mostly existing tokens re-paired behind fee hooks, and the
    // executor cannot route a v4 pool.
    const poolsCreated = await pull('v3 pool creations', a.uniswapV3Factory, uniswapV3PoolCreatedEvent as AbiEvent, fromBlock, toBlock)
    const pools = parseEventLogs({ abi: [uniswapV3PoolCreatedEvent], logs: poolsCreated, strict: false })
    for (const created of pools) {
      const g = created.args as { token0?: Address; token1?: Address; fee?: number; tickSpacing?: number; pool?: Address }
      if (!g.token0 || !g.token1 || !g.pool) continue
      stats.seen++
      const pair = classifyPair(getAddress(g.token0), getAddress(g.token1))
      if (!pair) {
        stats.skippedQuote++
        continue
      }
      if (known(pair.token)) {
        stats.skippedKnown++
        continue
      }
      try {
        const fresh = await patient('freshness', () => firstMint(pair.token, created.blockNumber))
        if (!fresh) {
          stats.skippedStale++
          continue
        }
        const tx = await patient('creating tx', () => withRpcRetry(() => client.getTransaction({ hash: created.transactionHash })))
        const creatingTo = tx.to ? getAddress(tx.to) : null
        const launchpad = launchpadNameFor(creatingTo, null)
        const entry = launchpadEntry(creatingTo)
        const creator = await resolveCreator(pair.token, fresh.txHash, getAddress(tx.from))
        stats.accepted++
        add({
          launchpad,
          token: pair.token,
          creator: creator.address,
          pool: getAddress(g.pool),
          factory: creatingTo ?? pair.token,
          blockNumber: created.blockNumber,
          txHash: created.transactionHash,
          logIndex: created.logIndex,
          seenAt: now,
          venue: 'pool',
          extra: {
            intake: 'pool_created', dex: 'v3', quote: pair.quote, quoteSide: pair.quoteSide, fee: g.fee ?? 0, tickSpacing: g.tickSpacing ?? 0,
            hooks: null, poolId: null, poolManager: null, creatingTo, creatingFrom: getAddress(tx.from), creatingSelector: tx.input.slice(0, 10),
            creatingLabel: entry?.label ?? null, seedLiquidityWei: null, seedLiquidityRaw: null, creatorSource: creator.source, mintTx: fresh.txHash,
          },
        })
      } catch (err) {
        stats.errors++
        log.warn({ token: pair.token, tx: created.transactionHash, err: errorText(err) }, 'history: pool intake failed')
      }
    }

    launches.sort((a, b) => (a.blockNumber !== b.blockNumber ? (a.blockNumber < b.blockNumber ? -1 : 1) : a.logIndex - b.logIndex))
    opts.onProgress?.({ from: fromBlock, to: toBlock, launches: launches.length })
    return { launches, graduations, intake: stats }
  }

  /** Which side of a v3 pair is the quote, or null when the pair is not a launch pair. */
  function classifyPair(token0: Address, token1: Address): { token: Address; quote: Address; quoteSide: 'WETH' | 'USDG'; tokenIsToken0: boolean } | null {
    const weth = chain.addresses.weth.toLowerCase()
    const side = (x: Address): 'WETH' | 'USDG' | null => (x.toLowerCase() === weth ? 'WETH' : x.toLowerCase() === usdg ? 'USDG' : null)
    const s0 = side(token0)
    const s1 = side(token1)
    if (s0 && s1) return null
    if (s0) return { token: token1, quote: token0, quoteSide: s0, tokenIsToken0: false }
    if (s1) return { token: token0, quote: token1, quoteSide: s1, tokenIsToken0: true }
    return null
  }

  /** The token's first mint inside the freshness window before `poolBlock`, or null when it is an older token. */
  async function firstMint(token: Address, poolBlock: bigint): Promise<{ txHash: Hash; block: bigint } | null> {
    const from = poolBlock > FRESH_BLOCKS ? poolBlock - FRESH_BLOCKS : 0n
    const mints = await getLogsChunked(client, { address: token, event: erc20TransferEvent as AbiEvent, args: { from: ZERO }, fromBlock: from, toBlock: poolBlock }, { chunk: FRESH_BLOCKS + 1n, minChunk: 64n })
    const first = mints[0]
    return first ? { txHash: first.transactionHash as Hash, block: first.blockNumber ?? poolBlock } : null
  }

  /** The token's deployer: Blockscout's creation record, else the first mint's sender, else the creating tx sender. */
  async function resolveCreator(token: Address, mintTx: Hash, creatingFrom: Address): Promise<{ address: Address; source: 'blockscout' | 'first_mint_tx' | 'creating_tx' }> {
    try {
      const res = await fetch(`${BLOCKSCOUT}/api?module=contract&action=getcontractcreation&contractaddresses=${token}`, { headers: { 'user-agent': BROWSER_UA }, signal: AbortSignal.timeout(4_000) })
      if (res.ok) {
        const body = (await res.json()) as { result?: { contractCreator?: string }[] | string }
        const creator = Array.isArray(body.result) ? body.result[0]?.contractCreator : undefined
        if (creator && /^0x[0-9a-fA-F]{40}$/.test(creator)) return { address: getAddress(creator), source: 'blockscout' }
      }
    } catch {
      // fall through to chain history
    }
    try {
      const tx = await patient('mint tx', () => withRpcRetry(() => client.getTransaction({ hash: mintTx })))
      return { address: getAddress(tx.from), source: 'first_mint_tx' }
    } catch {
      return { address: creatingFrom, source: 'creating_tx' }
    }
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
        const side = await patient('pool side', () => resolvePoolSide(client, launch.pool!, launch.token))
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
      all.push(...(await patient('trades', () => getTokenTrades(client, launch.token, source, fromBlock, toBlock, { chunk: 50_000n, maxChunk: 2_000_000n, ethUsd }))))
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
      return await patient('liquidity', () => withRpcRetry(() => client.readContract({ address: pool, abi: uniswapV3PoolAbi, functionName: 'liquidity' })))
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
        out.set(a, await patient('nonce', () => withRpcRetry(() => client.getTransactionCount({ address: a, blockNumber: block })), 2))
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
    const noxa = await pull('find noxa', a.noxaFactory, noxaTokenLaunchedEvent as AbiEvent, from, head, { token })
    const curve = await pull('find curve', [a.odysseyBonding, a.odysseyLegacy], curveTokenCreated, from, head, { token })
    const refl = await pull('find reflection', a.odysseyReflection, reflectionTokenCreated, from, head, { token })
    const instant = await pull('find instant', a.odysseyInstant, instantTokenCreated, from, head, { token })
    const hit = noxa[0] ?? curve[0] ?? refl[0] ?? instant[0]
    if (hit) {
      // Re-run the watcher's own decoder on the block that holds the event so
      // the record is shaped exactly as a live launch.
      const scan = await scanLaunches(hit.blockNumber ?? 0n, hit.blockNumber ?? 0n)
      return scan.launches.find((l) => l.token.toLowerCase() === token.toLowerCase()) ?? null
    }
    const as0 = await pull('find pool token0', a.uniswapV3Factory, uniswapV3PoolCreatedEvent as AbiEvent, from, head, { token0: token })
    const as1 = await pull('find pool token1', a.uniswapV3Factory, uniswapV3PoolCreatedEvent as AbiEvent, from, head, { token1: token })
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

  return { chain, headBlock, blockTimeMs, blockAtTime, scanLaunches, tradeSourceFor, trades, pricePath, poolLiquidity, txCounts, balanceAt, funderOf, findLaunch, ethUsd, patient }
}

/** The Odyssey factories, for callers that filter curve events. */
export const ODYSSEY_FACTORIES: readonly Address[] = [
  ODYSSEY_ADDRESSES.bondingCurveFactory, ODYSSEY_ADDRESSES.reflectionFactory, ODYSSEY_ADDRESSES.instantFactory, ODYSSEY_ADDRESSES.legacyFactory,
]
