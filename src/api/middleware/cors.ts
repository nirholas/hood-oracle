import type { MiddlewareHandler } from 'hono'
import { respond } from '../json.js'

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const ALLOW_METHODS = 'GET,HEAD,POST,PATCH,PUT,DELETE,OPTIONS'
const ALLOW_HEADERS = 'Authorization,Content-Type,Accept,X-Request-Id,X-PAYMENT,Mcp-Session-Id,Mcp-Protocol-Version,Last-Event-ID'
const EXPOSE_HEADERS = 'X-Request-Id,X-PAYMENT-RESPONSE,Mcp-Session-Id,Retry-After,X-RateLimit-Limit,X-RateLimit-Remaining'

export interface CorsOptions {
  /** Origins allowed cross-origin. `*` allows any origin on read routes only. */
  origins: string[]
}

function sameOrigin(origin: string, requestUrl: string): boolean {
  try {
    return new URL(origin).host === new URL(requestUrl).host
  } catch {
    return false
  }
}

/**
 * Same-origin by default: a request from another origin gets no
 * `Access-Control-Allow-Origin` and the browser refuses it. `CORS_ORIGINS`
 * opens named origins for every method. A `*` entry opens reads to anyone
 * but never a write route: the operator token must not be usable from an
 * arbitrary page, and a wildcard on a credentialed write is exactly that.
 */
export function cors({ origins }: CorsOptions): MiddlewareHandler {
  const named = new Set(origins.filter((o) => o !== '*'))
  const wildcard = origins.includes('*')

  function allowed(origin: string, method: string): boolean {
    if (named.has(origin)) return true
    if (wildcard && !WRITE_METHODS.has(method)) return true
    return false
  }

  return async (c, next) => {
    const origin = c.req.header('origin')
    if (!origin || sameOrigin(origin, c.req.url)) return next()
    const preflight = c.req.method === 'OPTIONS'
    const method = preflight ? (c.req.header('access-control-request-method') ?? 'GET').toUpperCase() : c.req.method
    c.header('Vary', 'Origin')
    if (!allowed(origin, method)) {
      if (preflight) {
        return respond(
          c,
          {
            error: 'cors_origin_not_allowed',
            message: `Origin ${origin} may not call ${method} routes here. Add it to CORS_ORIGINS on the server; a wildcard entry only opens reads.`,
          },
          403,
        )
      }
      return next()
    }
    c.header('Access-Control-Allow-Origin', origin)
    c.header('Access-Control-Expose-Headers', EXPOSE_HEADERS)
    if (preflight) {
      c.header('Access-Control-Allow-Methods', ALLOW_METHODS)
      c.header('Access-Control-Allow-Headers', ALLOW_HEADERS)
      c.header('Access-Control-Max-Age', '600')
      return c.body(null, 204)
    }
    return next()
  }
}
