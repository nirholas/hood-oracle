/**
 * Wallet sign-in state: single-use nonces and rotating server-side sessions.
 *
 * The browser never holds anything meaningful. A session cookie is
 * `<id>.<secret>.<hmac>`; the database stores only SHA-256 of the secret, so a
 * dump of the `sessions` table cannot be replayed as a login, and the HMAC
 * lets a forged cookie be thrown away before it costs a query. The secret is
 * re-minted whenever a session has been idle past {@link ROTATE_AFTER_MS}, so
 * a cookie captured once does not stay valid for the whole seven days.
 *
 * Nonces are bound to the pre-auth cookie that carried them rather than to an
 * IP: mobile wallets switch networks between "get the nonce" and "here is the
 * signature" constantly, and an IP binding would reject exactly the users who
 * did nothing wrong. The binding secret is what makes the nonce single-browser
 * as well as single-use.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, eq, isNull, lt, sql } from 'drizzle-orm'
import { getAddress } from 'viem'
import type { Address } from 'viem'
import type { Db } from '../db/client.js'
import { authNonces, sessions } from '../db/schema.js'
import type { WalletSession } from '../types.js'

export const NONCE_COOKIE = 'hood_siwe'
export const SESSION_COOKIE = 'hood_session'
export const NONCE_TTL_MS = 10 * 60_000
export const SESSION_TTL_MS = 7 * 24 * 60 * 60_000
export const ROTATE_AFTER_MS = 12 * 60 * 60_000

const sha256 = (v: string): string => createHash('sha256').update(v).digest('hex')

function hmac(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex').slice(0, 32)
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab)
    return false
  }
  return timingSafeEqual(ab, bb)
}

/** `<id>.<secret>.<hmac>`; anything else is not a cookie this server minted. */
export function signCookie(id: string, secret: string, key: string): string {
  return `${id}.${secret}.${hmac(key, `${id}.${secret}`)}`
}

export function parseCookieValue(raw: string | undefined, key: string): { id: string; secret: string } | null {
  if (!raw) return null
  const parts = raw.split('.')
  if (parts.length !== 3) return null
  const [id, secret, sig] = parts as [string, string, string]
  if (!/^[0-9a-f-]{36}$/.test(id) || !/^[0-9a-f]{32,128}$/.test(secret)) return null
  if (!constantTimeEqual(sig, hmac(key, `${id}.${secret}`))) return null
  return { id, secret }
}

export interface SessionStoreOptions {
  db: Db
  /** HMAC key for cookie signatures (config.accounts.sessionSecret). */
  key: string
  now?: () => number
}

export interface IssuedNonce {
  nonce: string
  cookie: string
  expiresAt: Date
}

export interface IssuedSession {
  session: WalletSession
  cookie: string
}

export class SessionStore {
  private readonly db: Db
  private readonly key: string
  private readonly now: () => number

  constructor(opts: SessionStoreOptions) {
    this.db = opts.db
    this.key = opts.key
    this.now = opts.now ?? (() => Date.now())
  }

  // ── nonces ────────────────────────────────────────────────────────────────

  /** Mint a single-use nonce and the pre-auth cookie it is bound to. */
  async issueNonce(): Promise<IssuedNonce> {
    const nonce = randomBytes(16).toString('hex')
    const secret = randomBytes(32).toString('hex')
    const expiresAt = new Date(this.now() + NONCE_TTL_MS)
    const [row] = await this.db
      .insert(authNonces)
      .values({ nonce, secretHash: sha256(secret), issuedAt: new Date(this.now()), expiresAt })
      .returning({ id: authNonces.id })
    return { nonce, cookie: signCookie(row!.id, secret, this.key), expiresAt }
  }

  /**
   * Burn the nonce this browser was issued, returning it when it is genuinely
   * this browser's, unconsumed and unexpired. The consume is a conditional
   * UPDATE, so two concurrent verifies of the same nonce cannot both win.
   */
  async consumeNonce(cookieValue: string | undefined): Promise<{ ok: true; nonce: string } | { ok: false; reason: string }> {
    const parsed = parseCookieValue(cookieValue, this.key)
    if (!parsed) return { ok: false, reason: 'no sign-in nonce cookie: request GET /api/auth/nonce first, with cookies enabled' }
    const [row] = await this.db.select().from(authNonces).where(eq(authNonces.id, parsed.id)).limit(1)
    if (!row) return { ok: false, reason: 'that sign-in nonce is unknown; request a fresh one' }
    if (!constantTimeEqual(row.secretHash, sha256(parsed.secret))) return { ok: false, reason: 'the sign-in nonce cookie does not match the nonce it names' }
    if (row.consumedAt) return { ok: false, reason: 'that nonce has already been used; request a fresh one' }
    if (row.expiresAt.getTime() <= this.now()) return { ok: false, reason: 'that nonce has expired; request a fresh one' }
    const burned = await this.db
      .update(authNonces)
      .set({ consumedAt: new Date(this.now()) })
      .where(and(eq(authNonces.id, row.id), isNull(authNonces.consumedAt)))
      .returning({ id: authNonces.id })
    if (!burned.length) return { ok: false, reason: 'that nonce has already been used; request a fresh one' }
    return { ok: true, nonce: row.nonce }
  }

