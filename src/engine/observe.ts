/**
 * The observation window. A launch (feed pre-signal confirmed by its log, or
 * the log alone) is recorded, its token metadata is read in one multicall,
 * the creator is classified from our own launch history, and a window opens
 * that collects every trade and transfer for 90 seconds. Arms that buy sooner
 * get an interim snapshot at their delay (scored with `missing` populated);
 * the final snapshot at 90s is what the oracle learns from.
 *
 * Correctness does not depend on the live watchers: every snapshot re-reads
 * the token's logs from the launch block to the head through the chunked
 * history reader and merges them with whatever the watchers delivered.
 */
import { type Address, type Hash, getAddress } from 'viem'
import { and, eq, ne, sql } from 'drizzle-orm'
import { erc20Abi } from '../chain/abis.js'
import { errorText, mapLimit, withRpcRetry } from '../chain/client.js'
import type { SequencerFeed, PreLaunchSignal } from '../chain/feed.js'
import { getTokenTrades, getTokenTransfers, resolvePoolSide, swapLogToTrade, transactionSenders, v4SwapLogToTrade, type QuoteKind, type TradeSource } from '../chain/history.js'
import { UNISWAP_V4 } from '../chain/launchpads.js'
import type { CurveTradeEvent, GraduationEvent, LaunchEvent, PoolSwapEvent, V4SwapEvent, Watchers } from '../chain/watchers.js'
import { creatorStats, launchFeatures, launches, oracleScores } from '../db/schema.js'
import type { FeatureSnapshot, LaunchRecord, OracleVerdict } from '../types.js'
import { type EngineContext, WINDOW_SECONDS } from './context.js'
import { computeFeatures, markMissing, type TapeContext, type TapeTrade, type TapeTransfer } from './features.js'
import { classifyNarrative } from '../oracle/narrative.js'
import type { NarrativeRead } from '../types.js'

export interface ObservationResult {
  launch: LaunchRecord
  snapshot: FeatureSnapshot
  verdict: OracleVerdict
  interim: boolean
  /** ms after first sight this snapshot was taken. */
  delayMs: number
}

interface Window {
  launch: LaunchRecord
  source: TradeSource | null
  trades: Map<string, TapeTrade>
  transfers: Map<string, TapeTransfer>
  startedAt: number
  timers: NodeJS.Timeout[]
  fresh: Map<string, boolean>
  funders: Map<string, Address | null>
  funderLookupFailed: boolean
  freshLookupFailed: boolean
  totalSupply: bigint
  taken: Set<number>
  busy: boolean
  closed: boolean
  narrative: Promise<NarrativeRead> | null
}

const BLOCKSCOUT = 'https://robinhoodchain.blockscout.com'
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const MAX_FUNDER_LOOKUPS = 40
const EARLY_BUYERS_KEPT = 200

export interface ObserverDeps {
  watchers: Watchers
  feed: SequencerFeed | null
  onResult: (r: ObservationResult) => void
  /** Interim snapshot delays the armed arms want (ms, each below the window). */
  interimDelaysMs: () => number[]
}

export class Observer {
  private readonly windows = new Map<string, Window>()
  private readonly launchCache = new Map<string, LaunchRecord>()
  private readonly verdicts = new Map<string, OracleVerdict>()
  private readonly preSignals = new Map<string, PreLaunchSignal>()
  private smartCache: { at: number; wallets: Set<Address> } | null = null
  private scored = 0
  private stopped = false

  constructor(private readonly ctx: EngineContext, private readonly deps: ObserverDeps) {}

  stop(): void {
    this.stopped = true
    for (const w of this.windows.values()) this.closeWindow(w)
  }

  health(): { openWindows: number; scored: number } {
    return { openWindows: this.windows.size, scored: this.scored }
  }

  lastVerdict(token: Address): OracleVerdict | null {
    return this.verdicts.get(token.toLowerCase()) ?? null
  }

  /** True once a token has an open window or a cached launch record (the pool intake asks before classifying). */
  isKnownToken(token: Address): boolean {
    const key = token.toLowerCase()
    return this.windows.has(key) || this.launchCache.has(key)
  }

  /** A factory call seen on the sequencer feed before its log; kept so the confirming log can measure the lead. */
  onPreSignal(signal: PreLaunchSignal): void {
    this.preSignals.set(signal.txHash.toLowerCase(), signal)
    if (this.preSignals.size > 500) this.preSignals.delete(this.preSignals.keys().next().value!)
    this.ctx.bus.emit({ kind: 'status', at: signal.seenAt, level: 'info', source: 'feed', message: `pre-launch: ${signal.launchpad} ${signal.functionName ?? signal.selector} from ${signal.from ?? 'unknown'} (${signal.txHash})` })
  }

