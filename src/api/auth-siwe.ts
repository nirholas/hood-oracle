/**
 * Wallet authentication: Sign-In With Ethereum (EIP-4361) over an HttpOnly
 * cookie session.
 *
 *   GET  /api/auth/nonce   single-use nonce + the pre-auth cookie it is bound to
 *   POST /api/auth/verify  { message, signature } -> session cookie
 *   POST /api/auth/logout  revokes the session
 *   GET  /api/auth/me      the connected address and its accounts
 *
 * What this does NOT do is take custody of anything. The signature proves an
 * address; it never moves funds, and the session it mints can only read and
 * write rows that belong to that address. Every on-chain action a user takes
 * (deploy, fund, policy, withdraw, revoke) is a transaction their own wallet
 * signs; the server only ever hands them unsigned calldata.
 *
 * Signature checking goes through the public client's `verifyMessage`, which
 * covers plain EOAs, EIP-1271 contract signatures (smart accounts, multisigs)
 * and ERC-6492 counterfactual ones. An EOA-only check would lock out exactly
 * the users this product is for, since a HoodArmAccount owner is very often a
 * smart account. When no chain client is configured the check degrades to the
 * EOA-only path rather than accepting anything: fail closed, never open.
 */
import { Hono } from 'hono'
import { getAddress, verifyMessage as verifyEoaMessage, type Address } from 'viem'
import { ApiError, badRequest } from './errors.js'
import { respond } from './json.js'
import type { AppDeps } from './deps.js'
import { clientIp, requestProtocol } from './middleware/client-ip.js'
import { createRateLimiter } from './middleware/rate-limit.js'
import {
  NONCE_COOKIE, SESSION_COOKIE, NONCE_TTL_MS, SESSION_TTL_MS,
  clearCookie, readCookie, serializeCookie,
} from '../accounts/session.js'
import { checkSiweMessage, parseSiweMessage, SiweParseError } from '../accounts/siwe.js'
import type { WalletSession } from '../types.js'
import type { MiddlewareHandler } from 'hono'

declare module 'hono' {
  interface ContextVariableMap {
    walletSession: WalletSession | undefined
  }
}

/** How stale a signed message may be when it arrives. Long enough for a hardware wallet, short enough to matter. */
export const MAX_MESSAGE_AGE_MS = 10 * 60_000
export const MAX_CLOCK_SKEW_MS = 2 * 60_000
/** Nonce and verify are cheap to call and expensive to serve; they get their own bucket. */
export const AUTH_READS_PER_MINUTE = 20
export const AUTH_WRITES_PER_MINUTE = 10

const secure = (c: Parameters<MiddlewareHandler>[0], trustProxy: boolean) => requestProtocol(c, trustProxy) === 'https'

/** The host this request arrived on, which is the only domain a SIWE message may claim by default. */
function requestHost(c: Parameters<MiddlewareHandler>[0], trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = c.req.header('x-forwarded-host')?.split(',')[0]?.trim()
    if (forwarded) return forwarded.toLowerCase()
  }
  const header = c.req.header('host')
  if (header) return header.toLowerCase()
  return new URL(c.req.url).host.toLowerCase()
}

function allowedDomains(deps: AppDeps, c: Parameters<MiddlewareHandler>[0]): string[] {
  const configured = deps.config.accounts.siweDomains
  return configured.length ? configured : [requestHost(c, deps.config.trustProxy)]
}

function store(deps: AppDeps) {
  if (!deps.sessions) {
    throw new ApiError(503, 'sessions_unavailable', 'Wallet sign-in is not available on this server: no session store is configured.')
  }
  return deps.sessions
}

/**
 * Resolve the session cookie on every /api request and hand a rotated cookie
 * back when one is due. Runs before the operator gate so a wallet session can
 * stand in for the operator token on the routes that check ownership.
 */
