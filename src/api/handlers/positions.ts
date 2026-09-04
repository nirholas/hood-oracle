import { and, desc, eq, sql } from 'drizzle-orm'
import { schema } from '../../db/client.js'
import type { AppDeps } from '../deps.js'
import { ApiError, conflict, notFound } from '../errors.js'
import { parseEnum, parseLimit, parseOptionalUuid, parseUuid } from '../query.js'
import { rowToPosition } from '../serialize.js'
import type { PositionListItem, PositionWire, TradeWire } from '../contract.js'

export const POSITION_STATUSES = ['open', 'closed', 'reconcile_pending'] as const

export interface PositionsQuery {
  status?: string
  arm?: string
  limit?: string | number
}

function wire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))) as T
}

/** Open positions first, then closed by newest. */
export async function listPositions(deps: AppDeps, q: PositionsQuery = {}): Promise<{ positions: PositionListItem[]; count: number }> {
  const status = parseEnum(q.status, POSITION_STATUSES, 'status')
  const armId = parseOptionalUuid(q.arm, 'arm')
  const limit = parseLimit(q.limit == null ? undefined : String(q.limit), 200, 1000)
  const conditions = [eq(schema.positions.network, deps.config.network)]
  if (status) conditions.push(eq(schema.positions.status, status))
  if (armId) conditions.push(eq(schema.positions.armId, armId))
  const rows = await deps.db
    .select({ position: schema.positions, armLabel: schema.arms.label, symbol: schema.launches.symbol, name: schema.launches.name })
    .from(schema.positions)
    .innerJoin(schema.arms, eq(schema.arms.id, schema.positions.armId))
    .leftJoin(schema.launches, and(eq(schema.launches.token, schema.positions.token), eq(schema.launches.network, schema.positions.network)))
    .where(and(...conditions))
    .orderBy(sql`case when ${schema.positions.status} = 'open' then 0 else 1 end`, desc(schema.positions.openedAt))
    .limit(limit)
  const items: PositionListItem[] = rows.map((r) => ({
    ...(wire(rowToPosition(r.position)) as unknown as Omit<PositionListItem, 'symbol' | 'name' | 'armLabel'>),
    symbol: r.symbol ?? null,
    name: r.name ?? null,
    armLabel: r.armLabel,
  }))
  return { positions: items, count: items.length }
}

/** Close an open position at market now, exit reason `manual`. */
export async function closePosition(deps: AppDeps, rawId: string): Promise<{ trade: TradeWire; position: PositionWire | null }> {
  const { db, engine, log } = deps
  const id = parseUuid(rawId, 'position id')
  const [row] = await db.select().from(schema.positions).where(eq(schema.positions.id, id)).limit(1)
  if (!row) throw notFound(`position ${id}`)
  if (row.status !== 'open') throw conflict('position_not_open', `Position ${id} is ${row.status}; only open positions can be closed.`)
  try {
    const trade = await engine.closePosition(id, 'manual')
    log.warn({ positionId: id, token: row.token, tradeId: trade.id }, 'position closed by operator')
    const [after] = await db.select().from(schema.positions).where(eq(schema.positions.id, id)).limit(1)
    return wire({ trade, position: after ? rowToPosition(after) : null }) as unknown as { trade: TradeWire; position: PositionWire | null }
  } catch (err) {
    if (err instanceof ApiError) throw err
    const message = err instanceof Error ? err.message : String(err)
    log.error({ positionId: id, err: message }, 'manual close failed')
    throw new ApiError(502, 'close_failed', `The engine could not close position ${id}: ${message}`)
  }
}
