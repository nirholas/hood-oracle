/**
 * Uniswap v4 on Robinhood Chain mainnet: pool keys, quoting, spot, and swap
 * calldata for the UniversalRouter. Every constant here was read from the
 * verified sources on Blockscout on 2026-09-04:
 *
 *   PoolManager     0x8366a39CC670B4001A1121B8F6A443A643e40951 (from the Odyssey
 *                   reflection factory's v4Graduator().poolManager())
 *   UniversalRouter 0x8876789976dEcBfCbBbe364623C63652db8C0904, whose constructor
 *                   args pin Permit2, WETH9, the v3 factory, the v4 PoolManager and
 *                   both position managers. Its verified source carries the command
 *                   bytes (WRAP_ETH 0x0b, UNWRAP_WETH 0x0c, V4_SWAP 0x10), the v4
 *                   action bytes (SWAP_EXACT_IN_SINGLE 0x06, SETTLE 0x0b, SETTLE_ALL
 *                   0x0c, TAKE 0x0e, TAKE_ALL 0x0f), the sentinels MSG_SENDER =
 *                   address(1), ADDRESS_THIS = address(2), OPEN_DELTA = 0, and a
 *                   fork-specific ExactInputSingleParams that carries an extra
 *                   `minHopPriceX36` (0 disables it) before `hookData`.
 *   V4Quoter        several verified deployments exist; the two whose poolManager()
 *                   is the canonical PoolManager and that answer a live quote are
 *                   0x08A50911bac753b7e11a7e5631afA19F14C1Af55 and
 *                   0x5c3db48cFd8352D845fac70009d714F0Ce1d7914 (0x987E643e… points
 *                   at the same PoolManager but reverts on a plain single-hop quote
 *                   and is left out).
 *   StateView       0x0284Cb0bcbaa8B87A8AA409D0e41afA7a76355F2 and
 *                   0xF3334192D15450CdD385c8B70e03f9A6bD9E673b (both on the
 *                   canonical PoolManager).
 *
 * Money flow: buys pay native ETH (msg.value settles the native currency
 * inside the router), or wrap ETH in the same execute for WETH-quoted pools,
 * or settle USDG from the wallet through Permit2 for USDG-quoted pools. Sells
 * settle the token through Permit2 (a one-time token->Permit2 approval and a
 * one-time Permit2->router allowance) and take native ETH, unwrap WETH to
 * ETH, or take USDG. Hook data is empty: none of the registered hooks reads
 * it (LaunchHook tolerates an empty envelope).
 */
import {
  type Address, type Hash, type Hex, concatHex, decodeFunctionData, encodeAbiParameters, encodeFunctionData, getAddress, keccak256, maxUint160, maxUint48, parseAbi, toHex,
} from 'viem'
import type { ChainClient } from './client.js'
import { withRpcRetry } from './client.js'
import type { LaunchRecord } from '../types.js'

export const V4_ADDRESSES = {
  poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951' as Address,
  positionManager: '0x58daec3116aae6d93017baaea7749052e8a04fa7' as Address,
  universalRouter: '0x8876789976dEcBfCbBbe364623C63652db8C0904' as Address,
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3' as Address,
  quoters: ['0x08A50911bac753b7e11a7e5631afA19F14C1Af55', '0x5c3db48cFd8352D845fac70009d714F0Ce1d7914'] as Address[],
  stateViews: ['0x0284Cb0bcbaa8B87A8AA409D0e41afA7a76355F2', '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b'] as Address[],
} as const

/** UniversalRouter command bytes (verified source). */
export const UR_COMMAND = { WRAP_ETH: 0x0b, UNWRAP_WETH: 0x0c, V4_SWAP: 0x10 } as const
/** v4 router action bytes (verified source). */
export const V4_ACTION = { SWAP_EXACT_IN_SINGLE: 0x06, SETTLE: 0x0b, SETTLE_ALL: 0x0c, TAKE: 0x0e, TAKE_ALL: 0x0f } as const
export const MSG_SENDER: Address = '0x0000000000000000000000000000000000000001'
export const ADDRESS_THIS: Address = '0x0000000000000000000000000000000000000002'
export const NATIVE: Address = '0x0000000000000000000000000000000000000000'
const OPEN_DELTA = 0n

