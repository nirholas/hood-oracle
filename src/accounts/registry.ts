/**
 * The account registry: the server's cache of what the chain says about every
 * HoodArmAccount a user created through us.
 *
 * The chain is the source of truth for all of it. Nothing here can widen what
 * an account allows; the row exists so the dashboard can render a list without
 * ten RPC round trips, and so the engine can find an arm's account without a
 * read on the hot path. Everything is refreshed on demand and on a 60s sweep
 * of the active accounts.
 *
 * The one decision the registry makes on its own is REVOCATION. An owner takes
 * our engine off their money by calling `setOperator(someoneElse)`; there is no
 * callback for that, so the sweep is how we find out. When an account's
 * operator is no longer our key the row flips to 'revoked', every arm bound to
 * it is disabled, and the journal records why. Fail closed: an account whose
 * state cannot be read is left alone (a transient RPC gap must never disarm a
 * working arm), but one that positively reports a different operator is
 * revoked immediately.
 */
import { eq, and, inArray, sql } from 'drizzle-orm'
import { decodeEventLog, getAddress, type Address, type Hash, type PublicClient } from 'viem'
import type { Db } from '../db/client.js'
import { toBigInt } from '../db/client.js'
import type { Logger } from '../log.js'
import { accounts as accountsTable, arms as armsTable } from '../db/schema.js'
import type { AccountChainState, AccountPolicy, AccountStatus, ArmAccount } from '../types.js'
import type { Journal } from '../engine/journal.js'
import { erc20BalanceAbi, hoodArmAccountAbi, hoodArmFactoryAbi } from './abi.js'
import { policyFromJson, policyToJson, tupleToPolicy, type PolicyTuple } from './policy.js'

export const REFRESH_INTERVAL_MS = 60_000
/** An account is refreshed on read when its cache is older than this. */
export const STALE_AFTER_MS = 30_000

export interface AccountRegistryOptions {
  db: Db
  log: Logger
  publicClient: PublicClient
  chainId: number
  factory: Address
  /** The engine's hot key: the address an account must name as its operator for us to trade it. */
  operatorAddress: Address | null
  /** Journal, so a revocation and its arm disarms land in the hash chain. */
  journal?: Journal
  refreshIntervalMs?: number
}

export type AccountRegistryApi = AccountRegistry

export class AccountRegistry {
  private readonly db: Db
  private readonly log: Logger
  private readonly client: PublicClient
  readonly chainId: number
  readonly factory: Address
  readonly operatorAddress: Address | null
  private readonly journal: Journal | null
  private readonly intervalMs: number
  private timer: NodeJS.Timeout | null = null
  private weth: Address | null = null
  private attestations: Address | null = null

  constructor(opts: AccountRegistryOptions) {
    this.db = opts.db
    this.log = opts.log
    this.client = opts.publicClient
    this.chainId = opts.chainId
    this.factory = getAddress(opts.factory)
    this.operatorAddress = opts.operatorAddress ? getAddress(opts.operatorAddress) : null
    this.journal = opts.journal ?? null
    this.intervalMs = opts.refreshIntervalMs ?? REFRESH_INTERVAL_MS
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.refreshActive().catch((err: unknown) => this.log.warn({ err: text(err) }, 'account refresh sweep failed'))
    }, this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  // ── chain reads ───────────────────────────────────────────────────────────

  /** The factory's immutable addresses, read once and remembered. */
  async factoryAddresses(): Promise<{ weth: Address; attestations: Address }> {
    if (this.weth && this.attestations) return { weth: this.weth, attestations: this.attestations }
    const [weth, attestations] = await Promise.all([
      this.client.readContract({ address: this.factory, abi: hoodArmFactoryAbi, functionName: 'weth' }),
      this.client.readContract({ address: this.factory, abi: hoodArmFactoryAbi, functionName: 'attestations' }),
    ])
    this.weth = getAddress(weth)
    this.attestations = getAddress(attestations)
    return { weth: this.weth, attestations: this.attestations }
  }

  async defaultPolicy(): Promise<AccountPolicy> {
    const tuple = await this.client.readContract({ address: this.factory, abi: hoodArmFactoryAbi, functionName: 'defaultPolicy' })
    return tupleToPolicy(tuple as unknown as PolicyTuple)
  }

