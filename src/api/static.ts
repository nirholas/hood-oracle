/**
 * Serves the built site from web/dist: the landing page at `/`, the
 * dashboard under `/app`, the pre-rendered docs under `/docs` and
 * `/litepaper`, hashed assets under `/assets`. The URL table itself is
 * ./site-routes.ts so the Vite dev server can mirror it. Pre-move dashboard
 * paths answer 301; a browser navigation to nothing gets the built 404 page.
 */
import type { Context, Hono } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { AppDeps } from './deps.js'
import { legacyRedirect, resolveSitePath } from './site-routes.js'

export { legacyRedirect, resolveSitePath } from './site-routes.js'

const IMMUTABLE = 'public, max-age=31536000, immutable'
const REVALIDATE = 'no-cache'

function wantsHtml(c: Context): boolean {
  return (c.req.header('accept') ?? '').includes('text/html')
}

export function mountStatic(app: Hono, deps: AppDeps): void {
  const root = deps.config.webDist
  const absRoot = resolve(root)
  if (!existsSync(absRoot)) {
    deps.log.warn({ webDist: root }, 'site build not found; run `npm run build:web` to serve it (API routes are unaffected)')
  }

  app.get('*', (c, next) => {
    const target = legacyRedirect(c.req.path)
    if (!target) return next()
    const search = new URL(c.req.url).search
    return c.redirect(target + search, 301)
  })

  // serveStatic builds its Response before it calls onFound, so a header set
  // there never reaches the wire; the cache policy is decided from the
  // resolved path before the file handler runs.
  app.use('*', async (c, next) => {
    c.header('Cache-Control', resolveSitePath(c.req.path).startsWith('/assets/') ? IMMUTABLE : REVALIDATE)
    await next()
  })
  app.use('*', serveStatic({ root, rewriteRequestPath: resolveSitePath }))

  const notFoundPage = resolve(absRoot, '404.html')
  app.get('*', async (c, next) => {
    if (!wantsHtml(c) || c.req.path.startsWith('/api/')) return next()
    let html: string
    try {
      html = await readFile(notFoundPage, 'utf8')
    } catch {
      return next()
    }
    return c.html(html, 404)
  })
}