export const universalRouterAbi = parseAbi([
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
])
export const permit2Abi = parseAbi([
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
  'function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
])
export const v4QuoterAbi = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }',
  'function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)',
  'function poolManager() view returns (address)',
])
export const stateViewAbi = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
])
const erc20ApproveAbi = parseAbi(['function approve(address spender, uint256 amount) returns (bool)'])

export interface V4PoolKey {
  currency0: Address
  currency1: Address
  fee: number
  tickSpacing: number
  hooks: Address
}

export type V4QuoteSide = 'native' | 'weth' | 'usdg'

/** A launch's v4 pool, resolved from the intake metadata. */
export interface V4Pool {
  key: V4PoolKey
  poolId: Hash
  token: Address
  quote: Address
  quoteSide: V4QuoteSide
  /** true when the launch token is currency0. */
  tokenIsCurrency0: boolean
}

const POOL_KEY_PARAMS = [{ type: 'tuple', components: [{ type: 'address', name: 'currency0' }, { type: 'address', name: 'currency1' }, { type: 'uint24', name: 'fee' }, { type: 'int24', name: 'tickSpacing' }, { type: 'address', name: 'hooks' }] }] as const

/** v4 PoolId = keccak256(abi.encode(PoolKey)). */
export function poolIdOf(key: V4PoolKey): Hash {
  return keccak256(encodeAbiParameters(POOL_KEY_PARAMS, [key]))
}

/** Build the pool from what the intake recorded on the launch (quote, fee, tickSpacing, hooks, poolId). */
export function v4PoolFromLaunch(launch: Pick<LaunchRecord, 'token' | 'metadata'>, addresses: { weth: Address; usdg: Address }): V4Pool | null {
  const m = launch.metadata
  if (typeof m.quote !== 'string' || typeof m.hooks !== 'string' && m.hooks !== null) return null
  const fee = Number(m.fee)
  const tickSpacing = Number(m.tickSpacing)
  if (!Number.isFinite(fee) || !Number.isFinite(tickSpacing)) return null
  const quote = getAddress(m.quote as string)
  const token = getAddress(launch.token)
  const hooks = typeof m.hooks === 'string' ? getAddress(m.hooks) : NATIVE
  const quoteSide: V4QuoteSide | null = quote === NATIVE ? 'native' : quote.toLowerCase() === addresses.weth.toLowerCase() ? 'weth' : quote.toLowerCase() === addresses.usdg.toLowerCase() ? 'usdg' : null
  if (!quoteSide) return null
  const tokenIsCurrency0 = BigInt(token) < BigInt(quote)
  const key: V4PoolKey = { currency0: tokenIsCurrency0 ? token : quote, currency1: tokenIsCurrency0 ? quote : token, fee, tickSpacing, hooks }
  const poolId = poolIdOf(key)
  if (typeof m.poolId === 'string' && m.poolId.toLowerCase() !== poolId.toLowerCase()) return null
  return { key, poolId, token, quote, quoteSide, tokenIsCurrency0 }
}

// ── encoding ──────────────────────────────────────────────────────────────────

const exactInputSingleParams = [{ type: 'tuple', components: [
  { type: 'tuple', name: 'poolKey', components: [{ type: 'address', name: 'currency0' }, { type: 'address', name: 'currency1' }, { type: 'uint24', name: 'fee' }, { type: 'int24', name: 'tickSpacing' }, { type: 'address', name: 'hooks' }] },
  { type: 'bool', name: 'zeroForOne' }, { type: 'uint128', name: 'amountIn' }, { type: 'uint128', name: 'amountOutMinimum' }, { type: 'uint256', name: 'minHopPriceX36' }, { type: 'bytes', name: 'hookData' },
] }] as const

