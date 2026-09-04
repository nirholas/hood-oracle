/**
 * The only module that signs and broadcasts. executeBuy / executeSell own the
 * guard chain, the idempotency lock, the trade build, the broadcast and the
 * position/trade writes. Simulate mode runs the full path against real quotes
 * and books the fill at the quote with tx 'SIMULATED'; live mode signs and
 * submits to every RPC in parallel, then reads the real fill from the receipt.
 */
import { type Address, type Hash, type Hex, decodeEventLog, encodeFunctionData, formatEther, getAddress, parseEther } from 'viem'
import { and, eq, isNull } from 'drizzle-orm'
import { erc20Abi, odysseyCurveAbi, ROUTER_ADDRESS_THIS, swapRouter02Abi, swapRouter02PaymentsAbi, uniswapV3PoolAbi } from '../chain/abis.js'
import { errorText, withRpcRetry } from '../chain/client.js'
import { submitTransaction, SubmitError } from '../chain/submit.js'
import { getLogsChunked } from '../chain/history.js'
import { erc20TransferEvent } from '../chain/abis.js'
import { toBigInt, toBigIntOrNull } from '../db/client.js'
import { positions, trades } from '../db/schema.js'
import { assessTradeSafety, criticalFirewallReason } from '../guards/firewall.js'
import type { Arm, ExitReason, FeatureSnapshot, FirewallAssessment, GuardVerdict, LaunchRecord, OracleVerdict, Position, Trade, Trigger, Venue } from '../types.js'
import type { EngineContext } from './context.js'
import { sellAmountForFraction, shouldGiveUpReconcile } from './exits.js'
import { spendSnapshot } from './spend.js'
import type { AbiEvent } from 'viem'

export interface BuyRequest {
  arm: Arm
  launch: LaunchRecord
  venue: Venue
  pool: Address | null
  factory: Address | null
  trigger: Trigger
  snapshot: FeatureSnapshot | null
  verdict: OracleVerdict | null
  /** Why the gate let this through (journaled). */
  gateDetail: string
}

export type BuyResult =
  | { status: 'filled'; position: Position; trade: Trade }
  | { status: 'refused'; verdict: GuardVerdict; firewall?: FirewallAssessment }
  | { status: 'failed'; error: string }

export interface SellRequest {
  position: Position
  arm: Arm
  reason: ExitReason
  /** Fraction of the current bag to sell, (0, 1]. */
  fraction: number
  recoversInitials?: boolean
  keepsMoonbag?: boolean
  /** Current pool for a graduated curve position, when the sweeper already resolved it. */
  pool?: Address | null
}

export type SellResult =
  | { status: 'filled'; trade: Trade; position: Position }
  | { status: 'reconcile_pending'; position: Position }
  | { status: 'closed_unknown'; position: Position }
  | { status: 'failed'; error: string }

const RECONCILE_GIVE_UP_MS = 6 * 60 * 60 * 1000
const MAX_UINT = 2n ** 256n - 1n
const swapEvent = uniswapV3PoolAbi.find((x) => x.type === 'event' && x.name === 'Swap') as AbiEvent

/** Sliding 60s window of global buys. */
export class BuyThrottle {
  private readonly hits: number[] = []
  constructor(private readonly maxPerMinute: number) {}
  tryConsume(now = Date.now()): boolean {
    if (this.maxPerMinute <= 0) return true
    while (this.hits.length && now - this.hits[0]! > 60_000) this.hits.shift()
    if (this.hits.length >= this.maxPerMinute) return false
    this.hits.push(now)
    return true
  }
}

export class Executor {
  private readonly inFlight = new Set<string>()
  private readonly positionLocks = new Map<string, Promise<unknown>>()
  private readonly throttle: BuyThrottle
  private readonly approvedSpenders = new Set<string>()

  constructor(private readonly ctx: EngineContext, opts: { maxBuysPerMinute?: number } = {}) {
    this.throttle = new BuyThrottle(opts.maxBuysPerMinute ?? 6)
  }

  // ── buy ───────────────────────────────────────────────────────────────────

