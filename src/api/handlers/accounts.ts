/**
 * Account operations for the wallet-authenticated surface. Every write here
 * hands back UNSIGNED calldata: the server never holds a user's key, so
 * "deploy an account", "change the policy", "withdraw" and "revoke" are all
 * transactions the user's own wallet signs. What the server does is verify
 * receipts, cache chain state, and refuse to bind an arm to an account the
 * caller does not own.
 */
import { and, eq, inArray, sql } from 'drizzle-orm'
import { encodeFunctionData, getAddress, type Address, type Hash } from 'viem'
import { schema } from '../../db/client.js'
import { ApiError, badRequest, notFound } from '../errors.js'
import { parseAddress } from '../query.js'
import { rowToArm, rowToPosition } from '../serialize.js'
import type { AppDeps } from '../deps.js'
import type { AccountPolicy, ArmAccount, WalletSession } from '../../types.js'
import type {
  AccountChainWire, AccountDetailResponse, AccountPolicyWire, AccountWire, AccountsResponse,
  PrepareCreateResponse, PreparePolicyResponse, UnsignedTx,
} from '../contract.js'
import { hoodArmFactoryAbi, hoodArmAccountAbi } from '../../accounts/abi.js'
import { policyFromJson, policyProblems, policyToJson, policyToTuple, isTighterOrEqual } from '../../accounts/policy.js'

export type { AccountWire, UnsignedTx }

export function wireAccount(a: ArmAccount): AccountWire {
  return {
    id: a.id,
    address: a.accountAddress,
    ownerAddress: a.ownerAddress,
    chainId: a.chainId,
    factoryAddress: a.factoryAddress,
    operatorAddress: a.operatorAddress,
    deployedTx: a.deployedTx,
    status: a.status,
    label: a.label,
    policy: a.policy ? policyToJson(a.policy) : null,
    revokedReason: a.revokedReason,
    ethBalanceWei: a.ethBalanceWei.toString(),
    wethBalanceWei: a.wethBalanceWei.toString(),
    createdAt: a.createdAt.toISOString(),
    lastSyncedAt: a.lastSyncedAt ? a.lastSyncedAt.toISOString() : null,
  }
}

/** The registry, or a 503 that says exactly what is missing. */
export function requireAccounts(deps: AppDeps) {
  if (!deps.accounts) {
    throw new ApiError(
      503,
      'accounts_unavailable',
      'On-chain arm accounts are not configured on this server. Set HOOD_ARM_FACTORY to the deployed HoodArmFactory address and restart. The operator-key arms are unaffected.',
    )
  }
  return deps.accounts
}

/**
 * The account at `address`, if this session owns it. A caller who does not own
 * it gets a 404, never a 403: whether an address has an account here is not
 * something a stranger gets to learn.
 */
export async function requireOwnedAccount(deps: AppDeps, session: WalletSession | null, rawAddress: string, isOperator = false): Promise<ArmAccount> {
  const { registry } = requireAccounts(deps)
  const address = getAddress(parseAddress(rawAddress, 'account address')) as Address
  const account = await registry.byAddress(address)
  if (!account) throw notFound(`account ${address}`)
  if (isOperator) return account
  if (!session || account.ownerAddress.toLowerCase() !== session.address.toLowerCase()) throw notFound(`account ${address}`)
  return account
}

// ── list ─────────────────────────────────────────────────────────────────────

export async function listAccounts(deps: AppDeps, session: WalletSession): Promise<AccountsResponse> {
  const { registry } = requireAccounts(deps)
  let accounts: ArmAccount[]
  try {
    accounts = await registry.syncOwner(session.address)
  } catch (err) {
    deps.log.warn({ err: (err as Error).message, owner: session.address }, 'factory sync failed; serving the cached accounts')
    accounts = await registry.listForOwner(session.address)
  }
  let defaultPolicy: AccountPolicy | null = null
  try {
    defaultPolicy = await registry.defaultPolicy()
  } catch (err) {
    deps.log.warn({ err: (err as Error).message }, 'factory default policy read failed')
  }
  return {
    accounts: accounts.map(wireAccount),
    factory: registry.factory,
    operator: registry.operatorAddress,
    chainId: registry.chainId,
    defaultPolicy: defaultPolicy ? policyToJson(defaultPolicy) : null,
  }
}

