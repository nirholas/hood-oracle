import { Hono } from 'hono'
import { eq, sql } from 'drizzle-orm'
import { schema } from '../../db/client.js'
import type { AppDeps } from '../deps.js'
import type { ArmSummary } from '../contract.js'
import { parseArmInput, assertArmable, defaultArm, toColumns, toDomainPatch } from '../arm-schema.js'
import { clampToTier } from '../../guards/autonomy.js'
import { rowToArm } from '../serialize.js'
import { respond } from '../json.js'
import { notFound, badRequest } from '../errors.js'
import { parseUuid } from '../query.js'
import type { Arm } from '../../types.js'

interface SummaryRow {
  arm_id: string
  open: string
  closed: string
  wins: string
  realized_pnl_wei: string
  last_trade_at: Date | null
}

const EMPTY_SUMMARY: ArmSummary = { open: 0, closed: 0, wins: 0, realizedPnlWei: '0', lastTradeAt: null }

async function summaries(db: AppDeps['db'], armIds: string[]): Promise<Map<string, ArmSummary>> {
  const out = new Map<string, ArmSummary>()
  if (!armIds.length) return out
  const rows = (await db.execute(sql`
    select p.arm_id,
           count(*) filter (where p.status = 'open')::text as open,
           count(*) filter (where p.status = 'closed')::text as closed,
           count(*) filter (where p.status = 'closed' and p.realized_pnl_wei > 0)::text as wins,
           coalesce(sum(p.realized_pnl_wei) filter (where p.status = 'closed'), 0)::text as realized_pnl_wei,
           (select max(t.at) from trades t where t.arm_id = p.arm_id) as last_trade_at
    from positions p
    where p.arm_id in ${armIds}
    group by p.arm_id
  `)) as unknown as SummaryRow[]
  for (const r of rows) {
    out.set(r.arm_id, {
      open: Number(r.open),
      closed: Number(r.closed),
      wins: Number(r.wins),
      realizedPnlWei: r.realized_pnl_wei,
      lastTradeAt: r.last_trade_at ? new Date(r.last_trade_at).toISOString() : null,
    })
  }
  return out
}

async function readJson(c: { req: { json(): Promise<unknown>; header(name: string): string | undefined } }): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    throw badRequest('request body must be JSON')
  }
}

export function armRoutes(deps: AppDeps): Hono {
  const { db, engine, log } = deps
  const app = new Hono()

  async function loadArm(id: string): Promise<Arm> {
    const [row] = await db.select().from(schema.arms).where(eq(schema.arms.id, id)).limit(1)
    if (!row) throw notFound(`arm ${id}`)
    return rowToArm(row)
  }

  async function writeArm(id: string, patch: Record<string, unknown>): Promise<Arm> {
    const [row] = await db
      .update(schema.arms)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(schema.arms.id, id))
      .returning()
    if (!row) throw notFound(`arm ${id}`)
    await engine.refreshArms()
    return rowToArm(row)
  }

  app.get('/', async (c) => {
    const rows = await db.select().from(schema.arms).orderBy(schema.arms.createdAt)
    const arms = rows.map(rowToArm)
    const sums = await summaries(db, arms.map((a) => a.id))
    return respond(c, {
      arms: arms.map((a) => ({ ...a, summary: sums.get(a.id) ?? EMPTY_SUMMARY })),
      count: arms.length,
    })
  })

  app.post('/', async (c) => {
    const input = parseArmInput(await readJson(c), 'create')
    const { enabled, ...columns } = input
    const network = columns.network ?? deps.config.network
    // Operator writes stay inside the arm's earned autonomy bounds: a knob
    // outside the tier's range is pulled to the edge, a refused one dropped,
    // and both are reported back instead of being stored silently.
    const domain = toDomainPatch(columns)
    const clamp = clampToTier(defaultArm(network), domain, domain.autonomyTier ?? 'standard')
    const [inserted] = await db
      .insert(schema.arms)
      .values({ ...(toColumns(clamp.patch) as typeof schema.arms.$inferInsert), label: input.label, network })
      .returning()
    let arm = rowToArm(inserted)
    if (enabled) {
      assertArmable(arm, engine.health())
      arm = await writeArm(arm.id, { enabled: true, killSwitch: false })
    } else {
      await engine.refreshArms()
    }
    log.info({ armId: arm.id, label: arm.label, mode: arm.mode, enabled: arm.enabled, clamped: clamp.clamped.length, refused: clamp.refused.length }, 'arm created')
    return respond(c, { arm, clamped: clamp.clamped, refused: clamp.refused }, 201)
  })

  app.get('/:id', async (c) => {
    const id = parseUuid(c.req.param('id'), 'arm id')
    const arm = await loadArm(id)
    const sums = await summaries(db, [id])
    return respond(c, { arm: { ...arm, summary: sums.get(id) ?? EMPTY_SUMMARY } })
  })

  app.patch('/:id', async (c) => {
    const id = parseUuid(c.req.param('id'), 'arm id')
    const input = parseArmInput(await readJson(c), 'patch')
    const current = await loadArm(id)
    const domain = toDomainPatch(input)
    const clamp = clampToTier(current, domain, domain.autonomyTier ?? current.autonomyTier)
    const merged: Arm = { ...current, ...clamp.patch }
    // An arm that ends up enabled after this write must still clear the gate:
    // patching the stop loss to 0 on a live arm is refused, not silently stored.
    if (merged.enabled) assertArmable(merged, engine.health())
    const patch: Record<string, unknown> = toColumns(clamp.patch)
    if (clamp.patch.enabled === true && !current.enabled) patch.killSwitch = false
    const arm = await writeArm(id, patch)
    log.info({ armId: id, fields: Object.keys(clamp.patch), clamped: clamp.clamped.length, refused: clamp.refused.length }, 'arm updated')
    return respond(c, { arm, clamped: clamp.clamped, refused: clamp.refused })
  })

  app.delete('/:id', async (c) => {
    const id = parseUuid(c.req.param('id'), 'arm id')
    const [deleted] = await db.delete(schema.arms).where(eq(schema.arms.id, id)).returning({ id: schema.arms.id })
    if (!deleted) throw notFound(`arm ${id}`)
    await engine.refreshArms()
    log.warn({ armId: id }, 'arm deleted')
    return respond(c, { ok: true, id })
  })

  app.post('/:id/arm', async (c) => {
    const id = parseUuid(c.req.param('id'), 'arm id')
    const current = await loadArm(id)
    assertArmable(current, engine.health())
    const arm = await writeArm(id, { enabled: true, killSwitch: false })
    log.info({ armId: id, mode: arm.mode }, 'arm armed')
    return respond(c, { arm })
  })

  app.post('/:id/disarm', async (c) => {
    const id = parseUuid(c.req.param('id'), 'arm id')
    await loadArm(id)
    const arm = await writeArm(id, { enabled: false })
    log.info({ armId: id }, 'arm disarmed')
    return respond(c, { arm })
  })

  app.post('/:id/kill', async (c) => {
    const id = parseUuid(c.req.param('id'), 'arm id')
    await loadArm(id)
    const arm = await writeArm(id, { enabled: false, killSwitch: true })
    log.warn({ armId: id }, 'arm kill switch tripped')
    return respond(c, { arm })
  })

  return app
}
