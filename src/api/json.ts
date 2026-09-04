import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

/** bigint -> decimal string. Dates already serialize as ISO through toJSON. */
export function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value
}

export function stringify(value: unknown): string {
  return JSON.stringify(value, jsonReplacer)
}

export function respond(c: Context, body: unknown, status: ContentfulStatusCode = 200): Response {
  return c.body(stringify(body), status, { 'content-type': 'application/json; charset=utf-8' })
}
