/**
 * Earned autonomy: how much rope an arm gets, decided by its own realized
 * record and recomputed from scratch on every optimizer pass.
 *
 * An arm that has proven it makes money is allowed to search a wider knob
 * space, faster, and to touch knobs a losing arm cannot (its entry universe,
 * its LLM confidence bar, the take-initials ladder). An arm that has proven it
 * loses money is held tighter until it recovers. Freedom is rented, never
 * owned: a demotion happens on the next pass without anyone intervening.
 *
 * WHAT NO TIER CAN TOUCH. The deterministic rails in src/guards/risk.ts and
 * the firewall are not knobs: the kill switch, the wallet floor and gas
 * headroom, the daily loss breaker, the price-impact ceiling, and the
 * firewall's real buy-then-sell round trip are enforced in the executor and
 * out of this module's reach. A tier widens the space an arm may search; it
 * never removes the floor under it. Every tier keeps a bounded stop loss that
 * can never be unset and never reach zero.
 *
 * Pure: no I/O, no clock, no DB.
 */
import type { Arm, AutonomyTier } from '../types.js'

export interface ArmRecord {
  /** Closed positions in the window. */
  closedTrades: number
  wins: number
  /** Signed realized P&L over the window, wei. */
  netPnlWei: bigint
  /** ETH spent opening the closed positions, wei. The denominator for net edge. */
  grossSpentWei: bigint
  /** Worst peak-to-trough drawdown of realized equity across the window, percent of peak. */
  maxDrawdownPct: number
  firstTradeAt: Date | null
}

export const TIER_ORDER: readonly AutonomyTier[] = ['probation', 'standard', 'trusted', 'autonomous']

/** A net edge this close to zero is noise, not profit. Percent of gross spend. */
export const MIN_EDGE_PCT = 0.5

/**
 * Evidence gates. `netEdgePct` is realized net P&L over gross spend, so it is
 * SIZE-WEIGHTED: an arm whose bigger bets are its losers cannot present a
 * healthy unweighted average and earn room it has not paid for. Drawdown is
 * the second axis: a profitable arm that gets there through a 50% hole is not
 * one to hand more size.
 */
export const GATES = {
  trusted: { closedTrades: 12, netEdgePct: MIN_EDGE_PCT, maxDrawdownPct: 35 },
  autonomous: { closedTrades: 40, netEdgePct: 5, maxDrawdownPct: 25 },
  /** Below this many closes a losing record has not lost enough times to mean anything. */
  probation: { closedTrades: 15, netEdgePct: -MIN_EDGE_PCT },
} as const

export interface NumericBound {
  min: number
  max: number
}
export interface WeiBound {
  min: bigint
  max: bigint
}

export interface TierBounds {
  perTradeWei: WeiBound
  dailyBudgetWei: WeiBound
  maxConcurrentPositions: NumericBound
  slippageBps: NumericBound
  maxPriceImpactPct: NumericBound
  stopLossPct: NumericBound
  takeProfitPct: NumericBound
  trailingStopPct: NumericBound
  maxHoldSeconds: NumericBound
  /** `min` is the floor a tier may never drop the oracle gate below. */
  minOracleScore: NumericBound
  maxRugRisk: NumericBound
  llmMinConfidence?: NumericBound
  minMarketCapEth?: NumericBound
  maxMarketCapEth?: NumericBound
  initialsOutMultiple?: NumericBound
  moonbagMinPct?: NumericBound
  maxCreatorLaunches?: NumericBound
}

export type BoundedKnob = keyof TierBounds
export type WeiKnob = 'perTradeWei' | 'dailyBudgetWei'

const ETH = 1_000_000_000_000_000_000n
const eth = (n: number): bigint => (ETH * BigInt(Math.round(n * 1_000_000))) / 1_000_000n

/**
 * Hard ranges per tier, ETH-native. `standard` is the default for an arm with
 * no verdict yet. Higher tiers widen; probation narrows. per-trade and daily
 * budget ceilings rise with tier, and the daily budget remains the real spend
 * ceiling regardless of what per-trade allows (a bet may equal it, never
 * exceed it: see the optimizer).
 */