  async launchOf(token: Address): Promise<LaunchRecord | null> {
    const key = token.toLowerCase()
    const hit = this.launchCache.get(key)
    if (hit) return hit
    const [row] = await this.ctx.db.select().from(launches).where(and(eq(launches.token, key), eq(launches.network, this.ctx.network))).limit(1)
    if (!row) return null
    const rec = rowToLaunch(row)
    this.launchCache.set(key, rec)
    return rec
  }

  // ── launch intake ─────────────────────────────────────────────────────────

  async onLaunch(e: LaunchEvent): Promise<void> {
    if (this.stopped) return
    const key = e.token.toLowerCase()
    if (this.windows.has(key)) return
    const pre = this.preSignals.get(e.txHash.toLowerCase()) ?? this.deps.feed?.seenAt(e.txHash)
    const feedSeenAt = typeof pre === 'number' ? pre : pre?.seenAt ?? null
    const feedLeadMs = feedSeenAt != null ? Math.max(0, e.seenAt - feedSeenAt) : null

    let name: string | null = null
    let symbol: string | null = null
    let decimals = 18
    let totalSupply = 0n
    try {
      const [n, s, d, t] = await withRpcRetry(() => this.ctx.chain.publicClient.multicall({
        contracts: [
          { address: e.token, abi: erc20Abi, functionName: 'name' },
          { address: e.token, abi: erc20Abi, functionName: 'symbol' },
          { address: e.token, abi: erc20Abi, functionName: 'decimals' },
          { address: e.token, abi: erc20Abi, functionName: 'totalSupply' },
        ],
        allowFailure: true,
      }))
      if (n.status === 'success') name = n.result
      if (s.status === 'success') symbol = s.result
      if (d.status === 'success') decimals = d.result
      if (t.status === 'success') totalSupply = t.result
    } catch (err) {
      this.ctx.log.warn({ token: e.token, err: errorText(err) }, 'token metadata read failed')
    }

    const venue = e.venue ?? (e.pool ? 'pool' : 'curve')
    const launch: LaunchRecord = {
      token: e.token, network: this.ctx.network, launchpad: e.launchpad, creator: e.creator, pool: e.pool, venue,
      blockNumber: e.blockNumber, txHash: e.txHash, firstSeenAt: new Date(e.seenAt), feedLeadMs, name, symbol, decimals,
      metadata: { factory: e.factory, ...e.extra, totalSupply: totalSupply.toString() }, graduatedAt: null,
    }
    const inserted = await this.ctx.db.insert(launches).values({
      token: key, network: launch.network, launchpad: launch.launchpad, creator: launch.creator.toLowerCase(), pool: launch.pool?.toLowerCase() ?? null, venue: launch.venue,
      blockNumber: launch.blockNumber.toString(), txHash: launch.txHash, firstSeenAt: launch.firstSeenAt, feedLeadMs, name, symbol, decimals, metadata: launch.metadata,
    }).onConflictDoNothing().returning({ token: launches.token })
    if (!inserted.length) {
      this.ctx.log.info({ token: e.token }, 'launch already recorded; not re-observing')
      return
    }
    this.launchCache.set(key, launch)
    await this.ctx.db.insert(creatorStats).values({ creator: launch.creator.toLowerCase(), network: launch.network, launches: 1, lastLaunchAt: launch.firstSeenAt })
      .onConflictDoUpdate({ target: [creatorStats.creator, creatorStats.network], set: { launches: sql`${creatorStats.launches} + 1`, lastLaunchAt: launch.firstSeenAt, updatedAt: new Date() } })
    if (launch.pool) this.deps.watchers.trackPool(launch.pool, launch.token)

    let source: TradeSource | null = null
    const usdg = this.ctx.chain.addresses.usdg.toLowerCase()
    if (venue === 'v4' && typeof e.extra.poolId === 'string') {
      const poolId = e.extra.poolId as Hash
      const quoteKind: QuoteKind = typeof e.extra.quote === 'string' && e.extra.quote.toLowerCase() === usdg ? 'usdg' : 'eth'
      const tokenIsCurrency0 = typeof e.extra.quote === 'string' ? BigInt(e.token) < BigInt(e.extra.quote) : true
      source = { venue: 'v4', poolManager: UNISWAP_V4.poolManager, poolId, tokenIsCurrency0, quoteKind }
      this.deps.watchers.trackV4Pool(poolId, launch.token)
    } else if (launch.pool) {
      try {
        const side = await resolvePoolSide(this.ctx.chain.publicClient, launch.pool, launch.token)
        source = { venue: 'pool', pool: launch.pool, tokenIsToken0: side.tokenIsToken0, quoteKind: side.quote.toLowerCase() === usdg ? 'usdg' : 'eth' }
      } catch (err) {
        this.ctx.log.warn({ token: e.token, pool: launch.pool, err: errorText(err) }, 'pool side unresolved; trades will be missing')
      }
    } else {
      source = { venue: 'curve', factory: e.factory }
    }
    const w: Window = {
      launch, source, trades: new Map(), transfers: new Map(), startedAt: e.seenAt, timers: [], fresh: new Map(), funders: new Map(),
      funderLookupFailed: false, freshLookupFailed: false, totalSupply, taken: new Set(), busy: false, closed: false, narrative: null,
    }
    this.windows.set(key, w)
    this.ctx.bus.emit({ kind: 'launch', at: e.seenAt, launch })
    await this.ctx.journal.append({ armId: null, token: launch.token, kind: 'observe', reason: 'launch', detail: { launchpad: launch.launchpad, venue: launch.venue, pool: launch.pool, factory: e.factory, creator: launch.creator, block: launch.blockNumber, feedLeadMs, name, symbol } })
    this.ctx.log.info({ token: e.token, launchpad: e.launchpad, venue: launch.venue, feedLeadMs, symbol }, 'launch observed; window open')

    const delays = new Set(this.deps.interimDelaysMs().filter((d) => d > 0 && d < WINDOW_SECONDS * 1000))
    for (const d of delays) {
      const t = setTimeout(() => { void this.snapshot(w, d, false) }, Math.max(0, d - (Date.now() - e.seenAt)))
      t.unref?.()
      w.timers.push(t)
    }
    const fin = setTimeout(() => { void this.snapshot(w, WINDOW_SECONDS * 1000, true) }, Math.max(0, WINDOW_SECONDS * 1000 - (Date.now() - e.seenAt)))
    fin.unref?.()
    w.timers.push(fin)
  }

