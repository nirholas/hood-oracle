/**
 * The risk engine: the last deterministic gate before any order, simulated or
 * live, reaches the executor. It fails CLOSED. A number it cannot read (a null
 * wallet balance, a quote with no price impact) refuses the buy instead of
 * letting it through, because every one of those nulls has already cost real
 * money somewhere: a null impact once let a sniper buy into a pool with no
 * depth, and an unreadable balance once let an arm attempt a buy it could not
 * pay gas for, fail, and retry on every candidate until the wallet was drained
 * by failed-tx fees.
 *
 * Refusals are ORDERED from cheapest and most fatal (the kill switch) to most
 * specific (caps) so the journaled reason is the most meaningful one, and so
 * the dashboard shows "killed" rather than "over budget" when both are true.
 *
 * Sells are exempt from every exposure cap (per-trade, daily budget, daily
 * loss, concurrency, wallet floor, price impact). Those caps exist to bound
 * how much risk an arm takes ON; refusing a de-risking exit because of one
 * would trap a losing position, which is the exact failure the stop loss is
 * supposed to prevent. Sells still honor the kill switch (an operator halt
 * pauses everything until they look), the cooldown, and the slippage bound.
 *
 * Pure and synchronous: the caller fetches the live numbers (balance, spend,
 * open count, quote) and hands them in, so every branch is unit-testable and
 * the same function rules everywhere.
 */
import { formatEther } from 'viem'
import type { Arm, GuardVerdict, RefusalReason } from '../types.js'

export interface RiskContext {
  side: 'buy' | 'sell'
  arm: Arm
  /** ETH this order would spend (buy) or the value being sold (sell), wei. */
  amountWei: bigint
  /** Live wallet balance, or null when it could not be read. Null refuses a buy. */
  walletWei: bigint | null
  /** Operator floor from MIN_WALLET_ETH: the engine never spends below it. */
  minWalletWei: bigint
  /** ETH this arm has already spent on buys in the trailing 24h. */
  spentTodayWei: bigint
  /** Realized net loss this arm has booked in the trailing 24h, as a positive magnitude (0n when profitable). */
  realizedLossTodayWei: bigint
  openPositions: number
  /** ms epoch of this arm's last executed trade, either side, or null. */
  lastTradeAt: number | null
  /** Slippage bound the order would execute with, bps. */
  slippageBps: number
  /** Quoted price impact, percent. Null means the quote could not price it and a buy is refused. */
  priceImpactPct: number | null
  /** Whether the global kill switch is tripped. */
  killed: boolean
  /** ms epoch; injected for deterministic tests. Defaults to Date.now(). */
  now?: number
}

/**
 * Gas headroom for one round trip on Robinhood Chain (4663), wei.
 *
 * Derivation. Robinhood Chain is an Arbitrum Orbit L2 that pays gas in ETH.
 * A launchpad round trip is an approve (about 50k gas), a buy (a curve buy or
 * a Uniswap v3 exactInputSingle, about 200k) and the eventual sell (another
 * 200k), so 500k gas end to end with margin. Orbit chains floor the L2 base
 * fee at 0.1 gwei, which makes that round trip 0.00005 ETH on a quiet chain;
 * a launch storm is exactly when the base fee spikes, and 2 gwei is the
 * heavy-congestion figure Arbitrum-family chains reach. 500,000 gas at 2 gwei
 * is 0.001 ETH. The headroom is reserved ON TOP of MIN_WALLET_ETH so the
 * operator floor is never what pays for the exit.
 */
export const GAS_HEADROOM_WEI = 1_000_000_000_000_000n

/**
 * Smallest entry worth placing, wei (0.0001 ETH). Below this the position's
 * own gas is a material fraction of its size and the fill teaches the oracle
 * nothing a bigger one would not.
 */
export const MIN_ENTRY_WEI = 100_000_000_000_000n

/**
 * Realized-loss circuit breaker as a share of the arm's daily budget. The
 * budget already bounds how much can be spent in a day; the breaker exists to
 * stop an arm EARLIER once the day is a proven bleed, so it cannot spend the
 * rest of its budget one losing entry at a time. Half the budget is the
 * default: past that point the arm has lost more than it can win back in the
 * same day at any realistic hit rate.
 */
