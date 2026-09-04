/**
 * Arm input validation. Ported from the three.ws sniper STRATEGY_SCHEMA
 * semantics onto the hood-oracle Arm shape:
 *   - wei fields accept a decimal wei string (`perTradeWei: "50000000000000000"`)
 *     or an ETH amount through the `Eth` variant (`perTradeEth: 0.05`)
 *   - percentages and ratios accept numbers or numeric strings
 *   - `null` clears an optional filter; omitting a key leaves it untouched
 *   - unknown keys are rejected (400), never silently dropped: a knob that is
 *     accepted but not stored is how the three.ws ladder exits went unsettable
 */
import { z } from 'zod'
import type { Arm, Category, EngineHealth, Launchpad, Network } from '../types.js'
import { ALL_LAUNCHPADS } from '../chain/launchpads.js'
import { ethToWei } from './wei.js'
import { badRequest, conflict, ApiError } from './errors.js'

export const CATEGORIES: readonly Category[] = [
  'meme', 'tech', 'ai', 'culture', 'community', 'political', 'news', 'animal', 'celebrity', 'utility', 'stock', 'unknown',
]

const numeric = z.union([z.number(), z.string().trim().regex(/^-?\d+(\.\d+)?$/, 'expected a number')]).transform(Number)
const num = (min: number, max: number) => numeric.pipe(z.number().min(min).max(max))
const int = (min: number, max: number) => numeric.pipe(z.number().int().min(min).max(max))
const weiString = z.string().trim().regex(/^\d{1,40}$/, 'expected a decimal wei string')
const eth = z.union([z.number(), z.string().trim().regex(/^\d+(\.\d+)?$/, 'expected an ETH amount')])

const shape = {
  label: z.string().trim().min(1).max(80),
  network: z.enum(['mainnet', 'testnet']),
  enabled: z.boolean(),
  mode: z.enum(['simulate', 'live']),
  trigger: z.enum(['new_launch', 'graduation', 'oracle_crossing']),
  launchpads: z.array(z.enum(ALL_LAUNCHPADS as [Launchpad, ...Launchpad[]])).min(1, 'pick at least one launchpad').transform((v) => [...new Set(v)]),
  // sizing: exactly one of the wei / eth spellings per field
  perTradeWei: weiString,
  perTradeEth: eth,
  dailyBudgetWei: weiString,
  dailyBudgetEth: eth,
  maxConcurrentPositions: int(1, 50),
  cooldownSeconds: int(0, 86_400),
  slippageBps: int(1, 5_000),
  maxPriceImpactPct: num(0.1, 100),
  firewallLevel: z.enum(['block', 'warn', 'off']),
  buyDelayMs: int(0, 600_000),
  // entry filters (null clears)
  minOracleScore: num(0, 100).nullable(),
  maxRugRisk: num(0, 1).nullable(),
  minUniqueBuyers: int(0, 100_000).nullable(),
  maxCreatorLaunches: int(0, 100_000).nullable(),
  maxDeployerPct: num(0, 100).nullable(),
  maxBundleScore: num(0, 100).nullable(),
  maxConcentrationTop1: num(0, 1).nullable(),
  minMarketCapEth: num(0, 1e9).nullable(),
  maxMarketCapEth: num(0, 1e9).nullable(),
  requireSocials: z.boolean(),
  avoidDevDump: z.boolean(),
  allowedCategories: z.array(z.enum(CATEGORIES as [Category, ...Category[]])).nullable().transform((v) => (v && v.length ? [...new Set(v)] : null)),
  // exits
  stopLossPct: num(0, 100),
  takeProfitPct: num(0.1, 100_000).nullable(),
  trailingStopPct: num(0.1, 100).nullable(),
  maxHoldSeconds: int(10, 604_800),
  liquidityDecaySeconds: int(10, 604_800).nullable(),
  initialsOutMultiple: num(1.01, 1_000).nullable(),
  moonbagMinPct: num(0, 100),
  moonbagAlways: z.boolean(),
  // intelligence
  decisionMode: z.enum(['rules', 'llm']),
  llmMinConfidence: num(0, 1).nullable(),
  autoOptimize: z.boolean(),
  autonomyTier: z.enum(['probation', 'standard', 'trusted', 'autonomous']),
  // notifications / grouping
  telegramChatId: z.string().trim().regex(/^-?\d+$/, 'Telegram chat ids are numeric').nullable(),
  experimentGroup: z.string().trim().max(80).nullable().transform((v) => (v ? v : null)),
  /** The on-chain account this arm trades from; null is the legacy operator-key arm. */
  accountId: z.uuid().nullable(),
}

export const ARM_PATCH_SCHEMA = z.strictObject(shape).partial()
export const ARM_CREATE_SCHEMA = ARM_PATCH_SCHEMA.required({ label: true })

export type ArmPatchInput = z.infer<typeof ARM_PATCH_SCHEMA>

/** Column-shaped update: the validated input with the eth variants folded into wei strings. */
export type ArmUpdate = Omit<ArmPatchInput, 'perTradeEth' | 'dailyBudgetEth'>

function issueMessage(issue: z.core.$ZodIssue): string {
  const path = issue.path.map(String).join('.')
  return path ? `${path}: ${issue.message}` : issue.message
}

