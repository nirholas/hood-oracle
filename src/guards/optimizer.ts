/**
 * Bounded per-run knob mutation from an arm's realized record.
 *
 * Every 6h the jobs scheduler asks `proposeMutation` for ONE change per arm
 * that opted in (auto_optimize). One knob, one direction, one bounded step,
 * clamped to the arm's earned-autonomy tier, with the evidence spelled out in
 * the rationale. A single run can never lurch an arm to an extreme, every
 * move is observable in the decisions journal, and the same inputs always
 * produce the same proposal.
 *
 * Rules are ordered by priority and the first rule that fires wins, so
 * proposals never conflict. Tightening rules (O, A, B, C, S, E) run for every
 * tier. Earned-freedom rules (D, F, G, H) hand room back to an arm that has
 * proven it makes money and are gated on tier plus realized profit.
 *
 * Never touched here: the kill switch, wallet floor, daily loss breaker,
 * price-impact ceiling, concurrency, slippage, and the firewall. Those are
 * rails, not knobs.
 */
import { createHash } from 'node:crypto'
import { desc, eq } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { arms as armsTable, decisions as decisionsTable } from '../db/schema.js'
import type { Arm, AutonomyTier, ExitReason, Position } from '../types.js'
import { atLeast, boundsFor, stepsFor, unsetOkFor, writableFor, type ArmRecord, type NumericBound } from './autonomy.js'
import { fmtEth } from './risk.js'

/** Closed trades before any pattern rule acts. Below this the sample is noise. */
export const MIN_SAMPLE = 8

/**
 * Exception floor for an arm with ZERO wins. A 0-for-6 record with a net loss
 * is evidence enough to shrink the bet while the sample grows; waiting for
 * MIN_SAMPLE let winless arms bleed unthrottled.
 */
export const MIN_SAMPLE_WINLESS = 6

export interface ArmStats {
  closed: number
  wins: number
  winRatePct: number
  avgPnlPct: number
  bestPnlPct: number
  worstPnlPct: number
  netPnlWei: bigint
  grossSpentWei: bigint
  avgHoldSeconds: number
  exitReasons: Partial<Record<ExitReason, number>>
  /** Realized wins bucketed by the oracle score the position entered at. */
  oracleBuckets: { lo: number; closed: number; wins: number }[]
}

export const ORACLE_BUCKET_EDGES = [0, 34, 56, 72, 86] as const

const isClosed = (p: Position) => p.status === 'closed' && p.closedAt !== null

/** Realized stats from a window of positions. Open positions are ignored. */
export function statsFromPositions(positions: Position[]): ArmStats {
  const closed = positions.filter(isClosed)
  const n = closed.length
  const pcts = closed.map((p) => p.realizedPnlPct ?? 0)
  const wins = closed.filter((p) => (p.realizedPnlWei ?? 0n) > 0n).length
  const netPnlWei = closed.reduce((s, p) => s + (p.realizedPnlWei ?? 0n), 0n)
  const grossSpentWei = closed.reduce((s, p) => s + p.entryWei, 0n)
  const exitReasons: Partial<Record<ExitReason, number>> = {}
  for (const p of closed) {
    if (p.exitReason) exitReasons[p.exitReason] = (exitReasons[p.exitReason] ?? 0) + 1
  }
  const holds = closed.map((p) => ((p.closedAt as Date).getTime() - p.openedAt.getTime()) / 1000)
  const buckets = ORACLE_BUCKET_EDGES.map((lo, i) => {
    const hi = ORACLE_BUCKET_EDGES[i + 1] ?? Infinity
    const inBucket = closed.filter((p) => p.oracleScoreAtEntry !== null && p.oracleScoreAtEntry >= lo && p.oracleScoreAtEntry < hi)
    return { lo, closed: inBucket.length, wins: inBucket.filter((p) => (p.realizedPnlWei ?? 0n) > 0n).length }
  })
  return {
    closed: n,
    wins,
    winRatePct: n ? Math.round((wins / n) * 100) : 0,
    avgPnlPct: n ? pcts.reduce((a, b) => a + b, 0) / n : 0,
    bestPnlPct: n ? Math.max(...pcts) : 0,
    worstPnlPct: n ? Math.min(...pcts) : 0,
    netPnlWei,
    grossSpentWei,
    avgHoldSeconds: n ? holds.reduce((a, b) => a + b, 0) / n : 0,
    exitReasons,
    oracleBuckets: buckets,
  }
}

