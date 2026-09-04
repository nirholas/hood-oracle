/**
 * The honeypot firewall. Before a buy the token is put through a REAL simulated
 * buy-then-sell round trip (eth_simulateV1 with a funded synthetic sender), and
 * its ERC-20 surface, deployer share and venue liquidity are read. The verdict
 * is structured (0..100, block / warn / allow) and every check carries a
 * plain-language reason. A data source that is unavailable degrades that
 * check to `unavailable` and the verdict to at most `warn`: the firewall never
 * manufactures an `allow`. A token that can be bought but not sold is blocked.
 */
import { type Address, type Hex, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256, parseEther, toHex } from 'viem'
import {
  erc20Abi, erc20ControlProbeAbi, odysseyCurveAbi, odysseyLaunchTokenAbi, ROUTER_ADDRESS_THIS,
  swapRouter02Abi, swapRouter02PaymentsAbi, uniswapV3PoolAbi,
} from '../chain/abis.js'
import type { ChainClient } from '../chain/client.js'
import { errorText, withRpcRetry } from '../chain/client.js'
import type { Prices } from '../chain/prices.js'
import { V4_ADDRESSES, buildV4Buy, buildV4Sell, permit2ApprovalCalls, type V4Pool } from '../chain/v4.js'
import type { Db } from '../db/client.js'
import { firewallDecisions } from '../db/schema.js'
import type { Logger } from '../log.js'
import type { FirewallAssessment, FirewallCheck, FirewallVerdict, Network, Venue } from '../types.js'

export interface FirewallInput {
  chain: ChainClient
  prices: Prices
  log: Logger
  db?: Db
  network: Network
  token: Address
  venue: Venue
  pool: Address | null
  /** Odyssey factory that owns the curve (curve venue only). */
  factory: Address | null
  /** The v4 pool (v4 venue only). */
  v4Pool?: V4Pool | null
  amountWei: bigint
  deployer: Address | null
  /** Round-trip loss cap as a percentage (default 35). */
  maxRoundTripLossPct?: number
  /** Pool quote-side liquidity floor in wei (default 0.05 ETH). */
  minLiquidityWei?: bigint
}

interface RoundTrip {
  check: FirewallCheck
  /** 0..1 loss on the round trip, or null. */
  loss: number | null
  /** 0..1 transfer tax measured on the buy leg, or null. */
  transferTax: number | null
  simulated: boolean
}

const PROBE_SENDER: Address = '0x1111111111111111111111111111111111111111'
const BLOCKSCOUT = 'https://robinhoodchain.blockscout.com'
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

const PENALTY = {
  sim_unavailable: 18,
  round_trip_loss_high: 22,
  transfer_tax: 20,
  owner_controls: 12,
  trading_disabled: 60,
  blacklist_surface: 16,
  max_tx_binding: 14,
  deployer_heavy: 16,
  deployer_dominant: 40,
  liquidity_thin: 14,
  liquidity_unreadable: 10,
  anti_snipe_cap: 8,
} as const

const BLOCK_SCORE = 45
const WARN_SCORE = 70

/** Reasons that mean "safety was NOT proven" rather than "unsafe"; a fail-closed caller treats them as blocks. */
export const CRITICAL_FIREWALL_REASONS: ReadonlySet<string> = new Set(['simulation_unavailable', 'sell_leg_reverted', 'sell_returns_nothing', 'buy_leg_reverted', 'no_venue', 'trading_disabled'])

export function criticalFirewallReason(a: FirewallAssessment): string | null {
  const failed = a.checks.find((c) => c.status === 'fail')
  if (failed) return failed.check
  if (a.checks.some((c) => c.check === 'round_trip' && c.status === 'unavailable')) return 'simulation_unavailable'
  return null
}

const simulateSupport = new WeakMap<ChainClient, boolean>()

const METHOD_UNSUPPORTED = /(method not found|not supported|does not exist|unsupported method|-32601)/i

/**
 * Probe once whether the node speaks eth_simulateV1 and cache the answer per
 * client. Only a definitive "unknown method" caches false: a transient RPC
 * failure leaves the question open so the next assessment probes again
 * instead of silently degrading every future check to the quote-only path.
 */
export async function supportsSimulateV1(chain: ChainClient): Promise<boolean> {
  const cached = simulateSupport.get(chain)
  if (cached !== undefined) return cached
  try {
    const data = encodeFunctionData({ abi: erc20Abi, functionName: 'totalSupply' })
    const res = (await withRpcRetry(() => chain.publicClient.request({
      method: 'eth_simulateV1' as never,
      params: [{ blockStateCalls: [{ calls: [{ to: chain.addresses.weth, data }] }], validation: false }, 'latest'] as never,
    }))) as { calls: { status: string }[] }[]
    const ok = Array.isArray(res) && res[0]?.calls?.[0]?.status === '0x1'
    simulateSupport.set(chain, ok)
    return ok
  } catch (err) {
    if (METHOD_UNSUPPORTED.test(errorText(err))) simulateSupport.set(chain, false)
    return false
  }
}

interface SimCall { from?: Address; to: Address; data: Hex; value?: Hex }
interface SimResult { status: string; returnData: Hex; gasUsed: Hex; error?: { message?: string }; logs?: { address: Address; topics: Hex[]; data: Hex }[] }

/**
 * One eth_simulateV1 block with the probe sender funded. `block` pins the
 * state: the sell leg is sized from the buy leg's result, so both legs must
 * see the same pool state or a tick between them fails the sell for a reason
 * that has nothing to do with the token.
 */
