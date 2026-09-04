import type { MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { respond } from '../json.js'

export const DEFAULT_BODY_LIMIT_BYTES = 64 * 1024

/**
 * Caps request bodies on the JSON routes. An arm is a few hundred bytes and a
 * kill reason is capped at 500 characters, so 64KB is generous and anything
 * larger is not a client we want to buffer for.
 */
export function jsonBodyLimit(maxSize = DEFAULT_BODY_LIMIT_BYTES): MiddlewareHandler {
  return bodyLimit({
    maxSize,
    onError: (c) =>
      respond(
        c,
        { error: 'payload_too_large', message: `Request bodies are limited to ${maxSize} bytes on this route.`, detail: { maxBytes: maxSize } },
        413,
      ),
  })
}
