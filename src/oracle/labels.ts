/**
 * Oracle: outcome labels, resolved from chain history 24 hours after first sight.
 *
 * Price-independent by construction. three.ws learned this the hard way: its
 * first rug label compared a bonding curve's dollar value to a hardcoded
 * threshold, and since an empty pump.fun curve is worth a fixed 27.96 SOL,
 * the label was a readout of the SOL price on the day the labeler ran. Every
 * ratio here is a token's own price against its own first-sight price, in
 * ETH per token, so the ETH price cannot move a label.
 *
 * Definitions (LABEL_VERSION 1):
 *
 *   first-sight price   the first trade at or after first sight
 *   ath_multiple        max price inside the 24h horizon / first-sight price
 *   price_24h           the last trade at or before the horizon
 *   moon                ath_multiple >= 2: it ran at all
 *   win                 moon AND price_24h >= first-sight: it ran and a
 *                       first-sight holder is still up
 *   rug                 price_24h < 0.5 * first-sight, OR the pool's
 *                       liquidity is gone: a first-sight holder is down more
 *                       than half
 *
 * A launch with no trade in its horizon cannot answer any of these and is
 * left unlabeled rather than counted as safe.
 *
 * Realized outcomes: for tokens we actually traded, the closed positions'
 * result is bridged onto the same row (realized_win, realized_pnl_pct,
 * realized_samples). The fitter prefers it over the chart label: a coin can
 * spike 2x and the trader still lose on a late entry, and the realized
 * result is the question the trader asked.
 */
import { and, eq, isNull, lt, sql } from 'drizzle-orm'
import type { Address } from 'viem'
import type { Db } from '../db/client.js'
import { schema } from '../db/client.js'
import { errorText } from '../chain/client.js'
import { rowToLaunch } from '../engine/observe.js'
import type { Logger } from '../log.js'
import type { Network } from '../types.js'
import type { OracleHistory } from './history.js'

export const LABEL_VERSION = 1
export const LABEL_HORIZON_MS = 86_400_000
export const MOON_ATH_MULTIPLE = 2
export const RUG_HOLD_MULTIPLE = 0.5

export interface PathPoint {
  /** Wall-clock ms. */
  at: number
  priceEth: number
}

export interface LabelResult {
  win: boolean
  rug: boolean
  moon: boolean
  athMultiple: number
  firstSightPrice: number
  price24h: number
  /** Trades inside the horizon. */
  samples: number
}

/**
 * Pure label maths over a price path. Returns null when no trade falls inside
 * the horizon, which is "unknowable", not "safe".
 */
export function labelFromPath(
  path: readonly PathPoint[],
  { firstSeenAt, horizonMs = LABEL_HORIZON_MS, liquidityGone = false }: { firstSeenAt: number; horizonMs?: number; liquidityGone?: boolean },
): LabelResult | null {
  const horizonEnd = firstSeenAt + horizonMs
  const inWindow = path
    .filter((p) => p.at >= firstSeenAt && p.at <= horizonEnd && Number.isFinite(p.priceEth) && p.priceEth > 0)
    .sort((a, b) => a.at - b.at)
  if (!inWindow.length) return null
  const firstSightPrice = inWindow[0]!.priceEth
  let ath = firstSightPrice
  for (const p of inWindow) if (p.priceEth > ath) ath = p.priceEth
  const price24h = inWindow[inWindow.length - 1]!.priceEth
  const athMultiple = ath / firstSightPrice
  const moon = athMultiple >= MOON_ATH_MULTIPLE
  const win = moon && price24h >= firstSightPrice && !liquidityGone
  const rug = liquidityGone || price24h < RUG_HOLD_MULTIPLE * firstSightPrice
  return { win, rug, moon, athMultiple: Number(athMultiple.toFixed(4)), firstSightPrice, price24h, samples: inWindow.length }
}

export interface ResolveResult {
  candidates: number
  resolved: number
  unlabelable: number
  failed: number
}

/**
 * Resolve labels for launches older than the horizon that have no outcome
 * row yet. Batched (`limit`), idempotent (a resolved token never re-enters
 * the candidate set), resumable (candidates are taken oldest-first, so a run
 * that dies mid-batch picks up where it stopped).
 */