const encodeSwapExactInSingle = (key: V4PoolKey, zeroForOne: boolean, amountIn: bigint, amountOutMinimum: bigint): Hex =>
  encodeAbiParameters(exactInputSingleParams, [{ poolKey: key, zeroForOne, amountIn, amountOutMinimum, minHopPriceX36: 0n, hookData: '0x' }])
const encodeCurrencyAmount = (currency: Address, amount: bigint): Hex => encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [currency, amount])
const encodeSettle = (currency: Address, amount: bigint, payerIsUser: boolean): Hex => encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bool' }], [currency, amount, payerIsUser])
const encodeTake = (currency: Address, recipient: Address, amount: bigint): Hex => encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], [currency, recipient, amount])
const encodeV4Swap = (actions: number[], params: Hex[]): Hex => encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [concatHex(actions.map((a) => toHex(a, { size: 1 }))), params])
const encodeRecipientAmount = (recipient: Address, amount: bigint): Hex => encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [recipient, amount])

export interface V4Tx {
  to: Address
  data: Hex
  value: bigint
  commands: Hex
  inputs: Hex[]
  deadline: bigint
}

/** `execute(commands, inputs, deadline)` for the UniversalRouter. */
export function encodeExecute(commands: number[], inputs: Hex[], deadline: bigint, value: bigint): V4Tx {
  const commandBytes = concatHex(commands.map((c) => toHex(c, { size: 1 })))
  return { to: V4_ADDRESSES.universalRouter, data: encodeFunctionData({ abi: universalRouterAbi, functionName: 'execute', args: [commandBytes, inputs, deadline] }), value, commands: commandBytes, inputs, deadline }
}

/** Decode an `execute` call back to its commands and inputs (used by tests and the journal). */
export function decodeExecute(data: Hex): { commands: Hex; inputs: readonly Hex[]; deadline: bigint } {
  const d = decodeFunctionData({ abi: universalRouterAbi, data })
  const [commands, inputs, deadline] = d.args
  return { commands, inputs, deadline }
}

/**
 * Buy `pool.token` with `amountIn` of the quote. Native: msg.value settles.
 * WETH: WRAP_ETH into the router, then SETTLE from the router's balance.
 * USDG: SETTLE_ALL from the wallet through Permit2 (allowances required).
 */
export function buildV4Buy(pool: V4Pool, amountIn: bigint, amountOutMinimum: bigint, deadline: bigint): V4Tx {
  const zeroForOne = !pool.tokenIsCurrency0 // quote is currency0 when the token is currency1
  const swap = encodeSwapExactInSingle(pool.key, zeroForOne, amountIn, amountOutMinimum)
  if (pool.quoteSide === 'native') {
    const v4 = encodeV4Swap([V4_ACTION.SWAP_EXACT_IN_SINGLE, V4_ACTION.SETTLE_ALL, V4_ACTION.TAKE_ALL], [swap, encodeCurrencyAmount(NATIVE, amountIn), encodeCurrencyAmount(pool.token, amountOutMinimum)])
    return encodeExecute([UR_COMMAND.V4_SWAP], [v4], deadline, amountIn)
  }
  if (pool.quoteSide === 'weth') {
    const wrap = encodeRecipientAmount(ADDRESS_THIS, amountIn)
    const v4 = encodeV4Swap([V4_ACTION.SWAP_EXACT_IN_SINGLE, V4_ACTION.SETTLE, V4_ACTION.TAKE_ALL], [swap, encodeSettle(pool.quote, amountIn, false), encodeCurrencyAmount(pool.token, amountOutMinimum)])
    return encodeExecute([UR_COMMAND.WRAP_ETH, UR_COMMAND.V4_SWAP], [wrap, v4], deadline, amountIn)
  }
  const v4 = encodeV4Swap([V4_ACTION.SWAP_EXACT_IN_SINGLE, V4_ACTION.SETTLE_ALL, V4_ACTION.TAKE_ALL], [swap, encodeCurrencyAmount(pool.quote, amountIn), encodeCurrencyAmount(pool.token, amountOutMinimum)])
  return encodeExecute([UR_COMMAND.V4_SWAP], [v4], deadline, 0n)
}

