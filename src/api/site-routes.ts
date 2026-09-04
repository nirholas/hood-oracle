/**
 * The public site's URL table. Pure: no imports, no I/O, so the Hono static
 * mount (src/api/static.ts), the Vite dev server (web/vite.config.ts) and the
 * docs builder's link check (scripts/build-docs.ts) all read the same table
 * and can never disagree about where a URL lands.
 *
 *   /                       landing page          web/dist/landing.html
 *   /app                    oracle board          web/dist/index.html
 *   /app/arm                arms                  web/dist/arm.html
 *   /app/positions          positions tape        web/dist/positions.html
 *   /app/coin/:token        one launch            web/dist/coin.html
 *   /docs                   docs index            web/dist/docs/index.html
 *   /docs/:slug             one rendered doc      web/dist/docs/<slug>.html
 *   /litepaper              the litepaper         web/dist/docs/litepaper.html
 *
 * The dashboard used to live at the root; its old paths answer 301 so
 * bookmarks and journal links keep working.
 */

/** Clean site paths -> the built file that serves them. */
export const PAGE_ROUTES: Readonly<Record<string, string>> = Object.freeze({
  '/': '/landing.html',
  '/app': '/index.html',
  '/app/oracle': '/index.html',
  '/app/arm': '/arm.html',
  '/app/arms': '/arm.html',
  '/app/positions': '/positions.html',
  '/app/coin': '/coin.html',
  '/docs': '/docs/index.html',
  '/litepaper': '/docs/litepaper.html',
})

/** Pre-move dashboard paths -> where they live now. Answered with a 301. */
export const LEGACY_REDIRECTS: Readonly<Record<string, string>> = Object.freeze({
  '/index': '/app',
  '/arm': '/app/arm',
  '/arms': '/app/arm',
  '/positions': '/app/positions',
  '/coin': '/app/coin',
})

/** A doc slug is a file name under docs/ without its .md: lowercase, digits, hyphens. */
export const DOC_SLUG = /^[a-z0-9][a-z0-9-]*$/

/** `/coin/0xabc/` -> `/coin/0xabc`; the root stays `/`. */
export function trimPath(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

/** Where a legacy dashboard path should redirect, or null when it is not one. Query strings are the caller's to keep. */
export function legacyRedirect(path: string): string | null {
  const clean = trimPath(path)
  const fixed = LEGACY_REDIRECTS[clean]
  if (fixed) return fixed
  if (clean.startsWith('/coin/')) return '/app' + clean
  return null
}

/** The doc slug a path names (`/docs/guardrails` -> `guardrails`), or null. */
export function docSlug(path: string): string | null {
  const clean = trimPath(path)
  if (clean === '/litepaper') return 'litepaper'
  const m = /^\/docs\/([^/]+)$/.exec(clean)
  return m && DOC_SLUG.test(m[1]) ? m[1] : null
}

/** The built file a site path serves. Paths that name a real file (`/assets/...`) come back unchanged. */
export function resolveSitePath(path: string): string {
  const clean = trimPath(path)
  const page = PAGE_ROUTES[clean]
  if (page) return page
  if (clean.startsWith('/app/coin/')) return '/coin.html'
  const slug = docSlug(clean)
  if (slug) return `/docs/${slug}.html`
  return path
}

/** True when a site-internal href resolves to a page this table serves (used by the docs link check). */
export function isSiteRoute(path: string): boolean {
  const clean = trimPath(path.split('#')[0].split('?')[0])
  if (PAGE_ROUTES[clean]) return true
  if (/^\/app\/coin\/0x[0-9a-fA-F]{40}$/.test(clean)) return true
  return docSlug(clean) != null
}