async function simulate(chain: ChainClient, calls: SimCall[], fundWei: bigint, block: Hex | 'latest' = 'latest'): Promise<{ calls: SimResult[]; block: Hex }> {
  const res = (await withRpcRetry(() => chain.publicClient.request({
    method: 'eth_simulateV1' as never,
    params: [{
      blockStateCalls: [{ stateOverrides: { [PROBE_SENDER]: { balance: toHex(fundWei) } }, calls: calls.map((c) => ({ from: PROBE_SENDER, ...c })) }],
      validation: false,
      traceTransfers: false,
    }, block] as never,
  }))) as { number: Hex; calls: SimResult[] }[]
  const simulated = res[0]
  if (!simulated) throw new Error('eth_simulateV1 returned no block')
  // The simulated block is built ON TOP of the requested state; its parent is the state both legs must share.
  const parent = toHex(BigInt(simulated.number) - 1n)
  return { calls: simulated.calls ?? [], block: block === 'latest' ? parent : block }
}

const TRANSFER_TOPIC = keccak256(new TextEncoder().encode('Transfer(address,address,uint256)'))

/** Sum of ERC-20 Transfer amounts of `token` delivered to `to` inside one simulated call's logs. */
function transferredTo(logs: SimResult['logs'], token: Address, to: Address): bigint {
  let sum = 0n
  const want = to.toLowerCase().slice(2).padStart(64, '0')
  for (const l of logs ?? []) {
    if (l.address.toLowerCase() !== token.toLowerCase()) continue
    if (l.topics[0] !== TRANSFER_TOPIC || l.topics.length < 3) continue
    if (l.topics[2]!.slice(2).toLowerCase() !== want) continue
    sum += BigInt(l.data)
  }
  return sum
}

function check(name: string, status: FirewallCheck['status'], reason: string, weight: number): FirewallCheck {
  return { check: name, status, reason, weight }
}

// ── round trip ────────────────────────────────────────────────────────────────

async function roundTripPool(input: FirewallInput): Promise<RoundTrip> {
  const { chain, prices, token, amountWei } = input
  const pool = input.pool!
  const info = await prices.pool(pool)
  const weth = chain.addresses.weth.toLowerCase()
  const quoteToken = info.token0.toLowerCase() === token.toLowerCase() ? info.token1 : info.token0
  if (quoteToken.toLowerCase() !== weth) {
    return { check: check('round_trip', 'unavailable', `The pool is paired with ${quoteToken}, not WETH, so an ETH round trip cannot be simulated.`, PENALTY.sim_unavailable), loss: null, transferTax: null, simulated: false }
  }
  const router = chain.addresses.router
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600)
  const buyInner = encodeFunctionData({ abi: swapRouter02Abi, functionName: 'exactInputSingle', args: [{ tokenIn: chain.addresses.weth, tokenOut: token, fee: info.fee, recipient: PROBE_SENDER, amountIn: amountWei, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }] })
  const refund = encodeFunctionData({ abi: swapRouter02PaymentsAbi, functionName: 'refundETH' })
  const buyData = encodeFunctionData({ abi: swapRouter02Abi, functionName: 'multicall', args: [deadline, [buyInner, refund]] })
  const balData = encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [PROBE_SENDER] })
  const approveData = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [router, 2n ** 256n - 1n] })

  if (await supportsSimulateV1(chain)) {
    let first: { calls: SimResult[]; block: Hex }
    try {
      first = await simulate(chain, [{ to: router, data: buyData, value: toHex(amountWei) }, { to: token, data: balData }], amountWei + parseEther('1'))
    } catch (err) {
      return { check: check('round_trip', 'unavailable', `The round-trip simulation could not run: ${errorText(err)}.`, PENALTY.sim_unavailable), loss: null, transferTax: null, simulated: false }
    }
    const buy = first.calls[0]!
    if (buy.status !== '0x1') {
      return { check: check('round_trip', 'fail', `The simulated buy leg reverted (${buy.error?.message ?? 'no reason'}); this size cannot be bought right now.`, 100), loss: null, transferTax: null, simulated: true }
    }
    const balance = BigInt(first.calls[1]!.returnData === '0x' ? '0x0' : first.calls[1]!.returnData)
    const swapOut = decodeMulticallFirst(buy.returnData)
    const tax = swapOut != null && swapOut > 0n && balance < swapOut ? 1 - Number((balance * 1_000_000n) / swapOut) / 1_000_000 : 0
    if (balance <= 0n) {
      return { check: check('round_trip', 'fail', 'The simulated buy delivered zero tokens to the buyer: the transfer path eats the whole purchase.', 100), loss: null, transferTax: 1, simulated: true }
    }
    const sellInner = encodeFunctionData({ abi: swapRouter02Abi, functionName: 'exactInputSingle', args: [{ tokenIn: token, tokenOut: chain.addresses.weth, fee: info.fee, recipient: ROUTER_ADDRESS_THIS, amountIn: balance, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }] })
    const unwrap = encodeFunctionData({ abi: swapRouter02PaymentsAbi, functionName: 'unwrapWETH9', args: [0n, PROBE_SENDER] })
    const sellData = encodeFunctionData({ abi: swapRouter02Abi, functionName: 'multicall', args: [deadline, [sellInner, unwrap]] })
    let second: { calls: SimResult[]; block: Hex }
    try {
      second = await simulate(chain, [
        { to: router, data: buyData, value: toHex(amountWei) },
        { to: token, data: approveData },
        { to: router, data: sellData },
      ], amountWei + parseEther('1'), first.block)
    } catch (err) {
      return { check: check('round_trip', 'unavailable', `The sell leg simulation could not run: ${errorText(err)}.`, PENALTY.sim_unavailable), loss: null, transferTax: tax, simulated: false }
    }
    const approve = second.calls[1]!
    const sell = second.calls[2]!
    if (approve.status !== '0x1') {
      return { check: check('round_trip', 'fail', `approve() reverted in simulation (${approve.error?.message ?? 'no reason'}); the router can never be allowed to sell.`, 100), loss: null, transferTax: tax, simulated: true }
    }
    if (sell.status !== '0x1') {
      return { check: check('round_trip', 'fail', `The simulated sell leg reverted (${sell.error?.message ?? 'no reason'}): this behaves like a honeypot you cannot exit.`, 100), loss: null, transferTax: tax, simulated: true }
    }
    const ethOut = decodeMulticallFirst(sell.returnData) ?? 0n
    if (ethOut <= 0n) {
      return { check: check('round_trip', 'fail', 'The simulated sell returned no ETH: there is no working exit for this token.', 100), loss: 1, transferTax: tax, simulated: true }
    }
    const loss = 1 - Number((ethOut * 1_000_000n) / amountWei) / 1_000_000
    return { check: check('round_trip', 'pass', `A simulated buy then sell of ${fmtEth(amountWei)} ETH returned ${fmtEth(ethOut)} ETH (${(loss * 100).toFixed(1)}% round-trip cost).`, 0), loss, transferTax: tax, simulated: true }
  }

  // No eth_simulateV1: prove pricing through QuoterV2 and the transfer path through a balance-override transfer call.
  const buyQuote = await prices.poolQuoteBuy(pool, token, amountWei)
  if (!buyQuote) return { check: check('round_trip', 'fail', 'QuoterV2 could not price a buy on this pool: there is no route in.', 100), loss: null, transferTax: null, simulated: false }
  const sellOut = await prices.poolQuoteSell(pool, token, buyQuote.amountOut)
  if (sellOut == null || sellOut <= 0n) return { check: check('round_trip', 'fail', 'QuoterV2 could not price the sell of the tokens a buy would deliver: no exit route.', 100), loss: null, transferTax: null, simulated: false }
  const loss = 1 - Number((sellOut * 1_000_000n) / amountWei) / 1_000_000
  const transfer = await proveTransfer(chain, token, buyQuote.amountOut)
  if (transfer === 'unavailable') {
    return { check: check('round_trip', 'unavailable', `Quotes price a ${(loss * 100).toFixed(1)}% round trip, but the node has no eth_simulateV1 and the token's balance slot was not discoverable, so the transfer path is unproven.`, PENALTY.sim_unavailable), loss, transferTax: null, simulated: false }
  }
  if (transfer === 'reverted') {
    return { check: check('round_trip', 'fail', 'A transfer of the tokens a buy would deliver reverts under a balance override: the token cannot be moved to the router to sell.', 100), loss, transferTax: null, simulated: false }
  }
  return { check: check('round_trip', 'pass', `Quotes price a ${(loss * 100).toFixed(1)}% round trip and a state-override transfer of the bought amount succeeds (no eth_simulateV1 on this node).`, 0), loss, transferTax: transfer, simulated: false }
}