  onCurveTrade(e: CurveTradeEvent): void {
    const w = this.windows.get(e.token.toLowerCase())
    if (!w || w.closed) return
    w.trades.set(`${e.txHash}:${e.logIndex}`, {
      block: e.blockNumber, txIndex: 0, logIndex: e.logIndex, at: Date.now(), trader: e.trader, isBuy: e.isBuy, tokenAmount: e.tokenAmount,
      quoteWei: e.isBuy ? e.quoteAmount + e.fee : e.quoteAmount - e.fee, txHash: e.txHash,
    })
  }

  onSwap(e: PoolSwapEvent): void {
    const w = this.windows.get(e.token.toLowerCase())
    if (!w || w.closed || !w.source || w.source.venue !== 'pool') return
    if (w.source.quoteKind === 'usdg') return // denominated at snapshot time, when ethUsd is at hand
    const t = swapLogToTrade(e.log, w.source, Date.now())
    if (t) w.trades.set(`${t.txHash}:${t.logIndex}`, t)
  }

  /** Live v4 swaps are attributed at snapshot time (the trader is the tx sender); here the log is only kept warm. */
  onV4Swap(e: V4SwapEvent): void {
    const w = this.windows.get(e.token.toLowerCase())
    if (!w || w.closed || !w.source || w.source.venue !== 'v4' || w.source.quoteKind === 'usdg') return
    const src = w.source
    void transactionSenders(this.ctx.chain.publicClient, [e.log.transactionHash as Hash]).then((senders) => {
      const trader = senders.get((e.log.transactionHash as string).toLowerCase())
      if (!trader) return
      const t = v4SwapLogToTrade(e.log, src, Date.now(), trader)
      if (t) w.trades.set(`${t.txHash}:${t.logIndex}`, t)
    }).catch(() => undefined)
  }