// ── prepare a create transaction ─────────────────────────────────────────────

const bigintFrom = (v: unknown, field: string): bigint => {
  if (typeof v === 'bigint') return v
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v)
  if (typeof v === 'string' && /^\d{1,40}$/.test(v.trim())) return BigInt(v.trim())
  throw badRequest(`${field} must be a decimal wei string`)
}

const intFrom = (v: unknown, field: string, max: number): number => {
  const n = typeof v === 'string' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > max) throw badRequest(`${field} must be an integer between 0 and ${max}`)
  return n
}

/**
 * Build the policy a create or update will carry: the caller's fields on top
 * of a base (the factory default for a create, the current policy for an
 * update), so a partial body is always a complete, valid policy.
 */
export function policyFromBody(body: unknown, base: AccountPolicy): AccountPolicy {
  if (body == null) return base
  if (typeof body !== 'object') throw badRequest('policy must be an object')
  const v = body as Record<string, unknown>
  const known = new Set([
    'perTradeCapWei', 'perTradeCapEth', 'dailyBudgetWei', 'dailyBudgetEth', 'maxOpenPositions', 'maxSlippageBps',
    'cooldownSeconds', 'maxHoldSecondsHint', 'minOracleScore', 'allowedRouter', 'quoteToken',
  ])
  for (const key of Object.keys(v)) if (!known.has(key)) throw badRequest(`unknown policy field ${JSON.stringify(key)}`)
  const eth = (value: unknown, field: string): bigint => {
    if (typeof value !== 'string' && typeof value !== 'number') throw badRequest(`${field} must be an ETH amount`)
    const s = String(value).trim()
    if (!/^\d+(\.\d{1,18})?$/.test(s)) throw badRequest(`${field} must be a non-negative ETH amount with at most 18 decimals`)
    const [whole, frac = ''] = s.split('.')
    return BigInt(whole!) * 10n ** 18n + BigInt(frac.padEnd(18, '0') || '0')
  }
  const out: AccountPolicy = { ...base }
  if (v.perTradeCapEth != null) out.perTradeCapWei = eth(v.perTradeCapEth, 'perTradeCapEth')
  else if (v.perTradeCapWei != null) out.perTradeCapWei = bigintFrom(v.perTradeCapWei, 'perTradeCapWei')
  if (v.dailyBudgetEth != null) out.dailyBudgetWei = eth(v.dailyBudgetEth, 'dailyBudgetEth')
  else if (v.dailyBudgetWei != null) out.dailyBudgetWei = bigintFrom(v.dailyBudgetWei, 'dailyBudgetWei')
  if (v.maxOpenPositions != null) out.maxOpenPositions = intFrom(v.maxOpenPositions, 'maxOpenPositions', 65_535)
  if (v.maxSlippageBps != null) out.maxSlippageBps = intFrom(v.maxSlippageBps, 'maxSlippageBps', 10_000)
  if (v.cooldownSeconds != null) out.cooldownSeconds = intFrom(v.cooldownSeconds, 'cooldownSeconds', 4_294_967_295)
  if (v.maxHoldSecondsHint != null) out.maxHoldSecondsHint = intFrom(v.maxHoldSecondsHint, 'maxHoldSecondsHint', 4_294_967_295)
  if (v.minOracleScore != null) out.minOracleScore = intFrom(v.minOracleScore, 'minOracleScore', 100)
  if (v.allowedRouter != null) out.allowedRouter = getAddress(parseAddress(String(v.allowedRouter), 'allowedRouter')) as Address
  if (v.quoteToken != null) out.quoteToken = getAddress(parseAddress(String(v.quoteToken), 'quoteToken')) as Address
  const problems = policyProblems(out)
  if (problems.length) throw badRequest(problems[0]!, { problems })
  return out
}