  /** Everything the account says about itself right now, in one multicall plus two balance reads. */
  async readChainState(address: Address): Promise<AccountChainState> {
    const { weth } = await this.factoryAddresses()
    const account = getAddress(address)
    const contract = { address: account, abi: hoodArmAccountAbi } as const
    const [owner, operator, killed, policy, spentToday, remaining, cooldown, openCount, fees] = await this.client.multicall({
      allowFailure: false,
      contracts: [
        { ...contract, functionName: 'owner' },
        { ...contract, functionName: 'operator' },
        { ...contract, functionName: 'killed' },
        { ...contract, functionName: 'policy' },
        { ...contract, functionName: 'spentTodayWei' },
        { ...contract, functionName: 'remainingDailyBudgetWei' },
        { ...contract, functionName: 'cooldownRemaining' },
        { ...contract, functionName: 'openPositionCount' },
        { ...contract, functionName: 'feesAccruedWei' },
      ],
    })
    const [ethBalanceWei, wethBalanceWei] = await Promise.all([
      this.client.getBalance({ address: account }),
      this.client.readContract({ address: weth, abi: erc20BalanceAbi, functionName: 'balanceOf', args: [account] }),
    ])
    return {
      owner: getAddress(owner),
      operator: getAddress(operator),
      killed,
      policy: tupleToPolicy(policy as unknown as PolicyTuple),
      spentTodayWei: spentToday,
      remainingDailyBudgetWei: remaining,
      cooldownRemainingSeconds: Number(cooldown),
      openPositionCount: Number(openCount),
      feesAccruedWei: fees,
      ethBalanceWei,
      wethBalanceWei,
      readAt: new Date(),
    }
  }

  // ── rows ──────────────────────────────────────────────────────────────────

  async listForOwner(owner: Address): Promise<ArmAccount[]> {
    const rows = await this.db
      .select()
      .from(accountsTable)
      .where(and(eq(accountsTable.ownerAddress, owner.toLowerCase()), eq(accountsTable.chainId, this.chainId)))
      .orderBy(accountsTable.createdAt)
    return rows.map(rowToAccount)
  }

  async byAddress(address: Address): Promise<ArmAccount | null> {
    const [row] = await this.db
      .select()
      .from(accountsTable)
      .where(and(eq(accountsTable.accountAddress, address.toLowerCase()), eq(accountsTable.chainId, this.chainId)))
      .limit(1)
    return row ? rowToAccount(row) : null
  }

  async byId(id: string): Promise<ArmAccount | null> {
    const [row] = await this.db.select().from(accountsTable).where(eq(accountsTable.id, id)).limit(1)
    return row ? rowToAccount(row) : null
  }

  /**
   * Pull `accountsOf(owner)` from the factory and make sure every account the
   * chain knows about has a row. This is how an account created outside our
   * dashboard (a `forge script`, a direct wallet call) still shows up.
   */
  async syncOwner(owner: Address): Promise<ArmAccount[]> {
    const onChain = (await this.client.readContract({
      address: this.factory,
      abi: hoodArmFactoryAbi,
      functionName: 'accountsOf',
      args: [getAddress(owner)],
    })) as readonly Address[]
    const known = new Set((await this.listForOwner(owner)).map((a) => a.accountAddress.toLowerCase()))
    for (const address of onChain) {
      if (known.has(address.toLowerCase())) continue
      await this.insertPending(owner, getAddress(address), null)
    }
    for (const address of onChain) await this.refresh(getAddress(address))
    return this.listForOwner(owner)
  }