  async onGraduation(g: GraduationEvent): Promise<void> {
    const key = g.token.toLowerCase()
    const now = new Date()
    await this.ctx.db.update(launches).set({ pool: g.pool?.toLowerCase() ?? null, venue: g.pool ? 'pool' : 'curve', graduatedAt: now, metadata: sql`${launches.metadata} || ${JSON.stringify({ graduationTx: g.txHash, v4PoolId: g.v4PoolId })}::jsonb` })
      .where(and(eq(launches.token, key), eq(launches.network, this.ctx.network)))
    const cached = this.launchCache.get(key)
    if (cached) {
      cached.pool = g.pool
      cached.venue = g.pool ? 'pool' : 'curve'
      cached.graduatedAt = now
      cached.metadata = { ...cached.metadata, graduationTx: g.txHash, v4PoolId: g.v4PoolId }
    }
    if (g.pool) {
      this.deps.watchers.trackPool(g.pool, g.token)
      this.ctx.bus.emit({ kind: 'graduation', at: now.getTime(), token: g.token, pool: g.pool })
    } else {
      this.ctx.bus.emit({ kind: 'status', at: now.getTime(), level: 'info', source: 'graduation', message: `${g.token} graduated to a Uniswap v4 pool (${g.v4PoolId}); not routable` })
    }
    await this.ctx.journal.append({ armId: null, token: g.token, kind: 'observe', reason: 'graduation', detail: { pool: g.pool, v4PoolId: g.v4PoolId, tx: g.txHash, factory: g.factory } })
  }

  // ── snapshots ─────────────────────────────────────────────────────────────

  private async snapshot(w: Window, delayMs: number, final: boolean): Promise<void> {
    if (w.closed || w.taken.has(delayMs)) return
    if (w.busy) {
      const t = setTimeout(() => { void this.snapshot(w, delayMs, final) }, 250)
      t.unref?.()
      w.timers.push(t)
      return
    }
    w.busy = true
    w.taken.add(delayMs)
    const token = w.launch.token
    try {
      await this.backfill(w)
      const trades = [...w.trades.values()]
      const transfers = [...w.transfers.values()]
      const buyers = [...new Set(trades.filter((t) => t.isBuy).map((t) => getAddress(t.trader)))]
      const [freshWallets, deployerBalance, pedigree, smartWallets, ethUsd] = await Promise.all([
        this.resolveFresh(w, buyers), this.deployerBalance(w), this.creatorPedigree(w.launch), this.smartWallets(), this.ctx.prices.ethUsd(),
      ])
      const freshBuyers = buyers.filter((b) => freshWallets.has(b))
      const funderOf = await this.resolveFunders(w, freshBuyers)
      w.narrative ??= classifyNarrative({ name: w.launch.name, symbol: w.launch.symbol, description: metaString(w.launch.metadata.description), website: metaString(w.launch.metadata.website), twitter: metaString(w.launch.metadata.twitter), telegram: metaString(w.launch.metadata.telegram) }, { llm: this.ctx.config.llm, timeoutMs: 6_000 })
      const narrative = await w.narrative
      const tctx: TapeContext = {
        launch: w.launch, totalSupply: w.totalSupply, ethUsd, creatorLaunches: pedigree.launches, creatorWins: pedigree.wins,
        freshWallets, smartWallets, deployerBalance, windowSeconds: final ? WINDOW_SECONDS : Math.max(1, Math.round(delayMs / 1000)),
        category: narrative.category, narrativeConfidence: narrative.confidence, funderOf,
      }
      let result = computeFeatures(trades, transfers, tctx)
      if (w.freshLookupFailed) result = markMissing(result, ['fresh_wallet_ratio', 'organic_score', 'bundle_score', 'coordination_score', 'bubblemap_connectivity'])
      if (w.funderLookupFailed) result = markMissing(result, ['organic_score', 'bundle_score', 'coordination_score', 'bubblemap_connectivity'])
      const snapshot: FeatureSnapshot = { token, network: this.ctx.network, observedAt: new Date(), windowSeconds: tctx.windowSeconds, features: result.features, missing: result.missing }
      await this.ctx.db.insert(launchFeatures).values({ token: token.toLowerCase(), network: this.ctx.network, observedAt: snapshot.observedAt, windowSeconds: snapshot.windowSeconds, features: snapshot.features as unknown as Record<string, unknown>, missing: snapshot.missing })
        .onConflictDoUpdate({ target: [launchFeatures.token, launchFeatures.network], set: { observedAt: snapshot.observedAt, windowSeconds: snapshot.windowSeconds, features: snapshot.features as unknown as Record<string, unknown>, missing: snapshot.missing } })
      const verdict = this.ctx.model.convict(snapshot, { creatorLaunches: pedigree.launches, creatorWins: pedigree.wins })
      await this.ctx.db.insert(oracleScores).values({
        token: token.toLowerCase(), network: this.ctx.network, scoredAt: verdict.scoredAt, modelVersion: verdict.modelVersion, score: verdict.score, tier: verdict.tier, rugRisk: verdict.rugRisk,
        probabilities: verdict.probabilities, pillars: verdict.pillars, hits: verdict.hits, reasons: verdict.reasons, confidence: verdict.confidence,
      })
      this.verdicts.set(token.toLowerCase(), verdict)
      this.scored++
      this.ctx.bus.emit({ kind: 'features', at: snapshot.observedAt.getTime(), snapshot })
      this.ctx.bus.emit({ kind: 'score', at: verdict.scoredAt.getTime(), verdict })
      await this.ctx.journal.append({ armId: null, token, kind: 'observe', reason: final ? 'final_snapshot' : 'interim_snapshot', detail: { delayMs, trades: trades.length, transfers: transfers.length, missing: result.missing, score: verdict.score, tier: verdict.tier, rugRisk: verdict.rugRisk, model: verdict.modelVersion } })
      this.ctx.log.info({ token, delayMs, final, trades: trades.length, buyers: buyers.length, score: verdict.score, tier: verdict.tier, missing: result.missing.length }, 'snapshot scored')
      if (final) {
        const early = buyers.slice(0, EARLY_BUYERS_KEPT).map((b) => b.toLowerCase())
        await this.ctx.db.update(launches).set({ metadata: sql`${launches.metadata} || ${JSON.stringify({ earlyBuyers: early, finalTrades: trades.length })}::jsonb` })
          .where(and(eq(launches.token, token.toLowerCase()), eq(launches.network, this.ctx.network)))
      }
      this.deps.onResult({ launch: w.launch, snapshot, verdict, interim: !final, delayMs })
    } catch (err) {
      this.ctx.log.error({ token, delayMs, err: errorText(err) }, 'snapshot failed')
      await this.ctx.journal.append({ armId: null, token, kind: 'error', reason: 'snapshot_failed', detail: { delayMs, final, error: errorText(err) } })
    } finally {
      w.busy = false
      if (final) this.closeWindow(w)
    }
  }