export const DAILY_LOSS_FRACTION_OF_BUDGET = 0.5

export interface RiskEngineOptions {
  gasHeadroomWei?: bigint
  dailyLossFractionOfBudget?: number
}

const refuse = (reason: RefusalReason, detail: string): GuardVerdict => ({ ok: false, reason, detail })

/** ETH for humans: up to 6 decimals, no trailing zeros. */
export function fmtEth(wei: bigint): string {
  const s = formatEther(wei)
  const [whole, frac = ''] = s.split('.')
  const trimmed = frac.slice(0, 6).replace(/0+$/, '')
  return `${trimmed ? `${whole}.${trimmed}` : whole} ETH`
}

/** Loss limit for an arm: a fixed fraction of its daily budget, wei. */
export function dailyLossLimitWei(arm: Arm, fraction = DAILY_LOSS_FRACTION_OF_BUDGET): bigint {
  const scaled = (arm.dailyBudgetWei * BigInt(Math.round(fraction * 10_000))) / 10_000n
  return scaled < 0n ? 0n : scaled
}

export class RiskEngine {
  private readonly gasHeadroomWei: bigint
  private readonly dailyLossFraction: number

  constructor(opts: RiskEngineOptions = {}) {
    this.gasHeadroomWei = opts.gasHeadroomWei ?? GAS_HEADROOM_WEI
    this.dailyLossFraction = opts.dailyLossFractionOfBudget ?? DAILY_LOSS_FRACTION_OF_BUDGET
  }

  check(ctx: RiskContext): GuardVerdict {
    const now = ctx.now ?? Date.now()
    const { arm } = ctx

    if (ctx.killed) {
      return refuse('kill_switch', 'Kill switch is tripped: no new orders until an operator clears it.')
    }

    if (ctx.amountWei <= 0n) {
      return refuse('zero_amount', 'Order amount is zero: nothing to trade.')
    }

    if (ctx.slippageBps > arm.slippageBps) {
      return refuse(
        'slippage_bound',
        `Order slippage ${ctx.slippageBps} bps is over this arm's ${arm.slippageBps} bps ceiling.`,
      )
    }

    if (ctx.lastTradeAt !== null && arm.cooldownSeconds > 0) {
      const elapsedMs = now - ctx.lastTradeAt
      const remainingMs = arm.cooldownSeconds * 1000 - elapsedMs
      if (remainingMs > 0) {
        return refuse('cooldown', `Cooldown active: ${(remainingMs / 1000).toFixed(1)}s until this arm may trade again.`)
      }
    }

    if (ctx.side === 'sell') {
      return { ok: true, detail: 'Exit allowed: sells are exempt from exposure caps.' }
    }

    if (!arm.enabled || arm.killSwitch) {
      return refuse(
        'disarmed',
        arm.killSwitch
          ? `Arm "${arm.label}" has its own kill switch set: no new buys until it is cleared.`
          : `Arm "${arm.label}" is disarmed: enable it to buy.`,
      )
    }

    if (ctx.openPositions >= arm.maxConcurrentPositions) {
      return refuse(
        'concurrency',
        `${ctx.openPositions} of ${arm.maxConcurrentPositions} allowed positions are open: wait for an exit.`,
      )
    }

    if (arm.perTradeWei <= 0n) {
      return refuse('per_trade_cap', 'Per-trade size is 0 ETH: set per_trade_wei before this arm can buy.')
    }
    if (ctx.amountWei > arm.perTradeWei) {
      return refuse(
        'per_trade_cap',
        `Buy of ${fmtEth(ctx.amountWei)} is over the per-trade cap of ${fmtEth(arm.perTradeWei)}.`,
      )
    }

    if (arm.dailyBudgetWei <= 0n) {
      return refuse('daily_budget', 'Daily budget is 0 ETH: set daily_budget_wei before this arm can buy.')
    }
    const wouldSpend = ctx.spentTodayWei + ctx.amountWei
    if (wouldSpend > arm.dailyBudgetWei) {
      return refuse(
        'daily_budget',
        `Daily spend would reach ${fmtEth(wouldSpend)}, over the ${fmtEth(arm.dailyBudgetWei)} daily budget (${fmtEth(ctx.spentTodayWei)} already spent).`,
      )
    }

    const lossLimit = dailyLossLimitWei(arm, this.dailyLossFraction)
    if (lossLimit > 0n && ctx.realizedLossTodayWei >= lossLimit) {
      return refuse(
        'daily_loss',
        `Realized loss today is ${fmtEth(ctx.realizedLossTodayWei)}, at or past the ${fmtEth(lossLimit)} circuit breaker (${Math.round(this.dailyLossFraction * 100)}% of the daily budget). No new buys until tomorrow.`,
      )
    }

    if (ctx.walletWei === null) {
      return refuse('wallet_floor', 'Wallet balance could not be read: refusing to buy blind.')
    }
    const floor = ctx.minWalletWei + this.gasHeadroomWei
    const remaining = ctx.walletWei - ctx.amountWei
    if (remaining < floor) {
      return refuse(
        'wallet_floor',
        `Wallet holds ${fmtEth(ctx.walletWei)}; a ${fmtEth(ctx.amountWei)} buy would leave ${fmtEth(remaining < 0n ? 0n : remaining)}, under the ${fmtEth(floor)} floor (${fmtEth(ctx.minWalletWei)} reserve plus ${fmtEth(this.gasHeadroomWei)} gas headroom).`,
      )
    }

    if (ctx.priceImpactPct === null) {
      return refuse('price_impact', 'Price impact could not be quoted: refusing to buy into unknown depth.')
    }
    if (!Number.isFinite(ctx.priceImpactPct)) {
      return refuse('price_impact', 'Price impact quote is not a number: refusing to buy into unknown depth.')
    }
    if (ctx.priceImpactPct > arm.maxPriceImpactPct) {
      return refuse(
        'price_impact',
        `Price impact ${ctx.priceImpactPct.toFixed(2)}% is over the ${arm.maxPriceImpactPct}% ceiling: the pool is too thin for this size.`,
      )
    }

    return { ok: true, detail: 'Within every risk limit.' }
  }
}