async function roundTripCurve(input: FirewallInput): Promise<RoundTrip> {
  const { chain, prices, token, amountWei } = input
  const factory = input.factory!
  const quote = await prices.curveQuoteBuy(factory, token, amountWei)
  if (!quote) return { check: check('round_trip', 'fail', 'The curve will not sell this size (completed, or the budget buys nothing).', 100), loss: null, transferTax: null, simulated: false }
  const buyData = encodeFunctionData({ abi: odysseyCurveAbi, functionName: 'buy', args: [token, quote.tokensOut] })
  const balData = encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [PROBE_SENDER] })
  const approveData = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [factory, 2n ** 256n - 1n] })
  if (await supportsSimulateV1(chain)) {
    let res: { calls: SimResult[]; block: Hex }
    try {
      res = await simulate(chain, [
        { to: factory, data: buyData, value: toHex(amountWei) },
        { to: token, data: balData },
        { to: token, data: approveData },
      ], amountWei + parseEther('1'))
    } catch (err) {
      return { check: check('round_trip', 'unavailable', `The round-trip simulation could not run: ${errorText(err)}.`, PENALTY.sim_unavailable), loss: null, transferTax: null, simulated: false }
    }
    const buy = res.calls[0]!
    if (buy.status !== '0x1') return { check: check('round_trip', 'fail', `The simulated curve buy reverted (${buy.error?.message ?? 'no reason'}).`, 100), loss: null, transferTax: null, simulated: true }
    const balance = BigInt(res.calls[1]!.returnData === '0x' ? '0x0' : res.calls[1]!.returnData)
    const decoded = decodeFunctionResult({ abi: odysseyCurveAbi, functionName: 'buy', data: buy.returnData })
    const actualOut = decoded[0]
    const tax = actualOut > 0n && balance < actualOut ? 1 - Number((balance * 1_000_000n) / actualOut) / 1_000_000 : 0
    if (balance <= 0n) return { check: check('round_trip', 'fail', 'The simulated curve buy delivered zero tokens.', 100), loss: null, transferTax: 1, simulated: true }
    const sellData = encodeFunctionData({ abi: odysseyCurveAbi, functionName: 'sell', args: [token, balance, 0n] })
    let second: { calls: SimResult[]; block: Hex }
    try {
      second = await simulate(chain, [
        { to: factory, data: buyData, value: toHex(amountWei) },
        { to: token, data: approveData },
        { to: factory, data: sellData },
      ], amountWei + parseEther('1'), res.block)
    } catch (err) {
      return { check: check('round_trip', 'unavailable', `The sell leg simulation could not run: ${errorText(err)}.`, PENALTY.sim_unavailable), loss: null, transferTax: tax, simulated: false }
    }
    const sell = second.calls[2]!
    if (second.calls[1]!.status !== '0x1') return { check: check('round_trip', 'fail', 'approve() to the curve reverted in simulation; the curve can never pull the tokens to sell.', 100), loss: null, transferTax: tax, simulated: true }
    if (sell.status !== '0x1') return { check: check('round_trip', 'fail', `The simulated curve sell reverted (${sell.error?.message ?? 'no reason'}): no exit.`, 100), loss: null, transferTax: tax, simulated: true }
    const userGets = decodeFunctionResult({ abi: odysseyCurveAbi, functionName: 'sell', data: sell.returnData })
    if (userGets <= 0n) return { check: check('round_trip', 'fail', 'The simulated curve sell returned no ETH.', 100), loss: 1, transferTax: tax, simulated: true }
    const loss = 1 - Number((userGets * 1_000_000n) / amountWei) / 1_000_000
    return { check: check('round_trip', 'pass', `A simulated curve buy then sell of ${fmtEth(amountWei)} ETH returned ${fmtEth(userGets)} ETH (${(loss * 100).toFixed(1)}% round-trip cost).`, 0), loss, transferTax: tax, simulated: true }
  }
  const sellOut = await prices.curveQuoteSell(factory, token, quote.tokensOut)
  if (sellOut == null || sellOut <= 0n) return { check: check('round_trip', 'fail', 'The curve cannot quote a sell of what a buy would deliver.', 100), loss: null, transferTax: null, simulated: false }
  const loss = 1 - Number((sellOut * 1_000_000n) / amountWei) / 1_000_000
  const transfer = await proveTransfer(chain, token, quote.tokensOut)
  if (transfer === 'unavailable') return { check: check('round_trip', 'unavailable', `Curve quotes price a ${(loss * 100).toFixed(1)}% round trip, but the transfer path is unproven (no eth_simulateV1, balance slot not found).`, PENALTY.sim_unavailable), loss, transferTax: null, simulated: false }
  if (transfer === 'reverted') return { check: check('round_trip', 'fail', 'A transfer of the tokens a curve buy would deliver reverts under a balance override.', 100), loss, transferTax: null, simulated: false }
  return { check: check('round_trip', 'pass', `Curve quotes price a ${(loss * 100).toFixed(1)}% round trip and a state-override transfer succeeds.`, 0), loss, transferTax: transfer, simulated: false }
}

