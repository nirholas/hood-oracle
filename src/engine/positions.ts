/**
 * Position sweep. Every two seconds each open position is re-quoted at its
 * venue, its peak / last / stale clocks are updated, and the exit ladder
 * decides whether to sell and how much. A curve position whose curve has
 * completed becomes a pool position once PoolMigrated has told us the pool.
 */
import { type Address, getAddress } from 'viem'
import { and, eq, isNull } from 'drizzle-orm'
import { errorText } from '../chain/client.js'
import { positions } from '../db/schema.js'
import type { Arm, ExitReason, LaunchRecord, Position } from '../types.js'
import type { EngineContext } from './context.js'
import { decideLadderedExit, decideLiquidityDecay, moonbagFraction, updateStaleClock, type ExitParams } from './exits.js'
import { rowToPosition, type Executor } from './executor.js'

export interface SweeperDeps {
  executor: Executor
  launchOf: (token: Address) => Promise<LaunchRecord | null>
  armById: (id: string) => Arm | undefined
}

export class PositionSweeper {
  private timer: NodeJS.Timeout | null = null
  private sweeping = false
  private open = 0
  private readonly lastReconcileAttempt = new Map<string, number>()

  constructor(private readonly ctx: EngineContext, private readonly deps: SweeperDeps) {}

  start(intervalMs = 2_000): void {
    this.timer = setInterval(() => { void this.sweepOnce() }, intervalMs)
    this.timer.unref?.()
    void this.sweepOnce()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  openCount(): number {
    return this.open
  }

  async sweepOnce(): Promise<void> {
    if (this.sweeping) return
    this.sweeping = true
    try {
      const rows = await this.ctx.db.select().from(positions).where(and(eq(positions.network, this.ctx.network), isNull(positions.closedAt)))
      this.open = rows.length
      for (const row of rows) {
        const pos = rowToPosition(row)
        try {
          await this.tick(pos)
        } catch (err) {
          this.ctx.log.error({ position: pos.id, token: pos.token, err: errorText(err) }, 'position tick failed')
        }
      }
    } catch (err) {
      this.ctx.log.error({ err: errorText(err) }, 'open-position query failed')
    } finally {
      this.sweeping = false
    }
  }

  private async tick(pos: Position): Promise<void> {
    const arm = this.deps.armById(pos.armId)
    if (!arm) {
      this.ctx.log.warn({ position: pos.id, arm: pos.armId }, 'position belongs to an arm that is no longer cached; skipping')
      return
    }
    if (pos.status === 'reconcile_pending') {
      const last = this.lastReconcileAttempt.get(pos.id) ?? 0
      if (Date.now() - last < 60_000) return
      this.lastReconcileAttempt.set(pos.id, Date.now())
      await this.deps.executor.sell({ position: pos, arm, reason: (pos.meta.intendedExit as ExitReason | undefined) ?? 'error', fraction: 1 })
      return
    }

    let pool = typeof pos.meta.pool === 'string' ? getAddress(pos.meta.pool) : null
    const factory = typeof pos.meta.factory === 'string' ? getAddress(pos.meta.factory) : null
    let venue = pos.venue
    let value: bigint | null = null
    if (venue === 'curve') {
      const state = factory ? await this.ctx.prices.curveState(pos.token, factory) : null
      if (state && state.completed) {
        const launch = await this.deps.launchOf(pos.token)
        if (launch?.pool) {
          pool = launch.pool
          venue = 'pool'
          await this.ctx.db.update(positions).set({ venue: 'pool', meta: { ...pos.meta, pool: pool.toLowerCase(), graduatedAt: new Date().toISOString() } }).where(eq(positions.id, pos.id))
          pos = { ...pos, venue: 'pool', meta: { ...pos.meta, pool: pool.toLowerCase() } }
          this.ctx.log.info({ position: pos.id, token: pos.token, pool }, 'curve position graduated; now managed on the pool')
          await this.ctx.journal.append({ armId: arm.id, token: pos.token, kind: 'observe', reason: 'position_graduated', detail: { positionId: pos.id, pool } })
        } else {
          this.ctx.log.warn({ position: pos.id, token: pos.token }, 'curve completed but no pool known yet; holding until PoolMigrated')
          return
        }
      } else if (state) {
        value = await this.ctx.prices.curveQuoteSell(factory!, pos.token, pos.tokenAmount)
      } else {
        this.ctx.log.warn({ position: pos.id, token: pos.token }, 'curve state unreadable this sweep')
        return
      }
    }
    if (venue === 'pool') {
      if (!pool) {
        // A row written without its pool (an older writer, or a graduation recorded elsewhere): the launch record knows it.
        const launch = await this.deps.launchOf(pos.token)
        if (!launch?.pool) {
          this.ctx.log.warn({ position: pos.id, token: pos.token }, 'pool position without a known pool; cannot quote')
          return
        }
        pool = launch.pool
        await this.ctx.db.update(positions).set({ meta: { ...pos.meta, pool: pool.toLowerCase() } }).where(eq(positions.id, pos.id))
        pos = { ...pos, meta: { ...pos.meta, pool: pool.toLowerCase() } }
      }
      value = await this.ctx.prices.poolQuoteSell(pool, pos.token, pos.tokenAmount)
    }
    if (value == null) return

    const now = Date.now()
    const entry = pos.entryWei
    const peak = value > pos.peakValueWei ? value : pos.peakValueWei
    const staleSince = updateStaleClock(pos.lastValueWei, value, entry, pos.staleSince ? pos.staleSince.getTime() : null, now)
    const [row] = await this.ctx.db.update(positions).set({
      lastValueWei: value.toString(), peakValueWei: peak.toString(), staleSince: staleSince != null ? new Date(staleSince) : null,
    }).where(eq(positions.id, pos.id)).returning()
    if (row) {
      pos = rowToPosition(row)
      this.ctx.bus.emit({ kind: 'position', at: now, position: pos })
    }

    if (decideLiquidityDecay(staleSince, arm.liquidityDecaySeconds, now)) {
      const houseMoney = pos.initialsRecovered && arm.moonbagAlways
      this.ctx.log.info({ position: pos.id, token: pos.token, staleForS: Math.round((now - (staleSince ?? now)) / 1000), houseMoney }, 'liquidity decay exit')
      await this.deps.executor.sell({ position: pos, arm, reason: 'liquidity_decay', fraction: houseMoney ? 1 - moonbagFraction(arm.moonbagMinPct) : 1, keepsMoonbag: houseMoney, pool })
      return
    }
    const params: ExitParams = {
      entryWei: entry, stopLossPct: arm.stopLossPct, trailingStopPct: arm.trailingStopPct, takeProfitPct: arm.takeProfitPct, maxHoldSeconds: arm.maxHoldSeconds,
      openedAt: pos.openedAt.getTime(), initialsOutMultiple: arm.initialsOutMultiple, moonbagMinPct: arm.moonbagMinPct, moonbagAlways: arm.moonbagAlways, initialsRecovered: pos.initialsRecovered,
    }
    const exit = decideLadderedExit(params, value, peak, now)
    if (exit) {
      await this.deps.executor.sell({ position: pos, arm, reason: exit.reason, fraction: exit.sellFraction, recoversInitials: exit.recoversInitials === true, keepsMoonbag: exit.keepsMoonbag === true, pool })
    }
  }
}