  async buy(req: BuyRequest): Promise<BuyResult> {
    const { arm, launch } = req
    const token = launch.token
    const key = `${token.toLowerCase()}:${arm.id}`
    const tag = { arm: arm.label, token, venue: req.venue, mode: arm.mode }
    const refuse = async (verdict: GuardVerdict, firewall?: FirewallAssessment): Promise<BuyResult> => {
      this.ctx.log.info({ ...tag, reason: verdict.reason, detail: verdict.detail }, 'buy refused')
      await this.ctx.journal.append({ armId: arm.id, token, kind: 'refused', reason: verdict.reason ?? 'refused', detail: { detail: verdict.detail, trigger: req.trigger, venue: req.venue, ...(firewall ? { firewall: { verdict: firewall.verdict, score: firewall.score } } : {}) } })
      return { status: 'refused', verdict, ...(firewall ? { firewall } : {}) }
    }

    if (this.inFlight.has(key)) return { status: 'refused', verdict: { ok: false, reason: 'concurrency', detail: 'a buy for this token and arm is already in flight' } }
    this.inFlight.add(key)
    try {
      if (this.ctx.kill.isKilled()) return refuse({ ok: false, reason: 'kill_switch', detail: this.ctx.kill.reason() ?? 'engine kill switch' })
      if (arm.mode === 'live' && !this.ctx.chain.account) return refuse({ ok: false, reason: 'disarmed', detail: 'arm is live but TRADER_PRIVATE_KEY is not configured' })
      if (req.venue === 'curve' && req.factory && req.factory.toLowerCase() === this.ctx.chain.addresses.odysseyReflection.toLowerCase()) {
        return refuse({ ok: false, reason: 'no_route', detail: 'reflection-factory tokens graduate to a Uniswap v4 pool that SwapRouter02 cannot exit; observe only' })
      }
      if (req.venue === 'v4') return refuse({ ok: false, reason: 'no_route', detail: 'the token trades on a Uniswap v4 pool; the executor routes SwapRouter02 (v3) only' })
      if (req.venue === 'pool' && !req.pool) return refuse({ ok: false, reason: 'no_route', detail: 'no pool known for this token yet' })
      if (req.venue === 'curve' && !req.factory) return refuse({ ok: false, reason: 'no_route', detail: 'no Odyssey curve found for this token' })
      const amountWei = arm.perTradeWei
      if (amountWei <= 0n) return refuse({ ok: false, reason: 'zero_amount', detail: 'per_trade_wei is zero' })

      // Already holding it for this arm? The DB unique index is the last line; this is the fast one.
      const existing = await this.ctx.db.select({ id: positions.id }).from(positions)
        .where(and(eq(positions.armId, arm.id), eq(positions.token, token.toLowerCase()), isNull(positions.closedAt))).limit(1)
      if (existing.length) return refuse({ ok: false, reason: 'concurrency', detail: 'this arm already holds an open position in the token' })

      if (!this.throttle.tryConsume()) return refuse({ ok: false, reason: 'cooldown', detail: 'global buys-per-minute throttle' })

      // Wallet and spend facts for the risk engine.
      const minWalletWei = parseEther(String(this.ctx.config.minWalletEth))
      let walletWei: bigint
      if (arm.mode === 'live') {
        try {
          walletWei = await withRpcRetry(() => this.ctx.chain.publicClient.getBalance({ address: this.ctx.chain.account!.address }))
        } catch (err) {
          return refuse({ ok: false, reason: 'wallet_floor', detail: `wallet balance unreadable: ${errorText(err)}` })
        }
        if (walletWei - amountWei < minWalletWei) return refuse({ ok: false, reason: 'wallet_floor', detail: `wallet ${formatEther(walletWei)} ETH cannot spend ${formatEther(amountWei)} and keep the ${this.ctx.config.minWalletEth} ETH floor` })
      } else {
        // Paper wallet: a simulated arm is sized by its budget, not by a balance.
        walletWei = amountWei + minWalletWei
      }
      const spend = await spendSnapshot(this.ctx.db, arm.id)

      // Quote and price impact vs spot. Unpriceable is a refusal, never a guess.
      const quoted = await this.quoteBuy(req, amountWei)
      if (!quoted) return refuse({ ok: false, reason: 'no_route', detail: 'the venue could not quote this buy' })
      if (quoted.impactPct == null) return refuse({ ok: false, reason: 'price_impact', detail: 'spot price unavailable, price impact cannot be measured' })
      if (req.venue === 'curve' && quoted.willGraduate) return refuse({ ok: false, reason: 'no_route', detail: 'this buy would complete the curve; the position would open on an unpriced pool' })

      const risk = this.ctx.risk.check({
        side: 'buy', arm, amountWei, walletWei, minWalletWei,
        spentTodayWei: spend.spentTodayWei, realizedLossTodayWei: spend.realizedLossTodayWei,
        openPositions: spend.openPositions, lastTradeAt: spend.lastTradeAt ? spend.lastTradeAt.getTime() : null,
        slippageBps: arm.slippageBps, priceImpactPct: quoted.impactPct, killed: this.ctx.kill.isKilled(),
      })
      if (!risk.ok) return refuse(risk)

      // Firewall: a real simulated round trip before any live broadcast.
      let firewall: FirewallAssessment | null = null
      if (arm.firewallLevel !== 'off') {
        firewall = await assessTradeSafety({
          chain: this.ctx.chain, prices: this.ctx.prices, log: this.ctx.log, db: this.ctx.db, network: this.ctx.network,
          token, venue: req.venue, pool: req.pool, factory: req.factory, amountWei, deployer: launch.creator,
        })
        const critical = criticalFirewallReason(firewall)
        if (arm.firewallLevel === 'block' && (firewall.verdict === 'block' || critical)) {
          const why = firewall.checks.find((c) => c.status === 'fail')?.reason ?? firewall.checks.find((c) => c.status === 'unavailable')?.reason ?? `firewall score ${firewall.score}`
          return refuse({ ok: false, reason: 'firewall', detail: why }, firewall)
        }
        if (firewall.verdict !== 'allow') this.ctx.log.warn({ ...tag, score: firewall.score, verdict: firewall.verdict }, 'firewall warned, proceeding at arm firewall_level')
      }

      // Fill.
      let fill: { tokenAmount: bigint; entryWei: bigint; txHash: Hash | 'SIMULATED'; gasWei: bigint | null; meta: Record<string, unknown> }
      if (arm.mode === 'simulate') {
        fill = { tokenAmount: quoted.amountOut, entryWei: quoted.spendWei, txHash: 'SIMULATED', gasWei: null, meta: { fillPrice: 'quote_mid' } }
      } else {
        try {
          fill = await this.liveBuy(req, amountWei, quoted)
        } catch (err) {
          const detail = err instanceof SubmitError ? `${err.stage}: ${err.message}` : errorText(err)
          this.ctx.log.error({ ...tag, err: detail }, 'live buy failed')
          await this.ctx.journal.append({ armId: arm.id, token, kind: 'error', reason: 'buy_failed', detail: { detail, hash: err instanceof SubmitError ? err.hash : null } })
          return { status: 'failed', error: detail }
        }
      }
      if (fill.tokenAmount <= 0n) {
        await this.ctx.journal.append({ armId: arm.id, token, kind: 'error', reason: 'buy_zero_fill', detail: { txHash: fill.txHash } })
        return { status: 'failed', error: 'the buy landed but delivered zero tokens' }
      }

      const now = new Date()
      const meta: Record<string, unknown> = {
        venue: req.venue, pool: req.pool, factory: req.factory, trigger: req.trigger,
        priceImpactPct: quoted.impactPct, quotedOut: quoted.amountOut.toString(), originalEntryWei: fill.entryWei.toString(),
        firewall: firewall ? { verdict: firewall.verdict, score: firewall.score, roundTripLossPct: firewall.roundTripLossPct } : null,
        symbol: launch.symbol, name: launch.name, launchpad: launch.launchpad, ...fill.meta,
      }
      const [row] = await this.ctx.db.insert(positions).values({
        armId: arm.id, token: token.toLowerCase(), network: this.ctx.network, launchpad: launch.launchpad, venue: req.venue, mode: arm.mode, status: 'open',
        entryWei: fill.entryWei.toString(), tokenAmount: fill.tokenAmount.toString(), tokenDecimals: launch.decimals, buyTx: fill.txHash,
        openedAt: now, peakValueWei: fill.entryWei.toString(), lastValueWei: fill.entryWei.toString(), oracleScoreAtEntry: req.verdict?.score ?? null, meta,
      }).returning()
      const position = rowToPosition(row!)
      const [tradeRow] = await this.ctx.db.insert(trades).values({
        armId: arm.id, positionId: position.id, token: token.toLowerCase(), network: this.ctx.network, side: 'buy', mode: arm.mode, venue: req.venue,
        amountIn: fill.entryWei.toString(), amountOut: fill.tokenAmount.toString(), txHash: fill.txHash, gasWei: fill.gasWei?.toString() ?? null,
        priceImpactPct: quoted.impactPct, slippageBps: arm.slippageBps, at: now, meta: { trigger: req.trigger, gate: req.gateDetail },
      }).returning()
      const trade = rowToTrade(tradeRow!)
      await this.ctx.journal.append({ armId: arm.id, token, kind: 'buy', reason: req.trigger, detail: {
        gate: req.gateDetail, entryWei: fill.entryWei, tokenAmount: fill.tokenAmount, txHash: fill.txHash, venue: req.venue, priceImpactPct: quoted.impactPct,
        oracleScore: req.verdict?.score ?? null, oracleTier: req.verdict?.tier ?? null, firewall: meta.firewall, positionId: position.id,
      } })
      this.ctx.bus.emit({ kind: 'trade', at: now.getTime(), trade })
      this.ctx.bus.emit({ kind: 'position', at: now.getTime(), position })
      this.ctx.alerts.buy({ armLabel: arm.label, token, symbol: launch.symbol, ethIn: formatEther(fill.entryWei), mode: arm.mode, score: req.verdict?.score ?? null, chatId: arm.telegramChatId })
      this.ctx.log.info({ ...tag, entryWei: fill.entryWei.toString(), tokens: fill.tokenAmount.toString(), tx: fill.txHash }, 'buy filled')
      return { status: 'filled', position, trade }
    } finally {
      this.inFlight.delete(key)
    }
  }