  private closeWindow(w: Window): void {
    w.closed = true
    for (const t of w.timers) clearTimeout(t)
    this.windows.delete(w.launch.token.toLowerCase())
  }

  /** Re-read the token's logs from the launch block to the head and merge them over the live-collected tape. */
  private async backfill(w: Window): Promise<void> {
    const head = await withRpcRetry(() => this.ctx.chain.publicClient.getBlockNumber())
    const from = w.launch.blockNumber
    const needsUsd = w.source !== null && w.source.venue !== 'curve' && w.source.quoteKind === 'usdg'
    const ethUsd = needsUsd ? await this.ctx.prices.ethUsd() : null
    const [trades, transfers] = await Promise.all([
      w.source ? getTokenTrades(this.ctx.chain.publicClient, w.launch.token, w.source, from, head, { chunk: 2_000n, ethUsd }) : Promise.resolve([] as TapeTrade[]),
      getTokenTransfers(this.ctx.chain.publicClient, w.launch.token, from, head, { chunk: 2_000n }),
    ])
    for (const t of trades) w.trades.set(`${t.txHash}:${t.logIndex}`, t)
    transfers.forEach((tr, i) => w.transfers.set(`${tr.block}:${i}:${tr.from}:${tr.to}:${tr.value}`, tr))
  }

  private async resolveFresh(w: Window, buyers: Address[]): Promise<Set<Address>> {
    const out = new Set<Address>()
    const before = w.launch.blockNumber > 0n ? w.launch.blockNumber - 1n : 0n
    const unknown = buyers.filter((b) => !w.fresh.has(b.toLowerCase()))
    try {
      await mapLimit(unknown, 12, async (b) => {
        const n = await withRpcRetry(() => this.ctx.chain.publicClient.getTransactionCount({ address: b, blockNumber: before }))
        w.fresh.set(b.toLowerCase(), n === 0)
      })
      w.freshLookupFailed = false
    } catch (err) {
      w.freshLookupFailed = true
      this.ctx.log.warn({ token: w.launch.token, err: errorText(err) }, 'fresh-wallet lookup failed')
    }
    for (const b of buyers) if (w.fresh.get(b.toLowerCase())) out.add(b)
    return out
  }

