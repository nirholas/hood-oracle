/**
 * The non-custodial execution path: the same buy and sell the engine already
 * does, routed through a user's `HoodArmAccount` instead of the engine's own
 * wallet.
 *
 * What changes and what does not:
 *   - The MONEY moves from the account, not from the hot key. The hot key
 *     signs and pays gas; it never holds the user's ETH and cannot withdraw it.
 *   - Every balance and floor check reads the ACCOUNT's balances. The hot key
 *     is only checked for enough ETH to pay gas.
 *   - Every buy is PRE-FLIGHTED with an `eth_call` of the exact account call
 *     that would be broadcast. A chain-side refusal (per-trade cap, daily
 *     budget, cooldown, concurrency, oracle gate, slippage bound) comes back as
 *     the custom error the contract defines, is mapped onto the RefusalReason
 *     the engine already journals, and is refused BEFORE a transaction is
 *     signed. A user should never pay gas to learn their own policy, and a
 *     dashboard should never show "execution reverted" where it could show
 *     "over the per-trade cap".
 *   - Sells are exempt from the caps on chain as well as off, exactly as
 *     `src/guards/risk.ts` documents: a cap that traps a losing position is the
 *     failure a stop loss exists to prevent.
 *
 * Only Uniswap v3 pools are routable: the account's `buy` calls
 * `exactInputSingle` on the policy's router. Odyssey curve positions and v4
 * pools stay on the hot key's own path until they graduate, and this executor
 * refuses them with `no_route` rather than pretending.
 */
import {
  decodeErrorResult, decodeEventLog, encodeFunctionData, formatEther, getAddress,
  type Address, type Hash, type Hex,
} from 'viem'
import { and, eq, isNull } from 'drizzle-orm'
import { errorText, withRpcRetry } from '../chain/client.js'
import { SubmitError, submitTransaction } from '../chain/submit.js'
import { positions, trades } from '../db/schema.js'
import { toBigIntOrNull } from '../db/client.js'
import { assessTradeSafety, criticalFirewallReason } from '../guards/firewall.js'
import { RiskEngine } from '../guards/risk.js'
import {
  hoodArmAccountAbi, hoodOracleAttestationsAbi, ATTESTATION_EIP712_TYPES,
  ATTESTATION_DOMAIN_NAME, ATTESTATION_DOMAIN_VERSION, erc20BalanceAbi,
} from '../accounts/abi.js'
import { tupleToPolicy, type PolicyTuple } from '../accounts/policy.js'
import type { AccountRegistryApi } from '../accounts/registry.js'
import type {
  AccountPolicy, ArmAccount, FirewallAssessment, GuardVerdict, OracleTier, OracleVerdict, Position, RefusalReason, Trade,
} from '../types.js'
import type { EngineContext } from './context.js'
import type { BuyRequest, BuyResult, Executor, SellRequest, SellResult } from './executor.js'
import { impactFromSpot, rowToPosition, rowToTrade } from './executor.js'
import { sellAmountForFraction } from './exits.js'
import { spendSnapshot } from './spend.js'

/** How long an attestation the engine posts stays fresh. Long enough for a fill, short enough that a stale score cannot gate one. */
export const ATTESTATION_TTL_SECONDS = 15 * 60
/** Gas the operator key must still hold after a trade, on top of nothing else: the account holds the trading funds. */
export const OPERATOR_GAS_FLOOR_WEI = 2_000_000_000_000_000n

const TIER_INDEX: Record<OracleTier, number> = { prime: 0, strong: 1, lean: 2, watch: 3, avoid: 4 }

export interface AccountExecutorDeps {
  ctx: EngineContext
  registry: AccountRegistryApi
  /** Overrides for tests; production uses the constants above. */
  attestationTtlSeconds?: number
  operatorGasFloorWei?: bigint
}

export interface AccountExecutor {
  buy(req: BuyRequest): Promise<BuyResult>
  sell(req: SellRequest): Promise<SellResult>
}

// ── revert decoding ──────────────────────────────────────────────────────────

export interface DecodedRefusal {
  reason: RefusalReason
  detail: string
  /** The custom error the account raised, when it was one we know. */
  error: string | null
}

const eth = (wei: bigint): string => `${formatEther(wei)} ETH`

/**
 * Map a HoodArmAccount custom error onto the RefusalReason vocabulary the
 * journal and the dashboard already speak. An unknown revert is
 * `account_unavailable` with the raw text, never a silent failure.
 */