export function parseArmInput(body: unknown, mode: 'create'): ArmUpdate & { label: string }
export function parseArmInput(body: unknown, mode: 'patch'): ArmUpdate
export function parseArmInput(body: unknown, mode: 'create' | 'patch'): ArmUpdate {
  const schema = mode === 'create' ? ARM_CREATE_SCHEMA : ARM_PATCH_SCHEMA
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    const issues = parsed.error.issues.map(issueMessage)
    throw badRequest(issues[0] ?? 'invalid arm', { issues })
  }
  const { perTradeEth, dailyBudgetEth, ...rest } = parsed.data
  const out: ArmUpdate = { ...rest }
  if (perTradeEth != null) {
    if (rest.perTradeWei != null) throw badRequest('send perTradeWei or perTradeEth, not both')
    out.perTradeWei = ethToWei(perTradeEth).toString()
  }
  if (dailyBudgetEth != null) {
    if (rest.dailyBudgetWei != null) throw badRequest('send dailyBudgetWei or dailyBudgetEth, not both')
    out.dailyBudgetWei = ethToWei(dailyBudgetEth).toString()
  }
  if (out.minMarketCapEth != null && out.maxMarketCapEth != null && out.minMarketCapEth > out.maxMarketCapEth) {
    throw badRequest('minMarketCapEth must not exceed maxMarketCapEth')
  }
  return out
}

/** The row a POST starts from (the schema defaults), so the tier clamp on create has a real base. */
export function defaultArm(network: Network): Arm {
  const now = new Date()
  return {
    id: '',
    label: '',
    network,
    enabled: false,
    killSwitch: false,
    mode: 'simulate',
    trigger: 'new_launch',
    launchpads: [...ALL_LAUNCHPADS],
    perTradeWei: 0n,
    dailyBudgetWei: 0n,
    maxConcurrentPositions: 1,
    cooldownSeconds: 0,
    slippageBps: 500,
    maxPriceImpactPct: 10,
    firewallLevel: 'block',
    buyDelayMs: 0,
    minOracleScore: null,
    maxRugRisk: null,
    minUniqueBuyers: null,
    maxCreatorLaunches: null,
    maxDeployerPct: null,
    maxBundleScore: null,
    maxConcentrationTop1: null,
    minMarketCapEth: null,
    maxMarketCapEth: null,
    requireSocials: false,
    avoidDevDump: true,
    allowedCategories: null,
    stopLossPct: 30,
    takeProfitPct: null,
    trailingStopPct: null,
    maxHoldSeconds: 1800,
    liquidityDecaySeconds: null,
    initialsOutMultiple: null,
    moonbagMinPct: 15,
    moonbagAlways: false,
    decisionMode: 'rules',
    llmMinConfidence: null,
    autoOptimize: false,
    autonomyTier: 'standard',
    telegramChatId: null,
    experimentGroup: null,
    accountId: null,
    createdAt: now,
    updatedAt: now,
  }
}

/** Column-shaped input -> domain patch (wei strings become bigint) for the tier clamp. */
export function toDomainPatch(input: ArmUpdate): Partial<Arm> {
  const { perTradeWei, dailyBudgetWei, ...rest } = input
  const out: Partial<Arm> = { ...(rest as Partial<Arm>) }
  if (perTradeWei != null) out.perTradeWei = BigInt(perTradeWei)
  if (dailyBudgetWei != null) out.dailyBudgetWei = BigInt(dailyBudgetWei)
  return out
}

/** Domain patch -> column-shaped write (bigint wei back to decimal strings). */
export function toColumns(patch: Partial<Arm>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...patch }
  if (patch.perTradeWei != null) out.perTradeWei = patch.perTradeWei.toString()
  if (patch.dailyBudgetWei != null) out.dailyBudgetWei = patch.dailyBudgetWei.toString()
  return out
}

/** Why an arm may not be enabled right now. Empty means it can be armed. */
export function armabilityProblems(arm: Arm, health: EngineHealth): { code: string; message: string }[] {
  const problems: { code: string; message: string }[] = []
  if (!(arm.stopLossPct > 0)) problems.push({ code: 'stop_loss_required', message: 'Every arm needs a stop loss above 0% before it can be armed.' })
  if (!(arm.perTradeWei > 0n)) problems.push({ code: 'per_trade_required', message: 'Set a per-trade size above 0 ETH.' })
  if (arm.dailyBudgetWei < arm.perTradeWei) problems.push({ code: 'daily_budget_too_small', message: 'The daily budget must cover at least one trade (dailyBudget >= perTrade).' })
  if (arm.mode === 'live' && !health.wallet.live) {
    problems.push({
      code: 'wallet_not_live',
      message: health.wallet.address
        ? `The signing wallet ${health.wallet.address} is not live (balance below MIN_WALLET_ETH or the key is unavailable). Fund it or arm in simulate mode.`
        : 'Live mode needs a signing wallet: set TRADER_PRIVATE_KEY on the server and fund it with ETH, or arm in simulate mode.',
    })
  }
  return problems
}

export function assertArmable(arm: Arm, health: EngineHealth): void {
  const problems = armabilityProblems(arm, health)
  if (!problems.length) return
  const walletOnly = problems.length === 1 && problems[0].code === 'wallet_not_live'
  throw new ApiError(
    409,
    walletOnly ? 'wallet_not_live' : 'unarmable',
    problems.map((p) => p.message).join(' '),
    { problems },
  )
}

export { conflict }