  /**
   * Record the account a create transaction produced. The receipt is the proof:
   * the AccountCreated log must come from our factory and name this owner, so a
   * caller cannot register an address they do not control.
   */
  async registerFromTx(owner: Address, txHash: Hash, label: string | null): Promise<{ ok: true; account: ArmAccount } | { ok: false; reason: string }> {
    let logs: { address: string; topics: readonly string[]; data: string }[]
    let status: 'success' | 'reverted'
    try {
      const receipt = await this.client.getTransactionReceipt({ hash: txHash })
      logs = receipt.logs as unknown as { address: string; topics: readonly string[]; data: string }[]
      status = receipt.status
    } catch (err) {
      return { ok: false, reason: `no receipt for ${txHash} yet: ${text(err)}. Wait for the transaction to confirm and try again.` }
    }
    if (status !== 'success') return { ok: false, reason: `transaction ${txHash} reverted; no account was created` }

    const decoded = decodeAccountCreated(logs, this.factory)
    if (!decoded.length) return { ok: false, reason: `transaction ${txHash} contains no AccountCreated event from factory ${this.factory}` }
    const mine = decoded.find((d) => d.owner.toLowerCase() === owner.toLowerCase())
    if (!mine) {
      return { ok: false, reason: `transaction ${txHash} created an account for ${decoded[0]!.owner}, not for the signed-in address ${owner}` }
    }
    const existing = await this.byAddress(mine.account)
    if (!existing) await this.insertPending(owner, mine.account, txHash, label, mine.policy)
    else if (label && !existing.label) await this.db.update(accountsTable).set({ label }).where(eq(accountsTable.id, existing.id))
    const account = await this.refresh(mine.account)
    return account ? { ok: true, account } : { ok: false, reason: `account ${mine.account} could not be read back from the chain` }
  }

  private async insertPending(owner: Address, account: Address, deployedTx: Hash | null, label: string | null = null, policy: AccountPolicy | null = null): Promise<void> {
    await this.db
      .insert(accountsTable)
      .values({
        ownerAddress: owner.toLowerCase(),
        accountAddress: account.toLowerCase(),
        chainId: this.chainId,
        factoryAddress: this.factory.toLowerCase(),
        deployedTx,
        status: 'pending',
        label,
        policy: policy ? policyToJson(policy) : null,
      })
      .onConflictDoNothing()
  }

  /**
   * Re-read one account and write the cache. Returns the updated row, or the
   * cached one when the read failed (a transient RPC gap is not a state change).
   */
  async refresh(address: Address): Promise<ArmAccount | null> {
    const cached = await this.byAddress(address)
    if (!cached) return null
    let state: AccountChainState
    try {
      state = await this.readChainState(address)
    } catch (err) {
      this.log.warn({ account: address, err: text(err) }, 'account state read failed; keeping the cached row')
      return cached
    }
    const ours = this.operatorAddress != null && state.operator.toLowerCase() === this.operatorAddress.toLowerCase()
    const status: AccountStatus = ours ? 'active' : 'revoked'
    const revokedReason = ours
      ? null
      : this.operatorAddress == null
        ? 'This server has no trading key configured (TRADER_PRIVATE_KEY is unset), so it cannot be any account\'s operator.'
        : `The account's operator is ${state.operator}, not this engine's key ${this.operatorAddress}. Nothing here can trade it.`

    const [row] = await this.db
      .update(accountsTable)
      .set({
        ownerAddress: state.owner.toLowerCase(),
        operatorAddress: state.operator.toLowerCase(),
        status,
        revokedReason,
        policy: policyToJson(state.policy),
        ethBalanceWei: state.ethBalanceWei.toString(),
        wethBalanceWei: state.wethBalanceWei.toString(),
        lastSyncedAt: state.readAt,
      })
      .where(eq(accountsTable.id, cached.id))
      .returning()
    const updated = rowToAccount(row!)
    if (status === 'revoked' && cached.status !== 'revoked') await this.onRevoked(updated, revokedReason ?? 'operator changed')
    return updated
  }

  /** Refresh every account we still believe is tradable, plus anything still pending. */
  async refreshActive(): Promise<number> {
    const rows = await this.db
      .select({ accountAddress: accountsTable.accountAddress })
      .from(accountsTable)
      .where(and(eq(accountsTable.chainId, this.chainId), inArray(accountsTable.status, ['active', 'pending'])))
    for (const r of rows) await this.refresh(getAddress(r.accountAddress))
    return rows.length
  }