/**
 * The realized record the autonomy tier is decided on. Sorted by close time so
 * the drawdown walk is chronological.
 */
export function recordFromPositions(positions: Position[]): ArmRecord {
  const closed = positions.filter(isClosed).sort((a, b) => (a.closedAt as Date).getTime() - (b.closedAt as Date).getTime())
  let equity = 0n
  let peak = 0n
  let worstDd = 0
  for (const p of closed) {
    equity += p.realizedPnlWei ?? 0n
    if (equity > peak) peak = equity
    const base = peak > 0n ? peak : null
    if (base !== null && equity < peak) {
      const dd = Number(((peak - equity) * 10_000n) / base) / 100
      if (dd > worstDd) worstDd = dd
    }
  }
  const stats = statsFromPositions(closed)
  return {
    closedTrades: stats.closed,
    wins: stats.wins,
    netPnlWei: stats.netPnlWei,
    grossSpentWei: stats.grossSpentWei,
    maxDrawdownPct: worstDd,
    firstTradeAt: closed.length ? closed[0]!.openedAt : null,
  }
}

/**
 * Oracle-aware entry threshold. Given an arm's realized win rate bucketed by
 * the oracle score each position entered at, find the floor that best
 * separates winners from losers: the lowest bucket edge T where trades at or
 * above T win meaningfully more than the arm overall, with enough sample above
 * T to trust it. Null when the data does not support a move. Pure.
 */
export function bestOracleThreshold(
  buckets: ArmStats['oracleBuckets'],
  { minAbove = 4, minLift = 0.15, minTotal = 6 } = {},
): number | null {
  const b = buckets.filter((x) => x.closed > 0).sort((a, z) => a.lo - z.lo)
  if (!b.length) return null
  const total = b.reduce((s, x) => s + x.closed, 0)
  const totalWins = b.reduce((s, x) => s + x.wins, 0)
  if (total < minTotal) return null
  const overall = totalWins / total
  let best: { threshold: number; rateAbove: number } | null = null
  for (const cand of b) {
    if (cand.lo <= 0) continue
    const above = b.filter((x) => x.lo >= cand.lo)
    const closedAbove = above.reduce((s, x) => s + x.closed, 0)
    const winsAbove = above.reduce((s, x) => s + x.wins, 0)
    if (closedAbove < minAbove || closedAbove === total) continue
    const rateAbove = winsAbove / closedAbove
    if (rateAbove - overall >= minLift && (!best || rateAbove > best.rateAbove)) best = { threshold: cand.lo, rateAbove }
  }
  return best ? best.threshold : null
}

export type OptimizerRule = 'O' | 'A' | 'B' | 'C' | 'S' | 'D' | 'E' | 'F' | 'G' | 'H' | 'W'

export interface Mutation {
  knob: keyof Arm
  from: number | bigint | null
  to: number | bigint
  patch: Partial<Arm>
  rationale: string
  rule: OptimizerRule
  tier: AutonomyTier
  sample: number
}

const clamp = (n: number, b: NumericBound) => Math.max(b.min, Math.min(b.max, n))

/** Move `from` toward `to` by at most `step`, then clamp. Null `from` sets directly. */
function boundedToward(from: number | null, to: number, step: number, b: NumericBound): number {
  const target = clamp(to, b)
  if (from === null) return target
  const delta = target - from
  const capped = Math.abs(delta) <= step ? target : from + Math.sign(delta) * step
  return clamp(capped, b)
}

