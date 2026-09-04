/**
 * Oracle: reconstruct a launch's 90-second tape from chain history and turn
 * it into a scored feature snapshot, the same way the live observer does it
 * at the end of a window. Shared by the backfill (many launches) and the
 * score CLI (one launch).
 *
 * The record it writes is shaped exactly like a live one: the same
 * `launches` row (metadata carries the factory and the launch's extra fields,
 * plus totalSupply), the same `launch_features` row from the same extractor,
 * the same `oracle_scores` row from the same model store. A backfilled launch
 * and a live one are indistinguishable to the fitter, which is the point.
 *
 * Time consistency: pedigree and the smart-wallet set are computed as of the
 * launch's own first sight (launches and outcomes that were already known by
 * then), never from today's tables, so a backfilled feature never sees its
 * own outcome.
 */
import { and, eq, lt, ne, sql } from 'drizzle-orm'
import { type Address, erc20Abi, getAddress } from 'viem'
import { errorText, withRpcRetry } from '../chain/client.js'
import type { LaunchEvent } from '../chain/watchers.js'
import type { Db } from '../db/client.js'
import { schema } from '../db/client.js'
import { WINDOW_SECONDS } from '../engine/context.js'
import { computeFeatures, markMissing, type FeatureResult, type TapeContext, type TapeTrade, type TapeTransfer } from '../engine/features.js'
import { getTokenTransfers } from '../chain/history.js'
import type { Logger } from '../log.js'
import type { FeatureSnapshot, LaunchRecord, NarrativeRead } from '../types.js'
import type { Config } from '../config.js'
import type { ConvictionDetail } from './conviction.js'
import { BLOCKS_PER_SECOND, type OracleHistory } from './history.js'
import type { ModelStore } from './model-store.js'
import { classifyNarrative } from './narrative.js'

export interface TapeDeps {
  db: Db
  log: Logger
  history: OracleHistory
  model: ModelStore
  llm: Config['llm']
}

export interface ReconstructedTape {
  launch: LaunchRecord
  windowEndBlock: bigint
  trades: TapeTrade[]
  transfers: TapeTransfer[]
  ctx: TapeContext
  result: FeatureResult
  snapshot: FeatureSnapshot
  verdict: ConvictionDetail
  narrative: NarrativeRead
}

const metaString = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)