  private async quoteBuy(req: BuyRequest, amountWei: bigint): Promise<{ amountOut: bigint; spendWei: bigint; impactPct: number | null; willGraduate: boolean; fee: number | null } | null> {
    const { token, decimals } = req.launch
    if (req.venue === 'pool') {
      const q = await this.ctx.prices.poolQuoteBuy(req.pool!, token, amountWei)
      if (!q) return null
      const spot = await this.ctx.prices.poolSpotEth(req.pool!, token, decimals)
      return { amountOut: q.amountOut, spendWei: amountWei, impactPct: impactFromSpot(amountWei, q.amountOut, decimals, spot), willGraduate: false, fee: q.fee }
    }
    const q = await this.ctx.prices.curveQuoteBuy(req.factory!, token, amountWei)
    if (!q) return null
    const spot = await this.ctx.prices.curveSpotEth(token, req.factory!)
    return { amountOut: q.tokensOut, spendWei: q.totalIn, impactPct: impactFromSpot(q.totalIn, q.tokensOut, decimals, spot), willGraduate: q.willGraduate, fee: null }
  }

  private async liveBuy(req: BuyRequest, amountWei: bigint, quoted: { amountOut: bigint; fee: number | null }): Promise<{ tokenAmount: bigint; entryWei: bigint; txHash: Hash; gasWei: bigint; meta: Record<string, unknown> }> {
    const { chain } = this.ctx
    const account = chain.account!
    const token = req.launch.token
    const minOut = (quoted.amountOut * BigInt(10_000 - req.arm.slippageBps)) / 10_000n
    let to: Address
    let data: Hex
    if (req.venue === 'pool') {
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 120)
      const inner = encodeFunctionData({ abi: swapRouter02Abi, functionName: 'exactInputSingle', args: [{ tokenIn: chain.addresses.weth, tokenOut: token, fee: quoted.fee ?? 10_000, recipient: account.address, amountIn: amountWei, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }] })
      const refund = encodeFunctionData({ abi: swapRouter02PaymentsAbi, functionName: 'refundETH' })
      to = chain.addresses.router
      data = encodeFunctionData({ abi: swapRouter02Abi, functionName: 'multicall', args: [deadline, [inner, refund]] })
    } else {
      to = req.factory!
      data = encodeFunctionData({ abi: odysseyCurveAbi, functionName: 'buy', args: [token, minOut] })
    }
    const result = await submitTransaction(chain, { to, data, value: amountWei }, { receiptDeadlineMs: 30_000 })
    const tokenAmount = receivedFromLogs(result.receipt.logs, token, account.address)
    let entryWei = amountWei
    if (req.venue === 'curve') {
      // The curve refunds the unspent budget; the Traded log carries what we actually paid.
      for (const log of result.receipt.logs) {
        if (log.address.toLowerCase() !== req.factory!.toLowerCase()) continue
        try {
          const d = decodeEventLog({ abi: odysseyCurveAbi, data: log.data, topics: log.topics, eventName: 'Traded' })
          const a = d.args as { trader: Address; isBuy: boolean; quoteAmount: bigint; fee: bigint }
          if (a.isBuy && a.trader.toLowerCase() === account.address.toLowerCase()) entryWei = a.quoteAmount + a.fee
        } catch {
          // not a Traded log
        }
      }
    }
    // Pre-approve the exit venue right away so every later sell is a single transaction.
    const spender = req.venue === 'pool' ? chain.addresses.router : req.factory!
    const approvalTx = await this.ensureApproval(token, spender)
    return { tokenAmount, entryWei, txHash: result.hash, gasWei: result.gasWei, meta: { acceptMs: result.acceptMs, confirmMs: result.confirmMs, acceptedBy: result.acceptedBy, approvalTx } }
  }

  /** One-time max approval per (token, spender); returns the approval tx hash or null when it was already in place. */
  private async ensureApproval(token: Address, spender: Address): Promise<Hash | null> {
    const { chain } = this.ctx
    const account = chain.account!
    const key = `${token.toLowerCase()}:${spender.toLowerCase()}`
    if (this.approvedSpenders.has(key)) return null
    const allowance = await withRpcRetry(() => chain.publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [account.address, spender] }))
    if (allowance >= MAX_UINT / 2n) {
      this.approvedSpenders.add(key)
      return null
    }
    const data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, MAX_UINT] })
    const res = await submitTransaction(chain, { to: token, data }, { receiptDeadlineMs: 30_000 })
    this.approvedSpenders.add(key)
    return res.hash
  }

  // ── sell ──────────────────────────────────────────────────────────────────

  sell(req: SellRequest): Promise<SellResult> {
    return this.withPositionLock(req.position.id, () => this.sellLocked(req))
  }

  private async sellLocked(req: SellRequest): Promise<SellResult> {
    const { arm, reason } = req
    let position = req.position
    const token = position.token
    const tag = { arm: arm.label, token, reason, mode: position.mode, fraction: req.fraction }
    if (position.status === 'closed') return { status: 'failed', error: 'position is already closed' }
    const total = position.tokenAmount
    let { amount: sellAmount, ppm, partial } = sellAmountForFraction(total, req.fraction)
    const retainsMoonbag = req.keepsMoonbag === true && partial && !req.recoversInitials

    const venue: Venue = position.venue
    const pool = req.pool ?? (typeof position.meta.pool === 'string' ? getAddress(position.meta.pool) : null)
    const factory = typeof position.meta.factory === 'string' ? getAddress(position.meta.factory) : null

    // Live: the chain is the source of truth for what we still hold.
    if (position.mode === 'live' && this.ctx.chain.account) {
      let realBalance: bigint | null = null
      try {
        realBalance = await withRpcRetry(() => this.ctx.chain.publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [this.ctx.chain.account!.address] }))
      } catch (err) {
        this.ctx.log.warn({ ...tag, err: errorText(err) }, 'balance read failed before sell; selling the recorded amount')
      }
      if (realBalance !== null && realBalance === 0n) return this.reconcileVanished(position, arm, reason)
      if (realBalance !== null && realBalance < sellAmount) {
        this.ctx.log.warn({ ...tag, recorded: sellAmount.toString(), real: realBalance.toString() }, 'sell clamped to the real wallet balance')
        sellAmount = realBalance
        partial = false
        ppm = 1_000_000n
      }
    }

    let quoteOut: bigint | null
    if (venue === 'pool') {
      if (!pool) return { status: 'failed', error: 'no pool recorded for this position' }
      quoteOut = await this.ctx.prices.poolQuoteSell(pool, token, sellAmount)
    } else {
      if (!factory) return { status: 'failed', error: 'no curve factory recorded for this position' }
      quoteOut = await this.ctx.prices.curveQuoteSell(factory, token, sellAmount)
    }
    if (quoteOut == null) return { status: 'failed', error: 'the venue could not quote the sell (transient, or the curve completed)' }

    let fill: { ethOut: bigint; txHash: Hash | 'SIMULATED'; gasWei: bigint | null }
    if (position.mode === 'simulate') {
      fill = { ethOut: quoteOut, txHash: 'SIMULATED', gasWei: null }
    } else {
      try {
        fill = await this.liveSell({ token, venue, pool, factory, amount: sellAmount, minOut: (quoteOut * BigInt(10_000 - arm.slippageBps)) / 10_000n })
      } catch (err) {
        const detail = err instanceof SubmitError ? `${err.stage}: ${err.message}` : errorText(err)
        this.ctx.log.error({ ...tag, err: detail }, 'live sell failed')
        await this.ctx.journal.append({ armId: arm.id, token, kind: 'error', reason: 'sell_failed', detail: { detail, positionId: position.id, exitReason: reason } })
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

    if (partial && !retainsMoonbag) {
      // Take-initials: the position stays open with the remainder and a scaled cost basis; the peak resets to the bag's value.
      const remaining = total - sellAmount
      const remainingEntry = entryFull - soldCostBasis
      const remainingValue = sellAmount > 0n ? (fill.ethOut * remaining) / sellAmount : 0n
      const [row] = await this.ctx.db.update(positions).set({
        tokenAmount: remaining.toString(), entryWei: remainingEntry.toString(), initialsRecovered: req.recoversInitials === true || position.initialsRecovered,
        peakValueWei: remainingValue.toString(), lastValueWei: remainingValue.toString(), staleSince: null, realizedPnlWei: cumRealized.toString(), realizedPnlPct: realizedPct,
        meta: { ...position.meta, initialsTx: fill.txHash, initialsAt: now.toISOString() },
      }).where(eq(positions.id, position.id)).returning()
      position = rowToPosition(row!)
    } else {
      const remaining = retainsMoonbag ? total - sellAmount : 0n
      const [row] = await this.ctx.db.update(positions).set({
        status: 'closed', closedAt: now, sellTx: fill.txHash, exitReason: reason, realizedPnlWei: cumRealized.toString(), realizedPnlPct: realizedPct,
        lastValueWei: fill.ethOut.toString(), staleSince: null,
        meta: { ...position.meta, ...(retainsMoonbag ? { moonbagTokens: remaining.toString(), moonbagKept: true } : {}), closedBy: reason },
      }).where(eq(positions.id, position.id)).returning()
      position = rowToPosition(row!)
    }

    const [tradeRow] = await this.ctx.db.insert(trades).values({
      armId: arm.id, positionId: position.id, token: token.toLowerCase(), network: this.ctx.network, side: 'sell', mode: position.mode, venue,
      amountIn: sellAmount.toString(), amountOut: fill.ethOut.toString(), txHash: fill.txHash, gasWei: fill.gasWei?.toString() ?? null,
      priceImpactPct: null, slippageBps: arm.slippageBps, at: now, meta: { exitReason: reason, fraction: req.fraction, legPnlWei: legPnl.toString(), recoversInitials: req.recoversInitials === true, keepsMoonbag: retainsMoonbag },
    }).returning()
    const trade = rowToTrade(tradeRow!)
    await this.ctx.journal.append({ armId: arm.id, token, kind: 'sell', reason, detail: {
      positionId: position.id, fraction: req.fraction, soldTokens: sellAmount, ethOut: fill.ethOut, legPnlWei: legPnl, cumRealizedWei: cumRealized, realizedPct, txHash: fill.txHash,
      recoversInitials: req.recoversInitials === true, keepsMoonbag: retainsMoonbag, status: position.status,
    } })
    this.ctx.bus.emit({ kind: 'trade', at: now.getTime(), trade })
    this.ctx.bus.emit({ kind: 'position', at: now.getTime(), position })
    const legPct = soldCostBasis > 0n ? Number((legPnl * 10_000n) / soldCostBasis) / 100 : null
    this.ctx.alerts.sell({ armLabel: arm.label, token, symbol: (position.meta.symbol as string | null) ?? null, reason, pnlPct: legPct, ethOut: formatEther(fill.ethOut), mode: position.mode, fraction: req.fraction, chatId: arm.telegramChatId })
    this.ctx.log.info({ ...tag, ethOut: fill.ethOut.toString(), legPnlWei: legPnl.toString(), tx: fill.txHash, status: position.status }, 'sell filled')
    return { status: 'filled', trade, position }
  }

  private async liveSell(p: { token: Address; venue: Venue; pool: Address | null; factory: Address | null; amount: bigint; minOut: bigint }): Promise<{ ethOut: bigint; txHash: Hash; gasWei: bigint }> {
    const { chain } = this.ctx
    const account = chain.account!
    let to: Address
    let data: Hex
    if (p.venue === 'pool') {
      const info = await this.ctx.prices.pool(p.pool!)
      const spender = chain.addresses.router
      await this.ensureApproval(p.token, spender)
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 120)
      const inner = encodeFunctionData({ abi: swapRouter02Abi, functionName: 'exactInputSingle', args: [{ tokenIn: p.token, tokenOut: chain.addresses.weth, fee: info.fee, recipient: ROUTER_ADDRESS_THIS, amountIn: p.amount, amountOutMinimum: p.minOut, sqrtPriceLimitX96: 0n }] })
      const unwrap = encodeFunctionData({ abi: swapRouter02PaymentsAbi, functionName: 'unwrapWETH9', args: [p.minOut, account.address] })
      to = spender
      data = encodeFunctionData({ abi: swapRouter02Abi, functionName: 'multicall', args: [deadline, [inner, unwrap]] })
    } else {
      await this.ensureApproval(p.token, p.factory!)
      to = p.factory!
      data = encodeFunctionData({ abi: odysseyCurveAbi, functionName: 'sell', args: [p.token, p.amount, p.minOut] })
    }
    const result = await submitTransaction(chain, { to, data }, { receiptDeadlineMs: 30_000 })
    let ethOut = 0n
    for (const log of result.receipt.logs) {
      if (p.venue === 'pool' && p.pool && log.address.toLowerCase() === p.pool.toLowerCase()) {
        try {
          const d = decodeEventLog({ abi: [swapEvent], data: log.data, topics: log.topics })
          const a = d.args as unknown as { amount0: bigint; amount1: bigint }
          const info = await this.ctx.prices.pool(p.pool)
          const wethDelta = info.token0.toLowerCase() === chain.addresses.weth.toLowerCase() ? a.amount0 : a.amount1
          if (wethDelta < 0n) ethOut += -wethDelta
        } catch {
          // not a Swap log
        }
      }
      if (p.venue === 'curve' && p.factory && log.address.toLowerCase() === p.factory.toLowerCase()) {
        try {
          const d = decodeEventLog({ abi: odysseyCurveAbi, data: log.data, topics: log.topics, eventName: 'Traded' })
          const a = d.args as { trader: Address; isBuy: boolean; quoteAmount: bigint; fee: bigint }
          if (!a.isBuy && a.trader.toLowerCase() === account.address.toLowerCase()) ethOut += a.quoteAmount - a.fee
        } catch {
          // not a Traded log
        }
      }
    }
    return { ethOut, txHash: result.hash, gasWei: result.gasWei }
  }

  /**
   * The wallet holds none of the token the position says it holds. Find the
   * transfer that emptied it; if it is found the position closes with unknown
   * proceeds (never invented), otherwise it parks as reconcile_pending until
   * history catches up or the give-up bound frees the slot.
   */
  private async reconcileVanished(position: Position, arm: Arm, reason: ExitReason): Promise<SellResult> {
    const { chain } = this.ctx
    const account = chain.account!
    const pendingSince = position.meta.reconcilePendingSince ? new Date(position.meta.reconcilePendingSince as string) : null
    let emptiedBy: Hash | null = null
    try {
      const head = await chain.publicClient.getBlockNumber()
      const fromBlock = toBigInt((position.meta.openedBlock as string | undefined) ?? '0') || (head > 200_000n ? head - 200_000n : 0n)
      const logs = await getLogsChunked(chain.publicClient, { address: position.token, event: erc20TransferEvent as AbiEvent, args: { from: account.address }, fromBlock, toBlock: head }, { chunk: 50_000n })
      emptiedBy = logs.length ? (logs[logs.length - 1]!.transactionHash as Hash) : null
    } catch (err) {
      this.ctx.log.warn({ token: position.token, err: errorText(err) }, 'reconcile history read failed')
    }
    const now = new Date()
    if (emptiedBy) {
      const [row] = await this.ctx.db.update(positions).set({
        status: 'closed', closedAt: now, sellTx: emptiedBy, exitReason: 'error', realizedPnlWei: null, realizedPnlPct: null,
        meta: { ...position.meta, reconciled: 'onchain_transfer', reconcileTx: emptiedBy, intendedExit: reason },
      }).where(eq(positions.id, position.id)).returning()
      const closed = rowToPosition(row!)
      await this.ctx.journal.append({ armId: arm.id, token: position.token, kind: 'sell', reason: 'reconciled_onchain', detail: { positionId: position.id, tx: emptiedBy, proceeds: 'unknown' } })
      this.ctx.bus.emit({ kind: 'position', at: now.getTime(), position: closed })
      return { status: 'closed_unknown', position: closed }
    }
    if (shouldGiveUpReconcile(pendingSince, RECONCILE_GIVE_UP_MS)) {
      const [row] = await this.ctx.db.update(positions).set({
        status: 'closed', closedAt: now, exitReason: 'error', realizedPnlWei: null, realizedPnlPct: null,
        meta: { ...position.meta, reconciled: 'unresolved', intendedExit: reason },
      }).where(eq(positions.id, position.id)).returning()
      const closed = rowToPosition(row!)
      await this.ctx.journal.append({ armId: arm.id, token: position.token, kind: 'error', reason: 'reconcile_unresolved', detail: { positionId: position.id, pendingSince } })
      this.ctx.alerts.warn(`reconcile:${position.id}`, `position ${position.id} in ${position.token} closed with unknown proceeds: the bag left the wallet but no transfer was found in ${RECONCILE_GIVE_UP_MS / 3_600_000}h`, arm.telegramChatId)
      this.ctx.bus.emit({ kind: 'position', at: now.getTime(), position: closed })
      return { status: 'closed_unknown', position: closed }
    }
    const [row] = await this.ctx.db.update(positions).set({
      status: 'reconcile_pending',
      meta: { ...position.meta, reconcilePendingSince: (pendingSince ?? now).toISOString(), intendedExit: reason },
    }).where(and(eq(positions.id, position.id), isNull(positions.closedAt))).returning()
    const parked = row ? rowToPosition(row) : position
    this.ctx.bus.emit({ kind: 'position', at: now.getTime(), position: parked })
    return { status: 'reconcile_pending', position: parked }
  }

  private withPositionLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.positionLocks.get(id) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    this.positionLocks.set(id, next.catch(() => undefined))
    next.finally(() => { if (this.positionLocks.get(id) === next) this.positionLocks.delete(id) }).catch(() => undefined)
    return next
  }
}