const INTEGER_KNOBS: ReadonlySet<keyof Arm> = new Set(['maxHoldSeconds', 'maxCreatorLaunches'])

const share = (er: ArmStats['exitReasons'], key: ExitReason, total: number) => (total ? (er[key] ?? 0) / total : 0)

/**
 * Propose at most one bounded mutation for an arm. `record` decides the tier
 * (computed from live fills by the scheduler); `recentPositions` supplies the
 * pattern evidence and may include simulated fills so an arm converges its
 * knobs before it ever goes live. Returns null when nothing should change.
 */
export function proposeMutation(arm: Arm, record: ArmRecord, recentPositions: Position[]): Mutation | null {
  const tier = arm.autonomyTier
  const stats = statsFromPositions(recentPositions)
  const sample = stats.closed
  const bounds = boundsFor(tier)
  const steps = stepsFor(tier)
  const writable = writableFor(tier)
  const unsetOk = unsetOkFor(tier)
  const earned = atLeast('trusted', tier)
  const netPnl = stats.netPnlWei
  const avg = stats.avgPnlPct
  const best = stats.bestPnlPct
  const winRate = stats.winRatePct
  const er = stats.exitReasons

  const winlessBleeder = stats.wins === 0 && sample >= MIN_SAMPLE_WINLESS && netPnl < 0n
  if (sample < MIN_SAMPLE && !winlessBleeder) return null

  const numeric = (knob: keyof Arm): number | null => {
    const v = arm[knob]
    return typeof v === 'number' && Number.isFinite(v) ? v : null
  }

  const build = (knob: keyof Arm, to: number | bigint, rationale: string, rule: OptimizerRule): Mutation | null => {
    if (!writable.has(knob)) return null
    if (knob === 'perTradeWei') {
      if (typeof to !== 'bigint') return null
      const b = bounds.perTradeWei
      let target = to < b.min ? b.min : to > b.max ? b.max : to
      // Never propose a bet the arm's own daily budget cannot fund: a size
      // above the day's budget fails `spent + size <= budget` on every
      // evaluation and the arm goes silently dead.
      if (arm.dailyBudgetWei > 0n && target > arm.dailyBudgetWei) target = arm.dailyBudgetWei
      if (target === arm.perTradeWei) return null
      return { knob, from: arm.perTradeWei, to: target, patch: { perTradeWei: target }, rationale, rule, tier, sample }
    }
    const b = (bounds as unknown as Record<string, NumericBound | undefined>)[knob]
    if (!b || typeof to !== 'number') return null
    const from = numeric(knob)
    if (from === null && !unsetOk.has(knob)) return null
    let target = boundedToward(from, to, (steps as Record<string, number>)[knob] ?? Infinity, b)
    if (!Number.isFinite(target)) return null
    target = INTEGER_KNOBS.has(knob) ? Math.round(target) : Number(target.toFixed(2))
    if (from !== null && target === from) return null
    return { knob, from, to: target, patch: { [knob]: target } as Partial<Arm>, rationale, rule, tier, sample }
  }

  const shrink = (fraction: number): bigint => {
    const keep = BigInt(Math.round((1 - fraction) * 10_000))
    return (arm.perTradeWei * keep) / 10_000n
  }
  const grow = (fraction: number): bigint => {
    const scale = BigInt(Math.round((1 + fraction) * 10_000))
    return (arm.perTradeWei * scale) / 10_000n
  }
  const pnl = fmtEth(netPnl)

  // Rule W: winless fast path. Below MIN_SAMPLE only this de-risking move may act.
  if (sample < MIN_SAMPLE && winlessBleeder) {
    return build(
      'perTradeWei',
      shrink(steps.perTradeFraction),
      `Zero wins in ${sample} closed trades (net ${pnl}): shrink the bet while the sample grows. Pattern rules stay quiet until ${MIN_SAMPLE} closes.`,
      'W',
    )
  }

  // Rule O: oracle-aware entry. Realized wins concentrate above a score floor:
  // raise the floor to buy where this arm actually wins. Runs first so the
  // data-driven signal claims the knob before Rule B's cruder bump.
  const oracleTarget = bestOracleThreshold(stats.oracleBuckets)
  const oracle = numeric('minOracleScore')
  if (oracleTarget !== null && (oracle === null || oracleTarget > oracle)) {
    const m = build(
      'minOracleScore',
      oracleTarget,
      `Realized wins concentrate at oracle score >= ${oracleTarget} over ${sample} trades: raise the conviction floor to buy where this arm actually wins.`,
      'O',
    )
    if (m) return m
  }

  // Rule A: winners are timing out unrealized.
  const timeoutShare = share(er, 'timeout', sample)
  if (timeoutShare >= 0.4 && avg > 5) {
    const tp = numeric('takeProfitPct')
    const m =
      tp === null
        ? build(
            'takeProfitPct',
            Math.round(Math.max(avg * 1.5, best * 0.6)),
            `${Math.round(timeoutShare * 100)}% of exits were timeouts while average P&L was +${avg.toFixed(1)}%: winners expire unrealized. Set a take-profit to lock gains.`,
            'A',
          )
        : build(
            'takeProfitPct',
            Math.round(Math.max(avg * 1.2, bounds.takeProfitPct.min)),
            `Winners still timing out with take-profit at ${tp}%: lower it toward the realized average (+${avg.toFixed(1)}%) so it actually triggers.`,
            'A',
          )
    if (m) return m
  }

  // Rule B: losers dominated by the stop: entries are low quality. Tighten
  // selection first, then de-risk size.
  const stopShare = share(er, 'stop_loss', sample)
  if (stopShare >= 0.5 && winRate < 40) {
    if (arm.decisionMode === 'rules' && oracle !== null) {
      const m = build(
        'minOracleScore',
        oracle + steps.minOracleScore,
        `${Math.round(stopShare * 100)}% of exits hit the stop and the win rate is ${winRate}%: raise the oracle floor to be more selective.`,
        'B',
      )
      if (m) return m
    }
    const m = build(
      'perTradeWei',
      shrink(steps.perTradeFraction),
      `Stop-loss heavy (${Math.round(stopShare * 100)}%) at a ${winRate}% win rate: cut position size ${Math.round(steps.perTradeFraction * 100)}% to reduce bleed while entries improve.`,
      'B',
    )
    if (m) return m
  }

  // Rule C: trailing-stop behaviour. One direction fires, chosen by P&L sign.
  const trail = numeric('trailingStopPct')
  if (share(er, 'trailing_stop', sample) >= 0.5 && trail !== null) {
    if (avg > 0 && best - avg >= 15) {
      const m = build(
        'trailingStopPct',
        trail - steps.trailingStopPct,
        `Trailing exits give back a lot (best +${best.toFixed(0)}% vs average +${avg.toFixed(0)}%): tighten the trailing stop to keep more of each run.`,
        'C',
      )
      if (m) return m
    } else if (avg < 0) {
      const m = build(
        'trailingStopPct',
        trail + steps.trailingStopPct,
        `Trailing stop is shaking positions out at a loss (average ${avg.toFixed(1)}%): loosen it to survive normal volatility.`,
        'C',
      )
      if (m) return m
    }
  }

  // Rule S: size-weighted divergence. A positive unweighted average beside a
  // negative net is only possible one way: the bigger bets are the losers, so
  // the edge does not scale. Shrink the bet rather than tune an exit. Runs
  // before Rule D so a losing arm is never handed more size on a vanity metric.
  if (netPnl < 0n && avg > 0) {
    const m = build(
      'perTradeWei',
      shrink(steps.perTradeFraction),
      `Average return is +${avg.toFixed(1)}% but the arm is down ${pnl} over ${sample} trades: the bigger bets are the losing ones, so the edge does not scale. Shrink position size rather than tune an exit.`,
      'S',
    )
    if (m) return m
  }

  // Rule D: proven arm: scale size up within the tier ceiling. Either a high
  // hit rate that is ALSO net positive, or (tier-gated) a real profit at any
  // hit rate.
  const provenByWinRate = winRate >= 60 && avg > 10 && netPnl >= 0n
  const provenByProfit = earned && netPnl > 0n
  if ((provenByWinRate || provenByProfit) && sample >= MIN_SAMPLE * 1.5) {
    const pct = Math.round(steps.perTradeFraction * 75)
    const m = build(
      'perTradeWei',
      grow(steps.perTradeFraction * 0.75),
      provenByWinRate
        ? `Proven arm (${winRate}% win rate, average +${avg.toFixed(1)}% over ${sample} trades): scale size up ${pct}% within the tier cap.`
        : `Net profitable over ${sample} trades (${pnl}, average +${avg.toFixed(1)}%) despite a ${winRate}% win rate: an edge that pays does not need a high hit rate. Scale size up ${pct}% within the tier cap.`,
      'D',
    )
    if (m) return m
  }

  // Rule E: chronic loser: throttle size hard (short of auto-disable, which
  // stays a human call).
  if (((winRate < 25 && sample >= MIN_SAMPLE * 1.5) || winlessBleeder) && netPnl < 0n) {
    const m = build(
      'perTradeWei',
      shrink(steps.perTradeFraction),
      winlessBleeder
        ? `Zero wins in ${sample} closed trades (net ${pnl}): throttle size while the record stays winless. Consider disarming this arm.`
        : `Sustained underperformance (${winRate}% win rate, net ${pnl} over ${sample} trades): throttle size. Consider disarming this arm.`,
      'E',
    )
    if (m) return m
  }

  // Earned freedom. Everything below hands room back to an arm that has proven
  // it makes money. Gated on tier and realized profit, bounded, reversible.
  const profitable = earned && netPnl > 0n

  // Rule F: a profitable judge earns a lower bar.
  const confidence = numeric('llmMinConfidence')
  if (profitable && arm.decisionMode === 'llm' && confidence !== null) {
    const m = build(
      'llmMinConfidence',
      confidence - steps.llmMinConfidence,
      `Profitable judgment (net ${pnl}, average +${avg.toFixed(1)}% over ${sample} trades): lower the confidence floor from ${confidence} so the model acts on more of what it sees.`,
      'F',
    )
    if (m) return m
  }

  // Rule G: a profitable arm earns a wider hunting ground. Only widens a band
  // that exists: no band means already unrestricted.
  if (profitable) {
    const mcapMin = numeric('minMarketCapEth')
    if (mcapMin !== null) {
      const m = build(
        'minMarketCapEth',
        mcapMin - steps.minMarketCapEth,
        `Profitable over ${sample} trades: lower the entry floor from ${mcapMin} ETH market cap to explore earlier launches this arm never sees.`,
        'G',
      )
      if (m) return m
    }
    const mcapMax = numeric('maxMarketCapEth')
    if (mcapMax !== null) {
      const m = build(
        'maxMarketCapEth',
        mcapMax + steps.maxMarketCapEth,
        `Profitable over ${sample} trades: raise the entry ceiling from ${mcapMax} ETH market cap to explore larger launches this arm never sees.`,
        'G',
      )
      if (m) return m
    }
    const creatorCap = numeric('maxCreatorLaunches')
    if (creatorCap !== null) {
      const m = build(
        'maxCreatorLaunches',
        creatorCap + steps.maxCreatorLaunches,
        `Profitable over ${sample} trades: loosen the serial-launcher cap from ${creatorCap}. A prolific creator is not automatically a bad one, and this arm has earned the right to test that.`,
        'G',
      )
      if (m) return m
    }
  }

  // Rule H: winners run well past the average exit: turn on (or widen) the
  // take-initials ladder.
  if (profitable && best - avg >= 25) {
    const ladder = numeric('initialsOutMultiple')
    if (ladder === null) {
      const m = build(
        'initialsOutMultiple',
        2,
        `Winners run far past the average exit (best +${best.toFixed(0)}% vs average +${avg.toFixed(1)}% over ${sample} trades) and the arm is net profitable: turn on the take-initials ladder. Recover the stake at 2x, keep the moon bag, let the rest ride the trailing stop.`,
        'H',
      )
      if (m) return m
    } else {
      const m = build(
        'moonbagMinPct',
        arm.moonbagMinPct + steps.moonbagMinPct,
        `Ladder is on and winners still run well past the average exit (best +${best.toFixed(0)}% vs average +${avg.toFixed(1)}%): raise the moon-bag floor from ${arm.moonbagMinPct}% so more of each winner keeps riding.`,
        'H',
      )
      if (m) return m
    }
  }

  return null
}

