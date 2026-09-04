/**
 * The site's URL table and the static mount: the landing page at `/`, the
 * dashboard under `/app`, 301s from the pre-move paths, docs slugs, and
 * the HTML 404. Page-serving assertions run against a real `npm run
 * build:web` output when one is present and are skipped, by name, when it
 * is not; the route table and the redirects need no build.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHarness, type Harness } from './api-helpers.js'
import { docSlug, isSiteRoute, legacyRedirect, resolveSitePath } from '../src/api/site-routes.js'

let h: Harness
const dist = resolve('web/dist')
const built = (file: string) => existsSync(resolve(dist, file))
const html = { accept: 'text/html,application/xhtml+xml' }

beforeAll(async () => {
  h = await createHarness()
})

afterAll(async () => {
  await h.close()
})

describe('site route table', () => {
  it('maps clean URLs to built pages', () => {
    expect(resolveSitePath('/')).toBe('/landing.html')
    expect(resolveSitePath('/app')).toBe('/index.html')
    expect(resolveSitePath('/app/')).toBe('/index.html')
    expect(resolveSitePath('/app/arm')).toBe('/arm.html')
    expect(resolveSitePath('/app/arms')).toBe('/arm.html')
    expect(resolveSitePath('/app/positions')).toBe('/positions.html')
    expect(resolveSitePath('/app/connect')).toBe('/connect.html')
    expect(resolveSitePath('/app/accounts')).toBe('/connect.html')
    expect(resolveSitePath('/app/coin/0x1111111111111111111111111111111111111111')).toBe('/coin.html')
    expect(resolveSitePath('/docs')).toBe('/docs/index.html')
    expect(resolveSitePath('/docs/guardrails')).toBe('/docs/guardrails.html')
    expect(resolveSitePath('/litepaper')).toBe('/docs/litepaper.html')
    expect(resolveSitePath('/assets/landing-abc123.js')).toBe('/assets/landing-abc123.js')
  })

  it('names the 301 target for every pre-move dashboard path', () => {
    expect(legacyRedirect('/arm')).toBe('/app/arm')
    expect(legacyRedirect('/arms')).toBe('/app/arm')
    expect(legacyRedirect('/positions/')).toBe('/app/positions')
    expect(legacyRedirect('/coin/0x1111111111111111111111111111111111111111')).toBe('/app/coin/0x1111111111111111111111111111111111111111')
    expect(legacyRedirect('/index')).toBe('/app')
    expect(legacyRedirect('/')).toBeNull()
    expect(legacyRedirect('/app/arm')).toBeNull()
    expect(legacyRedirect('/api/arms')).toBeNull()
  })

  it('accepts only lowercase slugs for docs', () => {
    expect(docSlug('/docs/site-build')).toBe('site-build')
    expect(docSlug('/litepaper')).toBe('litepaper')
    expect(docSlug('/docs/Guardrails')).toBeNull()
    expect(docSlug('/docs/a/b')).toBeNull()
    expect(docSlug('/docs')).toBeNull()
  })

  it('knows which internal hrefs the site serves', () => {
    expect(isSiteRoute('/')).toBe(true)
    expect(isSiteRoute('/#guardrails')).toBe(true)
    expect(isSiteRoute('/app/positions?arm=x')).toBe(true)
    expect(isSiteRoute('/app/coin/0x1111111111111111111111111111111111111111')).toBe(true)
    expect(isSiteRoute('/app/connect')).toBe(true)
    expect(isSiteRoute('/docs/multi-tenant')).toBe(true)
    expect(isSiteRoute('/docs/oracle#the-labels')).toBe(true)
    expect(isSiteRoute('/arm')).toBe(false)
    expect(isSiteRoute('/app/coin/not-an-address')).toBe(false)
    expect(isSiteRoute('/nothing')).toBe(false)
  })
})

describe('static mount', () => {
  it('301s the old dashboard paths and keeps the query string', async () => {
    const arm = await h.app.request('/arm?id=abc', { headers: html })
    expect(arm.status).toBe(301)
    expect(arm.headers.get('location')).toBe('/app/arm?id=abc')
    const coin = await h.app.request('/coin/0x1111111111111111111111111111111111111111')
    expect(coin.status).toBe(301)
    expect(coin.headers.get('location')).toBe('/app/coin/0x1111111111111111111111111111111111111111')
    const positions = await h.app.request('/positions/')
    expect(positions.headers.get('location')).toBe('/app/positions')
  })

  it('never redirects an API path', async () => {
    const res = await h.app.request('/api/arms')
    expect(res.status).toBe(200)
  })

  it('answers an unknown API path with JSON, not the 404 page', async () => {
    const res = await h.app.request('/api/nothing', { headers: html })
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/json')
  })

  it.skipIf(!built('landing.html'))('serves the landing page at / with no-cache', async () => {
    const res = await h.app.request('/', { headers: html })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('cache-control')).toBe('no-cache')
    const body = await res.text()
    expect(body).toContain('id="radar"')
    expect(body).toContain('href="/app"')
  })

  it.skipIf(!built('index.html'))('serves the oracle board at /app', async () => {
    const res = await h.app.request('/app', { headers: html })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('id="feedList"')
  })

  it.skipIf(!built('docs/litepaper.html'))('serves the litepaper at /litepaper and /docs/litepaper', async () => {
    for (const path of ['/litepaper', '/docs/litepaper']) {
      const res = await h.app.request(path, { headers: html })
      expect(res.status).toBe(200)
      expect(await res.text()).toContain('data-slug="litepaper"')
    }
  })

  it.skipIf(!built('docs/index.html'))('serves the docs overview at /docs', async () => {
    const res = await h.app.request('/docs', { headers: html })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('data-slug="index"')
  })

  it.skipIf(!built('404.html'))('serves the 404 page for an unknown browser navigation', async () => {
    const res = await h.app.request('/docs/no-such-doc', { headers: html })
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('Nothing is served at this address')
  })

  it.skipIf(!built('landing.html'))('marks hashed assets immutable', async () => {
    const landing = await (await h.app.request('/', { headers: html })).text()
    const asset = /href="(\/assets\/[^"]+\.css)"/.exec(landing)?.[1]
    expect(asset).toBeTruthy()
    const res = await h.app.request(asset!)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
  })
})
