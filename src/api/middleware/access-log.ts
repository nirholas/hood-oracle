import type { MiddlewareHandler } from 'hono'
import type { Logger } from '../../log.js'
import { clientIp } from './client-ip.js'

/** Probe and scrape paths that would otherwise be most of the log at info level. */
const QUIET_PATHS = new Set(['/api/health', '/api/ready', '/api/metrics'])

export interface AccessLogOptions {
  log: Logger
  trustProxy: boolean
}

/**
 * One structured line per request: id, method, path, status, latency and the
 * client address. For a streaming response (SSE, MCP) the latency is
 * time-to-headers, since the handler returns once the stream is open.
 */
export function accessLog({ log, trustProxy }: AccessLogOptions): MiddlewareHandler {
  return async (c, next) => {
    const started = performance.now()
    await next()
    const ms = Math.round((performance.now() - started) * 10) / 10
    const path = c.req.path
    const fields = {
      reqId: c.get('requestId'),
      method: c.req.method,
      path,
      status: c.res.status,
      ms,
      ip: clientIp(c, trustProxy),
      ua: c.req.header('user-agent') ?? null,
    }
    if (QUIET_PATHS.has(path)) log.debug(fields, 'request')
    else if (c.res.status >= 500) log.error(fields, 'request')
    else if (c.res.status >= 400) log.warn(fields, 'request')
    else log.info(fields, 'request')
  }
}