const getEthBalanceAbi = [{ type: 'function', name: 'getEthBalance', stateMutability: 'view', inputs: [{ name: 'addr', type: 'address' }], outputs: [{ name: 'balance', type: 'uint256' }] }] as const

/**
 * v4 round trip through the UniversalRouter: buy, then (in a second
 * simulation pinned to the same block) buy, Permit2 approvals, sell. The
 * quote moved is measured on the probe sender itself (Multicall3
 * getEthBalance for native and WETH pools, whose sells unwrap to ETH; USDG
 * balance for USDG pools, whose probe balance is a storage override on a
 * discovered slot), so a hook tax lands in the loss figure exactly.
 */
async function roundTripV4(input: FirewallInput): Promise<RoundTrip> {
  const { chain, prices, token, amountWei } = input
  const pool = input.v4Pool!
  const ethUsd = pool.quoteSide === 'usdg' ? await prices.ethUsd() : null
  const budget = pool.quoteSide === 'usdg' ? (ethUsd && ethUsd > 0 ? (amountWei * BigInt(Math.round(ethUsd * 1_000_000))) / (1_000_000_000_000n * 1_000_000n) : null) : amountWei
  if (budget == null || budget <= 0n) return { check: check('round_trip', 'unavailable', 'The USDG budget could not be denominated (no ETH/USD reading).', PENALTY.sim_unavailable), loss: null, transferTax: null, simulated: false }
  if (!(await supportsSimulateV1(chain))) {
    const q = await prices.v4.quoteBuy(pool, budget)
    if (!q) return { check: check('round_trip', 'fail', 'The v4 quoter cannot price a buy on this pool.', 100), loss: null, transferTax: null, simulated: false }
    const back = await prices.v4.quoteSell(pool, q.amountOut)
    if (back == null || back <= 0n) return { check: check('round_trip', 'fail', 'The v4 quoter cannot price the sell of what a buy would deliver (the pool cannot absorb it, or the hook refuses).', 100), loss: null, transferTax: null, simulated: false }
    const loss = 1 - Number((back * 1_000_000n) / budget) / 1_000_000
    return { check: check('round_trip', 'unavailable', `Independent quotes price a ${(loss * 100).toFixed(1)}% round trip, but the node has no eth_simulateV1 so the buy-then-sell sequence is unproven.`, PENALTY.sim_unavailable), loss, transferTax: null, simulated: false }
  }
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600)
  const buy = buildV4Buy(pool, budget, 0n, deadline)
  const balData = encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [PROBE_SENDER] })
  const quoteBalance: SimCall = pool.quoteSide === 'usdg'
    ? { to: pool.quote, data: balData }
    : { to: chain.addresses.multicall3, data: encodeFunctionData({ abi: getEthBalanceAbi, functionName: 'getEthBalance', args: [PROBE_SENDER] }) }
  let overrides: Record<string, { balance?: Hex; stateDiff?: Record<Hex, Hex> }> = { [PROBE_SENDER]: { balance: toHex(parseEther('1')) } }
  let usdgApprovals: SimCall[] = []
  if (pool.quoteSide === 'usdg') {
    const slot = await findBalanceSlot(chain, pool.quote, PROBE_SENDER)
    if (!slot) return { check: check('round_trip', 'unavailable', 'The USDG balance slot could not be discovered, so a funded USDG round trip cannot be simulated.', PENALTY.sim_unavailable), loss: null, transferTax: null, simulated: false }
    overrides = { ...overrides, [pool.quote]: { stateDiff: { [slot]: toHex(budget * 2n, { size: 32 }) } } }
    usdgApprovals = permit2ApprovalCalls(pool.quote).map((c) => ({ to: c.to, data: c.data }))
  }
  const buyCall: SimCall = { to: buy.to, data: buy.data, value: toHex(buy.value) }
  let first: { calls: SimResult[]; block: Hex }
  try {
    first = await simulateWith(chain, [...usdgApprovals, buyCall, { to: token, data: balData }], overrides, 'latest')
  } catch (err) {
    return { check: check('round_trip', 'unavailable', `The v4 round-trip simulation could not run: ${errorText(err)}.`, PENALTY.sim_unavailable), loss: null, transferTax: null, simulated: false }
  }
  const buyRes = first.calls[usdgApprovals.length]!
  if (buyRes.status !== '0x1') return { check: check('round_trip', 'fail', `The simulated v4 buy reverted (${buyRes.error?.message ?? 'no reason'}); this size cannot be bought right now.`, 100), loss: null, transferTax: null, simulated: true }
  const balance = BigInt(first.calls[usdgApprovals.length + 1]!.returnData === '0x' ? '0x0' : first.calls[usdgApprovals.length + 1]!.returnData)
  if (balance <= 0n) return { check: check('round_trip', 'fail', 'The simulated v4 buy delivered zero tokens to the buyer.', 100), loss: null, transferTax: 1, simulated: true }
  const quoted = await prices.v4.quoteBuy(pool, budget)
  const tax = quoted && quoted.amountOut > 0n && balance < quoted.amountOut ? 1 - Number((balance * 1_000_000n) / quoted.amountOut) / 1_000_000 : 0
  const sell = buildV4Sell(pool, balance, 0n, deadline)
  const tokenApprovals = permit2ApprovalCalls(token).map((c) => ({ to: c.to, data: c.data }))
  let second: { calls: SimResult[]; block: Hex }
  try {
    second = await simulateWith(chain, [...usdgApprovals, quoteBalance, buyCall, ...tokenApprovals, quoteBalance, { to: sell.to, data: sell.data }, quoteBalance], overrides, first.block)
  } catch (err) {
    return { check: check('round_trip', 'unavailable', `The v4 sell leg simulation could not run: ${errorText(err)}.`, PENALTY.sim_unavailable), loss: null, transferTax: tax, simulated: false }
  }
  const base = usdgApprovals.length
  const sellRes = second.calls[base + 2 + tokenApprovals.length + 1]!
  for (let i = base + 2; i < base + 2 + tokenApprovals.length; i++) {
    if (second.calls[i]!.status !== '0x1') return { check: check('round_trip', 'fail', `A Permit2 approval reverted in simulation (${second.calls[i]!.error?.message ?? 'no reason'}); the router can never pull the tokens to sell.`, 100), loss: null, transferTax: tax, simulated: true }
  }
  if (sellRes.status !== '0x1') return { check: check('round_trip', 'fail', `The simulated v4 sell reverted (${sellRes.error?.message ?? 'no reason'}): this behaves like a honeypot you cannot exit.`, 100), loss: null, transferTax: tax, simulated: true }
  const before = BigInt(second.calls[base]!.returnData)
  const afterBuy = BigInt(second.calls[base + 2 + tokenApprovals.length]!.returnData)
  const afterSell = BigInt(second.calls[base + 2 + tokenApprovals.length + 2]!.returnData)
  const spent = before - afterBuy
  const received = afterSell - afterBuy
  if (spent <= 0n) return { check: check('round_trip', 'unavailable', 'The simulated buy did not move the quote balance; the measurement is unusable.', PENALTY.sim_unavailable), loss: null, transferTax: tax, simulated: true }
  if (received <= 0n) return { check: check('round_trip', 'fail', 'The simulated v4 sell returned nothing to the seller: there is no working exit.', 100), loss: 1, transferTax: tax, simulated: true }
  const loss = 1 - Number((received * 1_000_000n) / spent) / 1_000_000
  const unit = pool.quoteSide === 'usdg' ? 'USDG' : 'ETH'
  const fmt = (v: bigint) => pool.quoteSide === 'usdg' ? (Number(v) / 1e6).toFixed(2) : fmtEth(v)
  return { check: check('round_trip', 'pass', `A simulated v4 buy then sell of ${fmt(spent)} ${unit} through the UniversalRouter returned ${fmt(received)} ${unit} (${(loss * 100).toFixed(1)}% round-trip cost, hook fees included).`, 0), loss, transferTax: tax, simulated: true }
}