  // ── sessions ──────────────────────────────────────────────────────────────

  async create(address: Address, chainId: number, userAgent: string | null): Promise<IssuedSession> {
    const secret = randomBytes(32).toString('hex')
    const at = new Date(this.now())
    const expiresAt = new Date(this.now() + SESSION_TTL_MS)
    const [row] = await this.db
      .insert(sessions)
      .values({
        address: address.toLowerCase(),
        tokenHash: sha256(secret),
        chainId,
        issuedAt: at,
        expiresAt,
        lastSeenAt: at,
        userAgentHash: userAgent ? sha256(`${this.key}:${userAgent}`) : null,
      })
      .returning()
    return {
      session: rowToSession(row!),
      cookie: signCookie(row!.id, secret, this.key),
    }
  }

  /**
   * Resolve a session cookie. Returns the session and, when the session was
   * idle long enough to be rotated, the replacement cookie the caller must
   * set. A revoked, expired or unknown cookie resolves to null.
   */
  async resolve(cookieValue: string | undefined): Promise<{ session: WalletSession; rotated: string | null } | null> {
    const parsed = parseCookieValue(cookieValue, this.key)
    if (!parsed) return null
    const [row] = await this.db.select().from(sessions).where(eq(sessions.id, parsed.id)).limit(1)
    if (!row) return null
    if (!constantTimeEqual(row.tokenHash, sha256(parsed.secret))) return null
    const now = this.now()
    if (row.revokedAt || row.expiresAt.getTime() <= now) return null

    if (now - row.lastSeenAt.getTime() < ROTATE_AFTER_MS) {
      await this.db.update(sessions).set({ lastSeenAt: new Date(now) }).where(eq(sessions.id, row.id))
      return { session: rowToSession({ ...row, lastSeenAt: new Date(now) }), rotated: null }
    }
    const secret = randomBytes(32).toString('hex')
    const [rotated] = await this.db
      .update(sessions)
      .set({ tokenHash: sha256(secret), lastSeenAt: new Date(now) })
      .where(and(eq(sessions.id, row.id), eq(sessions.tokenHash, row.tokenHash)))
      .returning()
    // Another request rotated first: its cookie is now the live one, and this
    // request is still authentic, so it proceeds without a second rotation.
    if (!rotated) return { session: rowToSession({ ...row, lastSeenAt: new Date(now) }), rotated: null }
    return { session: rowToSession(rotated), rotated: signCookie(rotated.id, secret, this.key) }
  }

  async revoke(cookieValue: string | undefined): Promise<boolean> {
    const parsed = parseCookieValue(cookieValue, this.key)
    if (!parsed) return false
    const revoked = await this.db
      .update(sessions)
      .set({ revokedAt: new Date(this.now()) })
      .where(and(eq(sessions.id, parsed.id), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id })
    return revoked.length > 0
  }

  /** Drop expired nonces and sessions. Cheap, and keeps the tables from growing without bound. */
  async sweep(): Promise<{ nonces: number; sessions: number }> {
    const cutoff = new Date(this.now())
    const n = await this.db.delete(authNonces).where(lt(authNonces.expiresAt, cutoff)).returning({ id: authNonces.id })
    const s = await this.db
      .delete(sessions)
      .where(sql`${sessions.expiresAt} < ${cutoff}`)
      .returning({ id: sessions.id })
    return { nonces: n.length, sessions: s.length }
  }
}

function rowToSession(r: typeof sessions.$inferSelect): WalletSession {
  return {
    id: r.id,
    address: getAddress(r.address) as Address,
    chainId: r.chainId,
    issuedAt: r.issuedAt,
    expiresAt: r.expiresAt,
    lastSeenAt: r.lastSeenAt,
  }
}

export interface CookieOptions {
  maxAgeSeconds: number
  secure: boolean
  /** Path the cookie is scoped to. */
  path?: string
}

/** Serialize a Set-Cookie header value. HttpOnly and SameSite=Lax always. */
export function serializeCookie(name: string, value: string, o: CookieOptions): string {
  const parts = [
    `${name}=${value}`,
    `Path=${o.path ?? '/'}`,
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${o.maxAgeSeconds}`,
  ]
  if (o.secure) parts.push('Secure')
  return parts.join('; ')
}

/** A Set-Cookie that deletes `name`. */
export function clearCookie(name: string, secure: boolean): string {
  return serializeCookie(name, '', { maxAgeSeconds: 0, secure })
}

/** Read one cookie out of a raw Cookie header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== name) continue
    return part.slice(eq + 1).trim()
  }
  return undefined
}