const WEI_COLUMNS: ReadonlySet<string> = new Set(['perTradeWei', 'dailyBudgetWei'])

/** Arm patch to a Drizzle row patch: wei bigints become numeric strings. */
export function armPatchToRow(patch: Partial<Arm>): Record<string, unknown> {
  const row: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'id' || k === 'createdAt') continue
    row[k] = WEI_COLUMNS.has(k) && typeof v === 'bigint' ? v.toString() : v
  }
  row.updatedAt = new Date()
  return row
}

/** Canonical JSON: keys sorted at every depth, bigints as strings, Dates as ISO. */
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (typeof v === 'bigint') return v.toString()
    if (v instanceof Date) return v.toISOString()
    if (Array.isArray(v)) return v.map(norm)
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = norm((v as Record<string, unknown>)[k])
      return out
    }
    return v
  }
  return JSON.stringify(norm(value))
}

export interface JournalEntry {
  armId: string
  token: null
  kind: 'observe'
  reason: 'auto_optimize'
  detail: Record<string, unknown>
}

export interface ApplyMutationOptions {
  /**
   * The engine's journal writer, when the caller has one. It owns the hash
   * chain; without it `applyMutation` chains the row itself using
   * `entryHash = sha256(prevHash + canonicalJson({armId, token, kind, reason, detail, at}))`.
   */
  journal?: (entry: JournalEntry) => Promise<unknown>
  now?: Date
}