/** eth_simulateV1 with arbitrary state overrides (the probe sender is always funded with ETH). */
async function simulateWith(chain: ChainClient, calls: SimCall[], overrides: Record<string, { balance?: Hex; stateDiff?: Record<Hex, Hex> }>, block: Hex | 'latest'): Promise<{ calls: SimResult[]; block: Hex }> {
  const res = (await withRpcRetry(() => chain.publicClient.request({
    method: 'eth_simulateV1' as never,
    params: [{ blockStateCalls: [{ stateOverrides: overrides, calls: calls.map((c) => ({ from: PROBE_SENDER, ...c })) }], validation: false, traceTransfers: false }, block] as never,
  }))) as { number: Hex; calls: SimResult[] }[]
  const simulated = res[0]
  if (!simulated) throw new Error('eth_simulateV1 returned no block')
  return { calls: simulated.calls ?? [], block: block === 'latest' ? toHex(BigInt(simulated.number) - 1n) : block }
}

/** The storage key of `holder`'s balance in `token`'s balances mapping, found by overriding candidate slots and reading balanceOf back. */
async function findBalanceSlot(chain: ChainClient, token: Address, holder: Address): Promise<Hex | null> {
  const probe = 123_456_789n
  const balData = encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [holder] })
  for (let slot = 0n; slot < 40n; slot++) {
    for (const order of ['solidity', 'vyper'] as const) {
      const key = order === 'solidity'
        ? keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [holder, slot]))
        : keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }], [slot, holder]))
      try {
        const read = await chain.publicClient.call({ to: token, data: balData, stateOverride: [{ address: token, stateDiff: [{ slot: key, value: toHex(probe, { size: 32 }) }] }] })
        if (read.data && BigInt(read.data) === probe) return key
      } catch {
        // not this slot
      }
    }
  }
  return null
}

