/** Trades, the hash-chained decision journal, and equity curves. */
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { schema } from '../../db/client.js'
import type { AppDeps } from '../deps.js'
import { parseLimit, parseOptionalAddress, parseOptionalUuid } from '../query.js'
import { rowToDecision, rowToTrade } from '../serialize.js'
import type { DecisionsResponse, EquityResponse, TradeListItem } from '../contract.js'

interface ChainRow {
  id: string
  at: Date
  prev_hash: string | null
  entry_hash: string
}

function wire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))) as T
}

/**
 * Walks the whole journal in insertion order and checks every row's prevHash
 * is the entryHash of the row before it. Recomputing each hash needs the
 * engine's canonical encoding, which lives with the writer; the link check is
 * what an outside reader can verify from the rows alone.
 */
export async function verifyDecisionChain(db: AppDeps['db']): Promise<DecisionsResponse['chain']> {
  const rows = (await db.execute(sql`select id, at, prev_hash, entry_hash from decisions order by at asc, id asc`)) as unknown as ChainRow[]
  const breaks: { id: string; at: string }[] = []
  let prev: string | null = null
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (i > 0 && r.prev_hash !== prev) breaks.push({ id: r.id, at: new Date(r.at).toISOString() })
    prev = r.entry_hash
  }
  return { ok: breaks.length === 0, rows: rows.length, breaks: breaks.slice(0, 20), verifiedAt: new Date().toISOString() }
}

export interface LedgerQuery {
  arm?: string
  token?: string
  limit?: string | number
}

const lim = (v: string | number | undefined) => (v == null ? undefined : String(v))

export async function listTrades(deps: AppDeps, q: LedgerQuery = {}): Promise<{ trades: TradeListItem[]; count: number }> {
  const armId = parseOptionalUuid(q.arm, 'arm')
  const token = parseOptionalAddress(q.token)
  const limit = parseLimit(lim(q.limit), 100, 1000)
  const conditions = [eq(schema.trades.network, deps.config.network)]
  if (armId) conditions.push(eq(schema.trades.armId, armId))
  if (token) conditions.push(sql`lower(${schema.trades.token}) = ${token}`)
  const rows = await deps.db
    .select({ trade: schema.trades, armLabel: schema.arms.label, symbol: schema.launches.symbol })
    .from(schema.trades)
    .innerJoin(schema.arms, eq(schema.arms.id, schema.trades.armId))
    .leftJoin(schema.launches, and(eq(schema.launches.token, schema.trades.token), eq(schema.launches.network, schema.trades.network)))
    .where(and(...conditions))
    .orderBy(desc(schema.trades.at))
    .limit(limit)
  const items: TradeListItem[] = rows.map((r) => ({
    ...(wire(rowToTrade(r.trade)) as unknown as Omit<TradeListItem, 'symbol' | 'armLabel'>),
    symbol: r.symbol ?? null,
    armLabel: r.armLabel,
  }))
  return { trades: items, count: items.length }
}

export async function listDecisions(deps: AppDeps, q: LedgerQuery = {}): Promise<DecisionsResponse> {
  const armId = parseOptionalUuid(q.arm, 'arm')
  const token = parseOptionalAddress(q.token)
  const limit = parseLimit(lim(q.limit), 100, 1000)
  const conditions = []
  if (armId) conditions.push(eq(schema.decisions.armId, armId))
  if (token) conditions.push(sql`lower(${schema.decisions.token}) = ${token}`)
  const [rows, chain] = await Promise.all([
    deps.db
      .select({ decision: schema.decisions, armLabel: schema.arms.label })
      .from(schema.decisions)
      .leftJoin(schema.arms, eq(schema.arms.id, schema.decisions.armId))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(schema.decisions.at))
      .limit(limit),
    verifyDecisionChain(deps.db),
  ])
  return {
    items: rows.map((r) => ({ ...(wire(rowToDecision(r.decision)) as unknown as DecisionsResponse['items'][number]), armLabel: r.armLabel ?? null })),
    chain,
  }
}

export async function equitySeries(deps: AppDeps, q: { arm?: string; limit?: string | number } = {}): Promise<EquityResponse> {
  const armId = parseOptionalUuid(q.arm, 'arm')
  const perArm = parseLimit(lim(q.limit), 1000, 5000)
  const armRows = await deps.db
    .select({ id: schema.arms.id, label: schema.arms.label })
    .from(schema.arms)
    .where(armId ? eq(schema.arms.id, armId) : eq(schema.arms.network, deps.config.network))
    .orderBy(asc(schema.arms.createdAt))
  const series: EquityResponse['series'] = []
  for (const arm of armRows) {
    const points = await deps.db
      .select({ at: schema.equityPoints.at, realizedWei: schema.equityPoints.realizedWei, openValueWei: schema.equityPoints.openValueWei, equityWei: schema.equityPoints.equityWei })
      .from(schema.equityPoints)
      .where(eq(schema.equityPoints.armId, arm.id))
      .orderBy(desc(schema.equityPoints.at))
      .limit(perArm)
    points.reverse()
    series.push({
      armId: arm.id,
      armLabel: arm.label,
      points: points.map((p) => ({ at: p.at.toISOString(), realizedWei: p.realizedWei, openValueWei: p.openValueWei, equityWei: p.equityWei })),
    })
  }
  return { series }
}
