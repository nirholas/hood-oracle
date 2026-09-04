import { defineConfig, type Plugin } from 'vite'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { docSlug, legacyRedirect, resolveSitePath } from '../src/api/site-routes'

const root = dirname(fileURLToPath(import.meta.url))

/**
 * Dev-server mirror of src/api/static.ts, reading the same route table:
 * clean URLs resolve to the page files, pre-move dashboard paths answer 301,
 * and `/docs/:slug` serves the pre-rendered page from web/dist/docs (the
 * docs are built by `npm run build:docs`, not by Vite).
 */
function siteRoutes(): Plugin {
  return {
    name: 'hood-site-routes',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '/'
        const q = url.indexOf('?')
        const path = q >= 0 ? url.slice(0, q) : url
        const query = q >= 0 ? url.slice(q) : ''
        const redirect = legacyRedirect(path)
        if (redirect) {
          res.statusCode = 301
          res.setHeader('Location', redirect + query)
          res.end()
          return
        }
        const slug = docSlug(path)
        if (slug) {
          const file = resolve(root, 'dist', 'docs', `${slug}.html`)
          if (existsSync(file)) {
            res.setHeader('Content-Type', 'text/html; charset=utf-8')
            res.setHeader('Cache-Control', 'no-cache')
            res.end(readFileSync(file))
          } else {
            res.statusCode = 503
            res.setHeader('Content-Type', 'text/plain; charset=utf-8')
            res.end(`docs are not built: run \`npm run build:docs\` to render docs/${slug}.md into web/dist/docs/`)
          }
          return
        }
        const resolved = resolveSitePath(path)
        if (resolved !== path) req.url = resolved + query
        next()
      })
    },
  }
}

export default defineConfig({
  root,
  appType: 'mpa',
  plugins: [siteRoutes()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        landing: resolve(root, 'landing.html'),
        index: resolve(root, 'index.html'),
        arm: resolve(root, 'arm.html'),
        positions: resolve(root, 'positions.html'),
        connect: resolve(root, 'connect.html'),
        coin: resolve(root, 'coin.html'),
        docs: resolve(root, 'docs.html'),
        notFound: resolve(root, '404.html'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
    },
  },
})
