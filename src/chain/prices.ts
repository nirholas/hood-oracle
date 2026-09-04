/**
 * Prices, sourced from live chain state only. ETH/USD comes from the deepest
 * WETH/USDG Uniswap v3 pool's slot0 (USDG is Paxos' dollar; the pool mid is
 * the on-chain dollar price of ETH). Token spot prices come from the venue the
 * token trades on: pool slot0 for Uniswap tokens, virtual reserves for Odyssey
 * curve tokens. Executable prices for a size go through QuoterV2 or the
 * curve's own quote functions. Nothing here is estimated or fabricated: a
 * venue that cannot answer resolves to null and the caller decides.
 */
import { type Address, formatUnits } from 'viem'
import { odysseyBondingPoolAbi, odysseyCurveAbi, odysseyReflectionPoolAbi, quoterV2Abi, uniswapV3FactoryAbi, uniswapV3PoolAbi } from './abis.js'
import { withRpcRetry } from './client.js'
import type { ChainClient } from './client.js'
import { V4, quoteUnitsToWei, weiToQuoteUnits, type V4Pool } from './v4.js'

const Q96 = 2 ** 96
const ZERO = '0x0000000000000000000000000000000000000000'

export interface PoolInfo {
  pool: Address
  token0: Address
  token1: Address
  fee: number
}

export interface CurveState {
  factory: Address
  creator: Address
  completed: boolean
  virtualQuote: bigint
  virtualToken: bigint
  virtualQuoteInit: bigint
  realQuote: bigint
}

export class Prices {
  /** Uniswap v4 reads and quotes (quoter + StateView with fallbacks). */
  readonly v4: V4
  private readonly poolInfo = new Map<string, PoolInfo>()
  private readonly curveFactory = new Map<string, Address>()
  private ethUsdCache: { value: number; at: number } | null = null
  private ethUsdInflight: Promise<number | null> | null = null
  private referencePool: { pool: Address; at: number } | null = null
  private curveFeeBps: { value: bigint; at: number } | null = null

  constructor(private readonly chain: ChainClient) {
    this.v4 = new V4(chain)
  }

  /** Buy on a v4 pool with an ETH budget: the budget in the pool's quote units, and the executable token output. Null when the quote cannot be denominated or the quoter cannot fill it. */
  async v4QuoteBuy(pool: V4Pool, budgetWei: bigint): Promise<{ amountOut: bigint; spendUnits: bigint; spendWei: bigint } | null> {
    const ethUsd = pool.quoteSide === 'usdg' ? await this.ethUsd() : null
    const units = weiToQuoteUnits(budgetWei, pool.quoteSide, ethUsd)
    if (units == null || units <= 0n) return null
    const q = await this.v4.quoteBuy(pool, units)
    if (!q || q.amountOut <= 0n) return null
    return { amountOut: q.amountOut, spendUnits: units, spendWei: budgetWei }
  }

  /** Executable ETH-wei proceeds of selling `amount` tokens on a v4 pool (USDG proceeds converted at the live ETH/USD). Null when the pool cannot absorb the sell. */
  async v4QuoteSellWei(pool: V4Pool, amount: bigint): Promise<{ wei: bigint; units: bigint } | null> {
    if (amount <= 0n) return { wei: 0n, units: 0n }
    const units = await this.v4.quoteSell(pool, amount)
    if (units == null) return null
    const wei = quoteUnitsToWei(units, pool.quoteSide, pool.quoteSide === 'usdg' ? await this.ethUsd() : null)
    return wei == null ? null : { wei, units }
  }

  /** Mid price of one whole token in ETH on a v4 pool (USDG quotes converted at the live ETH/USD). */
  async v4SpotEth(pool: V4Pool, tokenDecimals: number): Promise<number | null> {
    const inQuote = await this.v4.spotInQuote(pool, tokenDecimals)
    if (inQuote == null) return null
    if (pool.quoteSide !== 'usdg') return inQuote
    const ethUsd = await this.ethUsd()
    return ethUsd && ethUsd > 0 ? inQuote / ethUsd : null
  }

  /** Pool immutables, cached forever (they never change). */
  async pool(pool: Address): Promise<PoolInfo> {
    const key = pool.toLowerCase()
    const hit = this.poolInfo.get(key)
    if (hit) return hit
    const [token0, token1, fee] = await withRpcRetry(() => this.chain.publicClient.multicall({
      contracts: [
        { address: pool, abi: uniswapV3PoolAbi, functionName: 'token0' },
        { address: pool, abi: uniswapV3PoolAbi, functionName: 'token1' },
        { address: pool, abi: uniswapV3PoolAbi, functionName: 'fee' },
      ],
      allowFailure: false,
    }))
    const info = { pool, token0, token1, fee }
    this.poolInfo.set(key, info)
    return info
  }