export function decodeAccountRefusal(err: unknown): DecodedRefusal {
  const data = revertData(err)
  if (data) {
    try {
      const decoded = decodeErrorResult({ abi: hoodArmAccountAbi, data })
      const args = (decoded.args ?? []) as readonly unknown[]
      const n = (i: number): bigint => (typeof args[i] === 'bigint' ? (args[i] as bigint) : 0n)
      switch (decoded.errorName) {
        case 'KillSwitch':
          return { reason: 'kill_switch', detail: 'The account owner has the on-chain kill switch tripped: no new buys until they clear it.', error: 'KillSwitch' }
        case 'PerTradeCap':
          return { reason: 'per_trade_cap', detail: `The account refuses a ${eth(n(0))} buy: its on-chain per-trade cap is ${eth(n(1))}.`, error: 'PerTradeCap' }
        case 'DailyBudget':
          return { reason: 'daily_budget', detail: `The buy would take today's spend to ${eth(n(0))}, over the account's on-chain daily budget of ${eth(n(1))}.`, error: 'DailyBudget' }
        case 'Concurrency':
          return { reason: 'concurrency', detail: `The account already holds ${n(0)} of its ${n(1)} allowed positions on chain.`, error: 'Concurrency' }
        case 'Cooldown':
          return { reason: 'cooldown', detail: `The account's on-chain cooldown has ${n(0)}s left.`, error: 'Cooldown' }
        case 'SlippageBound':
          return { reason: 'slippage_bound', detail: `The account requires a minimum output of ${n(1)} units at the pool's spot price; this order offered ${n(0)}.`, error: 'SlippageBound' }
        case 'OracleGate': {
          const score = Number(args[0] ?? 0)
          const min = Number(args[1] ?? 0)
          const fresh = args[2] === true
          return {
            reason: 'oracle_gate',
            detail: fresh
              ? `The account requires an on-chain oracle score of at least ${min}; the latest attestation is ${score}.`
              : `The account requires an on-chain oracle score of at least ${min} and this token has no fresh attestation.`,
            error: 'OracleGate',
          }
        }
        case 'NotOperator':
          return { reason: 'operator_revoked', detail: `The account no longer accepts this engine as its operator (it refused ${String(args[0])}). The owner has rotated the key.`, error: 'NotOperator' }
        case 'NotOwnerOrOperator':
          return { reason: 'operator_revoked', detail: 'The account refuses this key for sells: the owner has rotated the operator away from this engine.', error: 'NotOwnerOrOperator' }
        case 'ZeroAmount':
          return { reason: 'zero_amount', detail: 'The account refuses a zero-size order.', error: 'ZeroAmount' }
        case 'DeadlineExpired':
          return { reason: 'no_route', detail: 'The order deadline passed before the account could execute it.', error: 'DeadlineExpired' }
        case 'QuoteTokenNotTradable':
          return { reason: 'entry_filter', detail: 'The account will not buy its own quote token.', error: 'QuoteTokenNotTradable' }
        case 'InsufficientBalance':
          return { reason: 'wallet_floor', detail: `The account holds ${eth(n(1))} of its quote token and the order needs ${eth(n(0))}. Fund the account with ETH.`, error: 'InsufficientBalance' }
        case 'NoPosition':
          return { reason: 'no_route', detail: 'The account holds no tracked position in this token, so there is nothing to sell.', error: 'NoPosition' }
        case 'InsufficientPosition':
          return { reason: 'no_route', detail: `The sell asks for ${n(1)} units but the account's books hold ${n(2)}.`, error: 'InsufficientPosition' }
        case 'NothingReceived':
          return { reason: 'no_route', detail: 'The swap delivered nothing: the pool could not fill this order.', error: 'NothingReceived' }
        case 'NoPool':
          return { reason: 'no_route', detail: 'The policy router knows no pool for this pair at that fee tier.', error: 'NoPool' }
        case 'PoolNotInitialized':
          return { reason: 'no_route', detail: 'The pool exists but has never been initialized with a price.', error: 'PoolNotInitialized' }
        default:
          return { reason: 'account_unavailable', detail: `The account refused with ${decoded.errorName}.`, error: decoded.errorName ?? null }
      }
    } catch {
      // not one of ours: fall through to the raw text
    }
  }
  return { reason: 'account_unavailable', detail: `The account call could not be simulated: ${errorText(err)}`, error: null }
}

/** Dig the revert payload out of whatever viem wrapped it in. */
function revertData(err: unknown): Hex | null {
  let e: unknown = err
  for (let depth = 0; e && typeof e === 'object' && depth < 8; depth++) {
    const o = e as { data?: unknown; raw?: unknown; cause?: unknown }
    const candidate = typeof o.data === 'string' ? o.data : typeof o.raw === 'string' ? o.raw : null
    if (candidate && /^0x[0-9a-fA-F]*$/.test(candidate) && candidate.length >= 10) return candidate as Hex
    if (o.data && typeof o.data === 'object' && 'data' in (o.data as object)) {
      const nested = (o.data as { data?: unknown }).data
      if (typeof nested === 'string' && nested.length >= 10) return nested as Hex
    }
    e = o.cause
  }
  return null
}

// ── local policy pre-check ───────────────────────────────────────────────────

export interface AccountBuyState {
  killed: boolean
  spentTodayWei: bigint
  cooldownRemainingSeconds: number
  openPositionCount: number
  /** Quote units the account already holds, plus native ETH it can wrap. */
  spendableQuoteWei: bigint
  /** True when the account already books a position in this token, so no slot is needed. */
  holdsToken: boolean
}

/**
 * The chain's own buy checks, run locally against a state snapshot. Pure, so
 * every branch is unit-testable, and identical in order to the contract's:
 * kill, amount, cooldown, per-trade cap, daily budget, concurrency. It is what
 * makes a SIMULATED arm on an account faithful without spending anything, and
 * it is a fast rejection before the eth_call in live mode.
 */
export function checkAccountPolicy(policy: AccountPolicy, state: AccountBuyState, amountWei: bigint): GuardVerdict {
  const refuse = (reason: RefusalReason, detail: string): GuardVerdict => ({ ok: false, reason, detail })
  if (state.killed) return refuse('kill_switch', 'The account owner has the on-chain kill switch tripped.')
  if (amountWei <= 0n) return refuse('zero_amount', 'Order amount is zero: nothing to trade.')
  if (state.cooldownRemainingSeconds > 0) return refuse('cooldown', `The account's on-chain cooldown has ${state.cooldownRemainingSeconds}s left.`)
  if (policy.perTradeCapWei === 0n || amountWei > policy.perTradeCapWei) {
    return refuse('per_trade_cap', `A ${eth(amountWei)} buy is over the account's on-chain per-trade cap of ${eth(policy.perTradeCapWei)}.`)
  }
  const wouldSpend = state.spentTodayWei + amountWei
  if (policy.dailyBudgetWei === 0n || wouldSpend > policy.dailyBudgetWei) {
    return refuse('daily_budget', `Today's account spend would reach ${eth(wouldSpend)}, over its on-chain daily budget of ${eth(policy.dailyBudgetWei)}.`)
  }
  if (!state.holdsToken && state.openPositionCount >= policy.maxOpenPositions) {
    return refuse('concurrency', `The account holds ${state.openPositionCount} of its ${policy.maxOpenPositions} allowed on-chain positions.`)
  }
  return { ok: true, detail: 'Inside the account\'s on-chain policy.' }
}