export async function resolveLabels({
  db, history, network, log, limit = 200, now = new Date(),
}: { db: Db; history: OracleHistory; network: Network; log: Logger; limit?: number; now?: Date }): Promise<ResolveResult> {
  const cutoff = new Date(now.getTime() - LABEL_HORIZON_MS)
  const candidates = await db
    .select({ launch: schema.launches })
    .from(schema.launches)
    .leftJoin(schema.oracleOutcomes, and(eq(schema.oracleOutcomes.token, schema.launches.token), eq(schema.oracleOutcomes.network, schema.launches.network)))
    .where(and(eq(schema.launches.network, network), lt(schema.launches.firstSeenAt, cutoff), isNull(schema.oracleOutcomes.token)))
    .orderBy(schema.launches.firstSeenAt, schema.launches.token)
    .limit(limit)

  const result: ResolveResult = { candidates: candidates.length, resolved: 0, unlabelable: 0, failed: 0 }
  if (!candidates.length) return result
  const head = await history.headBlock()

  for (const c of candidates) {
    const launch = rowToLaunch(c.launch)
    const token = launch.token
    try {
      const firstSeenMs = launch.firstSeenAt.getTime()
      const horizonBlock = await history.blockAtTime(firstSeenMs + LABEL_HORIZON_MS)
      const toBlock = horizonBlock > head ? head : horizonBlock
      const path = await history.pricePath(launch, launch.blockNumber, toBlock)
      // Most launchpads lock the LP forever, so liquidity only reads zero
      // when the pool was never seeded or was drained. Checked anyway: a
      // label that assumes the lock held is not a measurement.
      const liquidity = launch.pool && launch.venue === 'pool' ? await history.poolLiquidity(launch.pool) : null
      const label = labelFromPath(path, { firstSeenAt: firstSeenMs, liquidityGone: liquidity === 0n })
      if (!label) {
        result.unlabelable++
        log.debug({ token }, 'labels: no trade inside the horizon; left unlabeled')
        continue
      }
      await db
        .insert(schema.oracleOutcomes)
        .values({
          token: token.toLowerCase(), network, labelVersion: LABEL_VERSION,
          win: label.win, rug: label.rug, moon: label.moon, athMultiple: label.athMultiple, resolvedAt: now,
        })
        .onConflictDoUpdate({
          target: [schema.oracleOutcomes.token, schema.oracleOutcomes.network],
          set: { labelVersion: LABEL_VERSION, win: label.win, rug: label.rug, moon: label.moon, athMultiple: label.athMultiple, resolvedAt: now },
        })
      await refreshCreatorStats(db, network, launch.creator, now)
      result.resolved++
      log.info({ token, win: label.win, rug: label.rug, moon: label.moon, ath: label.athMultiple, samples: label.samples }, 'labels: resolved')
    } catch (err) {
      result.failed++
      log.warn({ token, err: errorText(err) }, 'labels: resolve failed')
    }
  }
  return result
}

/** Recount a creator's record from the launches and outcomes we hold. */
export async function refreshCreatorStats(db: Db, network: Network, creator: Address, now = new Date()): Promise<void> {
  const [row] = await db.execute(sql`
    select count(l.token)::int as launches,
           count(*) filter (where coalesce(o.realized_win, o.win))::int as wins,
           count(*) filter (where o.rug)::int as rugs,
           max(l.first_seen_at) as last_launch_at
    from ${schema.launches} l
    left join ${schema.oracleOutcomes} o on o.token = l.token and o.network = l.network
    where l.network = ${network} and l.creator = ${creator.toLowerCase()}
  `) as unknown as { launches: number; wins: number; rugs: number; last_launch_at: Date | string | null }[]
  if (!row) return
  const lastLaunchAt = row.last_launch_at == null ? null : new Date(row.last_launch_at)
  await db
    .insert(schema.creatorStats)
    .values({ creator: creator.toLowerCase(), network, launches: row.launches, wins: row.wins, rugs: row.rugs, lastLaunchAt, updatedAt: now })
    .onConflictDoUpdate({
      target: [schema.creatorStats.creator, schema.creatorStats.network],
      set: { launches: row.launches, wins: row.wins, rugs: row.rugs, lastLaunchAt, updatedAt: now },
    })
}

/**
 * Bridge realized results from closed live positions onto oracle_outcomes.
 * A closed trade's PnL never changes, so re-deriving is cheap and idempotent.
 * Returns the number of tokens with a realized record.
 */
export async function bridgeRealized({ db, network, log, now = new Date() }: { db: Db; network: Network; log: Logger; now?: Date }): Promise<number> {
  const rows = await db.execute(sql`
    select token,
           (sum(realized_pnl_wei) > 0) as realized_win,
           avg(realized_pnl_pct)::double precision as realized_pnl_pct,
           count(*)::int as samples
    from ${schema.positions}
    where network = ${network} and status = 'closed' and mode = 'live'
      and buy_tx <> 'SIMULATED' and realized_pnl_wei is not null
    group by token
  `) as unknown as { token: string; realized_win: boolean; realized_pnl_pct: number | null; samples: number }[]
  for (const r of rows) {
    const pct = r.realized_pnl_pct == null ? null : Number(Number(r.realized_pnl_pct).toFixed(4))
    await db
      .insert(schema.oracleOutcomes)
      .values({
        token: r.token.toLowerCase(), network, labelVersion: LABEL_VERSION,
        // No chart label yet: the realized result stands in until the horizon
        // resolver overwrites win/rug/moon from the tape.
        win: r.realized_win, rug: pct != null && pct <= -50, moon: pct != null && pct >= 100, athMultiple: null,
        realizedWin: r.realized_win, realizedPnlPct: pct, realizedSamples: r.samples, resolvedAt: now,
      })
      .onConflictDoUpdate({
        target: [schema.oracleOutcomes.token, schema.oracleOutcomes.network],
        set: { realizedWin: r.realized_win, realizedPnlPct: pct, realizedSamples: r.samples },
      })
  }
  if (rows.length) log.info({ network, tokens: rows.length }, 'labels: realized outcomes bridged')
  return rows.length
}
