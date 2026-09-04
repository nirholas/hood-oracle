import { Hono } from 'hono'
import { and, desc, eq, sql } from 'drizzle-orm'
import { schema } from '../../db/client.js'
import type { AppDeps } from '../deps.js'
import { respond } from '../json.js'
import { ApiError, conflict, notFound } from '../errors.js'
import { parseEnum, parseLimit, parseOptionalUuid, parseUuid } from '../query.js'
import { rowToPosition } from '../serialize.js'
import type { PositionListItem } from '../contract.js'

const STATUSES = ['open', 'closed', 'reconcile_pending'] as const

export function positionRoutes(deps: AppDeps): Hono {
  const app = new Hono()
  const { db, engine, config, log } = deps

  app.get('/', async (c) => {
    const status = parseEnum(c.req.query('status'), STATUSES, 'status')
    const armId = parseOptionalUuid(c.req.query('arm'), 'arm')
    const limit = parseLimit(c.req.query('limit'), 200, 1000)
    const conditions = [eq(schema.positions.network, config.network)]
    if (status) conditions.push(eq(schema.positions.status, status))
    if (armId) conditions.push(eq(schema.positions.armId, armId))
    const rows = await db
      .select({ position: schema.positions, armLabel: schema.arms.label, symbol: schema.launches.symbol, name: schema.launches.name })
      .from(schema.positions)
      .innerJoin(schema.arms, eq(schema.arms.id, schema.positions.armId))
      .leftJoin(schema.launches, and(eq(schema.launches.token, schema.positions.token), eq(schema.launches.network, schema.positions.network)))
      .where(and(...conditions))
      .orderBy(sql`case when ${schema.positions.status} = 'open' then 0 else 1 end`, desc(schema.positions.openedAt))
      .limit(limit)
    const items: PositionListItem[] = rows.map((r) => ({
      ...(rowToPosition(r.position) as unknown as Omit<PositionListItem, 'symbol' | 'name' | 'armLabel'>),
      symbol: r.symbol ?? null,
      name: r.name ?? null,
      armLabel: r.armLabel,
    }))
    return respond(c, { positions: items, count: items.length })
  })

  app.post('/:id/close', async (c) => {
    const id = parseUuid(c.req.param('id'), 'position id')
    const [row] = await db.select().from(schema.positions).where(eq(schema.positions.id, id)).limit(1)
    if (!row) throw notFound(`position ${id}`)
    if (row.status !== 'open') throw conflict('position_not_open', `Position ${id} is ${row.status}; only open positions can be closed.`)
    try {
      const trade = await engine.closePosition(id, 'manual')
      log.warn({ positionId: id, token: row.token, tradeId: trade.id }, 'position closed by operator')
      const [after] = await db.select().from(schema.positions).where(eq(schema.positions.id, id)).limit(1)
      return respond(c, { trade, position: after ? rowToPosition(after) : null })
    } catch (err) {
      if (err instanceof ApiError) throw err
      const message = err instanceof Error ? err.message : String(err)
      log.error({ positionId: id, err: message }, 'manual close failed')
      throw new ApiError(502, 'close_failed', `The engine could not close position ${id}: ${message}`)
    }
  })

  return app
}