export const TIER_BOUNDS: Record<AutonomyTier, TierBounds> = {
  probation: {
    perTradeWei: { min: eth(0.0005), max: eth(0.01) },
    dailyBudgetWei: { min: eth(0.001), max: eth(0.05) },
    maxConcurrentPositions: { min: 1, max: 1 },
    slippageBps: { min: 0, max: 500 },
    maxPriceImpactPct: { min: 0, max: 5 },
    stopLossPct: { min: 10, max: 40 },
    takeProfitPct: { min: 15, max: 150 },
    trailingStopPct: { min: 8, max: 40 },
    maxHoldSeconds: { min: 120, max: 3_600 },
    minOracleScore: { min: 56, max: 100 },
    maxRugRisk: { min: 0, max: 0.4 },
  },
  standard: {
    perTradeWei: { min: eth(0.0005), max: eth(0.05) },
    dailyBudgetWei: { min: eth(0.001), max: eth(0.25) },
    maxConcurrentPositions: { min: 1, max: 3 },
    slippageBps: { min: 0, max: 1_000 },
    maxPriceImpactPct: { min: 0, max: 10 },
    stopLossPct: { min: 10, max: 50 },
    takeProfitPct: { min: 15, max: 300 },
    trailingStopPct: { min: 8, max: 50 },
    maxHoldSeconds: { min: 120, max: 7_200 },
    minOracleScore: { min: 34, max: 100 },
    maxRugRisk: { min: 0, max: 0.6 },
  },
  trusted: {
    perTradeWei: { min: eth(0.0005), max: eth(0.1) },
    dailyBudgetWei: { min: eth(0.001), max: eth(0.5) },
    maxConcurrentPositions: { min: 1, max: 5 },
    slippageBps: { min: 0, max: 1_500 },
    maxPriceImpactPct: { min: 0, max: 15 },
    stopLossPct: { min: 10, max: 60 },
    takeProfitPct: { min: 10, max: 500 },
    trailingStopPct: { min: 5, max: 60 },
    maxHoldSeconds: { min: 60, max: 21_600 },
    minOracleScore: { min: 0, max: 100 },
    maxRugRisk: { min: 0, max: 0.8 },
    llmMinConfidence: { min: 0.35, max: 0.95 },
    minMarketCapEth: { min: 0.1, max: 50 },
    maxMarketCapEth: { min: 1, max: 500 },
    initialsOutMultiple: { min: 1.5, max: 5 },
    moonbagMinPct: { min: 5, max: 60 },
  },
  autonomous: {
    perTradeWei: { min: eth(0.0005), max: eth(0.25) },
    dailyBudgetWei: { min: eth(0.001), max: eth(1) },
    maxConcurrentPositions: { min: 1, max: 8 },
    slippageBps: { min: 0, max: 2_000 },
    maxPriceImpactPct: { min: 0, max: 25 },
    // Never null, never absent: the stop is the one thing every tier keeps.
    stopLossPct: { min: 10, max: 65 },
    takeProfitPct: { min: 5, max: 1_000 },
    trailingStopPct: { min: 3, max: 75 },
    maxHoldSeconds: { min: 30, max: 86_400 },
    minOracleScore: { min: 0, max: 100 },
    maxRugRisk: { min: 0, max: 1 },
    llmMinConfidence: { min: 0.25, max: 0.95 },
    minMarketCapEth: { min: 0.05, max: 100 },
    maxMarketCapEth: { min: 0.5, max: 1_000 },
    initialsOutMultiple: { min: 1.5, max: 10 },
    moonbagMinPct: { min: 5, max: 75 },
    maxCreatorLaunches: { min: 1, max: 100 },
  },
}

/** Per-run step multiplier: earned arms converge (and explore) faster. */
export const TIER_STEP_SCALE: Record<AutonomyTier, number> = {
  probation: 0.5,
  standard: 1,
  trusted: 1.75,
  autonomous: 2.5,
}

/**
 * Fitness multiplier for splitting a fixed fleet budget across arms. It
 * concentrates capital on earned arms without changing the fleet total or
 * removing the per-arm exploration floor.
 */
export const TIER_BUDGET_WEIGHT: Record<AutonomyTier, number> = {
  probation: 0.6,
  standard: 1,
  trusted: 1.5,
  autonomous: 2.2,
}