/** Price impact in percent of an executable fill against the spot mid; null when spot is unknown. */
export function impactFromSpot(spendWei: bigint, amountOut: bigint, decimals: number, spotEthPerToken: number | null): number | null {
  if (spotEthPerToken == null || !(spotEthPerToken > 0) || amountOut <= 0n) return null
  const paidEth = Number(spendWei) / 1e18
  const tokens = Number(amountOut) / 10 ** decimals
  const midCostEth = tokens * spotEthPerToken
  if (!(midCostEth > 0)) return null
  return Math.max(0, (paidEth / midCostEth - 1) * 100)
}

/** Tokens delivered to `to` in a receipt's Transfer logs for `token`. */
export function receivedFromLogs(logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[], token: Address, to: Address): bigint {
  let sum = 0n
  for (const log of logs) {
    if (log.address.toLowerCase() !== token.toLowerCase()) continue
    try {
      const d = decodeEventLog({ abi: [erc20TransferEvent], data: log.data, topics: log.topics as [Hex, ...Hex[]] })
      const a = d.args as unknown as { from: Address; to: Address; value: bigint }
      if (a.to.toLowerCase() === to.toLowerCase()) sum += a.value
      if (a.from.toLowerCase() === to.toLowerCase()) sum -= a.value
    } catch {
      // not a Transfer
    }
  }
  return sum
}