/**
 * Sell `amountIn` of `pool.token` for the quote. The token settles from the
 * wallet through Permit2. Native and USDG are taken straight to the sender;
 * WETH is taken into the router and unwrapped to ETH for the sender.
 */
export function buildV4Sell(pool: V4Pool, amountIn: bigint, amountOutMinimum: bigint, deadline: bigint): V4Tx {
  const zeroForOne = pool.tokenIsCurrency0
  const swap = encodeSwapExactInSingle(pool.key, zeroForOne, amountIn, amountOutMinimum)
  if (pool.quoteSide === 'weth') {
    const v4 = encodeV4Swap([V4_ACTION.SWAP_EXACT_IN_SINGLE, V4_ACTION.SETTLE_ALL, V4_ACTION.TAKE], [swap, encodeCurrencyAmount(pool.token, amountIn), encodeTake(pool.quote, ADDRESS_THIS, OPEN_DELTA)])
    return encodeExecute([UR_COMMAND.V4_SWAP, UR_COMMAND.UNWRAP_WETH], [v4, encodeRecipientAmount(MSG_SENDER, amountOutMinimum)], deadline, 0n)
  }
  const v4 = encodeV4Swap([V4_ACTION.SWAP_EXACT_IN_SINGLE, V4_ACTION.SETTLE_ALL, V4_ACTION.TAKE_ALL], [swap, encodeCurrencyAmount(pool.token, amountIn), encodeCurrencyAmount(pool.quote, amountOutMinimum)])
  return encodeExecute([UR_COMMAND.V4_SWAP], [v4], deadline, 0n)
}

/** The two one-time approvals that let the router pull `token` from the wallet through Permit2. */
export function permit2ApprovalCalls(token: Address): { to: Address; data: Hex }[] {
  return [
    { to: token, data: encodeFunctionData({ abi: erc20ApproveAbi, functionName: 'approve', args: [V4_ADDRESSES.permit2, 2n ** 256n - 1n] }) },
    { to: V4_ADDRESSES.permit2, data: encodeFunctionData({ abi: permit2Abi, functionName: 'approve', args: [token, V4_ADDRESSES.universalRouter, maxUint160, Number(maxUint48)] }) },
  ]
}

// ── reads ─────────────────────────────────────────────────────────────────────

const Q96 = 2 ** 96

export class V4 {
  private quoterIndex = 0
  private stateViewIndex = 0

  constructor(private readonly chain: ChainClient) {}

  /** Executable output of an exact-in single-hop swap through the quoter, trying each deployment in turn. Null when no quoter can price it (for example a sell the pool cannot absorb). */
  async quoteExactIn(key: V4PoolKey, zeroForOne: boolean, amountIn: bigint): Promise<{ amountOut: bigint; gasEstimate: bigint } | null> {
    if (amountIn <= 0n) return { amountOut: 0n, gasEstimate: 0n }
    for (let i = 0; i < V4_ADDRESSES.quoters.length; i++) {
      const quoter = V4_ADDRESSES.quoters[(this.quoterIndex + i) % V4_ADDRESSES.quoters.length]!
      try {
        const { result } = await withRpcRetry(() => this.chain.publicClient.simulateContract({ address: quoter, abi: v4QuoterAbi, functionName: 'quoteExactInputSingle', args: [{ poolKey: key, zeroForOne, exactAmount: amountIn, hookData: '0x' }] }))
        this.quoterIndex = (this.quoterIndex + i) % V4_ADDRESSES.quoters.length
        return { amountOut: result[0], gasEstimate: result[1] }
      } catch (err) {
        // A pool-level revert (NotEnoughLiquidity, hook refusal) is the same on every quoter; an RPC failure is worth the next one.
        if (isContractRevert(err)) return null
      }
    }
    return null
  }