  /**
   * The first wallet that sent a fresh buyer a transaction, from Blockscout's
   * address history (a fresh wallet's whole history fits on the first page,
   * so its oldest incoming transaction is its funding). Bounded per window.
   */
  private async resolveFunders(w: Window, freshBuyers: Address[]): Promise<Map<Address, Address>> {
    const out = new Map<Address, Address>()
    const todo = freshBuyers.filter((b) => !w.funders.has(b.toLowerCase())).slice(0, MAX_FUNDER_LOOKUPS)
    let failures = 0
    await mapLimit(todo, 4, async (b) => {
      try {
        const res = await fetch(`${BLOCKSCOUT}/api/v2/addresses/${b}/transactions?filter=to`, { headers: { accept: 'application/json', 'user-agent': BROWSER_UA }, signal: AbortSignal.timeout(4_000) })
        if (!res.ok) throw new Error(`blockscout ${res.status}`)
        const body = (await res.json()) as { items?: { from?: { hash?: string }; value?: string }[]; next_page_params?: unknown }
        const items = body.items ?? []
        const funded = [...items].reverse().find((i) => i.from?.hash && i.value && BigInt(i.value) > 0n)
        w.funders.set(b.toLowerCase(), funded?.from?.hash ? getAddress(funded.from.hash) : null)
      } catch {
        failures++
      }
    })
    w.funderLookupFailed = todo.length > 0 && failures === todo.length
    for (const b of freshBuyers) {
      const f = w.funders.get(b.toLowerCase())
      if (f) out.set(b, f)
    }
    return out
  }

  private async deployerBalance(w: Window): Promise<bigint | null> {
    try {
      return await withRpcRetry(() => this.ctx.chain.publicClient.readContract({ address: w.launch.token, abi: erc20Abi, functionName: 'balanceOf', args: [w.launch.creator] }))
    } catch {
      return null
    }
  }

  private async creatorPedigree(launch: LaunchRecord): Promise<{ launches: number | null; wins: number | null }> {
    try {
      const creator = launch.creator.toLowerCase()
      const [[prior], [stats]] = await Promise.all([
        this.ctx.db.select({ n: sql<number>`count(*)::int` }).from(launches).where(and(eq(launches.creator, creator), eq(launches.network, this.ctx.network), ne(launches.token, launch.token.toLowerCase()))),
        this.ctx.db.select({ wins: creatorStats.wins }).from(creatorStats).where(and(eq(creatorStats.creator, creator), eq(creatorStats.network, this.ctx.network))).limit(1),
      ])
      return { launches: prior?.n ?? 0, wins: stats?.wins ?? 0 }
    } catch (err) {
      this.ctx.log.warn({ err: errorText(err) }, 'creator pedigree query failed')
      return { launches: null, wins: null }
    }
  }

  /**
   * Smart money: wallets that were first-window buyers of at least two launches
   * later labeled wins. Derived from launches.metadata.earlyBuyers and
   * oracle_outcomes; cached five minutes.
   */
  private async smartWallets(): Promise<Set<Address>> {
    if (this.smartCache && Date.now() - this.smartCache.at < 300_000) return this.smartCache.wallets
    const wallets = new Set<Address>()
    try {
      const rows = await this.ctx.db.execute(sql`
        select w.wallet as wallet
        from launches l
        join oracle_outcomes o on o.token = l.token and o.network = l.network
        cross join lateral jsonb_array_elements_text(coalesce(l.metadata->'earlyBuyers', '[]'::jsonb)) as w(wallet)
        where o.win = true and l.network = ${this.ctx.network}
        group by w.wallet having count(*) >= 2 limit 5000`)
      for (const r of rows as unknown as { wallet: string }[]) {
        try { wallets.add(getAddress(r.wallet)) } catch { /* not an address */ }
      }
    } catch (err) {
      this.ctx.log.warn({ err: errorText(err) }, 'smart-wallet query failed')
    }
    this.smartCache = { at: Date.now(), wallets }
    return wallets
  }
}

const metaString = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)

export function rowToLaunch(r: typeof launches.$inferSelect): LaunchRecord {
  return {
    token: getAddress(r.token), network: r.network as LaunchRecord['network'], launchpad: r.launchpad as LaunchRecord['launchpad'], creator: getAddress(r.creator),
    pool: r.pool ? getAddress(r.pool) : null, venue: r.venue as LaunchRecord['venue'], blockNumber: BigInt(r.blockNumber), txHash: r.txHash as Hash, firstSeenAt: r.firstSeenAt,
    feedLeadMs: r.feedLeadMs, name: r.name, symbol: r.symbol, decimals: r.decimals, metadata: r.metadata, graduatedAt: r.graduatedAt,
  }
}
