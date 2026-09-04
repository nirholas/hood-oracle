import { serve, type ServerType } from '@hono/node-server'
import type { Hono } from 'hono'

/** Bind the app on `port` (all interfaces). Returns the node server for shutdown. */
export function serveApp(app: Hono, port: number, hostname = '0.0.0.0'): ServerType {
  return serve({ fetch: app.fetch, port, hostname })
}