  /**
   * The owner took us off their money. Disable every arm bound to the account
   * so the engine stops trying, and journal it: an arm that silently stopped
   * trading is a support ticket, an arm that says why is an answer.
   */
  private async onRevoked(account: ArmAccount, reason: string): Promise<void> {
    const disabled = await this.db
      .update(armsTable)
      .set({ enabled: false, updatedAt: new Date() })
      .where(and(eq(armsTable.accountId, account.id), eq(armsTable.enabled, true)))
      .returning({ id: armsTable.id, label: armsTable.label })
    this.log.warn(
      { account: account.accountAddress, owner: account.ownerAddress, operator: account.operatorAddress, disarmed: disabled.length },
      'account operator is no longer this engine; account revoked and its arms disarmed',
    )
    if (!this.journal) return
    await this.journal.append({
      armId: null,
      token: null,
      kind: 'alert',
      reason: 'account_revoked',
      detail: {
        accountId: account.id,
        account: account.accountAddress,
        owner: account.ownerAddress,
        operator: account.operatorAddress,
        why: reason,
        disarmedArms: disabled.map((a) => ({ id: a.id, label: a.label })),
      },
    })
    for (const arm of disabled) {
      await this.journal.append({
        armId: arm.id,
        token: null,
        kind: 'alert',
        reason: 'arm_disarmed_account_revoked',
        detail: { accountId: account.id, account: account.accountAddress, why: reason },
      })
    }
  }

  /** Read the row, refreshing first when the cache is older than {@link STALE_AFTER_MS}. */
  async fresh(address: Address, maxAgeMs = STALE_AFTER_MS): Promise<ArmAccount | null> {
    const cached = await this.byAddress(address)
    if (!cached) return null
    const age = cached.lastSyncedAt ? Date.now() - cached.lastSyncedAt.getTime() : Infinity
    if (age <= maxAgeMs) return cached
    return this.refresh(address)
  }

  /** How many arms point at this account, and how many of them are enabled. */
  async armCounts(accountId: string): Promise<{ total: number; enabled: number }> {
    const [row] = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        enabled: sql<number>`count(*) filter (where ${armsTable.enabled})::int`,
      })
      .from(armsTable)
      .where(eq(armsTable.accountId, accountId))
    return { total: row?.total ?? 0, enabled: row?.enabled ?? 0 }
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

export function rowToAccount(r: typeof accountsTable.$inferSelect): ArmAccount {
  return {
    id: r.id,
    ownerAddress: getAddress(r.ownerAddress),
    accountAddress: getAddress(r.accountAddress),
    chainId: r.chainId,
    factoryAddress: getAddress(r.factoryAddress),
    deployedTx: (r.deployedTx as Hash | null) ?? null,
    operatorAddress: r.operatorAddress ? getAddress(r.operatorAddress) : null,
    status: r.status as AccountStatus,
    label: r.label,
    policy: policyFromJson(r.policy),
    revokedReason: r.revokedReason,
    ethBalanceWei: toBigInt(r.ethBalanceWei),
    wethBalanceWei: toBigInt(r.wethBalanceWei),
    createdAt: r.createdAt,
    lastSyncedAt: r.lastSyncedAt,
  }
}

interface CreatedEvent {
  owner: Address
  account: Address
  operator: Address
  policy: AccountPolicy | null
}

/** Every AccountCreated log in a receipt that came from `factory`. */
export function decodeAccountCreated(
  logs: readonly { address: string; topics: readonly string[]; data: string }[],
  factory: Address,
): CreatedEvent[] {
  const out: CreatedEvent[] = []
  for (const log of logs) {
    if (log.address.toLowerCase() !== factory.toLowerCase()) continue
    try {
      const decoded = decodeCreatedLog(log)
      if (decoded) out.push(decoded)
    } catch {
      // a different event from the same contract
    }
  }
  return out
}

function decodeCreatedLog(log: { topics: readonly string[]; data: string }): CreatedEvent | null {
  const decoded = decodeEventLog({
    abi: hoodArmFactoryAbi,
    eventName: 'AccountCreated',
    topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
    data: log.data as `0x${string}`,
  })
  const args = decoded.args as unknown as { owner: Address; account: Address; operator: Address; policy: PolicyTuple }
  if (!args?.account) return null
  return {
    owner: getAddress(args.owner),
    account: getAddress(args.account),
    operator: getAddress(args.operator),
    policy: args.policy ? tupleToPolicy(args.policy) : null,
  }
}

const text = (err: unknown): string => {
  const o = err as { shortMessage?: string; message?: string }
  return String(o?.shortMessage || o?.message || err).split('\n')[0]!.slice(0, 300)
}