  /** The deepest WETH/USDG pool, re-resolved every 10 minutes. */
  private async ethUsdPool(): Promise<Address | null> {
    if (this.referencePool && Date.now() - this.referencePool.at < 600_000) return this.referencePool.pool
    const { weth, usdg, uniswapV3Factory } = this.chain.addresses
    const pools = await withRpcRetry(() => this.chain.publicClient.multicall({
      contracts: [100, 500, 3000].map((fee) => ({ address: uniswapV3Factory, abi: uniswapV3FactoryAbi, functionName: 'getPool' as const, args: [weth, usdg, fee] as const })),
      allowFailure: true,
    }))
    const candidates = pools.filter((p) => p.status === 'success' && p.result !== ZERO).map((p) => p.result as Address)
    if (!candidates.length) return null
    const liq = await withRpcRetry(() => this.chain.publicClient.multicall({
      contracts: candidates.map((pool) => ({ address: pool, abi: uniswapV3PoolAbi, functionName: 'liquidity' as const })),
      allowFailure: true,
    }))
    let best: { pool: Address; liquidity: bigint } | null = null
    liq.forEach((r, i) => {
      if (r.status !== 'success') return
      if (!best || r.result > best.liquidity) best = { pool: candidates[i]!, liquidity: r.result }
    })
    if (!best) return null
    const chosen: { pool: Address; liquidity: bigint } = best
    this.referencePool = { pool: chosen.pool, at: Date.now() }
    return chosen.pool
  }

  /**
   * ETH/USD from the WETH/USDG pool mid price, cached 30s and de-duplicated
   * across concurrent callers. Returns the last good value if the pool read
   * fails, or null on a cold start with no reachable pool.
   */
  async ethUsd(maxAgeMs = 30_000): Promise<number | null> {
    if (this.ethUsdCache && Date.now() - this.ethUsdCache.at < maxAgeMs) return this.ethUsdCache.value
    if (this.ethUsdInflight) return this.ethUsdInflight
    this.ethUsdInflight = (async () => {
      try {
        const pool = await this.ethUsdPool()
        if (!pool) return this.ethUsdCache?.value ?? null
        const [info, slot0] = await Promise.all([
          this.pool(pool),
          withRpcRetry(() => this.chain.publicClient.readContract({ address: pool, abi: uniswapV3PoolAbi, functionName: 'slot0' })),
        ])
        const wethIsToken0 = info.token0.toLowerCase() === this.chain.addresses.weth.toLowerCase()
        const usd = priceFromSqrt(slot0[0], wethIsToken0, 18, 6)
        if (!(usd > 0)) return this.ethUsdCache?.value ?? null
        this.ethUsdCache = { value: usd, at: Date.now() }
        return usd
      } catch {
        return this.ethUsdCache?.value ?? null
      } finally {
        this.ethUsdInflight = null
      }
    })()
    return this.ethUsdInflight
  }

  /**
   * Mid price of one whole token in ETH from its pool's slot0. The pool must
   * be paired with WETH; a USDG-paired pool is converted through ethUsd().
   */
  async poolSpotEth(pool: Address, token: Address, tokenDecimals: number): Promise<number | null> {
    try {
      const info = await this.pool(pool)
      const tokenIsToken0 = info.token0.toLowerCase() === token.toLowerCase()
      const quote = tokenIsToken0 ? info.token1 : info.token0
      const slot0 = await withRpcRetry(() => this.chain.publicClient.readContract({ address: pool, abi: uniswapV3PoolAbi, functionName: 'slot0' }))
      const isWeth = quote.toLowerCase() === this.chain.addresses.weth.toLowerCase()
      const isUsdg = quote.toLowerCase() === this.chain.addresses.usdg.toLowerCase()
      if (!isWeth && !isUsdg) return null
      const quoteDecimals = isWeth ? 18 : 6
      const inQuote = priceFromSqrt(slot0[0], tokenIsToken0, tokenDecimals, quoteDecimals)
      if (isWeth) return inQuote
      const ethUsd = await this.ethUsd()
      return ethUsd && ethUsd > 0 ? inQuote / ethUsd : null
    } catch {
      return null
    }
  }

