/**
 * Exit decisions, pure and in wei. Ported from the production Solana sniper's
 * exit-logic (stop-loss > trailing stop > take-initials > take-profit >
 * timeout, moon bag maths, liquidity-decay clock, reconcile give-up), with the
 * lamport floats replaced by bigint so a 1e18 position never loses precision.
 */
import type { ExitReason } from '../types.js'

export interface ExitParams {
  entryWei: bigint
  stopLossPct: number
  trailingStopPct: number | null
  takeProfitPct: number | null
  maxHoldSeconds: number | null
  /** epoch ms */
  openedAt: number
  initialsOutMultiple: number | null
  moonbagMinPct: number
  moonbagAlways: boolean
  initialsRecovered: boolean
}

export interface LadderDecision {
  reason: ExitReason
  /** Fraction of the CURRENT remaining position to sell, (0, 1]. */
  sellFraction: number
  recoversInitials?: boolean
  keepsMoonbag?: boolean
}

const PPM = 1_000_000n

/** A percentage as a ppm multiplier of the base: pctToPpm(30) = 300000n. */
const pctPpm = (pct: number): bigint => BigInt(Math.round(pct * 10_000))
/** value <= base * (1 - pct/100) */
const belowBy = (value: bigint, base: bigint, pct: number): boolean => value * PPM <= base * (PPM - pctPpm(pct))
/** value >= base * (1 + pct/100) */
const aboveBy = (value: bigint, base: bigint, pct: number): boolean => value * PPM >= base * (PPM + pctPpm(pct))
/** value >= base * mult */
const atMultiple = (value: bigint, base: bigint, mult: number): boolean => value * PPM >= base * BigInt(Math.round(mult * 1_000_000))

/** Coerce to a finite positive-or-zero number, or null. null means "disabled", never 0. */
export function pct(n: number | null | undefined): number | null {
  if (n == null) return null
  return Number.isFinite(n) ? n : null
}

/** The take-initials multiple, or null when the ladder is off (must exceed 1). */
export function ladderMultiple(n: number | null | undefined): number | null {
  const x = pct(n)
  return x != null && x > 1 ? x : null
}

/** Moon-bag floor as a fraction of the position, clamped to [0, 0.95]. */
export function moonbagFraction(n: number | null | undefined): number {
  const x = pct(n)
  const frac = x == null ? 15 : x
  return Math.max(0, Math.min(0.95, frac / 100))
}

/**
 * Single-shot exit reason, priority ordered. The trailing stop arms only once
 * the position has been green (peak above entry): armed underwater it turns
 * recoverable dips into locked losses while the hard stop already caps the
 * downside.
 */
export function decideExit(p: ExitParams, value: bigint, peak: bigint, now = Date.now()): ExitReason | null {
  const entry = p.entryWei
  if (entry <= 0n) return null
  const sl = pct(p.stopLossPct)
  const ts = pct(p.trailingStopPct)
  const tp = pct(p.takeProfitPct)
  if (sl != null && belowBy(value, entry, sl)) return 'stop_loss'
  if (ts != null && peak > entry && belowBy(value, peak, ts)) return 'trailing_stop'
  if (tp != null && aboveBy(value, entry, tp)) return 'take_profit'
  const heldS = (now - p.openedAt) / 1000
  if (p.maxHoldSeconds != null && p.maxHoldSeconds > 0 && heldS >= p.maxHoldSeconds) return 'timeout'
  return null
}

/**
 * How much of the remaining position to sell on a terminal exit that may keep
 * a moon bag. Never 1: a bag always rides. House money (initials recovered)
 * banks down to the floor; still carrying cost basis but exiting in profit
 * sells exactly enough to return the stake, capped by the floor.
 */
export function moonbagExitFraction(entry: bigint, value: bigint, moonbag: number, houseMoney: boolean): number {
  const cap = 1 - moonbag
  if (value <= 0n) return cap
  const target = houseMoney ? cap : Number((entry * PPM) / value) / 1_000_000
  return Math.max(0, Math.min(target, cap))
}