// ── the executor ─────────────────────────────────────────────────────────────

export function createAccountExecutor(deps: AccountExecutorDeps): AccountExecutor {
  return new AccountExecutorImpl(deps)
}

class AccountExecutorImpl implements AccountExecutor {
  private readonly ctx: EngineContext
  private readonly registry: AccountRegistryApi
  private readonly ttl: number
  private readonly gasFloor: bigint
  /** Sells are exempt from every cap; buys are bounded by the ACCOUNT's balance, and gas is the hot key's problem, so the wallet gas headroom is checked separately. */
  private readonly risk = new RiskEngine({ gasHeadroomWei: 0n })
  private readonly inFlight = new Set<string>()
  private readonly positionLocks = new Map<string, Promise<unknown>>()

  constructor(deps: AccountExecutorDeps) {
    this.ctx = deps.ctx
    this.registry = deps.registry
    this.ttl = deps.attestationTtlSeconds ?? ATTESTATION_TTL_SECONDS
    this.gasFloor = deps.operatorGasFloorWei ?? OPERATOR_GAS_FLOOR_WEI
  }

  // ── buy ─────────────────────────────────────────────────────────────────

  async buy(req: BuyRequest): Promise<BuyResult> {
    const { arm, launch } = req
    const token = launch.token
    const key = `${token.toLowerCase()}:${arm.id}`
    const tag = { arm: arm.label, token, venue: req.venue, mode: arm.mode, account: arm.accountId }
    const refuse = async (verdict: GuardVerdict, firewall?: FirewallAssessment): Promise<BuyResult> => {
      this.ctx.log.info({ ...tag, reason: verdict.reason, detail: verdict.detail }, 'account buy refused')
      await this.ctx.journal.append({
        armId: arm.id, token, kind: 'refused', reason: verdict.reason ?? 'refused',
        detail: { detail: verdict.detail, trigger: req.trigger, venue: req.venue, path: 'account', accountId: arm.accountId, ...(firewall ? { firewall: { verdict: firewall.verdict, score: firewall.score } } : {}) },
      })
      return { status: 'refused', verdict, ...(firewall ? { firewall } : {}) }
    }

    if (this.inFlight.has(key)) {
      return { status: 'refused', verdict: { ok: false, reason: 'concurrency', detail: 'a buy for this token and arm is already in flight' } }
    }
    this.inFlight.add(key)
    try {
      if (this.ctx.kill.isKilled()) return refuse({ ok: false, reason: 'kill_switch', detail: this.ctx.kill.reason() ?? 'engine kill switch' })
      const resolved = await this.resolveAccount(arm.accountId)
      if ('error' in resolved) return refuse(resolved.error)
      const { account, policy } = resolved
      if (req.venue !== 'pool' || !req.pool) {
        return refuse({
          ok: false,
          reason: 'no_route',
          detail: req.venue === 'pool'
            ? 'no Uniswap v3 pool is known for this token yet'
            : `an on-chain arm account routes through ${policy.allowedRouter} (Uniswap v3) only; ${req.venue} venues stay on the operator wallet until they graduate`,
        })
      }
      const amountWei = arm.perTradeWei
      if (amountWei <= 0n) return refuse({ ok: false, reason: 'zero_amount', detail: 'per_trade_wei is zero' })

      const existing = await this.ctx.db.select({ id: positions.id }).from(positions)
        .where(and(eq(positions.armId, arm.id), eq(positions.token, token.toLowerCase()), isNull(positions.closedAt))).limit(1)
      if (existing.length) return refuse({ ok: false, reason: 'concurrency', detail: 'this arm already holds an open position in the token' })

      let state: AccountBuyState
      try {
        state = await this.readBuyState(account.accountAddress, policy, token)
      } catch (err) {
        return refuse({ ok: false, reason: 'account_unavailable', detail: `the account's state could not be read: ${errorText(err)}` })
      }
      const chainSide = checkAccountPolicy(policy, state, amountWei)
      if (!chainSide.ok) return refuse(chainSide)
      if (arm.mode === 'live' && state.spendableQuoteWei < amountWei) {
        return refuse({
          ok: false,
          reason: 'wallet_floor',
          detail: `Account ${account.accountAddress} holds ${eth(state.spendableQuoteWei)} of spendable quote and the buy needs ${eth(amountWei)}. Send ETH to the account.`,
        })
      }
      if (arm.mode === 'live') {
        const gas = await this.operatorGasCheck()
        if (!gas.ok) return refuse(gas)
      }

      const spend = await spendSnapshot(this.ctx.db, arm.id)
      const quoted = await this.ctx.prices.poolQuoteBuy(req.pool, token, amountWei)
      if (!quoted) return refuse({ ok: false, reason: 'no_route', detail: 'the pool could not quote this buy' })
      const spot = await this.ctx.prices.poolSpotEth(req.pool, token, launch.decimals)
      const impactPct = impactFromSpot(amountWei, quoted.amountOut, launch.decimals, spot)
      if (impactPct == null) return refuse({ ok: false, reason: 'price_impact', detail: 'spot price unavailable, price impact cannot be measured' })

      // The off-chain risk engine still runs: it holds the rules the chain does
      // not know about (daily realized-loss breaker, price impact, the arm's
      // own caps, which may be tighter than the policy).
      const verdict = this.risk.check({
        side: 'buy', arm, amountWei, walletWei: state.spendableQuoteWei, minWalletWei: 0n,
        spentTodayWei: spend.spentTodayWei, realizedLossTodayWei: spend.realizedLossTodayWei,
        openPositions: spend.openPositions, lastTradeAt: spend.lastTradeAt ? spend.lastTradeAt.getTime() : null,
        slippageBps: arm.slippageBps, priceImpactPct: impactPct, killed: this.ctx.kill.isKilled(),
      })
      if (!verdict.ok) return refuse(verdict)

      let firewall: FirewallAssessment | null = null
      if (arm.firewallLevel !== 'off') {
        firewall = await assessTradeSafety({
          chain: this.ctx.chain, prices: this.ctx.prices, log: this.ctx.log, db: this.ctx.db, network: this.ctx.network,
          token, venue: 'pool', pool: req.pool, factory: req.factory, amountWei, deployer: launch.creator, v4Pool: null,
        })
        const critical = criticalFirewallReason(firewall)
        if (arm.firewallLevel === 'block' && (firewall.verdict === 'block' || critical)) {
          const why = firewall.checks.find((c) => c.status === 'fail')?.reason ?? firewall.checks.find((c) => c.status === 'unavailable')?.reason ?? `firewall score ${firewall.score}`
          return refuse({ ok: false, reason: 'firewall', detail: why }, firewall)
        }
      }

      // The on-chain oracle gate, if the owner set one: post the attestation
      // before the buy, or refuse with a reason that names what is missing.
      if (policy.minOracleScore > 0) {
        const gate = await this.ensureAttestation(account, policy, token, req.verdict, arm.mode)
        if (!gate.ok) return refuse(gate)
      }

      const minOut = (quoted.amountOut * BigInt(10_000 - arm.slippageBps)) / 10_000n
      const fee = quoted.fee
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 120)
      const data = encodeFunctionData({ abi: hoodArmAccountAbi, functionName: 'buy', args: [token, amountWei, minOut, fee, deadline] })

      let fill: { tokenAmount: bigint; entryWei: bigint; txHash: Hash | 'SIMULATED'; gasWei: bigint | null; meta: Record<string, unknown> }
      if (arm.mode === 'simulate') {
        fill = { tokenAmount: quoted.amountOut, entryWei: amountWei, txHash: 'SIMULATED', gasWei: null, meta: { fillPrice: 'quote_mid', preflight: 'skipped in simulate mode: no funds are committed' } }
      } else {
        const preflight = await this.preflight(account.accountAddress, data)
        if (!preflight.ok) return refuse({ ok: false, reason: preflight.refusal.reason, detail: preflight.refusal.detail })
        try {
          const result = await submitTransaction(this.ctx.chain, { to: account.accountAddress, data }, { receiptDeadlineMs: 30_000 })
          const booked = decodeBuyEvent(result.receipt.logs, account.accountAddress, token)
          fill = {
            tokenAmount: booked?.amountOut ?? 0n,
            entryWei: booked?.amountInWei ?? amountWei,
            txHash: result.hash,
            gasWei: result.gasWei,
            meta: {
              acceptMs: result.acceptMs, confirmMs: result.confirmMs, acceptedBy: result.acceptedBy,
              positionTokenAmount: booked?.positionTokenAmount?.toString() ?? null,
              positionCostBasisWei: booked?.positionCostBasisWei?.toString() ?? null,
            },
          }
        } catch (err) {
          const detail = err instanceof SubmitError ? `${err.stage}: ${err.message}` : errorText(err)
          this.ctx.log.error({ ...tag, err: detail }, 'account buy failed')
          await this.ctx.journal.append({ armId: arm.id, token, kind: 'error', reason: 'buy_failed', detail: { detail, path: 'account', accountId: account.id, hash: err instanceof SubmitError ? err.hash : null } })
          return { status: 'failed', error: detail }
        }
      }
      if (fill.tokenAmount <= 0n) {
        await this.ctx.journal.append({ armId: arm.id, token, kind: 'error', reason: 'buy_zero_fill', detail: { txHash: fill.txHash, path: 'account', accountId: account.id } })
        return { status: 'failed', error: 'the account buy landed but delivered zero tokens' }
      }

      const now = new Date()
      const meta: Record<string, unknown> = {
        venue: 'pool', pool: req.pool, factory: req.factory, trigger: req.trigger,
        account: { id: account.id, address: account.accountAddress, owner: account.ownerAddress },
        custody: 'account',
        fee, priceImpactPct: impactPct, quotedOut: quoted.amountOut.toString(), originalEntryWei: fill.entryWei.toString(),
        firewall: firewall ? { verdict: firewall.verdict, score: firewall.score, roundTripLossPct: firewall.roundTripLossPct } : null,
        symbol: launch.symbol, name: launch.name, launchpad: launch.launchpad, ...fill.meta,
      }
      const [row] = await this.ctx.db.insert(positions).values({
        armId: arm.id, token: token.toLowerCase(), network: this.ctx.network, launchpad: launch.launchpad, venue: 'pool', mode: arm.mode, status: 'open',
        entryWei: fill.entryWei.toString(), tokenAmount: fill.tokenAmount.toString(), tokenDecimals: launch.decimals, buyTx: fill.txHash,
        openedAt: now, peakValueWei: fill.entryWei.toString(), lastValueWei: fill.entryWei.toString(), oracleScoreAtEntry: req.verdict?.score ?? null, meta,
      }).returning()
      const position = rowToPosition(row!)
      const [tradeRow] = await this.ctx.db.insert(trades).values({
        armId: arm.id, positionId: position.id, token: token.toLowerCase(), network: this.ctx.network, side: 'buy', mode: arm.mode, venue: 'pool',
        amountIn: fill.entryWei.toString(), amountOut: fill.tokenAmount.toString(), txHash: fill.txHash, gasWei: fill.gasWei?.toString() ?? null,
        priceImpactPct: impactPct, slippageBps: arm.slippageBps, at: now,
        meta: { trigger: req.trigger, gate: req.gateDetail, account: account.accountAddress, custody: 'account' },
      }).returning()
      const trade = rowToTrade(tradeRow!)
      await this.ctx.journal.append({
        armId: arm.id, token, kind: 'buy', reason: req.trigger, detail: {
          gate: req.gateDetail, entryWei: fill.entryWei, tokenAmount: fill.tokenAmount, txHash: fill.txHash, venue: 'pool',
          path: 'account', accountId: account.id, account: account.accountAddress, owner: account.ownerAddress,
          priceImpactPct: impactPct, oracleScore: req.verdict?.score ?? null, oracleTier: req.verdict?.tier ?? null,
          firewall: meta.firewall, positionId: position.id,
        },
      })
      this.ctx.bus.emit({ kind: 'trade', at: now.getTime(), trade })
      this.ctx.bus.emit({ kind: 'position', at: now.getTime(), position })
      this.ctx.alerts.buy({ armLabel: arm.label, token, symbol: launch.symbol, ethIn: formatEther(fill.entryWei), mode: arm.mode, score: req.verdict?.score ?? null, chatId: arm.telegramChatId })
      this.ctx.log.info({ ...tag, entryWei: fill.entryWei.toString(), tokens: fill.tokenAmount.toString(), tx: fill.txHash }, 'account buy filled')
      return { status: 'filled', position, trade }
    } finally {
      this.inFlight.delete(key)
    }
  }

  // ── sell ────────────────────────────────────────────────────────────────

  sell(req: SellRequest): Promise<SellResult> {
    return this.withPositionLock(req.position.id, () => this.sellLocked(req))
  }

  private async sellLocked(req: SellRequest): Promise<SellResult> {
    const { arm, reason } = req
    let position = req.position
    const token = position.token
    const tag = { arm: arm.label, token, reason, mode: position.mode, fraction: req.fraction }
    if (position.status === 'closed') return { status: 'failed', error: 'position is already closed' }

    const accountAddress = accountAddressOf(position)
    if (!accountAddress) return { status: 'failed', error: 'this position was not opened through an on-chain account' }
    const resolved = await this.resolveAccount(arm.accountId ?? (position.meta.account as { id?: string } | undefined)?.id ?? null)
    if ('error' in resolved) {
      // Selling is the one thing that must not be blocked by a policy read.
      // A revoked account still lets its OWNER sell; the engine cannot, and
      // says so instead of failing silently.
      await this.ctx.journal.append({ armId: arm.id, token, kind: 'error', reason: 'sell_blocked', detail: { detail: resolved.error.detail, positionId: position.id, account: accountAddress } })
      return { status: 'failed', error: resolved.error.detail }
    }
    const { account } = resolved

    const pool = req.pool ?? (typeof position.meta.pool === 'string' ? getAddress(position.meta.pool) : null)
    if (!pool) return { status: 'failed', error: 'no pool recorded for this position' }
    const total = position.tokenAmount
    let { amount: sellAmount, ppm, partial } = sellAmountForFraction(total, req.fraction)
    const retainsMoonbag = req.keepsMoonbag === true && partial && !req.recoversInitials

    // The account's own books are the truth about what it still holds.
    if (position.mode === 'live') {
      try {
        const held = await withRpcRetry(() => this.ctx.chain.publicClient.readContract({
          address: accountAddress, abi: hoodArmAccountAbi, functionName: 'position', args: [token],
        }))
        const onChain = (held as { tokenAmount: bigint }).tokenAmount
        if (onChain === 0n) return { status: 'failed', error: `the account books no position in ${token} any more; the owner may have withdrawn or sold it` }
        if (onChain < sellAmount) {
          this.ctx.log.warn({ ...tag, recorded: sellAmount.toString(), onChain: onChain.toString() }, 'sell clamped to the account position')
          sellAmount = onChain
          partial = false
          ppm = 1_000_000n
        }
      } catch (err) {
        this.ctx.log.warn({ ...tag, err: errorText(err) }, 'account position read failed before sell; selling the recorded amount')
      }
    }

    const quoteOut = await this.ctx.prices.poolQuoteSell(pool, token, sellAmount)
    if (quoteOut == null) return { status: 'failed', error: 'the pool could not quote the sell' }
    const minOut = (quoteOut * BigInt(10_000 - arm.slippageBps)) / 10_000n
    const info = await this.ctx.prices.pool(pool)
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 120)
    const data = encodeFunctionData({ abi: hoodArmAccountAbi, functionName: 'sell', args: [token, sellAmount, minOut, info.fee, deadline] })

    let fill: { ethOut: bigint; feeWei: bigint; txHash: Hash | 'SIMULATED'; gasWei: bigint | null }
    if (position.mode === 'simulate') {
      fill = { ethOut: quoteOut, feeWei: 0n, txHash: 'SIMULATED', gasWei: null }
    } else {
      const preflight = await this.preflight(accountAddress, data)
      if (!preflight.ok) {
        await this.ctx.journal.append({ armId: arm.id, token, kind: 'error', reason: 'sell_refused_onchain', detail: { detail: preflight.refusal.detail, error: preflight.refusal.error, positionId: position.id, exitReason: reason } })
        return { status: 'failed', error: preflight.refusal.detail }
      }
      try {
        const result = await submitTransaction(this.ctx.chain, { to: accountAddress, data }, { receiptDeadlineMs: 30_000 })
        const booked = decodeSellEvent(result.receipt.logs, accountAddress, token)
        fill = { ethOut: booked?.proceedsWei ?? 0n, feeWei: booked?.feeWei ?? 0n, txHash: result.hash, gasWei: result.gasWei }
      } catch (err) {
        const detail = err instanceof SubmitError ? `${err.stage}: ${err.message}` : errorText(err)
        this.ctx.log.error({ ...tag, err: detail }, 'account sell failed')
        await this.ctx.journal.append({ armId: arm.id, token, kind: 'error', reason: 'sell_failed', detail: { detail, positionId: position.id, exitReason: reason, path: 'account' } })
        await this.ctx.db.update(positions).set({ meta: { ...position.meta, lastSellError: detail, lastSellErrorAt: new Date().toISOString() } }).where(eq(positions.id, position.id))
        return { status: 'failed', error: detail }
      }
    }

    const now = new Date()
    const entryFull = position.entryWei
    const soldCostBasis = partial ? (entryFull * ppm) / 1_000_000n : entryFull
    const legPnl = fill.ethOut - soldCostBasis
    const cumRealized = (position.realizedPnlWei ?? 0n) + legPnl
    const originalEntry = toBigIntOrNull(position.meta.originalEntryWei as string | undefined) ?? entryFull
    const realizedPct = originalEntry > 0n ? Number((cumRealized * 1_000_000n) / originalEntry) / 10_000 : null
    const feesPaid = (toBigIntOrNull(position.meta.performanceFeeWei as string | undefined) ?? 0n) + fill.feeWei

    if (partial && !retainsMoonbag) {
      const remaining = total - sellAmount
      const remainingEntry = entryFull - soldCostBasis
      const remainingValue = sellAmount > 0n ? (fill.ethOut * remaining) / sellAmount : 0n
      const [row] = await this.ctx.db.update(positions).set({
        tokenAmount: remaining.toString(), entryWei: remainingEntry.toString(), initialsRecovered: req.recoversInitials === true || position.initialsRecovered,
        peakValueWei: remainingValue.toString(), lastValueWei: remainingValue.toString(), staleSince: null,
        realizedPnlWei: cumRealized.toString(), realizedPnlPct: realizedPct,
        meta: { ...position.meta, initialsTx: fill.txHash, initialsAt: now.toISOString(), performanceFeeWei: feesPaid.toString() },
      }).where(eq(positions.id, position.id)).returning()
      position = rowToPosition(row!)
    } else {
      const remaining = retainsMoonbag ? total - sellAmount : 0n
      const [row] = await this.ctx.db.update(positions).set({
        status: 'closed', closedAt: now, sellTx: fill.txHash, exitReason: reason, realizedPnlWei: cumRealized.toString(), realizedPnlPct: realizedPct,
        lastValueWei: fill.ethOut.toString(), staleSince: null,
        meta: { ...position.meta, ...(retainsMoonbag ? { moonbagTokens: remaining.toString(), moonbagKept: true } : {}), closedBy: reason, performanceFeeWei: feesPaid.toString() },
      }).where(eq(positions.id, position.id)).returning()
      position = rowToPosition(row!)
    }

    const [tradeRow] = await this.ctx.db.insert(trades).values({
      armId: arm.id, positionId: position.id, token: token.toLowerCase(), network: this.ctx.network, side: 'sell', mode: position.mode, venue: 'pool',
      amountIn: sellAmount.toString(), amountOut: fill.ethOut.toString(), txHash: fill.txHash, gasWei: fill.gasWei?.toString() ?? null,
      priceImpactPct: null, slippageBps: arm.slippageBps, at: now,
      meta: {
        exitReason: reason, fraction: req.fraction, legPnlWei: legPnl.toString(), recoversInitials: req.recoversInitials === true,
        keepsMoonbag: retainsMoonbag, custody: 'account', account: account.accountAddress, performanceFeeWei: fill.feeWei.toString(),
      },
    }).returning()
    const trade = rowToTrade(tradeRow!)
    await this.ctx.journal.append({
      armId: arm.id, token, kind: 'sell', reason, detail: {
        positionId: position.id, fraction: req.fraction, soldTokens: sellAmount, ethOut: fill.ethOut, legPnlWei: legPnl,
        cumRealizedWei: cumRealized, realizedPct, txHash: fill.txHash, path: 'account', accountId: account.id,
        account: account.accountAddress, performanceFeeWei: fill.feeWei, recoversInitials: req.recoversInitials === true,
        keepsMoonbag: retainsMoonbag, status: position.status,
      },
    })
    this.ctx.bus.emit({ kind: 'trade', at: now.getTime(), trade })
    this.ctx.bus.emit({ kind: 'position', at: now.getTime(), position })
    const legPct = soldCostBasis > 0n ? Number((legPnl * 10_000n) / soldCostBasis) / 100 : null
    this.ctx.alerts.sell({ armLabel: arm.label, token, symbol: (position.meta.symbol as string | null) ?? null, reason, pnlPct: legPct, ethOut: formatEther(fill.ethOut), mode: position.mode, fraction: req.fraction, chatId: arm.telegramChatId })
    this.ctx.log.info({ ...tag, ethOut: fill.ethOut.toString(), legPnlWei: legPnl.toString(), tx: fill.txHash, status: position.status }, 'account sell filled')
    return { status: 'filled', trade, position }
  }

  // ── internals ───────────────────────────────────────────────────────────

  private async resolveAccount(accountId: string | null): Promise<{ account: ArmAccount; policy: AccountPolicy } | { error: GuardVerdict }> {
    if (!accountId) return { error: { ok: false, reason: 'account_unavailable', detail: 'this arm is not bound to an on-chain account' } }
    const account = await this.registry.byId(accountId)
    if (!account) return { error: { ok: false, reason: 'account_unavailable', detail: `on-chain account ${accountId} is not registered on this server` } }
    if (account.status === 'revoked') {
      return { error: { ok: false, reason: 'operator_revoked', detail: account.revokedReason ?? `account ${account.accountAddress} no longer names this engine as its operator` } }
    }
    const fresh = (await this.registry.fresh(account.accountAddress)) ?? account
    if (fresh.status === 'revoked') {
      return { error: { ok: false, reason: 'operator_revoked', detail: fresh.revokedReason ?? `account ${fresh.accountAddress} no longer names this engine as its operator` } }
    }
    if (!fresh.policy) {
      return { error: { ok: false, reason: 'account_unavailable', detail: `account ${fresh.accountAddress} has no policy cached; the chain could not be read` } }
    }
    return { account: fresh, policy: fresh.policy }
  }

  /** The account's live buy-side state, in one multicall plus two balance reads. */
  private async readBuyState(address: Address, policy: AccountPolicy, token: Address): Promise<AccountBuyState> {
    const contract = { address, abi: hoodArmAccountAbi } as const
    const [killed, spentToday, cooldown, openCount, position] = await this.ctx.chain.publicClient.multicall({
      allowFailure: false,
      contracts: [
        { ...contract, functionName: 'killed' },
        { ...contract, functionName: 'spentTodayWei' },
        { ...contract, functionName: 'cooldownRemaining' },
        { ...contract, functionName: 'openPositionCount' },
        { ...contract, functionName: 'position', args: [token] },
      ],
    })
    const [quoteBalance, ethBalance] = await Promise.all([
      this.ctx.chain.publicClient.readContract({ address: policy.quoteToken, abi: erc20BalanceAbi, functionName: 'balanceOf', args: [address] }),
      this.ctx.chain.publicClient.getBalance({ address }),
    ])
    return {
      killed,
      spentTodayWei: spentToday,
      cooldownRemainingSeconds: Number(cooldown),
      openPositionCount: Number(openCount),
      // The account wraps native ETH on demand when the quote token is WETH.
      spendableQuoteWei: quoteBalance + ethBalance,
      holdsToken: (position as { tokenAmount: bigint }).tokenAmount > 0n,
    }
  }

  /** The hot key pays gas and nothing else, so this is the only balance it must clear. */
  private async operatorGasCheck(): Promise<GuardVerdict> {
    const account = this.ctx.chain.account
    if (!account) return { ok: false, reason: 'disarmed', detail: 'the engine has no signing key (TRADER_PRIVATE_KEY is unset), so it cannot operate any account' }
    try {
      const balance = await withRpcRetry(() => this.ctx.chain.publicClient.getBalance({ address: account.address }))
      if (balance < this.gasFloor) {
        return { ok: false, reason: 'wallet_floor', detail: `the operator key ${account.address} holds ${eth(balance)}, under the ${eth(this.gasFloor)} gas floor. It pays gas only; top it up.` }
      }
      return { ok: true, detail: 'the operator key can pay gas' }
    } catch (err) {
      return { ok: false, reason: 'wallet_floor', detail: `the operator key's balance could not be read: ${errorText(err)}` }
    }
  }

  /**
   * eth_call the exact transaction that is about to be broadcast, from the
   * operator address. A refusal becomes a typed reason here rather than an
   * opaque revert after the gas is spent.
   */
  private async preflight(account: Address, data: Hex): Promise<{ ok: true } | { ok: false; refusal: DecodedRefusal }> {
    const from = this.ctx.chain.account?.address
    if (!from) return { ok: false, refusal: { reason: 'disarmed', detail: 'the engine has no signing key, so it cannot call the account', error: null } }
    try {
      await this.ctx.chain.publicClient.call({ account: from, to: account, data })
      return { ok: true }
    } catch (err) {
      return { ok: false, refusal: decodeAccountRefusal(err) }
    }
  }

  /**
   * Satisfy a policy's `minOracleScore` before the buy. The engine signs the
   * current verdict as an EIP-712 attestation and posts it; with no
   * ATTESTATION_PRIVATE_KEY there is nothing honest to do but refuse, and say
   * exactly that.
   */
  private async ensureAttestation(account: ArmAccount, policy: AccountPolicy, token: Address, verdict: OracleVerdict | null, mode: string): Promise<GuardVerdict> {
    const attestationsAddress = this.ctx.config.accounts.attestations ?? (await this.registry.factoryAddresses()).attestations
    if (!attestationsAddress || attestationsAddress === '0x0000000000000000000000000000000000000000') {
      return { ok: false, reason: 'oracle_gate', detail: `account ${account.accountAddress} requires an on-chain oracle score of ${policy.minOracleScore} but no attestations contract is configured` }
    }
    try {
      const [stored, fresh] = (await this.ctx.chain.publicClient.readContract({
        address: attestationsAddress, abi: hoodOracleAttestationsAbi, functionName: 'latest', args: [token],
      })) as unknown as [{ score: number }, boolean]
      if (fresh && Number(stored.score) >= policy.minOracleScore) return { ok: true, detail: 'a fresh on-chain attestation already clears the account\'s oracle gate' }
    } catch (err) {
      return { ok: false, reason: 'oracle_gate', detail: `the attestations contract could not be read: ${errorText(err)}` }
    }

    if (!verdict) {
      return { ok: false, reason: 'oracle_gate', detail: `account ${account.accountAddress} requires an on-chain oracle score of ${policy.minOracleScore} and this launch has not been scored yet` }
    }
    if (verdict.score < policy.minOracleScore) {
      return { ok: false, reason: 'oracle_gate', detail: `the oracle scores this launch ${verdict.score}; account ${account.accountAddress} requires at least ${policy.minOracleScore} on chain` }
    }
    const key = this.ctx.config.accounts.attestationPrivateKey
    if (!key) {
      return {
        ok: false,
        reason: 'oracle_gate',
        detail: `account ${account.accountAddress} requires an on-chain oracle score of ${policy.minOracleScore} and this server holds no attestation key (ATTESTATION_PRIVATE_KEY is unset), so it cannot post the score of ${verdict.score} it computed.`,
      }
    }
    if (mode === 'simulate') return { ok: true, detail: 'simulate mode: the attestation would be posted before the buy' }
    try {
      await this.postAttestation(attestationsAddress, key, token, verdict)
      return { ok: true, detail: `posted an attestation of ${verdict.score} to clear the account's oracle gate` }
    } catch (err) {
      return { ok: false, reason: 'oracle_gate', detail: `the attestation could not be posted: ${errorText(err)}` }
    }
  }

  private async postAttestation(attestations: Address, key: `0x${string}`, token: Address, verdict: OracleVerdict): Promise<Hash> {
    const { privateKeyToAccount } = await import('viem/accounts')
    const signer = privateKeyToAccount(key)
    const observedAt = BigInt(Math.floor(verdict.scoredAt.getTime() / 1000))
    const attestation = {
      token,
      score: Math.max(0, Math.min(100, Math.round(verdict.score))),
      tier: TIER_INDEX[verdict.tier] ?? TIER_INDEX.avoid,
      rugRiskBps: Math.max(0, Math.min(10_000, Math.round(verdict.rugRisk * 10_000))),
      modelVersion: modelVersionNumber(verdict.modelVersion),
      observedAt,
      expiresAt: BigInt(Math.floor(Date.now() / 1000) + this.ttl),
    }
    const signature = await signer.signTypedData({
      domain: { name: ATTESTATION_DOMAIN_NAME, version: ATTESTATION_DOMAIN_VERSION, chainId: this.ctx.chain.chainId, verifyingContract: attestations },
      types: ATTESTATION_EIP712_TYPES,
      primaryType: 'Attestation',
      message: attestation,
    })
    const data = encodeFunctionData({ abi: hoodOracleAttestationsAbi, functionName: 'post', args: [attestation, signature] })
    const result = await submitTransaction(this.ctx.chain, { to: attestations, data }, { receiptDeadlineMs: 30_000 })
    this.ctx.log.info({ token, score: attestation.score, tx: result.hash }, 'oracle attestation posted')
    return result.hash
  }

  private withPositionLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.positionLocks.get(id) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    this.positionLocks.set(id, next.catch(() => undefined))
    next.finally(() => { if (this.positionLocks.get(id) === next) this.positionLocks.delete(id) }).catch(() => undefined)
    return next
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** The digits of a model version string, as the uint32 the attestation carries. */
export function modelVersionNumber(version: string): number {
  const digits = version.replace(/\D+/g, '')
  if (!digits) return 0
  const n = Number(digits.slice(-9))
  return Number.isSafeInteger(n) && n >= 0 ? n : 0
}

