/**
 * Generic launch intake from pool creation. Every Uniswap v3 `PoolCreated`
 * and v4 `Initialize` whose one side is WETH, USDG or native ETH and whose
 * other side is a token deployed within the last `freshBlocks` becomes a
 * LaunchRecord: `launchpad` from the registry when the creating tx.to (or the
 * v4 hook) is a known launchpad, else 'direct'.
 *
 * Freshness and creator come from the token's creation record: Blockscout's
 * contract-creation entry (block + deployer) when it answers, else the first
 * mint (Transfer from the zero address) inside the freshness window, whose
 * transaction sender is the deployer. The public RPC is not an archive node
 * (eth_getCode at a past block answers "metadata is not found"), so code
 * presence at an earlier block cannot be the test. A token whose age cannot
 * be established is skipped and counted, never assumed fresh. The seed
 * liquidity is the quote the creating transaction moved into the pool.
 */
import { type Address, type Hash, type Hex, decodeEventLog, getAddress, parseAbiItem } from 'viem'
import { erc20Abi, erc20TransferEvent } from '../chain/abis.js'
import type { ChainClient } from '../chain/client.js'
import { errorText, withRpcRetry } from '../chain/client.js'
import { UNISWAP_V4, launchpadEntry, launchpadNameFor } from '../chain/launchpads.js'
import type { Prices } from '../chain/prices.js'
import type { DexPoolEvent, LaunchEvent } from '../chain/watchers.js'
import type { Logger } from '../log.js'

const ZERO = '0x0000000000000000000000000000000000000000'
const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')
const BLOCKSCOUT = 'https://robinhoodchain.blockscout.com'
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

export interface IntakeOptions {
  /** A token is a launch only if it had no code this many blocks before the pool (default 2000, about 3.5 minutes). */
  freshBlocks?: bigint
  onLaunch: (e: LaunchEvent) => void
  /** Already observed (a launchpad announced it itself); skip. */
  isKnownToken: (token: Address) => boolean
}

export interface IntakeStats {
  seen: number
  accepted: number
  skippedQuote: number
  skippedStale: number
  skippedKnown: number
  /** Neither Blockscout nor the mint history could establish the token's age. */
  skippedUnprovable: number
  errors: number
}

export type QuoteSide = 'WETH' | 'USDG' | 'ETH'

export class DirectLaunchIntake {
  private readonly freshBlocks: bigint
  private readonly stats: IntakeStats = { seen: 0, accepted: 0, skippedQuote: 0, skippedStale: 0, skippedKnown: 0, skippedUnprovable: 0, errors: 0 }

  constructor(private readonly chain: ChainClient, private readonly prices: Prices, private readonly log: Logger, private readonly opts: IntakeOptions) {
    this.freshBlocks = opts.freshBlocks ?? 2_000n
  }

  health(): IntakeStats {
    return { ...this.stats }
  }

  /** Which side is the quote, or null when the pair is not a launch pair. */
  classifyPair(e: Pick<DexPoolEvent, 'dex' | 'token0' | 'token1'>): { token: Address; quote: Address; quoteSide: QuoteSide; tokenIsToken0: boolean } | null {
    const weth = this.chain.addresses.weth.toLowerCase()
    const usdg = this.chain.addresses.usdg.toLowerCase()
    const side = (a: Address): QuoteSide | null => {
      const l = a.toLowerCase()
      if (l === weth) return 'WETH'
      if (l === usdg) return 'USDG'
      if (e.dex === 'v4' && l === ZERO) return 'ETH'
      return null
    }
    const s0 = side(e.token0)
    const s1 = side(e.token1)
    if (s0 && s1) return null
    if (s0) return { token: e.token1, quote: e.token0, quoteSide: s0, tokenIsToken0: false }
    if (s1) return { token: e.token0, quote: e.token1, quoteSide: s1, tokenIsToken0: true }
    return null
  }