const ethOf = (wei: bigint): string => {
  const whole = wei / 10n ** 18n
  const frac = (wei % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : `${whole}`
}

export async function prepareCreate(deps: AppDeps, session: WalletSession, body: unknown): Promise<PrepareCreateResponse> {
  const { registry } = requireAccounts(deps)
  if (!registry.operatorAddress) {
    throw new ApiError(
      503,
      'operator_unavailable',
      'This server has no trading key (TRADER_PRIVATE_KEY is unset), so there is no operator address to hand your account. Nothing would be able to trade it.',
    )
  }
  const input = (body ?? {}) as Record<string, unknown>
  if (input.policy != null && typeof input.policy !== 'object') throw badRequest('policy must be an object')
  const base = await registry.defaultPolicy()
  const policy = policyFromBody(input.policy ?? null, base)
  const data = encodeFunctionData({
    abi: hoodArmFactoryAbi,
    functionName: 'createAccount',
    args: [registry.operatorAddress, policyToTuple(policy)],
  })
  return {
    tx: {
      to: registry.factory,
      data,
      value: '0',
      chainId: registry.chainId,
      summary: `Create a hood-oracle arm account with a ${ethOf(policy.perTradeCapWei)} ETH per-trade cap and a ${ethOf(policy.dailyBudgetWei)} ETH daily budget, operated by ${registry.operatorAddress}.`,
    },
    policy: policyToJson(policy),
    operator: registry.operatorAddress,
    factory: registry.factory,
    note: `Sign this from ${session.address}: that address becomes the account's owner and the only one that can withdraw from it or change its policy.`,
  }
}

export async function registerAccount(deps: AppDeps, session: WalletSession, body: unknown): Promise<{ account: AccountWire }> {
  const { registry } = requireAccounts(deps)
  const input = (body ?? {}) as Record<string, unknown>
  const txHash = typeof input.txHash === 'string' ? input.txHash.trim() : ''
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw badRequest('txHash must be a 0x-prefixed 32-byte transaction hash')
  const label = typeof input.label === 'string' && input.label.trim() ? input.label.trim().slice(0, 80) : null
  const result = await registry.registerFromTx(session.address, txHash as Hash, label)
  if (!result.ok) throw new ApiError(400, 'account_not_created', result.reason)
  deps.log.info({ owner: session.address, account: result.account.accountAddress, tx: txHash }, 'arm account registered')
  return { account: wireAccount(result.account) }
}

// ── detail ───────────────────────────────────────────────────────────────────

export async function getAccount(deps: AppDeps, session: WalletSession | null, rawAddress: string, isOperator = false): Promise<AccountDetailResponse> {
  const { registry } = requireAccounts(deps)
  const account = await requireOwnedAccount(deps, session, rawAddress, isOperator)
  const refreshed = (await registry.refresh(account.accountAddress)) ?? account

  let chain: AccountChainWire | null = null
  let chainError: string | null = null
  try {
    const state = await registry.readChainState(refreshed.accountAddress)
    chain = {
      owner: state.owner,
      operator: state.operator,
      killed: state.killed,
      policy: policyToJson(state.policy),
      spentTodayWei: state.spentTodayWei.toString(),
      remainingDailyBudgetWei: state.remainingDailyBudgetWei.toString(),
      cooldownRemainingSeconds: state.cooldownRemainingSeconds,
      openPositionCount: state.openPositionCount,
      feesAccruedWei: state.feesAccruedWei.toString(),
      ethBalanceWei: state.ethBalanceWei.toString(),
      wethBalanceWei: state.wethBalanceWei.toString(),
      readAt: state.readAt.toISOString(),
    }
  } catch (err) {
    chainError = (err as Error).message.split('\n')[0]!.slice(0, 300)
  }

  const armRows = await deps.db.select().from(schema.arms).where(eq(schema.arms.accountId, account.id)).orderBy(schema.arms.createdAt)
  const arms = armRows.map(rowToArm)
  const armIds = arms.map((a) => a.id)
  const positionRows = armIds.length
    ? await deps.db.select().from(schema.positions).where(inArray(schema.positions.armId, armIds)).orderBy(schema.positions.openedAt).limit(200)
    : []
  const [realizedRow] = armIds.length
    ? await deps.db
        .select({
          closed: sql<number>`count(*) filter (where ${schema.positions.status} = 'closed')::int`,
          wins: sql<number>`count(*) filter (where ${schema.positions.status} = 'closed' and ${schema.positions.realizedPnlWei} > 0)::int`,
          pnl: sql<string>`coalesce(sum(${schema.positions.realizedPnlWei}) filter (where ${schema.positions.status} = 'closed'), 0)::text`,
        })
        .from(schema.positions)
        .where(inArray(schema.positions.armId, armIds))
    : [{ closed: 0, wins: 0, pnl: '0' }]

  return {
    account: wireAccount(refreshed),
    chain,
    chainError,
    arms: arms.map((a) => ({
      id: a.id, label: a.label, enabled: a.enabled, mode: a.mode,
      perTradeWei: a.perTradeWei.toString(), dailyBudgetWei: a.dailyBudgetWei.toString(),
    })),
    // Domain rows go out as wire shapes: respond()'s replacer turns every bigint into a decimal string.
    positions: positionRows.map(rowToPosition) as unknown as AccountDetailResponse['positions'],
    realized: { closed: realizedRow?.closed ?? 0, wins: realizedRow?.wins ?? 0, realizedPnlWei: realizedRow?.pnl ?? '0' },
  }
}

// ── policy update ────────────────────────────────────────────────────────────

export async function preparePolicyUpdate(deps: AppDeps, session: WalletSession | null, rawAddress: string, body: unknown, isOperator = false): Promise<PreparePolicyResponse> {
  const account = await requireOwnedAccount(deps, session, rawAddress, isOperator)
  const current = account.policy ?? policyFromJson(account.policy)
  if (!current) {
    throw new ApiError(409, 'policy_unknown', 'This account has never been read from the chain, so there is no current policy to change. Refresh it first (POST /api/accounts/:address/refresh).')
  }
  const input = (body ?? {}) as Record<string, unknown>
  const next = policyFromBody(input.policy ?? input, current)
  const immediate = isTighterOrEqual(current, next)
  const data = encodeFunctionData({ abi: hoodArmAccountAbi, functionName: 'setPolicy', args: [policyToTuple(next)] })
  return {
    tx: {
      to: account.accountAddress,
      data,
      value: '0',
      chainId: account.chainId,
      summary: immediate
        ? 'Tighten this account\'s trading policy. It takes effect immediately.'
        : 'Loosen this account\'s trading policy. It queues for one hour, then needs applyPolicy() to land.',
    },
    policy: policyToJson(next),
    immediate,
    note: immediate
      ? 'Every field is at least as tight as the current policy, so the account applies it in the same transaction.'
      : 'At least one field takes on more risk, so the account queues it for one hour. Send applyPolicy() after that, or cancelPolicy() to drop it.',
  }
}

export async function refreshAccount(deps: AppDeps, session: WalletSession | null, rawAddress: string, isOperator = false): Promise<{ account: AccountWire }> {
  const { registry } = requireAccounts(deps)
  const account = await requireOwnedAccount(deps, session, rawAddress, isOperator)
  const refreshed = await registry.refresh(account.accountAddress)
  return { account: wireAccount(refreshed ?? account) }
}

/** Arm ids this session may touch, for the ownership checks on the arm routes. */
export async function accountIdsOwnedBy(deps: AppDeps, session: WalletSession): Promise<Set<string>> {
  if (!deps.accounts) return new Set()
  const rows = await deps.db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.ownerAddress, session.address.toLowerCase()), eq(schema.accounts.chainId, deps.config.chainId)))
  return new Set(rows.map((r) => r.id))
}