/** The account a position was opened through, from the metadata the buy recorded. */
export function accountAddressOf(position: Position): Address | null {
  const meta = position.meta.account as { address?: unknown } | undefined
  if (meta && typeof meta.address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(meta.address)) return getAddress(meta.address)
  return null
}

interface BuyBooking {
  amountInWei: bigint
  amountOut: bigint
  positionTokenAmount: bigint
  positionCostBasisWei: bigint
}

export function decodeBuyEvent(
  logs: readonly { address: string; topics: readonly string[]; data: string }[],
  account: Address,
  token: Address,
): BuyBooking | null {
  for (const log of logs) {
    if (log.address.toLowerCase() !== account.toLowerCase()) continue
    try {
      const decoded = decodeEventLog({
        abi: hoodArmAccountAbi, eventName: 'Buy',
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]], data: log.data as Hex,
      })
      const a = decoded.args as unknown as BuyBooking & { token: Address }
      if (a.token.toLowerCase() !== token.toLowerCase()) continue
      return { amountInWei: a.amountInWei, amountOut: a.amountOut, positionTokenAmount: a.positionTokenAmount, positionCostBasisWei: a.positionCostBasisWei }
    } catch {
      // a different event from the account
    }
  }
  return null
}

interface SellBooking {
  proceedsWei: bigint
  realizedWei: bigint
  feeWei: bigint
}

