/**
 * Uniswap v4 on 4663: pool id maths and UniversalRouter calldata (pure), then
 * a live quote plus a pinned buy-then-sell simulation (no broadcast) on the
 * newest LunchTaxHook launch that has liquidity. Live parts skip with a
 * logged reason when the RPC is unreachable.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { encodeFunctionData, getAddress, parseAbi, parseEther, formatEther, toHex, type Address, type Hash, type Hex } from 'viem'
import { createChainClient, probeRpcUrls, withRpcRetry, type ChainClient } from '../src/chain/client.js'
import { uniswapV4InitializeEvent } from '../src/chain/abis.js'
import { PUBLIC_RPC } from '../src/config.js'
import { ADDRESS_THIS, MSG_SENDER, NATIVE, UR_COMMAND, V4, V4_ADDRESSES, buildV4Buy, buildV4Sell, decodeExecute, permit2ApprovalCalls, poolIdOf, v4PoolFromLaunch, type V4Pool } from '../src/chain/v4.js'
import { log } from '../src/log.js'
import { withLiveLock } from './live-lock.js'
import { Prices } from '../src/chain/prices.js'
import { assessTradeSafety } from '../src/guards/firewall.js'

const LUNCH_HOOK: Address = '0xf7521cf0bb7c11e2d2794189412614cf2e29a0cc'
let chain: ChainClient | null = null
let reason = ''

beforeAll(async () => {
  const c = createChainClient({ network: 'mainnet', rpcUrls: [PUBLIC_RPC.mainnet], traderPrivateKey: null })
  const [probe] = await probeRpcUrls(c.rpcUrls)
  if (!probe?.ok) {
    reason = `RPC unreachable: ${probe?.error ?? 'no probe'}`
    log.warn({ reason }, 'v4 integration tests skipped')
    return
  }
  chain = c
}, 60_000)

const live = (fn: (c: ChainClient) => Promise<void>) => async () => {
  if (!chain) {
    log.warn({ reason }, 'skipped')
    return
  }
  await withLiveLock(() => fn(chain!))
}

describe('v4 calldata (pure)', () => {
  const token = '0x5E893D118F07720AD6c7bA0A01d94877f5c00123' as Address
  const key = { currency0: NATIVE, currency1: token, fee: 3000, tickSpacing: 200, hooks: LUNCH_HOOK }
  it('derives the pool id the PoolManager announced for the CLAWD lunch pool', () => {
    expect(poolIdOf(key)).toBe('0xf69b9f9357c849974d707acbc65ed4ea888eb158292ec50521162b347a8eb9c2')
  })
  it('rebuilds the pool from launch metadata and rejects a mismatching pool id', () => {
    const meta = { quote: NATIVE, quoteSide: 'ETH', fee: 3000, tickSpacing: 200, hooks: LUNCH_HOOK, poolId: poolIdOf(key) }
    const pool = v4PoolFromLaunch({ token, metadata: meta }, { weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' })
    expect(pool?.quoteSide).toBe('native')
    expect(pool?.tokenIsCurrency0).toBe(false)
    expect(v4PoolFromLaunch({ token, metadata: { ...meta, poolId: `0x${'11'.repeat(32)}` } }, { weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' })).toBeNull()
  })
  it('encodes native, WETH and USDG buys and sells that decode back to the documented commands', () => {
    const native: V4Pool = { key, poolId: poolIdOf(key), token, quote: NATIVE, quoteSide: 'native', tokenIsCurrency0: false }
    const buy = buildV4Buy(native, parseEther('0.01'), 1n, 100n)
    expect(buy.value).toBe(parseEther('0.01'))
    expect(decodeExecute(buy.data).commands).toBe(toHex(UR_COMMAND.V4_SWAP, { size: 1 }))
    const sell = buildV4Sell(native, 5n, 1n, 100n)
    expect(sell.value).toBe(0n)
    expect(decodeExecute(sell.data).inputs.length).toBe(1)
    const weth = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as Address
    const wethPool: V4Pool = { key: { ...key, currency0: weth }, poolId: `0x${'00'.repeat(32)}` as Hash, token, quote: weth, quoteSide: 'weth', tokenIsCurrency0: false }
    const wbuy = decodeExecute(buildV4Buy(wethPool, 7n, 1n, 100n).data)
    expect(wbuy.commands).toBe(`0x${UR_COMMAND.WRAP_ETH.toString(16).padStart(2, '0')}${UR_COMMAND.V4_SWAP.toString(16).padStart(2, '0')}`)
    expect(wbuy.inputs[0]!.toLowerCase()).toContain(ADDRESS_THIS.slice(2).toLowerCase())
    const wsell = decodeExecute(buildV4Sell(wethPool, 7n, 1n, 100n).data)
    expect(wsell.commands).toBe(`0x${UR_COMMAND.V4_SWAP.toString(16).padStart(2, '0')}${UR_COMMAND.UNWRAP_WETH.toString(16).padStart(2, '0')}`)
    expect(wsell.inputs[1]!.toLowerCase()).toContain(MSG_SENDER.slice(2).toLowerCase())
    const approvals = permit2ApprovalCalls(token)
    expect(approvals[0]!.to).toBe(token)
    expect(approvals[1]!.to).toBe(V4_ADDRESSES.permit2)
  })
})

describe('v4 live', () => {
  it('quotes and simulates a buy then sell through the UniversalRouter on the newest lunch-hook launch with liquidity', live(async (c) => {
    const v4 = new V4(c)
    const head = await withRpcRetry(() => c.publicClient.getBlockNumber())
    const inits = await withRpcRetry(() => c.publicClient.getLogs({ address: V4_ADDRESSES.poolManager, event: uniswapV4InitializeEvent, fromBlock: head - 400_000n, toBlock: head }))
    const lunch = inits.filter((l) => (l.args.hooks ?? '').toLowerCase() === LUNCH_HOOK && l.args.currency0 === NATIVE).reverse()
    let pool: V4Pool | null = null
    for (const l of lunch) {
      const liq = await v4.liquidity(l.args.id!)
      if (liq && liq > 0n) {
        const key = { currency0: NATIVE, currency1: getAddress(l.args.currency1!), fee: l.args.fee!, tickSpacing: l.args.tickSpacing!, hooks: getAddress(l.args.hooks!) }
        pool = { key, poolId: l.args.id!, token: key.currency1, quote: NATIVE, quoteSide: 'native', tokenIsCurrency0: false }
        break
      }
    }
    expect(pool, 'a native lunch pool with liquidity').not.toBeNull()

    // 1. the v4 quoter prices the buy, and the StateView mid agrees with it within an order of magnitude
    const amountIn = parseEther('0.001')
    const q = await v4.quoteBuy(pool!, amountIn)
    expect(q).not.toBeNull()
    expect(q!.amountOut).toBeGreaterThan(0n)
    const spot = await v4.spotInQuote(pool!, 18)
    expect(spot).not.toBeNull()
    const atMid = Number(amountIn) / 1e18 / spot!
    const executed = Number(q!.amountOut) / 1e18
    expect(executed).toBeLessThanOrEqual(atMid * 1.05)
    expect(executed).toBeGreaterThan(atMid / 10)
    log.info({ token: pool!.token, poolId: pool!.poolId, quotedTokens: executed, tokensAtMid: atMid, spotEthPerToken: spot }, 'v4 quote')

    // 2. the calldata this path would broadcast decodes back to the documented router commands
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600)
    const buy = buildV4Buy(pool!, amountIn, (q!.amountOut * 9_500n) / 10_000n, deadline)
    const sell = buildV4Sell(pool!, q!.amountOut, 0n, deadline)
    expect(buy.to).toBe(V4_ADDRESSES.universalRouter)
    expect(buy.value).toBe(amountIn)
    expect(decodeExecute(buy.data).commands).toBe(toHex(UR_COMMAND.V4_SWAP, { size: 1 }))
    expect(decodeExecute(buy.data).deadline).toBe(deadline)
    expect(sell.value).toBe(0n)
    expect(decodeExecute(sell.data).commands).toBe(toHex(UR_COMMAND.V4_SWAP, { size: 1 }))

    // 3. the firewall simulates the real buy-then-sell through this same router (no broadcast) and measures the
    //    round trip from the probe wallet's own ETH balance, so the hook's tax is inside the number.
    //    A transport failure is retried: the public RPC throttles heavy eth_simulateV1 calls.
    const prices = new Prices(c)
    let assessment = null
    for (let attempt = 1; attempt <= 3; attempt++) {
      assessment = await assessTradeSafety({ chain: c, prices, log, network: 'mainnet', token: pool!.token, venue: 'v4', pool: null, factory: null, v4Pool: pool!, amountWei: amountIn, deployer: null })
      const check = assessment.checks.find((x) => x.check === 'round_trip')
      if (check?.status !== 'unavailable') break
      log.warn({ attempt, reason: check.reason }, 'v4 firewall round trip unavailable; retrying')
      await new Promise((r) => setTimeout(r, 2_000 * attempt))
    }
    const rt = assessment!.checks.find((x) => x.check === 'round_trip')
    log.info({ verdict: assessment!.verdict, score: assessment!.score, loss: assessment!.roundTripLossPct, checks: assessment!.checks.map((x) => `${x.check}:${x.status} ${x.reason}`) }, 'v4 firewall round trip')
    expect(rt?.status, rt?.reason).toBe('pass')
    const loss = assessment!.roundTripLossPct
    expect(loss).not.toBeNull()
    expect(Number.isFinite(loss!)).toBe(true)
    expect(loss!).toBeGreaterThanOrEqual(0)
    expect(loss!).toBeLessThan(1)
    expect(assessment!.checks.find((x) => x.check === 'liquidity')?.status).toBe('pass')
    expect(['allow', 'warn']).toContain(assessment!.verdict)
  }), 300_000)
})