/** Max change a single optimizer run may make to each knob at the standard tier. */
export const BASE_STEPS = {
  takeProfitPct: 15,
  trailingStopPct: 5,
  stopLossPct: 5,
  maxHoldSeconds: 300,
  minOracleScore: 5,
  /** Fraction of the current per-trade size, so a run moves it at most 20%. */
  perTradeFraction: 0.2,
  llmMinConfidence: 0.05,
  minMarketCapEth: 0.5,
  maxMarketCapEth: 5,
  initialsOutMultiple: 0.5,
  moonbagMinPct: 5,
  maxCreatorLaunches: 5,
} as const

export type StepKnob = keyof typeof BASE_STEPS
export type Steps = Record<StepKnob, number>

/** Knobs the optimizer may write at every tier. */
export const BASE_WRITABLE: readonly (keyof Arm)[] = [
  'takeProfitPct',
  'trailingStopPct',
  'stopLossPct',
  'maxHoldSeconds',
  'minOracleScore',
  'perTradeWei',
]

/** Knobs each tier unlocks for the optimizer on top of BASE_WRITABLE. */
export const TIER_UNLOCKS: Record<AutonomyTier, readonly (keyof Arm)[]> = {
  probation: [],
  standard: [],
  trusted: ['llmMinConfidence', 'minMarketCapEth', 'maxMarketCapEth', 'initialsOutMultiple', 'moonbagMinPct'],
  autonomous: [
    'llmMinConfidence',
    'minMarketCapEth',
    'maxMarketCapEth',
    'initialsOutMultiple',
    'moonbagMinPct',
    'maxCreatorLaunches',
  ],
}

/**
 * Knobs the optimizer may set from null. trailingStopPct is here for every
 * tier on purpose: a null trailing stop leaves a fading position only the hard
 * stop or the timeout, and setting one only ever protects. The ladder knob
 * needs null-to-set because that is precisely how the take-initials exit is
 * turned on.
 */
export const BASE_UNSET_OK: readonly (keyof Arm)[] = ['takeProfitPct', 'minOracleScore', 'trailingStopPct']
export const TIER_UNSET_OK: Record<AutonomyTier, readonly (keyof Arm)[]> = {
  probation: [],
  standard: [],
  trusted: ['initialsOutMultiple'],
  autonomous: ['initialsOutMultiple'],
}

const norm = (tier: string | null | undefined): AutonomyTier =>
  (TIER_ORDER as readonly string[]).includes(tier ?? '') ? (tier as AutonomyTier) : 'standard'

/** Rank comparison: `atLeast('trusted', tier)`. */
export function atLeast(minTier: AutonomyTier, tier: AutonomyTier | string | null | undefined): boolean {
  return TIER_ORDER.indexOf(norm(tier)) >= TIER_ORDER.indexOf(norm(minTier))
}

export function boundsFor(tier: AutonomyTier | string | null | undefined): TierBounds {
  return TIER_BOUNDS[norm(tier)]
}

/** Per-run step ceilings for a tier, scaled from BASE_STEPS. Fractions stay a sane fraction. */
export function stepsFor(tier: AutonomyTier | string | null | undefined): Steps {
  const scale = TIER_STEP_SCALE[norm(tier)]
  const out = {} as Steps
  for (const [knob, step] of Object.entries(BASE_STEPS) as [StepKnob, number][]) {
    out[knob] = knob === 'perTradeFraction' ? Math.min(0.75, step * scale) : step * scale
  }
  return out
}

export function writableFor(tier: AutonomyTier | string | null | undefined): Set<keyof Arm> {
  return new Set([...BASE_WRITABLE, ...TIER_UNLOCKS[norm(tier)]])
}

export function unsetOkFor(tier: AutonomyTier | string | null | undefined): Set<keyof Arm> {
  return new Set([...BASE_UNSET_OK, ...TIER_UNSET_OK[norm(tier)]])
}

export function budgetWeightFor(tier: AutonomyTier | string | null | undefined): number {
  return TIER_BUDGET_WEIGHT[norm(tier)]
}

