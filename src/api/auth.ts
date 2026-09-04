import { timingSafeEqual } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import type { Config } from '../config.js'
import { ApiError } from './errors.js'

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export const OPERATOR_TOKEN_UNSET_MESSAGE =
  'Write routes are disabled until OPERATOR_TOKEN is set on the server. Generate one with `openssl rand -hex 32`, set OPERATOR_TOKEN in the environment, and restart the process. Reads and the dashboard stay public.'

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab)
    return false
  }
  return timingSafeEqual(ab, bb)
}

export function extractBearer(header: string | undefined): string | null {
  if (!header) return null
  const m = /^Bearer\s+(.+)$/i.exec(header.trim())
  return m ? m[1].trim() : null
}

/**
 * Operator gate for every write method under /api. Reads pass through.
 * With no OPERATOR_TOKEN configured, writes answer 503 rather than opening up:
 * an unauthenticated arm/kill surface is never the default.
 */
export function operatorAuth(config: Config): MiddlewareHandler {
  return async (c, next) => {
    if (!WRITE_METHODS.has(c.req.method)) return next()
    if (!config.operatorToken) throw new ApiError(503, 'operator_token_unset', OPERATOR_TOKEN_UNSET_MESSAGE)
    const presented = extractBearer(c.req.header('authorization'))
    if (!presented || !safeEqual(presented, config.operatorToken)) {
      c.header('WWW-Authenticate', 'Bearer realm="hood-oracle operator"')
      throw new ApiError(401, 'unauthorized', 'This action needs the operator token: send `Authorization: Bearer <OPERATOR_TOKEN>`.')
    }
    return next()
  }
}