  quoteBuy(pool: V4Pool, amountIn: bigint) {
    return this.quoteExactIn(pool.key, !pool.tokenIsCurrency0, amountIn)
  }

  async quoteSell(pool: V4Pool, amountIn: bigint): Promise<bigint | null> {
    const q = await this.quoteExactIn(pool.key, pool.tokenIsCurrency0, amountIn)
    return q ? q.amountOut : null
  }

  async slot0(poolId: Hash): Promise<{ sqrtPriceX96: bigint; tick: number; lpFee: number } | null> {
    for (let i = 0; i < V4_ADDRESSES.stateViews.length; i++) {
      const view = V4_ADDRESSES.stateViews[(this.stateViewIndex + i) % V4_ADDRESSES.stateViews.length]!
      try {
        const r = await withRpcRetry(() => this.chain.publicClient.readContract({ address: view, abi: stateViewAbi, functionName: 'getSlot0', args: [poolId] }))
        this.stateViewIndex = (this.stateViewIndex + i) % V4_ADDRESSES.stateViews.length
        return { sqrtPriceX96: r[0], tick: r[1], lpFee: r[3] }
      } catch {
        // try the next view
      }
    }
    return null
  }

  async liquidity(poolId: Hash): Promise<bigint | null> {
    for (let i = 0; i < V4_ADDRESSES.stateViews.length; i++) {
      const view = V4_ADDRESSES.stateViews[(this.stateViewIndex + i) % V4_ADDRESSES.stateViews.length]!
      try {
        return await withRpcRetry(() => this.chain.publicClient.readContract({ address: view, abi: stateViewAbi, functionName: 'getLiquidity', args: [poolId] }))
      } catch {
        // try the next view
      }
    }
    return null
  }

  /** Mid price of one whole token in quote units (ETH for native/WETH, dollars for USDG) from slot0. */
  async spotInQuote(pool: V4Pool, tokenDecimals: number): Promise<number | null> {
    const s = await this.slot0(pool.poolId)
    if (!s || s.sqrtPriceX96 === 0n) return null
    const ratio = (Number(s.sqrtPriceX96) / Q96) ** 2 // currency1 per currency0, raw
    const raw = pool.tokenIsCurrency0 ? ratio : 1 / ratio
    const quoteDecimals = pool.quoteSide === 'usdg' ? 6 : 18
    return raw * 10 ** (tokenDecimals - quoteDecimals)
  }
}

function isContractRevert(err: unknown): boolean {
  let e: unknown = err
  for (let depth = 0; e && typeof e === 'object' && depth < 6; depth++) {
    const name = (e as { name?: string }).name ?? ''
    if (name === 'ContractFunctionRevertedError' || name === 'ContractFunctionExecutionError') return true
    e = (e as { cause?: unknown }).cause
  }
  return false
}

/** Quote units to ETH wei for a v4 pool: native and WETH are already wei; USDG needs the live ETH/USD. */
export function quoteUnitsToWei(amount: bigint, side: V4QuoteSide, ethUsd: number | null): bigint | null {
  if (side !== 'usdg') return amount
  if (ethUsd == null || !(ethUsd > 0)) return null
  return (amount * 1_000_000_000_000n * 1_000_000n) / BigInt(Math.round(ethUsd * 1_000_000))
}

/** ETH wei to quote units for a v4 pool (the buy budget in the pool's own currency). */
export function weiToQuoteUnits(wei: bigint, side: V4QuoteSide, ethUsd: number | null): bigint | null {
  if (side !== 'usdg') return wei
  if (ethUsd == null || !(ethUsd > 0)) return null
  return (wei * BigInt(Math.round(ethUsd * 1_000_000))) / (1_000_000_000_000n * 1_000_000n)
}

import { v4HookSupport } from './launchpads.js'

/** Swap-path verdict for a pool's hook (registry-backed; see launchpads.ts). */
export const v4HookSupportFor = v4HookSupport