export type EntrySize = { sizeWei: bigint; shrunk: boolean; detail: string } | { skip: RefusalReason; detail: string }

/**
 * Resolve the entry size a wallet can actually fund, or decide it must sit out.
 *
 * Pure. Two floors apply and they are not the same number:
 *   - `gasHeadroomWei` is what the round trip itself costs (see GAS_HEADROOM_WEI).
 *   - `minWalletWei` is the operator's reserve (MIN_WALLET_ETH): what must be
 *     left after the buy so the exit, the firewall probe and the next day's
 *     gas are never in question.
 *
 * A wallet that can fund a smaller entry than the arm wants gets the smaller
 * entry rather than sitting out (a learning fill beats no fill), but only down
 * to MIN_ENTRY_WEI: below that the position is dust. A wallet that cannot even
 * fund that sits out with `wallet_floor`, and the caller should stop
 * re-attempting on every candidate until the wallet is topped up.
 */
export function resolveEntrySize(
  walletWei: bigint,
  wantWei: bigint,
  minWalletWei: bigint,
  gasHeadroomWei: bigint = GAS_HEADROOM_WEI,
): EntrySize {
  if (wantWei <= 0n) return { skip: 'zero_amount', detail: 'Requested entry is 0 ETH.' }
  const floor = minWalletWei + gasHeadroomWei
  const available = walletWei - floor
  if (available >= wantWei) {
    return { sizeWei: wantWei, shrunk: false, detail: `Funding the full ${fmtEth(wantWei)} entry.` }
  }
  if (available >= MIN_ENTRY_WEI) {
    return {
      sizeWei: available,
      shrunk: true,
      detail: `Wallet can fund ${fmtEth(available)} of the ${fmtEth(wantWei)} entry after the ${fmtEth(floor)} floor: shrinking the buy.`,
    }
  }
  return {
    skip: 'wallet_floor',
    detail: `Wallet holds ${fmtEth(walletWei)}; after the ${fmtEth(floor)} floor only ${fmtEth(available < 0n ? 0n : available)} is free, under the ${fmtEth(MIN_ENTRY_WEI)} minimum entry. Sitting out until topped up.`,
  }
}
