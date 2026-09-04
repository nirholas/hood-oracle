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
    const head = await c.publicClient.getBlockNumber()
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
    const amountIn = parseEther('0.001')
    const q = await v4.quoteBuy(pool!, amountIn)
    expect(q).not.toBeNull()
    expect(q!.amountOut).toBeGreaterThan(0n)
    const spot = await v4.spotInQuote(pool!, 18)
    expect(spot).not.toBeNull()
    const impliedTokens = Number(amountIn) / 1e18 / spot!
    log.info({ token: pool!.token, poolId: pool!.poolId, quoteOut: q!.amountOut.toString(), spotEthPerToken: spot, impliedAtMid: impliedTokens }, 'v4 quote')
    // pinned single-block simulation: buy, read balance, approve token to Permit2, Permit2 allowance to the router, sell everything
    const sender: Address = '0x1111111111111111111111111111111111111111'
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600)
    const buy = buildV4Buy(pool!, amountIn, 0n, deadline)
    const balData = `0x70a08231${sender.slice(2).padStart(64, '0')}` as Hex
    const sim = async (calls: { to: Address; data: Hex; value?: Hex }[], block: Hex | 'latest') => withRpcRetry(async () => (await c.publicClient.request({ method: 'eth_simulateV1' as never, params: [{ blockStateCalls: [{ stateOverrides: { [sender]: { balance: toHex(parseEther('1')) } }, calls: calls.map((x) => ({ from: sender, ...x })) }], validation: false }, block] as never })) as { number: Hex; calls: { status: Hex; returnData: Hex; error?: { message?: string } }[] }[])
    const ethBalance = { to: c.addresses.multicall3, data: encodeFunctionData({ abi: parseAbi(['function getEthBalance(address addr) view returns (uint256)']), functionName: 'getEthBalance', args: [sender] }) }
    const first = (await sim([{ to: buy.to, data: buy.data, value: toHex(buy.value) }, { to: pool!.token, data: balData }], 'latest'))[0]!
    expect(first.calls[0]!.status, first.calls[0]!.error?.message).toBe('0x1')
    const bought = BigInt(first.calls[1]!.returnData)
    expect(bought).toBeGreaterThan(0n)
    const pinned = toHex(BigInt(first.number) - 1n)
    const approvals = permit2ApprovalCalls(pool!.token)
    const sell = buildV4Sell(pool!, bought, 0n, deadline)
    const second = (await sim([ethBalance, { to: buy.to, data: buy.data, value: toHex(buy.value) }, ...approvals, ethBalance, { to: sell.to, data: sell.data }, ethBalance], pinned))[0]!
    for (const [i, call] of second.calls.entries()) expect(call.status, `call ${i}: ${call.error?.message}`).toBe('0x1')
    const before = BigInt(second.calls[0]!.returnData)
    const afterBuy = BigInt(second.calls[4]!.returnData)
    const afterSell = BigInt(second.calls[6]!.returnData)
    const spent = before - afterBuy
    const received = afterSell - afterBuy
    const loss = 1 - Number(received) / Number(spent)
    log.info({ bought: bought.toString(), spentEth: formatEther(spent), receivedEth: formatEther(received), roundTripLoss: loss }, 'v4 round trip simulated')
    expect(spent).toBe(amountIn)
    expect(received).toBeGreaterThan(0n)
    expect(Number.isFinite(loss)).toBe(true)
    expect(loss).toBeGreaterThanOrEqual(0)
    expect(loss).toBeLessThan(1)
    expect(decodeExecute(sell.data).commands).toBe(toHex(UR_COMMAND.V4_SWAP, { size: 1 }))
    expect(formatEther(amountIn)).toBe('0.001')
    // the firewall runs the same round trip and must agree
    const prices = new Prices(c)
    const a = await assessTradeSafety({ chain: c, prices, log, network: 'mainnet', token: pool!.token, venue: 'v4', pool: null, factory: null, v4Pool: pool!, amountWei: amountIn, deployer: null })
    const rt = a.checks.find((x) => x.check === 'round_trip')
    log.info({ verdict: a.verdict, score: a.score, loss: a.roundTripLossPct, checks: a.checks.map((x) => `${x.check}:${x.status} ${x.reason}`) }, 'firewall on the v4 lunch pool')
    expect(rt?.status, rt?.reason).toBe('pass')
    expect(a.roundTripLossPct).not.toBeNull()
    expect(Number.isFinite(a.roundTripLossPct!)).toBe(true)
    expect(Math.abs(a.roundTripLossPct! - loss)).toBeLessThan(0.02)
    expect(a.checks.find((x) => x.check === 'liquidity')?.status).toBe('pass')
  }), 300_000)
})