/**
 * Write a mutation to the arm and record it as an `observe` decision with
 * reason `auto_optimize`, in one transaction. Returns the decision id and hash.
 */
export async function applyMutation(
  db: Db,
  armId: string,
  patch: Partial<Arm>,
  rationale: string,
  opts: ApplyMutationOptions = {},
): Promise<{ decisionId: string | null; entryHash: string | null }> {
  const row = armPatchToRow(patch)
  const detail = { rationale, patch: JSON.parse(canonicalJson(patch)) as Record<string, unknown> }
  const at = opts.now ?? new Date()

  if (opts.journal) {
    await db.update(armsTable).set(row).where(eq(armsTable.id, armId))
    await opts.journal({ armId, token: null, kind: 'observe', reason: 'auto_optimize', detail })
    return { decisionId: null, entryHash: null }
  }

  return db.transaction(async (tx) => {
    await tx.update(armsTable).set(row).where(eq(armsTable.id, armId))
    const [last] = await tx
      .select({ entryHash: decisionsTable.entryHash })
      .from(decisionsTable)
      .orderBy(desc(decisionsTable.at), desc(decisionsTable.id))
      .limit(1)
    const prevHash = last?.entryHash ?? null
    const body = { armId, token: null, kind: 'observe', reason: 'auto_optimize', detail, at }
    const entryHash = createHash('sha256').update(`${prevHash ?? ''}${canonicalJson(body)}`).digest('hex')
    const [inserted] = await tx
      .insert(decisionsTable)
      .values({ armId, token: null, kind: 'observe', reason: 'auto_optimize', detail, prevHash, entryHash, at })
      .returning({ id: decisionsTable.id })
    return { decisionId: inserted?.id ?? null, entryHash }
  })
}
