import { defineConfig, type Plugin } from 'vite'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))

const CLEAN_ROUTES: Record<string, string> = {
  '/arm': '/arm.html',
  '/arms': '/arm.html',
  '/positions': '/positions.html',
  '/coin': '/coin.html',
}

/** Dev-server mirror of src/api/static.ts: clean URLs resolve to the page files. */
function cleanRoutes(): Plugin {
  return {
    name: 'hood-clean-routes',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const url = req.url ?? '/'
        const q = url.indexOf('?')
        const path = q >= 0 ? url.slice(0, q) : url
        const query = q >= 0 ? url.slice(q) : ''
        const trimmed = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
        if (CLEAN_ROUTES[trimmed]) req.url = CLEAN_ROUTES[trimmed] + query
        else if (trimmed.startsWith('/coin/')) req.url = '/coin.html' + query
        next()
      })
    },
  }
}

export default defineConfig({
  root,
  appType: 'mpa',
  plugins: [cleanRoutes()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        index: resolve(root, 'index.html'),
        arm: resolve(root, 'arm.html'),
        positions: resolve(root, 'positions.html'),
        coin: resolve(root, 'coin.html'),
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