/** Build the LaunchRecord for a historical launch event, reading token metadata the way the observer does. */
export async function launchRecordFor(deps: Pick<TapeDeps, 'history' | 'log'>, e: LaunchEvent, network: LaunchRecord['network']): Promise<LaunchRecord> {
  const client = deps.history.chain.publicClient
  let name: string | null = null
  let symbol: string | null = null
  let decimals = 18
  let totalSupply = 0n
  try {
    const [n, s, d, t] = await withRpcRetry(() => client.multicall({
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
    deps.log.warn({ token: e.token, err: errorText(err) }, 'tape: token metadata read failed')
  }
  const firstSeenAt = new Date(await deps.history.blockTimeMs(e.blockNumber))
  const venue = e.venue ?? (e.pool ? 'pool' : 'curve')
  return {
    token: e.token, network, launchpad: e.launchpad, creator: e.creator, pool: e.pool, venue,
    blockNumber: e.blockNumber, txHash: e.txHash, firstSeenAt, feedLeadMs: null, name, symbol, decimals,
    metadata: { factory: e.factory, ...e.extra, totalSupply: totalSupply.toString(), intakeSource: 'backfill' }, graduatedAt: null,
  }
}

/** Insert the launch row if absent (a live observer may already hold it) and bump the creator's launch count on insert. */
export async function upsertLaunch(db: Db, launch: LaunchRecord): Promise<boolean> {
  const inserted = await db.insert(schema.launches).values({
    token: launch.token.toLowerCase(), network: launch.network, launchpad: launch.launchpad, creator: launch.creator.toLowerCase(),
    pool: launch.pool?.toLowerCase() ?? null, venue: launch.venue, blockNumber: launch.blockNumber.toString(), txHash: launch.txHash,
    firstSeenAt: launch.firstSeenAt, feedLeadMs: null, name: launch.name, symbol: launch.symbol, decimals: launch.decimals, metadata: launch.metadata,
    graduatedAt: launch.graduatedAt,
  }).onConflictDoNothing().returning({ token: schema.launches.token })
  if (!inserted.length) return false
  await db.insert(schema.creatorStats).values({ creator: launch.creator.toLowerCase(), network: launch.network, launches: 1, lastLaunchAt: launch.firstSeenAt })
    .onConflictDoUpdate({
      target: [schema.creatorStats.creator, schema.creatorStats.network],
      set: { launches: sql`${schema.creatorStats.launches} + 1`, lastLaunchAt: sql`greatest(${schema.creatorStats.lastLaunchAt}, ${launch.firstSeenAt})`, updatedAt: new Date() },
    })
  return true
}

/** Record a graduation on the launch row: the pool it moved to and when. */
export async function recordGraduation(db: Db, network: LaunchRecord['network'], token: Address, pool: Address | null, at: Date): Promise<void> {
  await db.update(schema.launches)
    .set({ pool: pool?.toLowerCase() ?? null, venue: pool ? 'pool' : 'v4', graduatedAt: at })
    .where(and(eq(schema.launches.token, token.toLowerCase()), eq(schema.launches.network, network)))
}

/** Creator pedigree as of `before`: prior launches and how many of them had already won. */
export async function creatorPedigreeAt(db: Db, network: LaunchRecord['network'], creator: Address, token: Address, before: Date): Promise<{ launches: number; wins: number }> {
  const [row] = await db.execute(sql`
    select count(*)::int as launches,
           count(*) filter (where coalesce(o.realized_win, o.win))::int as wins
    from ${schema.launches} l
    left join ${schema.oracleOutcomes} o on o.token = l.token and o.network = l.network
    where l.network = ${network} and l.creator = ${creator.toLowerCase()} and l.first_seen_at < ${before} and l.token <> ${token.toLowerCase()}
  `) as unknown as { launches: number; wins: number }[]
  return { launches: row?.launches ?? 0, wins: row?.wins ?? 0 }
}

/**
 * Smart money as of `before`: wallets that were first-window buyers of at
 * least two launches, seen before `before`, that were later labeled wins.
 * Same definition as the live observer, time-boxed.
 */
export async function smartWalletsAt(db: Db, network: LaunchRecord['network'], before: Date): Promise<Set<Address>> {
  const rows = await db.execute(sql`
    select w.wallet as wallet
    from ${schema.launches} l
    join ${schema.oracleOutcomes} o on o.token = l.token and o.network = l.network
    cross join lateral jsonb_array_elements_text(coalesce(l.metadata->'earlyBuyers', '[]'::jsonb)) as w(wallet)
    where o.win = true and l.network = ${network} and l.first_seen_at < ${before}
    group by w.wallet having count(*) >= 2 limit 5000
  `) as unknown as { wallet: string }[]
  const out = new Set<Address>()
  for (const r of rows) {
    try {
      out.add(getAddress(r.wallet))
    } catch {
      // not an address
    }
  }
  return out
}

const EARLY_BUYERS_KEPT = 200

/**
 * Rebuild the observation window for one recorded launch, extract features,
 * and score it under the active model. Does not write; see {@link persistTape}.
 */
export async function reconstructTape(deps: TapeDeps, launch: LaunchRecord, opts: { windowSeconds?: number; now?: Date } = {}): Promise<ReconstructedTape> {
  const { history, db, log } = deps
  const windowSeconds = opts.windowSeconds ?? WINDOW_SECONDS
  const network = launch.network
  const firstSeenMs = launch.firstSeenAt.getTime()
  const head = await history.headBlock()
  const estimate = launch.blockNumber + BigInt(Math.ceil(windowSeconds * BLOCKS_PER_SECOND)) + 20n
  const windowEndBlock = estimate >= head ? head : await history.blockAtTime(firstSeenMs + windowSeconds * 1000)
  const endBlock = windowEndBlock > head ? head : windowEndBlock

  const [tradesAll, transfersAll] = await Promise.all([
    history.trades(launch, launch.blockNumber, endBlock),
    getTokenTransfers(history.chain.publicClient, launch.token, launch.blockNumber, endBlock, { chunk: 5_000n }),
  ])
  const windowEndMs = firstSeenMs + windowSeconds * 1000
  const trades = tradesAll.filter((t) => t.at <= windowEndMs)
  const transfers = transfersAll.filter((t) => t.block <= endBlock)

  const buyers = [...new Set(trades.filter((t) => t.isBuy).map((t) => getAddress(t.trader)))]
  const before = launch.blockNumber > 0n ? launch.blockNumber - 1n : 0n
  const nonces = await history.txCounts(buyers, before)
  const freshLookupFailed = buyers.length > 0 && nonces.size === 0
  const freshWallets = new Set<Address>(buyers.filter((b) => nonces.get(b) === 0))
  const freshBuyers = buyers.filter((b) => freshWallets.has(b))
  const funder = await history.funderOf(freshBuyers)

  const [deployer, pedigree, smartWallets, ethUsd] = await Promise.all([
    history.balanceAt(launch.token, launch.creator, endBlock),
    creatorPedigreeAt(db, network, launch.creator, launch.token, launch.firstSeenAt),
    smartWalletsAt(db, network, launch.firstSeenAt),
    history.ethUsd(),
  ])
  const totalSupply = BigInt(String(launch.metadata.totalSupply ?? '0'))
  const narrative = await classifyNarrative(
    { name: launch.name, symbol: launch.symbol, description: metaString(launch.metadata.description), website: metaString(launch.metadata.website), twitter: metaString(launch.metadata.twitter), telegram: metaString(launch.metadata.telegram) },
    { llm: deps.llm, timeoutMs: 6_000 },
  )

  const ctx: TapeContext = {
    launch, totalSupply, ethUsd, creatorLaunches: pedigree.launches, creatorWins: pedigree.wins,
    freshWallets, smartWallets, deployerBalance: deployer?.balance ?? null, windowSeconds,
    category: narrative.category, narrativeConfidence: narrative.confidence, funderOf: funder.funders,
  }
  let result = computeFeatures(trades, transfers, ctx)
  if (freshLookupFailed) result = markMissing(result, ['fresh_wallet_ratio', 'bubblemap_connectivity', 'coordination_score', 'bundle_score', 'organic_score'])
  else if (funder.failed) result = markMissing(result, ['bubblemap_connectivity', 'coordination_score', 'bundle_score', 'organic_score'])
  if (deployer && !deployer.historical) result = markMissing(result, ['deployer_holding_pct'])

  const snapshot: FeatureSnapshot = {
    token: launch.token, network, observedAt: new Date(windowEndMs), windowSeconds, features: result.features, missing: result.missing,
  }
  const verdict = deps.model.convict(snapshot, { creatorLaunches: pedigree.launches, creatorWins: pedigree.wins })
  log.debug({ token: launch.token, trades: trades.length, transfers: transfers.length, buyers: buyers.length, fresh: freshWallets.size, missing: result.missing.length, score: verdict.score }, 'tape: reconstructed')
  return { launch, windowEndBlock: endBlock, trades, transfers, ctx, result, snapshot, verdict, narrative }
}

/** Write the feature row and the score row, and remember the early buyers the smart-money query reads. */
export async function persistTape(db: Db, tape: ReconstructedTape): Promise<void> {
  const token = tape.launch.token.toLowerCase()
  const network = tape.launch.network
  await db.insert(schema.launchFeatures).values({
    token, network, observedAt: tape.snapshot.observedAt, windowSeconds: tape.snapshot.windowSeconds,
    features: tape.result.features as unknown as Record<string, unknown>, missing: tape.result.missing,
  }).onConflictDoUpdate({
    target: [schema.launchFeatures.token, schema.launchFeatures.network],
    set: { observedAt: tape.snapshot.observedAt, windowSeconds: tape.snapshot.windowSeconds, features: tape.result.features as unknown as Record<string, unknown>, missing: tape.result.missing },
  })
  const v = tape.verdict
  await db.insert(schema.oracleScores).values({
    token, network, scoredAt: v.scoredAt, modelVersion: v.modelVersion, score: v.score, tier: v.tier, rugRisk: v.rugRisk,
    probabilities: v.probabilities, pillars: v.pillars, hits: v.hits, reasons: v.reasons, confidence: v.confidence,
  })
  const early = [...new Set(tape.trades.filter((t) => t.isBuy).map((t) => t.trader.toLowerCase()))].slice(0, EARLY_BUYERS_KEPT)
  await db.update(schema.launches)
    .set({ metadata: sql`${schema.launches.metadata} || ${JSON.stringify({ earlyBuyers: early, finalTrades: tape.trades.length })}::jsonb` })
    .where(and(eq(schema.launches.token, token), eq(schema.launches.network, network)))
}

/** Tokens that already carry a feature row, so a resumed backfill skips them. */
export async function featuredTokens(db: Db, network: LaunchRecord['network']): Promise<Set<string>> {
  const rows = await db.select({ token: schema.launchFeatures.token }).from(schema.launchFeatures).where(eq(schema.launchFeatures.network, network))
  return new Set(rows.map((r) => r.token.toLowerCase()))
}

/** Launches recorded before `before` for a creator, excluding one token (for pedigree without leakage). */
export async function priorLaunchCount(db: Db, network: LaunchRecord['network'], creator: Address, token: Address, before: Date): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.launches)
    .where(and(eq(schema.launches.network, network), eq(schema.launches.creator, creator.toLowerCase()), lt(schema.launches.firstSeenAt, before), ne(schema.launches.token, token.toLowerCase())))
  return row?.n ?? 0
}