  /** Which Odyssey factory owns a token's curve, or null when none does. Cached. */
  async curveFactoryOf(token: Address): Promise<Address | null> {
    const key = token.toLowerCase()
    const hit = this.curveFactory.get(key)
    if (hit) return hit
    const { odysseyBonding, odysseyReflection, odysseyLegacy } = this.chain.addresses
    const reads = await withRpcRetry(() => this.chain.publicClient.multicall({
      contracts: [
        { address: odysseyBonding, abi: odysseyBondingPoolAbi, functionName: 'getPool', args: [token] },
        { address: odysseyReflection, abi: odysseyReflectionPoolAbi, functionName: 'getPool', args: [token] },
        { address: odysseyLegacy, abi: odysseyBondingPoolAbi, functionName: 'getPool', args: [token] },
      ],
      allowFailure: true,
    }))
    const factories = [odysseyBonding, odysseyReflection, odysseyLegacy]
    for (let i = 0; i < reads.length; i++) {
      const r = reads[i]!
      if (r.status === 'success' && (r.result as { creator: Address }).creator !== ZERO) {
        this.curveFactory.set(key, factories[i]!)
        return factories[i]!
      }
    }
    return null
  }

  /** Live curve state for a token. Null when the token has no curve. */
  async curveState(token: Address, factory?: Address): Promise<CurveState | null> {
    const f = factory ?? (await this.curveFactoryOf(token))
    if (!f) return null
    const isReflection = f.toLowerCase() === this.chain.addresses.odysseyReflection.toLowerCase()
    try {
      if (isReflection) {
        const p = await withRpcRetry(() => this.chain.publicClient.readContract({ address: f, abi: odysseyReflectionPoolAbi, functionName: 'getPool', args: [token] }))
        if (p.creator === ZERO) return null
        return { factory: f, creator: p.creator, completed: p.completed, virtualQuote: p.virtualQuote, virtualToken: p.virtualToken, virtualQuoteInit: p.virtualQuoteInit, realQuote: p.realQuote }
      }
      const p = await withRpcRetry(() => this.chain.publicClient.readContract({ address: f, abi: odysseyBondingPoolAbi, functionName: 'getPool', args: [token] }))
      if (p.creator === ZERO) return null
      return { factory: f, creator: p.creator, completed: p.completed, virtualQuote: p.virtualQuote, virtualToken: p.virtualToken, virtualQuoteInit: p.virtualQuoteInit, realQuote: p.realQuote }
    } catch {
      return null
    }
  }

  /** The curve's trading fee in bps (read once per hour; it is an owner setting, not a constant). */
  async curveFee(factory: Address): Promise<bigint> {
    if (this.curveFeeBps && Date.now() - this.curveFeeBps.at < 3_600_000) return this.curveFeeBps.value
    const fee = await withRpcRetry(() => this.chain.publicClient.readContract({ address: factory, abi: odysseyCurveAbi, functionName: 'feeBps' }))
    this.curveFeeBps = { value: fee, at: Date.now() }
    return fee
  }

  /** Mid price of one whole curve token in ETH from virtual reserves (18-decimal tokens). */
  async curveSpotEth(token: Address, factory?: Address): Promise<number | null> {
    const s = await this.curveState(token, factory)
    if (!s || s.virtualToken === 0n) return null
    return Number(formatUnits(s.virtualQuote, 18)) / Number(formatUnits(s.virtualToken, 18))
  }

  /** Executable ETH proceeds for selling `amount` of a curve token (after the curve fee). Null when the curve is gone. */
  async curveQuoteSell(factory: Address, token: Address, amount: bigint): Promise<bigint | null> {
    if (amount <= 0n) return 0n
    try {
      const [, , userGets] = await withRpcRetry(() => this.chain.publicClient.readContract({ address: factory, abi: odysseyCurveAbi, functionName: 'quoteSell', args: [token, amount] }))
      return userGets
    } catch {
      return null
    }
  }

