/**
 * The one place that builds RPC clients. Every other chain module receives a
 * ChainClient and never constructs a transport of its own, so failover, nonce
 * management and batching are decided exactly once.
 */
import {
  createPublicClient, createWalletClient, fallback, http, webSocket,
  type Account, type Chain, type PublicClient, type Transport, type WalletClient,
} from 'viem'
import { privateKeyToAccount, nonceManager } from 'viem/accounts'
import { robinhood, robinhoodTestnet } from 'viem/chains'
import {
  createHoodClient, MAINNET_ADDRESSES, TESTNET_ADDRESSES, NOXA_ADDRESSES, ODYSSEY_ADDRESSES, swapAddresses,
  type HoodClient,
} from 'hoodchain'
import type { Address } from 'viem'
import type { Config } from '../config.js'
import type { Network } from '../types.js'

export interface ChainAddresses {
  usdg: Address
  weth: Address
  uniswapV3Factory: Address
  quoterV2: Address
  /** The swap router for this network (SwapRouter02 on mainnet, classic SwapRouter on testnet). */
  router: Address
  routerKind: 'swapRouter02' | 'swapRouter'
  multicall3: Address
  noxaFactory: Address
  odysseyBonding: Address
  odysseyReflection: Address
  odysseyInstant: Address
  odysseyLegacy: Address
}

export interface ChainClient {
  network: Network
  chainId: number
  chain: Chain
  rpcUrls: string[]
  hood: HoodClient
  publicClient: PublicClient<Transport, Chain>
  walletClient: WalletClient<Transport, Chain, Account> | null
  account: Account | null
  addresses: ChainAddresses
}

const makeTransport = (url: string) =>
  url.startsWith('ws')
    ? webSocket(url, { timeout: 15_000, retryCount: 2, reconnect: true })
    : http(url, { timeout: 20_000, retryCount: 2, batch: { batchSize: 100, wait: 8 } })

/**
 * Build the chain client from config. `rpcUrls` already ends with the public
 * endpoint (config.ts guarantees it), so the fallback always has a last rung.
 * `rank: false` keeps the operator's order: an accelerator URL listed first
 * stays first instead of being demoted by a latency sample.
 */
export function createChainClient(config: Pick<Config, 'network' | 'rpcUrls' | 'traderPrivateKey'>): ChainClient {
  const chain = config.network === 'testnet' ? robinhoodTestnet : robinhood
  const transport = fallback(config.rpcUrls.map(makeTransport), { rank: false, retryCount: 1 })
  const account = config.traderPrivateKey ? privateKeyToAccount(config.traderPrivateKey, { nonceManager }) : null
  const hood = createHoodClient({ chain: config.network, transport, ...(account ? { account } : {}) })
  const publicClient = createPublicClient({ chain, transport, batch: { multicall: true } })
  const walletClient = account ? createWalletClient({ chain, transport, account }) : null
  const base = config.network === 'testnet' ? TESTNET_ADDRESSES : MAINNET_ADDRESSES
  const swap = swapAddresses(hood)
  return {
    network: config.network,
    chainId: chain.id,
    chain,
    rpcUrls: config.rpcUrls,
    hood,
    publicClient,
    walletClient,
    account,
    addresses: {
      usdg: base.usdg,
      weth: base.weth,
      uniswapV3Factory: base.uniswapV3Factory,
      quoterV2: swap.quoterV2,
      router: swap.router,
      routerKind: swap.routerKind,
      multicall3: base.multicall3,
      noxaFactory: NOXA_ADDRESSES.launchFactory,
      odysseyBonding: ODYSSEY_ADDRESSES.bondingCurveFactory,
      odysseyReflection: ODYSSEY_ADDRESSES.reflectionFactory,
      odysseyInstant: ODYSSEY_ADDRESSES.instantFactory,
      odysseyLegacy: ODYSSEY_ADDRESSES.legacyFactory,
    },
  }
}