export function rowToPosition(r: typeof positions.$inferSelect): Position {
  return {
    id: r.id, armId: r.armId, token: getAddress(r.token), network: r.network as Position['network'], launchpad: r.launchpad as Position['launchpad'], venue: r.venue as Venue,
    mode: r.mode as Position['mode'], status: r.status as Position['status'], entryWei: toBigInt(r.entryWei), tokenAmount: toBigInt(r.tokenAmount), tokenDecimals: r.tokenDecimals,
    buyTx: r.buyTx as Position['buyTx'], sellTx: r.sellTx as Position['sellTx'], openedAt: r.openedAt, closedAt: r.closedAt, peakValueWei: toBigInt(r.peakValueWei),
    lastValueWei: toBigIntOrNull(r.lastValueWei), staleSince: r.staleSince, initialsRecovered: r.initialsRecovered, realizedPnlWei: toBigIntOrNull(r.realizedPnlWei),
    realizedPnlPct: r.realizedPnlPct, exitReason: r.exitReason as ExitReason | null, oracleScoreAtEntry: r.oracleScoreAtEntry, meta: r.meta,
  }
}

export function rowToTrade(r: typeof trades.$inferSelect): Trade {
  return {
    id: r.id, armId: r.armId, positionId: r.positionId, token: getAddress(r.token), network: r.network as Trade['network'], side: r.side as Trade['side'], mode: r.mode as Trade['mode'],
    venue: r.venue as Venue, amountIn: toBigInt(r.amountIn), amountOut: toBigInt(r.amountOut), txHash: r.txHash as Trade['txHash'], gasWei: toBigIntOrNull(r.gasWei),
    priceImpactPct: r.priceImpactPct, slippageBps: r.slippageBps, at: r.at, meta: r.meta,
  }
}