function decodeMulticallFirst(data: Hex): bigint | null {
  try {
    const out = decodeFunctionResult({ abi: swapRouter02Abi, functionName: 'multicall', data }) as readonly Hex[]
    return out.length ? BigInt(out[0]!) : null
  } catch {
    return null
  }
}

/**
 * Without eth_simulateV1: find the token's balances mapping slot by overriding
 * candidate slots and reading balanceOf back, then eth_call a transfer of
 * `amount` from the probe sender to the router with that override. Returns the
 * transfer tax observed (0 when the full amount arrives), 'reverted', or
 * 'unavailable' when no slot answers.
 */
async function proveTransfer(chain: ChainClient, token: Address, amount: bigint): Promise<number | 'reverted' | 'unavailable'> {
  const balData = encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [PROBE_SENDER] })
  for (let slot = 0n; slot < 40n; slot++) {
    for (const order of ['solidity', 'vyper'] as const) {
      const key = order === 'solidity'
        ? keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [PROBE_SENDER, slot]))
        : keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }], [slot, PROBE_SENDER]))
      const override = [{ address: token, stateDiff: [{ slot: key, value: toHex(amount, { size: 32 }) }] }]
      try {
        const read = await chain.publicClient.call({ to: token, data: balData, stateOverride: override })
        if (!read.data || BigInt(read.data) !== amount) continue
        const transferData = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [chain.addresses.router, amount] })
        try {
          await chain.publicClient.call({ account: PROBE_SENDER, to: token, data: transferData, stateOverride: override })
          return 0
        } catch {
          return 'reverted'
        }
      } catch {
        // this slot is not the mapping; keep looking
      }
    }
  }
  return 'unavailable'
}

// ── ERC-20 control surfaces ───────────────────────────────────────────────────

const abiCache = new Map<string, { at: number; names: Set<string> | null }>()

/** Function names from the Blockscout-verified ABI, or null when the token is unverified / Blockscout is unreachable. */
async function verifiedFunctionNames(token: Address): Promise<Set<string> | null> {
  const key = token.toLowerCase()
  const hit = abiCache.get(key)
  if (hit && Date.now() - hit.at < 600_000) return hit.names
  let names: Set<string> | null = null
  try {
    const res = await fetch(`${BLOCKSCOUT}/api/v2/smart-contracts/${token}`, { headers: { accept: 'application/json', 'user-agent': BROWSER_UA }, signal: AbortSignal.timeout(4_000) })
    if (res.ok) {
      const body = (await res.json()) as { is_verified?: boolean; abi?: { type: string; name?: string }[] }
      if (body.is_verified && Array.isArray(body.abi)) names = new Set(body.abi.filter((x) => x.type === 'function' && x.name).map((x) => x.name!))
    }
  } catch {
    names = null
  }
  abiCache.set(key, { at: Date.now(), names })
  return names
}

const OWNER_CONTROL_RE = /^(setBlacklist|blacklist|addBot|setBots|setBlackList|removeLimits|enableTrading|openTrading|setTradingEnabled|setTax|setTaxes|setFee|setFees|updateFees|setSellFee|setBuyFee|setMaxTx|setMaxWallet|setMaxTxAmount|pause|unpause|mint|excludeFromFee|excludeFromFees|setSwapEnabled|setCooldown|lockTheSwap)$/i

async function checkControls(input: FirewallInput, expectedOut: bigint | null): Promise<FirewallCheck[]> {
  const { chain, token } = input
  const out: FirewallCheck[] = []
  const names = await verifiedFunctionNames(token)
  if (names) {
    const controls = [...names].filter((n) => OWNER_CONTROL_RE.test(n))
    if (controls.length) out.push(check('owner_controls', 'warn', `The verified source exposes owner controls (${controls.slice(0, 6).join(', ')}) that can change fees, limits or trading after you buy.`, PENALTY.owner_controls))
    else out.push(check('owner_controls', 'pass', 'The verified source exposes no fee, blacklist, pause or trading toggles.', 0))
  }
  const probes = [
    { functionName: 'paused' as const }, { functionName: 'tradingEnabled' as const }, { functionName: 'tradingActive' as const }, { functionName: 'tradingOpen' as const },
    { functionName: 'isBlacklisted' as const, args: [PROBE_SENDER] as const }, { functionName: 'blacklist' as const, args: [PROBE_SENDER] as const }, { functionName: 'blacklisted' as const, args: [PROBE_SENDER] as const }, { functionName: 'isBot' as const, args: [PROBE_SENDER] as const },
    { functionName: 'maxTxAmount' as const }, { functionName: 'maxTransactionAmount' as const }, { functionName: 'maxWalletAmount' as const }, { functionName: 'sellTax' as const }, { functionName: 'buyTax' as const }, { functionName: 'owner' as const },
  ]
  let results: { status: 'success' | 'failure'; result?: unknown }[]
  try {
    results = await withRpcRetry(() => chain.publicClient.multicall({
      contracts: probes.map((p) => ({ address: token, abi: erc20ControlProbeAbi, ...p })) as never,
      allowFailure: true,
    })) as { status: 'success' | 'failure'; result?: unknown }[]
  } catch (err) {
    out.push(check('erc20_probe', 'unavailable', `The token's control surface could not be read: ${errorText(err)}.`, PENALTY.liquidity_unreadable))
    return out
  }
  const got = (name: string) => {
    const i = probes.findIndex((p) => p.functionName === name)
    const r = results[i]
    return r && r.status === 'success' ? r.result : undefined
  }
  // A probe that decodes on an unverified token is only trusted if the verified ABI (when we have it) names the function.
  const present = (name: string) => (names ? names.has(name) : got(name) !== undefined)
  if (present('paused') && got('paused') === true) out.push(check('trading', 'fail', 'The token reports paused(): transfers are switched off.', PENALTY.trading_disabled))
  for (const flag of ['tradingEnabled', 'tradingActive', 'tradingOpen'] as const) {
    if (present(flag) && got(flag) === false) out.push(check('trading', 'fail', `The token reports ${flag}() = false: trading is switched off for everyone but exempt wallets.`, PENALTY.trading_disabled))
  }
  const blacklistFns = (['isBlacklisted', 'blacklist', 'blacklisted', 'isBot'] as const).filter((n) => present(n))
  if (blacklistFns.length) out.push(check('blacklist', 'warn', `The token has a blacklist surface (${blacklistFns.join(', ')}): the owner can stop specific wallets from selling.`, PENALTY.blacklist_surface))
  for (const cap of ['maxTxAmount', 'maxTransactionAmount', 'maxWalletAmount'] as const) {
    const v = got(cap)
    if (present(cap) && typeof v === 'bigint' && v > 0n && expectedOut != null && v < expectedOut) {
      out.push(check('max_tx', 'fail', `${cap}() = ${v} is below the ${expectedOut} tokens this buy would deliver: the transaction would revert or the exit would be capped.`, PENALTY.max_tx_binding))
    }
  }
  const sellTax = got('sellTax')
  if (present('sellTax') && typeof sellTax === 'bigint' && sellTax > 0n) out.push(check('tax_setting', 'warn', `The token declares a sell tax setting of ${sellTax} (contract units).`, PENALTY.transfer_tax / 2))
  // Odyssey anti-snipe cap: a per-wallet max during the first blocks after launch.
  try {
    const [active, maxWallet] = await chain.publicClient.multicall({
      contracts: [
        { address: token, abi: odysseyLaunchTokenAbi, functionName: 'limitsActive' },
        { address: token, abi: odysseyLaunchTokenAbi, functionName: 'maxWallet' },
      ],
      allowFailure: true,
    })
    if (active.status === 'success' && active.result === true && maxWallet.status === 'success' && expectedOut != null && maxWallet.result < expectedOut) {
      out.push(check('anti_snipe', 'fail', `The launch token's anti-snipe max wallet (${maxWallet.result}) is below the ${expectedOut} tokens this buy would deliver; the buy would revert.`, PENALTY.anti_snipe_cap))
    } else if (active.status === 'success' && active.result === true) {
      out.push(check('anti_snipe', 'pass', 'The launch token enforces a per-wallet cap during its anti-snipe window; this size fits under it.', 0))
    }
  } catch {
    // not an Odyssey launch token; nothing to report
  }
  return out
}

