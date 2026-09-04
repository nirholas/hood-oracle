/**
 * The on-chain policy: how it is read, stored, sent back to a wallet, and how
 * it bounds an arm's off-chain knobs.
 *
 * The policy is the ceiling. Every knob an arm carries that has an on-chain
 * twin (per-trade size, daily budget, concurrency, slippage, cooldown, oracle
 * floor) is CLAMPED to it on write, because a server-side number above the
 * chain's would not buy the user anything: the account would refuse the trade
 * at execution and the arm would look broken instead of bounded. Clamping on
 * write means the arm's dashboard numbers are the numbers that will actually
 * trade.
 */
import type { AccountPolicy, Arm } from '../types.js'
import type { Address } from 'viem'
import { getAddress } from 'viem'

/** The tuple shape viem reads from and writes to `Policy` in the contracts. */
export interface PolicyTuple {
  perTradeCapWei: bigint
  dailyBudgetWei: bigint
  maxOpenPositions: number
  maxSlippageBps: number
  cooldownSeconds: number
  maxHoldSecondsHint: number
  minOracleScore: number
  allowedRouter: Address
  quoteToken: Address
}

export const MAX_UINT128 = 2n ** 128n - 1n

export function tupleToPolicy(t: PolicyTuple): AccountPolicy {
  return {
    perTradeCapWei: t.perTradeCapWei,
    dailyBudgetWei: t.dailyBudgetWei,
    maxOpenPositions: Number(t.maxOpenPositions),
    maxSlippageBps: Number(t.maxSlippageBps),
    cooldownSeconds: Number(t.cooldownSeconds),
    maxHoldSecondsHint: Number(t.maxHoldSecondsHint),
    minOracleScore: Number(t.minOracleScore),
    allowedRouter: getAddress(t.allowedRouter),
    quoteToken: getAddress(t.quoteToken),
  }
}

export function policyToTuple(p: AccountPolicy): PolicyTuple {
  return {
    perTradeCapWei: p.perTradeCapWei,
    dailyBudgetWei: p.dailyBudgetWei,
    maxOpenPositions: p.maxOpenPositions,
    maxSlippageBps: p.maxSlippageBps,
    cooldownSeconds: p.cooldownSeconds,
    maxHoldSecondsHint: p.maxHoldSecondsHint,
    minOracleScore: p.minOracleScore,
    allowedRouter: p.allowedRouter,
    quoteToken: p.quoteToken,
  }
}

/** JSON snapshot for the `accounts.policy` column and the wire: wei as decimal strings. */
export function policyToJson(p: AccountPolicy): Record<string, unknown> {
  return {
    perTradeCapWei: p.perTradeCapWei.toString(),
    dailyBudgetWei: p.dailyBudgetWei.toString(),
    maxOpenPositions: p.maxOpenPositions,
    maxSlippageBps: p.maxSlippageBps,
    cooldownSeconds: p.cooldownSeconds,
    maxHoldSecondsHint: p.maxHoldSecondsHint,
    minOracleScore: p.minOracleScore,
    allowedRouter: p.allowedRouter,
    quoteToken: p.quoteToken,
  }
}

const bi = (v: unknown): bigint | null => {
  if (typeof v === 'bigint') return v
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v)
  if (typeof v === 'string' && /^\d{1,40}$/.test(v.trim())) return BigInt(v.trim())
  return null
}

const int = (v: unknown, max: number): number | null => {
  const n = typeof v === 'string' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > max) return null
  return n
}

const addr = (v: unknown): Address | null =>
  typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) ? getAddress(v) : null