// ── arm ownership ────────────────────────────────────────────────────────────

/**
 * Who is asking. The operator token is the admin path and sees everything; a
 * wallet session sees only what its accounts own; neither means an anonymous
 * reader, which still sees the public, operator-owned arms exactly as before.
 */
export interface ArmCaller {
  session: WalletSession | null
  isOperator: boolean
}

/** The default for in-process callers (the MCP tools), which are already operator-gated. */
export const OPERATOR_CALLER: ArmCaller = { session: null, isOperator: true }
export const ANONYMOUS_CALLER: ArmCaller = { session: null, isOperator: false }

/**
 * Restrict a list of arms to what this caller may see. Legacy arms
 * (`accountId` null) stay public, exactly as they have always been; an arm
 * bound to an account is visible only to that account's owner and to the
 * operator.
 */
export async function armVisibility(deps: AppDeps, caller: ArmCaller): Promise<ReturnType<typeof and> | undefined> {
  if (caller.isOperator) return undefined
  const owned = caller.session ? await accountIdsOwnedBy(deps, caller.session) : new Set<string>()
  if (!owned.size) return sql`${schema.arms.accountId} is null`
  return sql`(${schema.arms.accountId} is null or ${schema.arms.accountId} in ${[...owned]})`
}

/**
 * May this caller see this arm? A stranger asking about someone else's
 * account arm gets a 404 rather than a 403: the existence of an arm is itself
 * the owner's business.
 */
