import type { Context } from 'hono'
import { getConnInfo } from '@hono/node-server/conninfo'

/**
 * The client address a request came from. `X-Forwarded-For` is only trusted
 * when the operator says the process sits behind a proxy (`TRUST_PROXY=1`):
 * otherwise any caller could pick their own rate-limit bucket by setting it.
 */
export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = c.req.header('x-forwarded-for')
    if (forwarded) {
      const first = forwarded.split(',')[0]?.trim()
      if (first) return first
    }
  }
  try {
    const address = getConnInfo(c).remote.address
    if (address) return address
  } catch {
    // app.request() in tests and non-node runtimes carry no socket
  }
  return 'unknown'
}

/** The scheme a browser used to reach us, honouring X-Forwarded-Proto behind a proxy. */
export function requestProtocol(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim()
    if (proto === 'http' || proto === 'https') return proto
  }
  return new URL(c.req.url).protocol.replace(':', '')
}

/** The absolute URL of the current request as the outside world sees it. */
export function publicUrl(c: Context, trustProxy: boolean): string {
  const url = new URL(c.req.url)
  url.protocol = `${requestProtocol(c, trustProxy)}:`
  const host = trustProxy ? c.req.header('x-forwarded-host')?.split(',')[0]?.trim() : undefined
  if (host) url.host = host
  return url.toString()
}
