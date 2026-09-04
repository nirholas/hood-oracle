/**
 * Sign-In With Ethereum (EIP-4361), parsed and validated strictly.
 *
 * No dependency: the ABNF is small, the failure modes are all security
 * relevant, and a parser we can read line by line is worth more here than one
 * we cannot. The rules that matter and why:
 *
 *   - The message is parsed POSITIONALLY, not by scanning for keys. A lenient
 *     parser that greps for "Nonce:" accepts a message whose statement
 *     contains a second "Nonce:" line, which is how a signed message for one
 *     site gets replayed at another.
 *   - Unknown fields are rejected. A field the server ignores is a field an
 *     attacker can hide meaning in.
 *   - The domain, URI host, chain id and nonce are all checked by the caller
 *     against what the server issued; this module only guarantees the message
 *     says exactly one unambiguous thing.
 *
 * Message shape (https://eips.ethereum.org/EIPS/eip-4361):
 *
 *   ${domain} wants you to sign in with your Ethereum account:
 *   ${address}
 *
 *   ${statement}
 *
 *   URI: ${uri}
 *   Version: ${version}
 *   Chain ID: ${chainId}
 *   Nonce: ${nonce}
 *   Issued At: ${issuedAt}
 *   [Expiration Time: ${expirationTime}]
 *   [Not Before: ${notBefore}]
 *   [Request ID: ${requestId}]
 *   [Resources:
 *   - ${resource}]
 */
import { getAddress, isAddress } from 'viem'
import type { Address } from 'viem'

export interface SiweMessage {
  /** RFC 3986 authority the signer is signing in to, optionally prefixed with a scheme. */
  domain: string
  /** The scheme the message claimed, when it used the `scheme://domain` form. */
  scheme: string | null
  address: Address
  statement: string | null
  uri: string
  version: string
  chainId: number
  nonce: string
  issuedAt: string
  expirationTime: string | null
  notBefore: string | null
  requestId: string | null
  resources: string[]
}

export class SiweParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SiweParseError'
  }
}

const PREAMBLE = ' wants you to sign in with your Ethereum account:'
/** RFC 3986 authority: host, optional port, no userinfo (userinfo lets a message lie about its origin). */
const DOMAIN = /^[a-zA-Z0-9.\-_~%]+(:\d{1,5})?$/
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.\-]*$/
const NONCE = /^[a-zA-Z0-9]{8,}$/
/** ISO 8601 with a required timezone, which EIP-4361 mandates for every datetime field. */
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/

function datetime(value: string, field: string): string {
  if (!DATETIME.test(value)) throw new SiweParseError(`${field} must be an ISO 8601 datetime with a timezone`)
  if (Number.isNaN(Date.parse(value))) throw new SiweParseError(`${field} is not a real datetime`)
  return value
}

/** Parse an EIP-4361 message. Throws SiweParseError with a specific reason on anything malformed. */
export function parseSiweMessage(raw: string): SiweMessage {
  if (typeof raw !== 'string') throw new SiweParseError('the message must be a string')
  if (raw.length > 8_000) throw new SiweParseError('the message is too long to be a sign-in message')
  if (raw.includes('\r')) throw new SiweParseError('the message must use LF line endings')
  const lines = raw.split('\n')
  let i = 0
  const next = (what: string): string => {
    if (i >= lines.length) throw new SiweParseError(`the message ends before ${what}`)
    return lines[i++]!
  }

  const header = next('the domain line')
  if (!header.endsWith(PREAMBLE)) throw new SiweParseError('the first line must be "<domain> wants you to sign in with your Ethereum account:"')
  const authority = header.slice(0, header.length - PREAMBLE.length)
  let scheme: string | null = null
  let domain = authority
  const schemeSplit = authority.indexOf('://')
  if (schemeSplit > 0) {
    scheme = authority.slice(0, schemeSplit)
    domain = authority.slice(schemeSplit + 3)
    if (!SCHEME.test(scheme)) throw new SiweParseError('the scheme in the domain line is malformed')
  }
  if (!DOMAIN.test(domain)) throw new SiweParseError('the domain is not a bare host[:port] authority')

  const addressLine = next('the address line')
  if (!isAddress(addressLine, { strict: true })) {
    throw new SiweParseError('the address line must be an EIP-55 checksummed 0x address')
  }
  const address = getAddress(addressLine)

  if (next('the blank line after the address') !== '') throw new SiweParseError('a blank line must follow the address')

  // The optional statement is one line, followed by another blank line.
  let statement: string | null = null
  if (i < lines.length && lines[i] !== '') {
    statement = next('the statement')
    if (statement.includes('\n')) throw new SiweParseError('the statement must be a single line')
    if (next('the blank line after the statement') !== '') throw new SiweParseError('a blank line must follow the statement')
  } else {
    next('the blank line before the fields')
  }

  const field = (label: string): string => {
    const line = next(`the ${label} field`)
    const prefix = `${label}: `
    if (!line.startsWith(prefix)) throw new SiweParseError(`expected "${label}: ..." but found ${JSON.stringify(line.slice(0, 40))}`)
    const value = line.slice(prefix.length)
    if (!value) throw new SiweParseError(`${label} is empty`)
    return value
  }

  const uri = field('URI')
  let uriUrl: URL
  try {
    uriUrl = new URL(uri)
  } catch {
    throw new SiweParseError('URI must be an absolute URI')
  }
  if (!uriUrl.protocol) throw new SiweParseError('URI must carry a scheme')

  const version = field('Version')
  if (version !== '1') throw new SiweParseError(`unsupported SIWE version ${JSON.stringify(version)}; this server speaks version 1`)

  const chainIdRaw = field('Chain ID')
  if (!/^\d{1,19}$/.test(chainIdRaw)) throw new SiweParseError('Chain ID must be a decimal integer')
  const chainId = Number(chainIdRaw)
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new SiweParseError('Chain ID is out of range')

  const nonce = field('Nonce')
  if (!NONCE.test(nonce)) throw new SiweParseError('Nonce must be at least 8 alphanumeric characters')

  const issuedAt = datetime(field('Issued At'), 'Issued At')

  let expirationTime: string | null = null
  let notBefore: string | null = null
  let requestId: string | null = null
  const resources: string[] = []

  const optional = (label: string): string | null => {
    const prefix = `${label}: `
    if (i < lines.length && lines[i]!.startsWith(prefix)) return next(label).slice(prefix.length)
    return null
  }

  const exp = optional('Expiration Time')
  if (exp !== null) expirationTime = datetime(exp, 'Expiration Time')
  const nbf = optional('Not Before')
  if (nbf !== null) notBefore = datetime(nbf, 'Not Before')
  requestId = optional('Request ID')

  if (i < lines.length && lines[i] === 'Resources:') {
    i++
    while (i < lines.length && lines[i]!.startsWith('- ')) {
      const resource = next('a resource').slice(2)
      try {
        void new URL(resource)
      } catch {
        throw new SiweParseError('every entry under Resources must be an absolute URI')
      }
      resources.push(resource)
    }
    if (!resources.length) throw new SiweParseError('Resources: was given with no entries')
  }

  // A trailing newline is fine; anything else is a field this server does not
  // understand, and a field the server ignores is one an attacker can use.
  while (i < lines.length && lines[i] === '') i++
  if (i < lines.length) throw new SiweParseError(`unexpected trailing content in the message: ${JSON.stringify(lines[i]!.slice(0, 40))}`)

  return { domain, scheme, address, statement, uri, version, chainId, nonce, issuedAt, expirationTime, notBefore, requestId, resources }
}