  async onDexPool(e: DexPoolEvent): Promise<void> {
    this.stats.seen++
    const pair = this.classifyPair(e)
    if (!pair) {
      this.stats.skippedQuote++
      return
    }
    if (this.opts.isKnownToken(pair.token)) {
      this.stats.skippedKnown++
      return
    }
    try {
      const origin = await this.tokenOrigin(pair.token, e.blockNumber)
      if (origin.kind === 'unprovable') {
        this.stats.skippedUnprovable++
        this.log.info({ token: pair.token, tx: e.txHash }, 'pool intake: token age unprovable; skipped')
        return
      }
      if (e.blockNumber - origin.createdBlock > this.freshBlocks) {
        this.stats.skippedStale++
        return
      }
      if (this.opts.isKnownToken(pair.token)) {
        this.stats.skippedKnown++
        return
      }
      const [tx, receipt] = await Promise.all([
        withRpcRetry(() => this.chain.publicClient.getTransaction({ hash: e.txHash })),
        withRpcRetry(() => this.chain.publicClient.getTransactionReceipt({ hash: e.txHash })),
      ])
      const creatingTo = tx.to ? getAddress(tx.to) : null
      const launchpad = launchpadNameFor(creatingTo, e.hooks)
      const entry = launchpadEntry(creatingTo)
      const creator = { address: origin.creator, source: origin.kind }
      let seed = this.seedLiquidity(receipt.logs, pair, e)
      let seedSource: 'creating_tx' | 'pool_balance' | null = seed.raw != null ? 'creating_tx' : null
      if (seed.raw == null && e.dex === 'v3' && e.pool && pair.quoteSide !== 'ETH') {
        // Direct position-manager launches create the pool in one transaction and mint liquidity in the next;
        // the pool's quote balance is the seed once that mint has landed.
        try {
          const bal = await withRpcRetry(() => this.chain.publicClient.readContract({ address: pair.quote, abi: erc20Abi, functionName: 'balanceOf', args: [e.pool!] }))
          if (bal > 0n) { seed = { raw: bal }; seedSource = 'pool_balance' }
        } catch (err) {
          this.log.warn({ token: pair.token, err: errorText(err) }, 'pool quote balance unreadable; seed left null')
        }
      }
      let seedWei: bigint | null = seed.raw
      if (pair.quoteSide === 'USDG' && seed.raw != null) {
        const ethUsd = await this.prices.ethUsd()
        seedWei = ethUsd && ethUsd > 0 ? (seed.raw * 1_000_000_000_000n * 1_000_000n) / BigInt(Math.round(ethUsd * 1_000_000)) : null
      }
      if (pair.quoteSide === 'ETH' && seed.raw == null) seedWei = tx.value
      this.stats.accepted++
      this.opts.onLaunch({
        launchpad,
        token: pair.token,
        creator: creator.address,
        pool: e.dex === 'v3' ? e.pool : null,
        factory: creatingTo ?? pair.token,
        blockNumber: e.blockNumber,
        txHash: e.txHash,
        logIndex: e.logIndex,
        seenAt: e.seenAt,
        venue: e.dex === 'v3' ? 'pool' : 'v4',
        extra: {
          intake: 'pool_created',
          dex: e.dex,
          quote: pair.quote,
          quoteSide: pair.quoteSide,
          fee: e.fee,
          tickSpacing: e.tickSpacing,
          hooks: e.hooks,
          poolId: e.poolId,
          poolManager: e.dex === 'v4' ? UNISWAP_V4.poolManager : null,
          creatingTo,
          creatingFrom: getAddress(tx.from),
          creatingSelector: tx.input.slice(0, 10),
          creatingLabel: entry?.label ?? null,
          seedLiquidityWei: seedWei != null ? seedWei.toString() : null,
          seedLiquidityRaw: seed.raw != null ? seed.raw.toString() : null,
          seedSource,
          creatorSource: creator.source,
          tokenCreatedBlock: origin.createdBlock.toString(),
          tokenAgeBlocks: (e.blockNumber - origin.createdBlock).toString(),
        },
      })
    } catch (err) {
      this.stats.errors++
      this.log.warn({ token: pair.token, tx: e.txHash, err: errorText(err) }, 'pool intake failed')
    }
  }