// ── deployer share and liquidity ──────────────────────────────────────────────

async function checkDeployer(input: FirewallInput): Promise<FirewallCheck> {
  const { chain, token, deployer } = input
  if (!deployer) return check('deployer', 'unavailable', 'The deployer wallet is unknown, so its share of supply could not be read.', PENALTY.liquidity_unreadable)
  try {
    const [supply, bal] = await withRpcRetry(() => chain.publicClient.multicall({
      contracts: [
        { address: token, abi: erc20Abi, functionName: 'totalSupply' },
        { address: token, abi: erc20Abi, functionName: 'balanceOf', args: [deployer] },
      ],
      allowFailure: false,
    }))
    if (supply === 0n) return check('deployer', 'unavailable', 'The token reports zero total supply.', PENALTY.liquidity_unreadable)
    const pct = Number((bal * 10_000n) / supply) / 100
    if (pct > 50) return check('deployer', 'fail', `The deployer holds ${pct.toFixed(1)}% of supply: one wallet can crater the price at will.`, PENALTY.deployer_dominant)
    if (pct > 20) return check('deployer', 'warn', `The deployer holds ${pct.toFixed(1)}% of supply, an outsized share for a launch.`, PENALTY.deployer_heavy)
    return check('deployer', 'pass', `The deployer holds ${pct.toFixed(1)}% of supply.`, 0)
  } catch (err) {
    return check('deployer', 'unavailable', `The deployer's balance could not be read: ${errorText(err)}.`, PENALTY.liquidity_unreadable)
  }
}

async function checkLiquidity(input: FirewallInput): Promise<FirewallCheck> {
  const { chain, prices, token, venue } = input
  const floor = input.minLiquidityWei ?? parseEther('0.05')
  if (venue === 'v4') {
    if (!input.v4Pool) return check('liquidity', 'fail', 'No v4 pool key is known for this token.', 100)
    const liq = await prices.v4.liquidity(input.v4Pool.poolId)
    if (liq == null) return check('liquidity', 'unavailable', 'The v4 pool liquidity could not be read from StateView.', PENALTY.liquidity_unreadable)
    if (liq === 0n) return check('liquidity', 'fail', 'The v4 pool has zero in-range liquidity: nothing to sell into.', 100)
    return check('liquidity', 'pass', `The v4 pool reports in-range liquidity ${liq} (hook ${input.v4Pool.key.hooks}).`, 0)
  }
  if (venue === 'curve') {
    const s = await prices.curveState(token, input.factory ?? undefined)
    if (!s) return check('liquidity', 'fail', 'No Odyssey curve exists for this token.', 100)
    if (s.completed) return check('liquidity', 'fail', 'The curve is complete; trading has moved to a pool.', 100)
    return check('liquidity', 'pass', `The curve holds ${fmtEth(s.realQuote)} ETH of real reserve on ${fmtEth(s.virtualQuote)} virtual.`, 0)
  }
  if (!input.pool) return check('liquidity', 'fail', 'No pool is known for this token.', 100)
  try {
    const [info, liquidity] = await Promise.all([
      prices.pool(input.pool),
      withRpcRetry(() => chain.publicClient.readContract({ address: input.pool!, abi: uniswapV3PoolAbi, functionName: 'liquidity' })),
    ])
    const quoteToken = info.token0.toLowerCase() === token.toLowerCase() ? info.token1 : info.token0
    const quoteBalance = await withRpcRetry(() => chain.publicClient.readContract({ address: quoteToken, abi: erc20Abi, functionName: 'balanceOf', args: [input.pool!] }))
    const isWeth = quoteToken.toLowerCase() === chain.addresses.weth.toLowerCase()
    if (liquidity === 0n) return check('liquidity', 'fail', 'The pool has zero in-range liquidity: nothing to sell into.', 100)
    if (isWeth && quoteBalance < floor) return check('liquidity', 'warn', `The pool holds only ${fmtEth(quoteBalance)} WETH (floor ${fmtEth(floor)}): a thin exit.`, PENALTY.liquidity_thin)
    return check('liquidity', 'pass', isWeth ? `The pool holds ${fmtEth(quoteBalance)} WETH.` : 'The pool has in-range liquidity (non-WETH quote).', 0)
  } catch (err) {
    return check('liquidity', 'unavailable', `Pool liquidity could not be read: ${errorText(err)}.`, PENALTY.liquidity_unreadable)
  }
}