  /**
   * Curve buy sizing: invert the constant product so `budgetWei` (fee included)
   * buys `tokensOut`, then confirm with the contract's own quoteBuy so the
   * number we send is exactly what the curve will honor. Returns null when the
   * curve is complete or the budget buys nothing.
   */
  async curveQuoteBuy(factory: Address, token: Address, budgetWei: bigint): Promise<{ tokensOut: bigint; totalIn: bigint; willGraduate: boolean } | null> {
    const s = await this.curveState(token, factory)
    if (!s || s.completed) return null
    const feeBps = await this.curveFee(factory)
    // totalIn = cost + ceil(cost * fee / 10000) + 1, so the largest cost that fits is a shade under budget * 10000 / (10000 + fee).
    const cost = (budgetWei * 10_000n) / (10_000n + feeBps) - 2n
    if (cost <= 0n) return null
    const out = s.virtualToken - (s.virtualQuote * s.virtualToken) / (s.virtualQuote + cost) - 1n
    if (out <= 0n) return null
    try {
      const [, , totalIn, actualOut, willGraduate] = await withRpcRetry(() => this.chain.publicClient.readContract({ address: factory, abi: odysseyCurveAbi, functionName: 'quoteBuy', args: [token, out] }))
      if (actualOut <= 0n) return null
      if (totalIn > budgetWei) {
        // Rounding pushed a wei over; step down until the contract agrees.
        const shrunk = actualOut - actualOut / 1000n
        const [, , totalIn2, actualOut2, willGraduate2] = await withRpcRetry(() => this.chain.publicClient.readContract({ address: factory, abi: odysseyCurveAbi, functionName: 'quoteBuy', args: [token, shrunk] }))
        if (totalIn2 > budgetWei || actualOut2 <= 0n) return null
        return { tokensOut: actualOut2, totalIn: totalIn2, willGraduate: willGraduate2 }
      }
      return { tokensOut: actualOut, totalIn, willGraduate }
    } catch {
      return null
    }
  }

  /** Executable ETH proceeds for selling `amount` of a pool token through QuoterV2 (single hop on its own pool). */
  async poolQuoteSell(pool: Address, token: Address, amount: bigint): Promise<bigint | null> {
    if (amount <= 0n) return 0n
    try {
      const info = await this.pool(pool)
      const tokenOut = info.token0.toLowerCase() === token.toLowerCase() ? info.token1 : info.token0
      const { result } = await withRpcRetry(() => this.chain.publicClient.simulateContract({
        address: this.chain.addresses.quoterV2,
        abi: quoterV2Abi,
        functionName: 'quoteExactInputSingle',
        args: [{ tokenIn: token, tokenOut, amountIn: amount, fee: info.fee, sqrtPriceLimitX96: 0n }],
      }))
      const out = result[0]
      if (tokenOut.toLowerCase() === this.chain.addresses.weth.toLowerCase()) return out
      if (tokenOut.toLowerCase() === this.chain.addresses.usdg.toLowerCase()) {
        const ethUsd = await this.ethUsd()
        if (!ethUsd || ethUsd <= 0) return null
        return BigInt(Math.floor((Number(formatUnits(out, 6)) / ethUsd) * 1e18))
      }
      return null
    } catch {
      return null
    }
  }

  /** Executable token amount for buying with `amountWei` of WETH through QuoterV2 on the token's own pool. */
  async poolQuoteBuy(pool: Address, token: Address, amountWei: bigint): Promise<{ amountOut: bigint; fee: number; quoteToken: Address } | null> {
    try {
      const info = await this.pool(pool)
      const tokenIn = info.token0.toLowerCase() === token.toLowerCase() ? info.token1 : info.token0
      if (tokenIn.toLowerCase() !== this.chain.addresses.weth.toLowerCase()) return null
      const { result } = await withRpcRetry(() => this.chain.publicClient.simulateContract({
        address: this.chain.addresses.quoterV2,
        abi: quoterV2Abi,
        functionName: 'quoteExactInputSingle',
        args: [{ tokenIn, tokenOut: token, amountIn: amountWei, fee: info.fee, sqrtPriceLimitX96: 0n }],
      }))
      return result[0] > 0n ? { amountOut: result[0], fee: info.fee, quoteToken: tokenIn } : null
    } catch {
      return null
    }
  }
}

/**
 * Price of token in quote units from a v3 sqrtPriceX96. sqrtP encodes
 * sqrt(token1/token0) in raw units; the decimals shift makes it whole units.
 */
export function priceFromSqrt(sqrtPriceX96: bigint, tokenIsToken0: boolean, tokenDecimals: number, quoteDecimals: number): number {
  const ratio = (Number(sqrtPriceX96) / Q96) ** 2 // token1 per token0, raw
  const raw = tokenIsToken0 ? ratio : 1 / ratio // quote per token, raw
  return raw * 10 ** (tokenDecimals - quoteDecimals)
}
