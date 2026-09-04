/**
 * Arm operations shared by the HTTP routes and the MCP tools. Every function
 * takes raw input (an id string, an unparsed body), validates it the same way
 * the API always has, and throws ApiError on a refusal so both surfaces
 * answer with the same code and message.
 */
import { eq, sql } from 'drizzle-orm'
import { schema } from '../../db/client.js'
import type { AppDeps } from '../deps.js'
import type { ArmListItem, ArmSummary, ArmWire, ArmWriteResponse } from '../contract.js'
import { parseArmInput, assertArmable, defaultArm, toColumns, toDomainPatch } from '../arm-schema.js'
import { clampToTier } from '../../guards/autonomy.js'
import { rowToArm } from '../serialize.js'
import { notFound } from '../errors.js'
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

/** Domain arm -> wire arm. Wei become decimal strings and dates ISO, exactly as the JSON replacer would. */
function wire(arm: Arm): ArmWire {
  return JSON.parse(JSON.stringify(arm, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))) as ArmWire
}

type Clamp = ReturnType<typeof clampToTier>

/** The tier clamp's report with wei as decimal strings, matching the wire contract. */
function wireClamp(clamp: Clamp): Pick<ArmWriteResponse, 'clamped' | 'refused'> {
  const str = (v: number | bigint | null) => (typeof v === 'bigint' ? v.toString() : v)
  return {
    clamped: clamp.clamped.map((c) => ({ knob: c.knob, from: str(c.from), to: str(c.to) as string | number })),
    refused: clamp.refused,
  }
}

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

async function loadArm(deps: AppDeps, id: string): Promise<Arm> {
  const [row] = await deps.db.select().from(schema.arms).where(eq(schema.arms.id, id)).limit(1)
  if (!row) throw notFound(`arm ${id}`)
  return rowToArm(row)
}

async function writeArm(deps: AppDeps, id: string, patch: Record<string, unknown>): Promise<Arm> {
  const [row] = await deps.db
    .update(schema.arms)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(schema.arms.id, id))
    .returning()
  if (!row) throw notFound(`arm ${id}`)
  await deps.engine.refreshArms()
  return rowToArm(row)
}

export async function listArms(deps: AppDeps): Promise<{ arms: ArmListItem[]; count: number }> {
  const rows = await deps.db.select().from(schema.arms).orderBy(schema.arms.createdAt)
  const arms = rows.map(rowToArm)
  const sums = await summaries(deps.db, arms.map((a) => a.id))
  return { arms: arms.map((a) => ({ ...wire(a), summary: sums.get(a.id) ?? EMPTY_SUMMARY })), count: arms.length }
}

export async function getArm(deps: AppDeps, rawId: string): Promise<{ arm: ArmListItem }> {
  const id = parseUuid(rawId, 'arm id')
  const arm = await loadArm(deps, id)
  const sums = await summaries(deps.db, [id])
  return { arm: { ...wire(arm), summary: sums.get(id) ?? EMPTY_SUMMARY } }
}

export async function createArm(deps: AppDeps, body: unknown): Promise<ArmWriteResponse> {
  const { db, engine, log } = deps
  const input = parseArmInput(body, 'create')
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
    arm = await writeArm(deps, arm.id, { enabled: true, killSwitch: false })
  } else {
    await engine.refreshArms()
  }
  log.info({ armId: arm.id, label: arm.label, mode: arm.mode, enabled: arm.enabled, clamped: clamp.clamped.length, refused: clamp.refused.length }, 'arm created')
  return { arm: wire(arm), ...wireClamp(clamp) }
}

export async function patchArm(deps: AppDeps, rawId: string, body: unknown): Promise<ArmWriteResponse> {
  const id = parseUuid(rawId, 'arm id')
  const input = parseArmInput(body, 'patch')
  const current = await loadArm(deps, id)
  const domain = toDomainPatch(input)
  const clamp = clampToTier(current, domain, domain.autonomyTier ?? current.autonomyTier)
  const merged: Arm = { ...current, ...clamp.patch }
  // An arm that ends up enabled after this write must still clear the gate:
  // patching the stop loss to 0 on a live arm is refused, not silently stored.
  if (merged.enabled) assertArmable(merged, deps.engine.health())
  const patch: Record<string, unknown> = toColumns(clamp.patch)
  if (clamp.patch.enabled === true && !current.enabled) patch.killSwitch = false
  const arm = await writeArm(deps, id, patch)
  deps.log.info({ armId: id, fields: Object.keys(clamp.patch), clamped: clamp.clamped.length, refused: clamp.refused.length }, 'arm updated')
  return { arm: wire(arm), ...wireClamp(clamp) }
}

export async function deleteArm(deps: AppDeps, rawId: string): Promise<{ ok: true; id: string }> {
  const id = parseUuid(rawId, 'arm id')
  const [deleted] = await deps.db.delete(schema.arms).where(eq(schema.arms.id, id)).returning({ id: schema.arms.id })
  if (!deleted) throw notFound(`arm ${id}`)
  await deps.engine.refreshArms()
  deps.log.warn({ armId: id }, 'arm deleted')
  return { ok: true, id }
}

/** Enable an arm. Runs the armability gate (stop loss, sizing, live wallet). */
export async function enableArm(deps: AppDeps, rawId: string): Promise<{ arm: ArmWire }> {
  const id = parseUuid(rawId, 'arm id')
  const current = await loadArm(deps, id)
  assertArmable(current, deps.engine.health())
  const arm = await writeArm(deps, id, { enabled: true, killSwitch: false })
  deps.log.info({ armId: id, mode: arm.mode }, 'arm armed')
  return { arm: wire(arm) }
}

export async function disableArm(deps: AppDeps, rawId: string): Promise<{ arm: ArmWire }> {
  const id = parseUuid(rawId, 'arm id')
  await loadArm(deps, id)
  const arm = await writeArm(deps, id, { enabled: false })
  deps.log.info({ armId: id }, 'arm disarmed')
  return { arm: wire(arm) }
}

export async function killArm(deps: AppDeps, rawId: string): Promise<{ arm: ArmWire }> {
  const id = parseUuid(rawId, 'arm id')
  await loadArm(deps, id)
  const arm = await writeArm(deps, id, { enabled: false, killSwitch: true })
  deps.log.warn({ armId: id }, 'arm kill switch tripped')
  return { arm: wire(arm) }
}
