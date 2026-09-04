/**
 * Rolling-window spend and realized loss per arm, straight from `trades` and
 * `positions`. These feed the risk engine's daily budget and daily loss caps;
 * they are recomputed from the database on every check so a restart never
 * forgets the money already at risk today.
 */
import { and, eq, gte, isNotNull, isNull, sql } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { toBigInt } from '../db/client.js'
import { positions, trades } from '../db/schema.js'

export const DAY_MS = 24 * 60 * 60 * 1000

/** ETH committed to buys by this arm since `since` (default: the last 24h), wei. */
export async function spentSinceWei(db: Db, armId: string, since = new Date(Date.now() - DAY_MS)): Promise<bigint> {
  const [row] = await db
    .select({ v: sql<string>`coalesce(sum(${trades.amountIn}), 0)` })
    .from(trades)
    .where(and(eq(trades.armId, armId), eq(trades.side, 'buy'), gte(trades.at, since)))
  return toBigInt(row?.v)
}

/** Realized loss (absolute wei) on positions this arm closed since `since`; profits do not offset it. */
export async function realizedLossSinceWei(db: Db, armId: string, since = new Date(Date.now() - DAY_MS)): Promise<bigint> {
  const [row] = await db
    .select({ v: sql<string>`coalesce(sum(case when ${positions.realizedPnlWei} < 0 then -${positions.realizedPnlWei} else 0 end), 0)` })
    .from(positions)
    .where(and(eq(positions.armId, armId), isNotNull(positions.closedAt), gte(positions.closedAt, since)))
  return toBigInt(row?.v)
}

/** Net realized P&L (wei, signed) on positions this arm closed since `since`. */
export async function realizedNetSinceWei(db: Db, armId: string, since = new Date(Date.now() - DAY_MS)): Promise<bigint> {
  const [row] = await db
    .select({ v: sql<string>`coalesce(sum(${positions.realizedPnlWei}), 0)` })
    .from(positions)
    .where(and(eq(positions.armId, armId), isNotNull(positions.closedAt), gte(positions.closedAt, since)))
  return toBigInt(row?.v)
}

/** Open (plus reconcile-pending, which still holds a slot) positions for an arm. */
export async function openPositionCount(db: Db, armId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(positions)
    .where(and(eq(positions.armId, armId), isNull(positions.closedAt)))
  return row?.n ?? 0
}

/** When this arm last opened a position, for the cooldown. */
export async function lastBuyAt(db: Db, armId: string): Promise<Date | null> {
  const [row] = await db
    .select({ at: sql<Date | null>`max(${trades.at})` })
    .from(trades)
    .where(and(eq(trades.armId, armId), eq(trades.side, 'buy')))
  return row?.at ? new Date(row.at) : null
}

export interface SpendSnapshot {
  spentTodayWei: bigint
  realizedLossTodayWei: bigint
  openPositions: number
  lastTradeAt: Date | null
}

export async function spendSnapshot(db: Db, armId: string): Promise<SpendSnapshot> {
  const [spentTodayWei, realizedLossTodayWei, openPositions, lastTradeAt] = await Promise.all([
    spentSinceWei(db, armId), realizedLossSinceWei(db, armId), openPositionCount(db, armId), lastBuyAt(db, armId),
  ])
  return { spentTodayWei, realizedLossTodayWei, openPositions, lastTradeAt }
}