// ── transient RPC failures ────────────────────────────────────────────────────
// The public RPC sheds load by answering a valid request with JSON-RPC -32602
// ("Missing or invalid parameters", "log query timed out", "logs matched by
// query exceeds limit") and with HTTP 429. viem never retries -32602 because it
// classifies it as a caller mistake, so bulk reads go through withRpcRetry.

const RETRYABLE_CODES = new Set([-1, -32005, -32603, -32602, 429])
const RETRYABLE_STATUS = new Set([408, 413, 429, 500, 502, 503, 504])
const RETRYABLE_TEXT = /(fetch failed|socket hang up|econnreset|etimedout|econnrefused|eai_again|enotfound|timed out|timeout|rate limit|too many requests|service unavailable|bad gateway)/i

export function isTransientRpcError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  if ((err as { name?: string }).name === 'AbortError') return false
  let e: unknown = err
  for (let depth = 0; e && typeof e === 'object' && depth < 5; depth++) {
    const o = e as { code?: unknown; status?: unknown; message?: unknown; details?: unknown; cause?: unknown }
    if (typeof o.code === 'number' && RETRYABLE_CODES.has(o.code)) return true
    if (typeof o.status === 'number' && RETRYABLE_STATUS.has(o.status)) return true
    if (typeof o.code === 'string' && RETRYABLE_TEXT.test(o.code)) return true
    if (typeof o.message === 'string' && RETRYABLE_TEXT.test(o.message)) return true
    if (typeof o.details === 'string' && RETRYABLE_TEXT.test(o.details)) return true
    e = o.cause
  }
  return false
}

/** The RPC refused the log query because too many logs matched or it ran too long: shrink the range. */
export function isLogRangeTooWide(err: unknown): boolean {
  let e: unknown = err
  for (let depth = 0; e && typeof e === 'object' && depth < 5; depth++) {
    const o = e as { message?: unknown; details?: unknown; cause?: unknown }
    const text = `${typeof o.message === 'string' ? o.message : ''} ${typeof o.details === 'string' ? o.details : ''}`
    if (/exceeds limit|query timed out|block range|too many|response size|query returned more than/i.test(text)) return true
    e = o.cause
  }
  return false
}

export const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms).unref?.() })

export interface RetryOptions {
  attempts?: number
  baseDelayMs?: number
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void
}

/** Run an RPC read, retrying transient failures with exponential backoff and jitter. */
export async function withRpcRetry<T>(fn: () => Promise<T>, { attempts = 4, baseDelayMs = 250, onRetry }: RetryOptions = {}): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (attempt === attempts || !isTransientRpcError(err)) throw err
      const delayMs = Math.round(baseDelayMs * 2 ** (attempt - 1) * (1 + Math.random() * 0.4))
      onRetry?.({ attempt, delayMs, error: err })
      await sleep(delayMs)
    }
  }
  throw lastError
}

/** One-line error text for logs and journal rows. */
export function errorText(err: unknown): string {
  if (!err) return 'unknown error'
  if (typeof err === 'string') return err
  const o = err as { shortMessage?: string; message?: string }
  return String(o.shortMessage || o.message || err).split('\n')[0]!.slice(0, 300)
}

/** Bounded-concurrency map: a burst of address lookups must not become a request storm. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!, i)
    }
  })
  await Promise.all(workers)
  return out
}

/** Probe every configured RPC once so a dead rung shows up at boot, not mid-trade. */
export async function probeRpcUrls(urls: string[]): Promise<{ url: string; ok: boolean; chainId: number | null; error: string | null; ms: number }[]> {
  return Promise.all(urls.map(async (url) => {
    const t = Date.now()
    if (url.startsWith('ws')) return { url, ok: true, chainId: null, error: null, ms: 0 }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
        signal: AbortSignal.timeout(10_000),
      })
      const body = (await res.json()) as { result?: string; error?: { message?: string } }
      if (body.error) return { url, ok: false, chainId: null, error: body.error.message ?? 'rpc error', ms: Date.now() - t }
      return { url, ok: true, chainId: Number(body.result ?? 0), error: null, ms: Date.now() - t }
    } catch (err) {
      return { url, ok: false, chainId: null, error: errorText(err), ms: Date.now() - t }
    }
  }))
}