// ── compose ───────────────────────────────────────────────────────────────────

function compose(checks: FirewallCheck[]): { verdict: FirewallVerdict; score: number } {
  let score = 100
  let fatal = false
  let unavailable = false
  for (const c of checks) {
    if (c.status === 'pass') continue
    score -= c.weight
    if (c.status === 'fail' && c.weight >= 40) fatal = true
    if (c.status === 'unavailable') unavailable = true
  }
  score = Math.max(0, Math.min(100, Math.round(score)))
  let verdict: FirewallVerdict
  if (fatal || score <= BLOCK_SCORE) verdict = 'block'
  else if (score <= WARN_SCORE || unavailable || checks.some((c) => c.status !== 'pass')) verdict = 'warn'
  else verdict = 'allow'
  return { verdict, score }
}

/**
 * Assess a buy. Always resolves: a thrown data source becomes an
 * `unavailable` check, never an exception on the trade path.
 */
export async function assessTradeSafety(input: FirewallInput): Promise<FirewallAssessment> {
  const t0 = Date.now()
  const checks: FirewallCheck[] = []
  let roundTrip: RoundTrip
  try {
    if (input.venue === 'pool' && input.pool) roundTrip = await roundTripPool(input)
    else if (input.venue === 'curve' && input.factory) roundTrip = await roundTripCurve(input)
    else if (input.venue === 'v4' && input.v4Pool) roundTrip = await roundTripV4(input)
    else roundTrip = { check: check('round_trip', 'fail', 'No venue to trade on: no pool and no curve.', 100), loss: null, transferTax: null, simulated: false }
  } catch (err) {
    roundTrip = { check: check('round_trip', 'unavailable', `The round trip could not be evaluated: ${errorText(err)}.`, PENALTY.sim_unavailable), loss: null, transferTax: null, simulated: false }
  }
  checks.push(roundTrip.check)
  const cap = (input.maxRoundTripLossPct ?? 35) / 100
  if (roundTrip.loss != null) {
    if (roundTrip.loss > cap) checks.push(check('round_trip_loss', 'fail', `An immediate round trip loses ${(roundTrip.loss * 100).toFixed(1)}%, above the ${(cap * 100).toFixed(0)}% cap.`, PENALTY.round_trip_loss_high))
    else checks.push(check('round_trip_loss', 'pass', `Round-trip cost ${(roundTrip.loss * 100).toFixed(1)}% is within the ${(cap * 100).toFixed(0)}% cap.`, 0))
  }
  if (roundTrip.transferTax != null && roundTrip.transferTax > 0.005) {
    checks.push(check('transfer_tax', roundTrip.transferTax > 0.25 ? 'fail' : 'warn', `${(roundTrip.transferTax * 100).toFixed(1)}% of the bought tokens never reached the buyer: a transfer tax.`, roundTrip.transferTax > 0.25 ? 60 : PENALTY.transfer_tax))
  } else if (roundTrip.simulated) {
    checks.push(check('transfer_tax', 'pass', 'The full bought amount reached the buyer in simulation.', 0))
  }
  let expectedOut: bigint | null = null
  if (input.venue === 'pool' && input.pool) expectedOut = (await input.prices.poolQuoteBuy(input.pool, input.token, input.amountWei))?.amountOut ?? null
  else if (input.venue === 'v4' && input.v4Pool) expectedOut = (await input.prices.v4QuoteBuy(input.v4Pool, input.amountWei))?.amountOut ?? null
  else if (input.factory) expectedOut = (await input.prices.curveQuoteBuy(input.factory, input.token, input.amountWei))?.tokensOut ?? null
  const [controls, deployer, liquidity] = await Promise.all([
    checkControls(input, expectedOut).catch((err) => [check('erc20_probe', 'unavailable', `Control probes failed: ${errorText(err)}.`, PENALTY.liquidity_unreadable)]),
    checkDeployer(input).catch((err) => check('deployer', 'unavailable', `Deployer read failed: ${errorText(err)}.`, PENALTY.liquidity_unreadable)),
    checkLiquidity(input).catch((err) => check('liquidity', 'unavailable', `Liquidity read failed: ${errorText(err)}.`, PENALTY.liquidity_unreadable)),
  ])
  checks.push(...controls, deployer, liquidity)
  const { verdict, score } = compose(checks)
  const assessment: FirewallAssessment = {
    token: input.token, venue: input.venue, verdict, score, checks, roundTripLossPct: roundTrip.loss, assessedAt: new Date(), latencyMs: Date.now() - t0,
  }
  if (input.db) {
    input.db.insert(firewallDecisions).values({
      token: input.token.toLowerCase(), network: input.network, venue: input.venue, verdict, score, roundTripLossPct: roundTrip.loss, checks, latencyMs: assessment.latencyMs, at: assessment.assessedAt,
    }).catch((err) => input.log.warn({ err: errorText(err) }, 'firewall decision write failed'))
  }
  return assessment
}

function fmtEth(wei: bigint): string {
  return (Number(wei) / 1e18).toFixed(5)
}
