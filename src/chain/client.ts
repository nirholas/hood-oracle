/**
 * The one place that builds RPC clients. Every other chain module receives a
 * ChainClient and never constructs a transport of its own, so failover, nonce
 * management and batching are decided exactly once.
 */
import {
  createPublicClient, createWalletClient, custom, fallback, http, webSocket,
  type Account, type Chain, type EIP1193RequestFn, type PublicClient, type Transport, type WalletClient,
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

/**
 * JSON-RPC request batching stays OFF on purpose: under load the public RPC
 * answers a batch with a single error body instead of an array, and viem then
 * fails every request in that batch at once ("Cannot read properties of
 * undefined (reading 'error')"). Multicall3 read batching is unaffected: it is
 * one eth_call.
 */
const makeTransport = (url: string) =>
  url.startsWith('ws')
    ? webSocket(url, { timeout: 15_000, retryCount: 2, reconnect: true })
    : throttled(http(url, { timeout: 20_000, retryCount: 2 }))

/**
 * Process-wide pacing for HTTP JSON-RPC: at most `MAX_IN_FLIGHT` requests at
 * once and a short gap between dispatches. The public endpoint answers bursts
 * with 429 and Cloudflare challenges; spreading the same requests over a few
 * hundred milliseconds keeps them under its limit without changing what is
 * asked. Live trading paths issue a handful of calls at a time and are not
 * slowed by it; bulk history reads are.
 */
const MAX_IN_FLIGHT = 6
const MIN_GAP_MS = 25
let inFlight = 0
let lastDispatch = 0
const waiters: (() => void)[] = []

async function acquire(): Promise<void> {
  if (inFlight >= MAX_IN_FLIGHT) await new Promise<void>((resolve) => waiters.push(resolve))
  inFlight++
  const gap = lastDispatch + MIN_GAP_MS - Date.now()
  if (gap > 0) await sleep(gap)
  lastDispatch = Date.now()
}

function release(): void {
  inFlight--
  const next = waiters.shift()
  if (next) next()
}

/** Wrap a viem transport so every request passes through the pacing gate. */
function throttled(inner: Transport): Transport {
  return (config) => {
    const built = inner(config)
    const request: EIP1193RequestFn = (async (args: Parameters<EIP1193RequestFn>[0], options?: Parameters<EIP1193RequestFn>[1]) => {
      await acquire()
      try {
        return await built.request(args as never, options as never)
      } finally {
        release()
      }
    }) as EIP1193RequestFn
    return custom({ request }, { key: built.config.key, name: built.config.name, retryCount: 0 })(config)
  }
}

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
/**
 * Text that marks a server-side or transport condition worth retrying. The
 * last group matters on Robinhood Chain: the public RPC sits behind
 * Cloudflare and, under load, answers a JSON-RPC call with a "Just a moment"
 * challenge page, which viem reports as "HTTP request failed".
 */
const RETRYABLE_TEXT = /(fetch failed|socket hang up|econnreset|etimedout|econnrefused|eai_again|enotfound|timed out|timeout|rate limit|too many requests|service unavailable|bad gateway|reading 'error'|unknown rpc error|http request failed|just a moment|cloudflare|unexpected token '<')/i

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
export async function withRpcRetry<T>(fn: () => Promise<T>, { attempts = 8, baseDelayMs = 500, onRetry }: RetryOptions = {}): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (attempt === attempts || !isTransientRpcError(err)) throw err
      const delayMs = Math.min(15_000, Math.round(baseDelayMs * 2 ** (attempt - 1) * (1 + Math.random() * 0.4)))
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

/**
 * Probe every configured RPC so a dead rung shows up at boot, not mid-trade.
 * A challenge page, a 429 or a 5xx is retried with backoff (the public RPC
 * sheds load that way); only a rung that never answers eth_chainId is dead.
 */
export async function probeRpcUrls(urls: string[], { attempts = 6, baseDelayMs = 400 }: { attempts?: number; baseDelayMs?: number } = {}): Promise<{ url: string; ok: boolean; chainId: number | null; error: string | null; ms: number }[]> {
  return Promise.all(urls.map(async (url) => {
    const t = Date.now()
    if (url.startsWith('ws')) return { url, ok: true, chainId: null, error: null, ms: 0 }
    let error = 'unreachable'
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
          signal: AbortSignal.timeout(10_000),
        })
        const text = await res.text()
        let body: { result?: string; error?: { message?: string } } | null = null
        try { body = JSON.parse(text) as { result?: string; error?: { message?: string } } } catch { body = null }
        if (body?.result) return { url, ok: true, chainId: Number(body.result), error: null, ms: Date.now() - t }
        error = body?.error?.message ?? (text.includes('Just a moment') ? `cloudflare challenge (http ${res.status})` : `http ${res.status}: ${text.slice(0, 80)}`)
        if (body?.error && !isTransientRpcError({ code: (body.error as { code?: number }).code, message: body.error.message })) break
      } catch (err) {
        error = errorText(err)
        if (!isTransientRpcError(err) && (err as { name?: string }).name !== 'TimeoutError') break
      }
      if (attempt < attempts) await sleep(Math.round(baseDelayMs * 2 ** (attempt - 1) * (1 + Math.random() * 0.4)))
    }
    return { url, ok: false, chainId: null, error, ms: Date.now() - t }
  }))
}