  /** Quote units the creating transaction moved into the pool (v3) or the PoolManager (v4). Null when no transfer was found. */
  private seedLiquidity(logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[], pair: { quote: Address }, e: DexPoolEvent): { raw: bigint | null } {
    const target = (e.dex === 'v3' ? e.pool! : UNISWAP_V4.poolManager).toLowerCase()
    if (pair.quote.toLowerCase() === ZERO) return { raw: null }
    let sum = 0n
    let found = false
    for (const log of logs) {
      if (log.address.toLowerCase() !== pair.quote.toLowerCase()) continue
      try {
        const d = decodeEventLog({ abi: [erc20TransferEvent], data: log.data, topics: log.topics as [Hex, ...Hex[]] })
        const a = d.args as unknown as { from: Address; to: Address; value: bigint }
        if (a.to.toLowerCase() === target) { sum += a.value; found = true }
      } catch {
        // not a Transfer
      }
    }
    return { raw: found ? sum : null }
  }

  /**
   * When and by whom the token was deployed. Blockscout's contract-creation
   * record is exact (block + sender). Without it, the first mint inside the
   * freshness window dates the token and names its deployer through the
   * mint transaction's sender; a token with no mint in the window is either
   * older than the window or unreadable, and both are skipped.
   */
  private async tokenOrigin(token: Address, poolBlock: bigint): Promise<{ kind: 'blockscout' | 'first_mint_tx'; createdBlock: bigint; creator: Address } | { kind: 'unprovable' }> {
    try {
      const res = await fetch(`${BLOCKSCOUT}/api?module=contract&action=getcontractcreation&contractaddresses=${token}`, { headers: { 'user-agent': BROWSER_UA }, signal: AbortSignal.timeout(4_000) })
      if (res.ok) {
        const body = (await res.json()) as { result?: { contractCreator?: string; blockNumber?: string }[] | string }
        const rec = Array.isArray(body.result) ? body.result[0] : undefined
        if (rec?.contractCreator && /^0x[0-9a-fA-F]{40}$/.test(rec.contractCreator) && rec.blockNumber && /^\d+$/.test(rec.blockNumber)) {
          return { kind: 'blockscout', createdBlock: BigInt(rec.blockNumber), creator: getAddress(rec.contractCreator) }
        }
      }
    } catch {
      // fall through to chain history
    }
    try {
      const from = poolBlock > this.freshBlocks ? poolBlock - this.freshBlocks : 0n
      const mints = await withRpcRetry(() => this.chain.publicClient.getLogs({ address: token, event: transferEvent, args: { from: ZERO }, fromBlock: from, toBlock: poolBlock, strict: false }))
      const first = mints[0]
      if (first) {
        const tx = await withRpcRetry(() => this.chain.publicClient.getTransaction({ hash: first.transactionHash as Hash }))
        return { kind: 'first_mint_tx', createdBlock: first.blockNumber ?? poolBlock, creator: getAddress(tx.from) }
      }
      // A mint older than the window means an old token: date it as outside the window.
      const older = await withRpcRetry(() => this.chain.publicClient.getLogs({ address: token, event: transferEvent, args: { from: ZERO }, fromBlock: from > 200_000n ? from - 200_000n : 0n, toBlock: from, strict: false }))
      const old = older[0]
      if (old) {
        const tx = await withRpcRetry(() => this.chain.publicClient.getTransaction({ hash: old.transactionHash as Hash }))
        return { kind: 'first_mint_tx', createdBlock: old.blockNumber ?? 0n, creator: getAddress(tx.from) }
      }
    } catch (err) {
      this.log.warn({ token, err: errorText(err) }, 'mint-history lookup failed')
    }
    return { kind: 'unprovable' }
  }
}
