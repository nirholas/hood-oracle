import { randomUUID } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'

export const REQUEST_ID_HEADER = 'X-Request-Id'
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/

declare module 'hono' {
  interface ContextVariableMap {
    requestId: string
  }
}

/**
 * Every request carries an id: the caller's `X-Request-Id` when it is a sane
 * token, else a fresh UUID. It is echoed in the response and stamped on the
 * access log line so a dashboard error and its server log line can be joined.
 */
export function requestId(): MiddlewareHandler {
  return async (c, next) => {
    const presented = c.req.header(REQUEST_ID_HEADER)
    const id = presented && SAFE_ID.test(presented) ? presented : randomUUID()
    c.set('requestId', id)
    c.header(REQUEST_ID_HEADER, id)
    await next()
  }
}