/** Parse a stored or user-supplied policy snapshot. Returns null when any field is missing or out of range. */
export function policyFromJson(value: unknown): AccountPolicy | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const perTradeCapWei = bi(v.perTradeCapWei)
  const dailyBudgetWei = bi(v.dailyBudgetWei)
  const maxOpenPositions = int(v.maxOpenPositions, 65_535)
  const maxSlippageBps = int(v.maxSlippageBps, 10_000)
  const cooldownSeconds = int(v.cooldownSeconds, 4_294_967_295)
  const maxHoldSecondsHint = int(v.maxHoldSecondsHint, 4_294_967_295)
  const minOracleScore = int(v.minOracleScore, 100)
  const allowedRouter = addr(v.allowedRouter)
  const quoteToken = addr(v.quoteToken)
  if (
    perTradeCapWei == null || dailyBudgetWei == null || maxOpenPositions == null || maxSlippageBps == null ||
    cooldownSeconds == null || maxHoldSecondsHint == null || minOracleScore == null || allowedRouter == null || quoteToken == null
  ) {
    return null
  }
  if (perTradeCapWei > MAX_UINT128 || dailyBudgetWei > MAX_UINT128) return null
  return {
    perTradeCapWei, dailyBudgetWei, maxOpenPositions, maxSlippageBps, cooldownSeconds,
    maxHoldSecondsHint, minOracleScore, allowedRouter, quoteToken,
  }
}

/** `PolicyLib.validate`, re-implemented so an invalid policy is refused before it costs gas. */
export function policyProblems(p: AccountPolicy): string[] {
  const out: string[] = []
  if (p.maxSlippageBps > 10_000) out.push('maxSlippageBps must be at most 10000 (100%)')
  if (p.minOracleScore > 100) out.push('minOracleScore must be at most 100')
  if (p.perTradeCapWei > p.dailyBudgetWei) out.push('perTradeCapWei must not exceed dailyBudgetWei')
  if (p.perTradeCapWei > MAX_UINT128 || p.dailyBudgetWei > MAX_UINT128) out.push('wei amounts must fit in uint128')
  if (p.maxOpenPositions > 65_535) out.push('maxOpenPositions must fit in uint16')
  return out
}

/** True when `next` takes no more risk than `current` on every axis, so the account applies it at once. */
export function isTighterOrEqual(current: AccountPolicy, next: AccountPolicy): boolean {
  return next.perTradeCapWei <= current.perTradeCapWei &&
    next.dailyBudgetWei <= current.dailyBudgetWei &&
    next.maxOpenPositions <= current.maxOpenPositions &&
    next.maxSlippageBps <= current.maxSlippageBps &&
    next.cooldownSeconds >= current.cooldownSeconds &&
    next.minOracleScore >= current.minOracleScore &&
    next.allowedRouter.toLowerCase() === current.allowedRouter.toLowerCase() &&
    next.quoteToken.toLowerCase() === current.quoteToken.toLowerCase()
}

// ── arm knobs against the policy ─────────────────────────────────────────────

export interface PolicyClampChange {
  knob: string
  from: string | number
  to: string | number
  /** The chain-side limit that produced the clamp, named so the message can quote it. */
  limit: string
}

export interface PolicyClamp {
  patch: Partial<Arm>
  changes: PolicyClampChange[]
}

const str = (v: bigint | number): string | number => (typeof v === 'bigint' ? v.toString() : v)

/**
 * Pull an arm patch inside the account's on-chain policy. Only the knobs the
 * chain actually enforces are touched; everything else (stop loss, filters,
 * exit ladder) is the server's business and is left alone.
 */