export function sessionContext(deps: AppDeps): MiddlewareHandler {
  return async (c, next) => {
    if (!deps.sessions) return next()
    const raw = readCookie(c.req.header('cookie'), SESSION_COOKIE)
    if (raw) {
      try {
        const resolved = await deps.sessions.resolve(raw)
        if (resolved) {
          c.set('walletSession', resolved.session)
          if (resolved.rotated) {
            c.header('Set-Cookie', serializeCookie(SESSION_COOKIE, resolved.rotated, {
              maxAgeSeconds: Math.floor((resolved.session.expiresAt.getTime() - Date.now()) / 1000),
              secure: secure(c, deps.config.trustProxy),
            }), { append: true })
          }
        }
      } catch (err) {
        deps.log.warn({ err: (err as Error).message }, 'session lookup failed; continuing unauthenticated')
      }
    }
    return next()
  }
}

/** The signed-in wallet, or null. */
export function currentSession(c: Parameters<MiddlewareHandler>[0]): WalletSession | null {
  return c.get('walletSession') ?? null
}

/** The signed-in wallet, or a 401 that says exactly how to get one. */
export function requireSession(c: Parameters<MiddlewareHandler>[0]): WalletSession {
  const session = currentSession(c)
  if (!session) {
    throw new ApiError(
      401,
      'wallet_unauthenticated',
      'This route needs a connected wallet. Call GET /api/auth/nonce, sign the returned EIP-4361 message with your wallet, and POST it to /api/auth/verify.',
    )
  }
  return session
}

/** True when the caller presented the operator token, which is the admin path over everything. */
export function isOperatorCall(c: Parameters<MiddlewareHandler>[0], deps: AppDeps): boolean {
  const token = deps.config.operatorToken
  if (!token) return false
  const header = c.req.header('authorization')
  const m = header ? /^Bearer\s+(.+)$/i.exec(header.trim()) : null
  return m ? m[1]!.trim() === token : false
}

async function readJson(c: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    throw badRequest('request body must be JSON')
  }
}

/**
 * Verify a personal_sign signature for `address`. Tries the chain-aware path
 * (EOA, EIP-1271, ERC-6492) and falls back to plain EOA recovery only when
 * there is no public client to ask.
 */
export async function verifyWalletSignature(
  deps: AppDeps,
  address: Address,
  message: string,
  signature: `0x${string}`,
): Promise<boolean> {
  const client = deps.accounts ? deps.accounts.publicClient : null
  if (client) {
    try {
      return await client.verifyMessage({ address, message, signature })
    } catch (err) {
      deps.log.warn({ err: (err as Error).message, address }, 'contract signature verification failed; falling back to EOA recovery')
    }
  }
  try {
    return await verifyEoaMessage({ address, message, signature })
  } catch {
    return false
  }
}