export interface SiweCheckOptions {
  /** Domains the message is allowed to claim, lowercase. */
  allowedDomains: string[]
  /** The chain the server accepts sign-ins on. */
  chainId: number
  /** The nonce the server issued for this browser. */
  expectedNonce: string
  /** How far in the past `Issued At` may be, ms. */
  maxIssuedAgeMs: number
  /** How far in the future `Issued At` may be, ms (clock skew). */
  maxClockSkewMs: number
  now?: number
}

export interface SiweCheckResult {
  ok: boolean
  reason: string
}

const OK: SiweCheckResult = { ok: true, reason: 'the message is well formed, fresh, and addressed to this server' }
const bad = (reason: string): SiweCheckResult => ({ ok: false, reason })

/**
 * Everything about a parsed message that must be true before a signature is
 * even worth verifying. Pure, so every branch is unit-testable.
 */
export function checkSiweMessage(m: SiweMessage, o: SiweCheckOptions): SiweCheckResult {
  const now = o.now ?? Date.now()
  const domain = m.domain.toLowerCase()
  if (!o.allowedDomains.map((d) => d.toLowerCase()).includes(domain)) {
    return bad(`the message is addressed to ${m.domain}, which is not a domain this server signs people in for`)
  }
  let host: string
  try {
    const url = new URL(m.uri)
    host = url.host.toLowerCase()
  } catch {
    return bad('the URI field is not a valid absolute URI')
  }
  if (host !== domain) return bad(`the URI host ${host} does not match the domain ${m.domain}`)
  if (m.chainId !== o.chainId) return bad(`the message is for chain ${m.chainId}; this server signs in on chain ${o.chainId}`)
  if (m.nonce !== o.expectedNonce) return bad('the nonce does not match the one this browser was issued')

  const issuedAt = Date.parse(m.issuedAt)
  if (issuedAt > now + o.maxClockSkewMs) return bad('the message claims to have been issued in the future')
  if (now - issuedAt > o.maxIssuedAgeMs) return bad(`the message was issued ${Math.round((now - issuedAt) / 1000)}s ago and is too old to sign in with`)
  if (m.expirationTime && Date.parse(m.expirationTime) <= now) return bad('the message has expired')
  if (m.notBefore && Date.parse(m.notBefore) > now) return bad('the message is not valid yet (Not Before is in the future)')
  if (m.expirationTime && m.notBefore && Date.parse(m.expirationTime) <= Date.parse(m.notBefore)) {
    return bad('the message expires before it becomes valid')
  }
  return OK
}

export interface BuildSiweOptions {
  domain: string
  address: Address
  uri: string
  chainId: number
  nonce: string
  issuedAt?: Date
  expirationTime?: Date
  statement?: string
  resources?: string[]
}

/**
 * Render a message in the exact shape {@link parseSiweMessage} accepts. The
 * dashboard builds its own in the browser; this is what the tests and the
 * docs examples sign, so the two can never drift.
 */
export function buildSiweMessage(o: BuildSiweOptions): string {
  const lines = [`${o.domain}${PREAMBLE}`, getAddress(o.address), '']
  if (o.statement) lines.push(o.statement, '')
  lines.push(
    `URI: ${o.uri}`,
    'Version: 1',
    `Chain ID: ${o.chainId}`,
    `Nonce: ${o.nonce}`,
    `Issued At: ${(o.issuedAt ?? new Date()).toISOString()}`,
  )
  if (o.expirationTime) lines.push(`Expiration Time: ${o.expirationTime.toISOString()}`)
  if (o.resources?.length) lines.push('Resources:', ...o.resources.map((r) => `- ${r}`))
  return lines.join('\n')
}