export function clampToPolicy(current: Arm, patch: Partial<Arm>, policy: AccountPolicy): PolicyClamp {
  const merged = { ...current, ...patch }
  const out: Partial<Arm> = { ...patch }
  const changes: PolicyClampChange[] = []
  const note = (knob: string, from: bigint | number, to: bigint | number, limit: string) =>
    changes.push({ knob, from: str(from), to: str(to), limit })

  if (merged.perTradeWei > policy.perTradeCapWei) {
    note('perTradeWei', merged.perTradeWei, policy.perTradeCapWei, 'policy.perTradeCapWei')
    out.perTradeWei = policy.perTradeCapWei
  }
  if (merged.dailyBudgetWei > policy.dailyBudgetWei) {
    note('dailyBudgetWei', merged.dailyBudgetWei, policy.dailyBudgetWei, 'policy.dailyBudgetWei')
    out.dailyBudgetWei = policy.dailyBudgetWei
  }
  if (merged.maxConcurrentPositions > policy.maxOpenPositions && policy.maxOpenPositions > 0) {
    note('maxConcurrentPositions', merged.maxConcurrentPositions, policy.maxOpenPositions, 'policy.maxOpenPositions')
    out.maxConcurrentPositions = policy.maxOpenPositions
  }
  if (merged.slippageBps > policy.maxSlippageBps && policy.maxSlippageBps > 0) {
    note('slippageBps', merged.slippageBps, policy.maxSlippageBps, 'policy.maxSlippageBps')
    out.slippageBps = policy.maxSlippageBps
  }
  if (merged.cooldownSeconds < policy.cooldownSeconds) {
    note('cooldownSeconds', merged.cooldownSeconds, policy.cooldownSeconds, 'policy.cooldownSeconds')
    out.cooldownSeconds = policy.cooldownSeconds
  }
  if (policy.minOracleScore > 0 && (merged.minOracleScore == null || merged.minOracleScore < policy.minOracleScore)) {
    note('minOracleScore', merged.minOracleScore ?? 0, policy.minOracleScore, 'policy.minOracleScore')
    out.minOracleScore = policy.minOracleScore
  }
  return { patch: out, changes }
}

/**
 * Why an arm bound to this account may not be enabled. Non-empty means the
 * chain would refuse every buy the arm tried, so arming it would only produce
 * refusals; each message names the binding limit.
 */
export function armAgainstPolicyProblems(arm: Arm, policy: AccountPolicy): { code: string; message: string }[] {
  const problems: { code: string; message: string }[] = []
  const eth = (wei: bigint) => `${Number(wei) / 1e18} ETH`
  if (policy.perTradeCapWei === 0n || policy.dailyBudgetWei === 0n) {
    problems.push({
      code: 'policy_disarmed',
      message: 'This account\'s on-chain policy has a zero per-trade cap or daily budget, which disables buying entirely. Raise the policy in your wallet first.',
    })
  }
  if (arm.perTradeWei > policy.perTradeCapWei) {
    problems.push({
      code: 'per_trade_over_policy',
      message: `Per-trade size ${eth(arm.perTradeWei)} is above the account's on-chain per-trade cap of ${eth(policy.perTradeCapWei)} (policy.perTradeCapWei). The chain would refuse every buy.`,
    })
  }
  if (arm.dailyBudgetWei > policy.dailyBudgetWei) {
    problems.push({
      code: 'daily_budget_over_policy',
      message: `Daily budget ${eth(arm.dailyBudgetWei)} is above the account's on-chain daily budget of ${eth(policy.dailyBudgetWei)} (policy.dailyBudgetWei).`,
    })
  }
  if (policy.maxOpenPositions > 0 && arm.maxConcurrentPositions > policy.maxOpenPositions) {
    problems.push({
      code: 'concurrency_over_policy',
      message: `Max concurrent positions ${arm.maxConcurrentPositions} is above the account's on-chain limit of ${policy.maxOpenPositions} (policy.maxOpenPositions).`,
    })
  }
  if (policy.maxSlippageBps > 0 && arm.slippageBps > policy.maxSlippageBps) {
    problems.push({
      code: 'slippage_over_policy',
      message: `Slippage ${arm.slippageBps} bps is above the account's on-chain ceiling of ${policy.maxSlippageBps} bps (policy.maxSlippageBps).`,
    })
  }
  if (arm.cooldownSeconds < policy.cooldownSeconds) {
    problems.push({
      code: 'cooldown_under_policy',
      message: `Cooldown ${arm.cooldownSeconds}s is shorter than the account's on-chain cooldown of ${policy.cooldownSeconds}s (policy.cooldownSeconds).`,
    })
  }
  if (policy.minOracleScore > 0 && (arm.minOracleScore == null || arm.minOracleScore < policy.minOracleScore)) {
    problems.push({
      code: 'oracle_floor_under_policy',
      message: `The account requires a fresh oracle score of at least ${policy.minOracleScore} on chain (policy.minOracleScore); this arm asks for ${arm.minOracleScore ?? 'none'}.`,
    })
  }
  return problems
}