/** Realized net edge: net P&L as a percent of gross spend. 0 with no spend. */
export function netEdgePct(record: ArmRecord): number {
  if (record.grossSpentWei <= 0n) return 0
  // Scale to basis points in bigint before the float division so a wei-sized
  // numerator over a large denominator keeps its sign and magnitude.
  const bps = (record.netPnlWei * 1_000_000n) / record.grossSpentWei
  return Number(bps) / 10_000
}

export interface TierVerdict {
  tier: AutonomyTier
  reason: string
  evidence: {
    closedTrades: number
    wins: number
    winRatePct: number
    netPnlEth: number
    netEdgePct: number
    maxDrawdownPct: number
  }
}

const ethNum = (wei: bigint): number => Number((wei * 1_000_000n) / ETH) / 1_000_000

/**
 * Classify one arm from its realized record. Size-weighted edge rather than
 * win rate, on purpose: an arm can win 36% of the time and still be the most
 * profitable on the board, and that is exactly the arm that has earned room.
 * The reverse holds too: a 60% hit rate that is net negative is not success.
 */
export function tierFor(record: ArmRecord): TierVerdict {
  const closed = Math.max(0, Math.floor(record.closedTrades))
  const wins = Math.max(0, Math.floor(record.wins))
  const edge = netEdgePct(record)
  const dd = Number.isFinite(record.maxDrawdownPct) ? Math.max(0, record.maxDrawdownPct) : 100
  const evidence = {
    closedTrades: closed,
    wins,
    winRatePct: closed > 0 ? Math.round((wins / closed) * 100) : 0,
    netPnlEth: ethNum(record.netPnlWei),
    netEdgePct: Number(edge.toFixed(2)),
    maxDrawdownPct: Number(dd.toFixed(1)),
  }
  const profitable = record.netPnlWei > 0n && edge >= MIN_EDGE_PCT
  const bleeding = record.netPnlWei < 0n && edge <= -MIN_EDGE_PCT
  const summary = `${edge >= 0 ? '+' : ''}${edge.toFixed(1)}% net edge over ${closed} closed trades (net ${evidence.netPnlEth} ETH, max drawdown ${evidence.maxDrawdownPct}%)`

  if (
    profitable &&
    closed >= GATES.autonomous.closedTrades &&
    edge >= GATES.autonomous.netEdgePct &&
    dd <= GATES.autonomous.maxDrawdownPct
  ) {
    return { tier: 'autonomous', reason: `Sustained profit: ${summary}. Widest bounds, 2.5x steps, every tunable knob.`, evidence }
  }
  if (profitable && closed >= GATES.trusted.closedTrades && dd <= GATES.trusted.maxDrawdownPct) {
    return {
      tier: 'trusted',
      reason: `Profitable with a real sample: ${summary}. Entry universe, confidence bar and take-initials ladder unlocked.`,
      evidence,
    }
  }
  if (bleeding && closed >= GATES.probation.closedTrades) {
    return { tier: 'probation', reason: `Proven bleed: ${summary}. Bounds narrowed and steps halved until the record recovers.`, evidence }
  }
  if (profitable && closed >= GATES.trusted.closedTrades) {
    return { tier: 'standard', reason: `Profitable but the ${evidence.maxDrawdownPct}% drawdown is over the ${GATES.trusted.maxDrawdownPct}% gate: ${summary}. Standard bounds.`, evidence }
  }
  return {
    tier: 'standard',
    reason:
      closed < GATES.trusted.closedTrades
        ? `Insufficient evidence: ${closed} closed trades. Standard bounds until the record can carry a verdict.`
        : `No decisive edge: ${summary}. Standard bounds.`,
    evidence,
  }
}

const clampNum = (n: number, b: NumericBound) => Math.max(b.min, Math.min(b.max, n))
const clampWei = (n: bigint, b: WeiBound) => (n < b.min ? b.min : n > b.max ? b.max : n)

const WEI_KNOBS: ReadonlySet<string> = new Set(['perTradeWei', 'dailyBudgetWei'])
const lookupBound = (bounds: TierBounds, knob: string): NumericBound | WeiBound | undefined =>
  Object.prototype.hasOwnProperty.call(bounds, knob) ? bounds[knob as BoundedKnob] : undefined
const INTEGER_KNOBS: ReadonlySet<string> = new Set(['maxConcurrentPositions', 'slippageBps', 'maxHoldSeconds', 'maxCreatorLaunches'])