export function decodeSellEvent(
  logs: readonly { address: string; topics: readonly string[]; data: string }[],
  account: Address,
  token: Address,
): SellBooking | null {
  for (const log of logs) {
    if (log.address.toLowerCase() !== account.toLowerCase()) continue
    try {
      const decoded = decodeEventLog({
        abi: hoodArmAccountAbi, eventName: 'Sell',
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]], data: log.data as Hex,
      })
      const a = decoded.args as unknown as SellBooking & { token: Address }
      if (a.token.toLowerCase() !== token.toLowerCase()) continue
      return { proceedsWei: a.proceedsWei, realizedWei: a.realizedWei, feeWei: a.feeWei }
    } catch {
      // a different event from the account
    }
  }
  return null
}

/**
 * The integration seam. Wrap the engine's existing executor once and every
 * buy for an account-bound arm, and every sell of a position opened through
 * an account, goes down the non-custodial path; everything else is untouched
 * and reaches the original executor by identity.
 *
 * In `src/engine/index.ts` this is a one-line change:
 *
 *     const executor = withAccountRouting(
 *       new Executor(ctx, { maxBuysPerMinute: opts.maxBuysPerMinute ?? 6 }),
 *       createAccountExecutor({ ctx, registry }),
 *     )
 *
 * The proxy returns the real Executor for every other property, so the
 * position sweeper and the exit ladder keep working against one object.
 */
export function withAccountRouting(direct: Executor, account: AccountExecutor): Executor {
  return new Proxy(direct, {
    get(target, prop, _receiver) {
      if (prop === 'buy') {
        return (req: BuyRequest): Promise<BuyResult> => (req.arm.accountId ? account.buy(req) : target.buy(req))
      }
      if (prop === 'sell') {
        return (req: SellRequest): Promise<SellResult> => (accountAddressOf(req.position) ? account.sell(req) : target.sell(req))
      }
      const value = Reflect.get(target, prop, target) as unknown
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  })
}

export type { Trade, PolicyTuple }
export { tupleToPolicy }