/**
 * Laddered exit: the reason AND the fraction of the current remainder to sell.
 *   - Protective exits (stop, trailing) are full exits of whatever remains.
 *   - The first time value reaches initialsOutMultiple x entry, sell exactly
 *     enough to return the cost basis, never more than 1 - moon bag floor.
 *   - After initials are out the bag runs under the trailing stop; an optional
 *     take-profit ceiling exits the remainder. Timeout exits the remainder.
 *   - With moonbagAlways, no exit in profit (or on house money) sells 100%.
 */
export function decideLadderedExit(p: ExitParams, value: bigint, peak: bigint, now = Date.now()): LadderDecision | null {
  const entry = p.entryWei
  if (entry <= 0n) return null
  const mult = ladderMultiple(p.initialsOutMultiple)
  const moonbag = moonbagFraction(p.moonbagMinPct)
  const recovered = p.initialsRecovered
  const sl = pct(p.stopLossPct)
  const ts = pct(p.trailingStopPct)
  const tp = pct(p.takeProfitPct)

  let reason: ExitReason | null = null
  if (sl != null && belowBy(value, entry, sl)) {
    reason = 'stop_loss'
  } else if (ts != null && peak > entry && belowBy(value, peak, ts)) {
    reason = 'trailing_stop'
  } else if (mult != null && !recovered && atMultiple(value, entry, mult)) {
    const sellFraction = Math.max(0, Math.min(Number((entry * PPM) / value) / 1_000_000, 1 - moonbag))
    if (sellFraction > 0) return { reason: 'take_initials', sellFraction, recoversInitials: true }
  }
  if (reason == null) {
    if (tp != null && aboveBy(value, entry, tp) && (recovered || mult == null)) {
      reason = 'take_profit'
    } else {
      const heldS = (now - p.openedAt) / 1000
      if (p.maxHoldSeconds != null && p.maxHoldSeconds > 0 && heldS >= p.maxHoldSeconds) reason = 'timeout'
    }
  }
  if (reason == null) return null
  if (!p.moonbagAlways) return { reason, sellFraction: 1 }
  const houseMoney = recovered
  const inProfit = value > entry
  if (!houseMoney && !inProfit) return { reason, sellFraction: 1 }
  if (!houseMoney && reason === 'stop_loss') return { reason, sellFraction: 1 }
  const sellFraction = moonbagExitFraction(entry, value, moonbag, houseMoney)
  if (!(sellFraction > 0)) return null
  return { reason, sellFraction, keepsMoonbag: true }
}

/**
 * Liquidity-decay clock. A quote that is EXACTLY unchanged sweep after sweep
 * while the position is underwater is a market nobody is trading. Any
 * movement resets it; a quiet winner is left to the trailing stop.
 */
export function updateStaleClock(prevValue: bigint | null, value: bigint, entry: bigint, staleSince: number | null, now: number): number | null {
  const underwater = value < entry
  const unchanged = prevValue != null && prevValue === value
  if (!underwater || !unchanged) return null
  return staleSince ?? now
}

export function decideLiquidityDecay(staleSince: number | null, decaySeconds: number | null, now: number): boolean {
  if (staleSince == null || decaySeconds == null || !(decaySeconds > 0)) return false
  return (now - staleSince) / 1000 >= decaySeconds
}

/** Has an unreconcilable position (bag gone, emptying tx not found) waited long enough to give up on? */
export function shouldGiveUpReconcile(pendingSince: Date | number | null, giveUpMs: number, now = Date.now()): boolean {
  if (pendingSince == null || !(giveUpMs > 0)) return false
  const since = pendingSince instanceof Date ? pendingSince.getTime() : pendingSince
  if (!Number.isFinite(since)) return false
  return now - since >= giveUpMs
}

/** Token units to sell for a fraction, exact in ppm so the remainder never drifts. */
export function sellAmountForFraction(total: bigint, fraction: number): { amount: bigint; ppm: bigint; partial: boolean } {
  const f = Number(fraction)
  const ppm = f > 0 && f < 1 ? BigInt(Math.max(1, Math.min(999_999, Math.round(f * 1_000_000)))) : PPM
  let amount = ppm === PPM ? total : (total * ppm) / PPM
  const partial = amount > 0n && amount < total
  if (amount <= 0n) amount = total
  return { amount, ppm: partial ? ppm : PPM, partial }
}