export interface ClampResult {
  patch: Partial<Arm>
  /** Knobs whose value was pulled inside the tier's range. */
  clamped: { knob: BoundedKnob; from: number | bigint | null; to: number | bigint }[]
  /** Knobs refused outright, with the plain-language reason. */
  refused: { knob: BoundedKnob; reason: string }[]
}

/**
 * Clamp an arm patch into a tier's bounds. Never widens: a value outside the
 * range is pulled to the nearest edge, a null oracle gate on a tier with a
 * floor is set to the floor (probation cannot turn the gate off), and a null
 * stop loss is refused because no tier may run without one. Knobs the tier
 * does not bound (label, launchpads, mode...) pass through untouched. A knob
 * whose range the tier has not unlocked (ladder knobs below trusted) is still
 * clamped to the widest range any tier allows so an operator write can never
 * exceed what autonomous would permit.
 *
 * `arm` is the current row and supplies the value for a knob the patch leaves
 * alone; only knobs present in `patch` are returned.
 */
export function clampToTier(arm: Arm, patch: Partial<Arm>, tier: AutonomyTier | string | null | undefined): ClampResult {
  const t = norm(tier)
  const bounds = boundsFor(t)
  const widest = TIER_BOUNDS.autonomous
  const out: Partial<Arm> = { ...patch }
  const clamped: ClampResult['clamped'] = []
  const refused: ClampResult['refused'] = []

  for (const knob of Object.keys(patch) as (keyof Arm)[]) {
    const bound = lookupBound(bounds, knob) ?? lookupBound(widest, knob)
    if (!bound) continue
    const k = knob as BoundedKnob
    const value = patch[knob]

    if (WEI_KNOBS.has(knob)) {
      const b = bound as WeiBound
      if (typeof value !== 'bigint') {
        refused.push({ knob: k, reason: `${knob} must be a wei amount.` })
        delete out[knob]
        continue
      }
      const next = clampWei(value, b)
      if (next !== value) clamped.push({ knob: k, from: value, to: next })
      ;(out as Record<string, unknown>)[knob] = next
      continue
    }

    const b = bound as NumericBound
    if (value === null || value === undefined) {
      if (knob === 'stopLossPct') {
        refused.push({ knob: k, reason: 'Every arm keeps a stop loss: it cannot be unset at any tier.' })
        delete out[knob]
        continue
      }
      if (knob === 'minOracleScore' && b.min > 0) {
        clamped.push({ knob: k, from: null, to: b.min })
        ;(out as Record<string, unknown>)[knob] = b.min
        continue
      }
      continue
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      refused.push({ knob: k, reason: `${knob} must be a finite number.` })
      delete out[knob]
      continue
    }
    let next = clampNum(value, b)
    if (INTEGER_KNOBS.has(knob)) next = Math.round(next)
    if (next !== value) clamped.push({ knob: k, from: value, to: next })
    ;(out as Record<string, unknown>)[knob] = next
  }

  // A patch that touches the sizing pair must stay internally consistent:
  // a per-trade size above the day's whole budget goes silently dead.
  const perTrade = out.perTradeWei ?? arm.perTradeWei
  const budget = out.dailyBudgetWei ?? arm.dailyBudgetWei
  if (budget > 0n && perTrade > budget && ('perTradeWei' in out || 'dailyBudgetWei' in out)) {
    clamped.push({ knob: 'perTradeWei', from: perTrade, to: budget })
    out.perTradeWei = budget
  }

  return { patch: out, clamped, refused }
}

/** One-line human summary of what a tier grants. For the dashboard and reports. */
export function describeTier(tier: AutonomyTier | string | null | undefined): string {
  return {
    probation: 'Held tight: narrowed bounds, half steps, one position at a time, size capped at 0.01 ETH, oracle gate at least Lean.',
    standard: 'Default: standard bounds and steps, up to 0.05 ETH per trade, oracle gate at least Watch.',
    trusted: 'Earned: wider bounds, 1.75x steps, up to 0.1 ETH per trade, entry universe + confidence bar + ladder unlocked.',
    autonomous: 'Fully earned: widest bounds, 2.5x steps, up to 0.25 ETH per trade, every tunable knob unlocked.',
  }[norm(tier)]
}
