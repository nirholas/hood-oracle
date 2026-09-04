import type { ApiErrorBody } from '../../src/api/contract'

const TOKEN_KEY = 'hood-oracle:operator-token'
const DEFAULT_TIMEOUT_MS = 12_000

export interface ApiResult<T> {
  ok: boolean
  status: number
  data: T | null
  error: ApiErrorBody | null
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    // storage blocked: the token lives for this page only
  }
  for (const fn of tokenListeners) fn(token)
}

const tokenListeners = new Set<(token: string | null) => void>()
export function onTokenChange(fn: (token: string | null) => void): () => void {
  tokenListeners.add(fn)
  return () => tokenListeners.delete(fn)
}

/**
 * True once a wallet session cookie is known to exist. A signed-in wallet
 * authenticates writes on its own accounts with that cookie, so `write` must
 * not demand an operator token it will never need.
 */
let walletSession = false
export function setWalletSession(active: boolean): void {
  walletSession = active
}
export function hasWalletSession(): boolean {
  return walletSession
}

/** The shell registers the key dialog here; `write` uses it on a 401. */
let tokenPrompt: ((reason: string) => Promise<boolean>) | null = null
export function setTokenPrompt(fn: (reason: string) => Promise<boolean>): void {
  tokenPrompt = fn
}
export function requestToken(reason: string): Promise<boolean> {
  return tokenPrompt ? tokenPrompt(reason) : Promise.resolve(false)
}

export interface ApiInit {
  method?: string
  body?: unknown
  timeout?: number
  signal?: AbortSignal
  auth?: boolean
}

export async function api<T>(path: string, init: ApiInit = {}): Promise<ApiResult<T>> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), init.timeout ?? DEFAULT_TIMEOUT_MS)
  if (init.signal) init.signal.addEventListener('abort', () => ctrl.abort(), { once: true })
  const headers: Record<string, string> = { accept: 'application/json' }
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  if (init.auth) {
    const token = getToken()
    if (token) headers.authorization = `Bearer ${token}`
  }
  try {
    const res = await fetch(path, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: ctrl.signal,
      credentials: 'same-origin',
    })
    const text = await res.text()
    let parsed: unknown = null
    if (text) {
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = null
      }
    }
    if (res.ok) return { ok: true, status: res.status, data: parsed as T, error: null }
    const err = (parsed && typeof parsed === 'object' && 'error' in (parsed as object))
      ? (parsed as ApiErrorBody)
      : { error: `http_${res.status}`, message: text.slice(0, 200) || res.statusText || `HTTP ${res.status}` }
    return { ok: false, status: res.status, data: null, error: err }
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === 'AbortError'
    return {
      ok: false,
      status: 0,
      data: null,
      error: { error: aborted ? 'timeout' : 'network', message: aborted ? 'The request timed out.' : 'Could not reach the hood-oracle API. Is the engine running?' },
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Authenticated write. Prompts for the operator key when none is stored and
 * no wallet session is signed in, or when the server rejects it, then retries
 * once. A 503 (no OPERATOR_TOKEN on the
 * server) is returned as-is: the operator has to fix the server, not the key.
 */
export async function write<T>(path: string, body?: unknown, method = 'POST'): Promise<ApiResult<T>> {
  if (!getToken() && !walletSession) {
    const got = await requestToken('This action needs the operator token.')
    if (!got) return { ok: false, status: 0, data: null, error: { error: 'cancelled', message: 'Cancelled: no operator token entered.' } }
  }
  let res = await api<T>(path, { method, body, auth: true })
  if (res.status === 401) {
    const got = await requestToken(res.error?.message ?? 'The operator token was rejected. Enter it again.')
    if (!got) return res
    res = await api<T>(path, { method, body, auth: true })
  }
  return res
}

export function errorMessage(r: ApiResult<unknown>, fallback = 'Something went wrong.'): string {
  return r.error?.message || fallback
}