export async function assertArmReadable(deps: AppDeps, caller: ArmCaller, arm: { id: string; accountId: string | null }): Promise<void> {
  if (caller.isOperator || arm.accountId == null) return
  const owned = caller.session ? await accountIdsOwnedBy(deps, caller.session) : new Set<string>()
  if (!owned.has(arm.accountId)) throw notFound(`arm ${arm.id}`)
}

/**
 * May this caller write this arm? Account arms need their owner's session (or
 * the operator token); the legacy operator-key arms need the operator token
 * and nothing else, because they spend the server's own wallet.
 */
export async function assertArmWritable(deps: AppDeps, caller: ArmCaller, arm: { id: string; accountId: string | null }): Promise<void> {
  if (caller.isOperator) return
  if (arm.accountId == null) {
    throw new ApiError(
      403,
      'operator_only',
      'This arm trades the server\'s own wallet, so only the operator token can change it. Bind an arm to your own on-chain account to manage it with your wallet.',
    )
  }
  await assertArmReadable(deps, caller, arm)
}

/**
 * The account an arm is being bound to, checked for ownership and for being
 * tradable at all. A revoked account is refused on write rather than accepted
 * and silently never traded.
 */
export async function requireBindableAccount(deps: AppDeps, caller: ArmCaller, accountId: string): Promise<ArmAccount> {
  const { registry } = requireAccounts(deps)
  const account = await registry.byId(accountId)
  if (!account) throw badRequest(`no on-chain account ${accountId} is registered here`)
  if (!caller.isOperator) {
    const owned = caller.session ? await accountIdsOwnedBy(deps, caller.session) : new Set<string>()
    if (!owned.has(account.id)) throw notFound(`account ${accountId}`)
  }
  if (account.status === 'revoked') {
    throw new ApiError(409, 'account_revoked', account.revokedReason ?? `Account ${account.accountAddress} no longer names this engine as its operator, so it cannot trade.`)
  }
  return account
}

/** The account an arm currently trades from, or null for a legacy arm. */
export async function accountForArm(deps: AppDeps, accountId: string | null): Promise<ArmAccount | null> {
  if (!accountId || !deps.accounts) return null
  return deps.accounts.registry.byId(accountId)
}
