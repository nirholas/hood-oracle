import type { Hono } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AppDeps } from './deps.js'

/** Clean dashboard routes -> built pages in web/dist. */
const CLEAN_ROUTES: Record<string, string> = {
  '/': '/index.html',
  '/index': '/index.html',
  '/arm': '/arm.html',
  '/arms': '/arm.html',
  '/positions': '/positions.html',
  '/coin': '/coin.html',
}

export function rewriteDashboardPath(path: string): string {
  const clean = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
  if (CLEAN_ROUTES[clean]) return CLEAN_ROUTES[clean]
  if (clean.startsWith('/coin/')) return '/coin.html'
  return path
}

export function mountStatic(app: Hono, deps: AppDeps): void {
  const root = deps.config.webDist
  if (!existsSync(resolve(root))) {
    deps.log.warn({ webDist: root }, 'dashboard build not found; run `npm run build:web` to serve it (API routes are unaffected)')
  }
  app.use(
    '*',
    serveStatic({
      root,
      rewriteRequestPath: rewriteDashboardPath,
      onFound: (path, c) => {
        if (path.includes('/assets/')) c.header('Cache-Control', 'public, max-age=31536000, immutable')
        else c.header('Cache-Control', 'no-cache')
      },
    }),
  )
}