export function authRoutes(deps: AppDeps): Hono {
  const app = new Hono()
  const limiter = createRateLimiter({
    trustProxy: deps.config.trustProxy,
    readsPerMinute: deps.limits?.authReadsPerMinute ?? AUTH_READS_PER_MINUTE,
    writesPerMinute: deps.limits?.authWritesPerMinute ?? AUTH_WRITES_PER_MINUTE,
  })
  app.use('*', limiter.middleware)

  app.get('/nonce', async (c) => {
    const sessions = store(deps)
    const issued = await sessions.issueNonce()
    c.header('Set-Cookie', serializeCookie(NONCE_COOKIE, issued.cookie, {
      maxAgeSeconds: Math.floor(NONCE_TTL_MS / 1000),
      secure: secure(c, deps.config.trustProxy),
    }), { append: true })
    c.header('Cache-Control', 'no-store')
    return respond(c, {
      nonce: issued.nonce,
      expiresAt: issued.expiresAt.toISOString(),
      domain: allowedDomains(deps, c)[0]!,
      uri: `${requestProtocol(c, deps.config.trustProxy)}://${requestHost(c, deps.config.trustProxy)}`,
      chainId: deps.config.chainId,
      statement: 'Sign in to hood-oracle. This signature proves you control this address. It moves no funds and approves no transaction.',
    })
  })

  app.post('/verify', async (c) => {
    const sessions = store(deps)
    const body = await readJson(c)
    if (!body || typeof body !== 'object') throw badRequest('send { message, signature }')
    const { message, signature } = body as { message?: unknown; signature?: unknown }
    if (typeof message !== 'string') throw badRequest('message must be the EIP-4361 string your wallet signed')
    if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signature)) throw badRequest('signature must be 0x-prefixed hex')

    const burned = await sessions.consumeNonce(readCookie(c.req.header('cookie'), NONCE_COOKIE))
    if (!burned.ok) throw new ApiError(401, 'nonce_invalid', burned.reason)

    let parsed
    try {
      parsed = parseSiweMessage(message)
    } catch (err) {
      if (err instanceof SiweParseError) throw new ApiError(400, 'siwe_malformed', `That is not a valid EIP-4361 message: ${err.message}`)
      throw err
    }
    const check = checkSiweMessage(parsed, {
      allowedDomains: allowedDomains(deps, c),
      chainId: deps.config.chainId,
      expectedNonce: burned.nonce,
      maxIssuedAgeMs: MAX_MESSAGE_AGE_MS,
      maxClockSkewMs: MAX_CLOCK_SKEW_MS,
    })
    if (!check.ok) throw new ApiError(401, 'siwe_rejected', check.reason)

    const valid = await verifyWalletSignature(deps, parsed.address, message, signature as `0x${string}`)
    if (!valid) {
      throw new ApiError(401, 'signature_invalid', `That signature does not prove control of ${parsed.address}. Sign the exact message the nonce route returned, with that address selected in your wallet.`)
    }

    const issued = await sessions.create(parsed.address, parsed.chainId, c.req.header('user-agent') ?? null)
    c.header('Set-Cookie', serializeCookie(SESSION_COOKIE, issued.cookie, {
      maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000),
      secure: secure(c, deps.config.trustProxy),
    }), { append: true })
    c.header('Set-Cookie', clearCookie(NONCE_COOKIE, secure(c, deps.config.trustProxy)), { append: true })
    c.header('Cache-Control', 'no-store')
    deps.log.info({ address: parsed.address, ip: clientIp(c, deps.config.trustProxy) }, 'wallet signed in')
    return respond(c, {
      address: issued.session.address,
      chainId: issued.session.chainId,
      expiresAt: issued.session.expiresAt.toISOString(),
    })
  })

  app.post('/logout', async (c) => {
    const sessions = store(deps)
    const revoked = await sessions.revoke(readCookie(c.req.header('cookie'), SESSION_COOKIE))
    c.header('Set-Cookie', clearCookie(SESSION_COOKIE, secure(c, deps.config.trustProxy)), { append: true })
    return respond(c, { ok: true, revoked })
  })

  app.get('/me', async (c) => {
    const session = currentSession(c)
    c.header('Cache-Control', 'no-store')
    if (!session) return respond(c, { address: null, chainId: deps.config.chainId, accounts: [], operator: null, factory: deps.config.accounts.factory })
    const accounts = deps.accounts ? await deps.accounts.registry.listForOwner(session.address) : []
    return respond(c, {
      address: session.address,
      chainId: session.chainId,
      expiresAt: session.expiresAt.toISOString(),
      operator: deps.accounts?.registry.operatorAddress ?? null,
      factory: deps.config.accounts.factory,
      accounts: accounts.map((a) => ({
        id: a.id,
        address: a.accountAddress,
        status: a.status,
        label: a.label,
        lastSyncedAt: a.lastSyncedAt ? a.lastSyncedAt.toISOString() : null,
      })),
    })
  })

  return app
}

export { getAddress }
