/**
 * The process entry. Boots in the order docs/architecture.md documents and
 * refuses to start if any step fails:
 *
 *   1. config            2. database + pending-migration check (exit 4)
 *   3. model store       4. chain client (+ wallet when TRADER_PRIVATE_KEY is set)
 *   5. kill switch       6. engine (feed, watchers, observer, executor, sweep)
 *   7. oracle jobs       8. Hono API on PORT
 *
 * Shutdown on SIGTERM/SIGINT: stop accepting connections, stop the engine,
 * stop the jobs, close the database, exit 0; or exit 1 after 25 seconds. An
 * unhandled rejection or uncaught exception is logged with its module and
 * the process exits non-zero so the platform restarts a clean one, rather
 * than limping on with a half-broken trading loop.
 */
import { loadConfig } from './config.js'
import { log as rootLog } from './log.js'
import { createDb } from './db/client.js'
import { runMigrations } from './db/migrate.js'
import { createModelStore } from './oracle/model-store.js'
import { startOracleJobs } from './oracle/jobs.js'
import { createChainClient, errorText } from './chain/client.js'
import { KillSwitch } from './guards/kill.js'
import { EventBus } from './engine/bus.js'
import { createEngine } from './engine/index.js'
import { createApp } from './api/app.js'
import { serveApp } from './api/server.js'
import { createMetrics } from './api/metrics.js'

export const SHUTDOWN_DEADLINE_MS = 25_000
export const EXIT_PENDING_MIGRATIONS = 4
/** engine.start() retries: the public RPC rate-limits per address and resets within a minute. */
export const ENGINE_START_ATTEMPTS = 6
export const ENGINE_START_RETRY_MS = 15_000

const log = rootLog.child({ module: 'boot' })

let exiting = false

/** Log once with the module that failed, then leave. Never limp on with a half-broken trading loop. */
function fatal(module: string, err: unknown, code = 1): void {
  if (exiting) return
  exiting = true
  rootLog.child({ module }).fatal({ err: errorText(err), stack: err instanceof Error ? err.stack : undefined }, 'fatal; exiting so the platform restarts a clean process')
  // Give pino one tick to flush before the process goes away.
  setTimeout(() => process.exit(code), 50).unref()
}

process.on('unhandledRejection', (reason) => fatal('unhandledRejection', reason))
process.on('uncaughtException', (err) => fatal('uncaughtException', err))

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * A boot must survive a throttled RPC: the public endpoint answers "Rate
 * Limit Hit, limit will reset in 60 seconds" under load, and a crash loop
 * on that is slower than waiting it out. A wrong chain id or a bad key
 * still fails every attempt and exits.
 */
async function startEngineWithRetry(engine: { start(): Promise<void> }): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await engine.start()
      return
    } catch (err) {
      if (attempt >= ENGINE_START_ATTEMPTS) throw err
      log.warn({ attempt, of: ENGINE_START_ATTEMPTS, retryInMs: ENGINE_START_RETRY_MS, err: errorText(err) }, 'engine start failed; retrying')
      await sleep(ENGINE_START_RETRY_MS)
    }
  }
}

export async function main(): Promise<void> {
  // 1. config
  const config = loadConfig()
  rootLog.level = config.logLevel
  log.info({ network: config.network, chainId: config.chainId, rpcs: config.rpcUrls.length, feed: config.disableFeed ? 'disabled' : config.feedUrl, wallet: config.traderPrivateKey ? 'key set' : 'none', operatorToken: config.operatorToken ? 'set' : 'unset', x402: config.x402.payTo ? 'enabled' : 'disabled' }, 'config loaded')

  // 2. database + migration gate
  const migrations = await runMigrations(config.databaseUrl, { statusOnly: true })
  if (migrations.pending > 0) {
    log.fatal({ ...migrations }, `${migrations.pending} migration(s) pending. This process never applies them on its own: run \`npm run db:migrate\` against this database, then start again.`)
    setTimeout(() => process.exit(EXIT_PENDING_MIGRATIONS), 50).unref()
    return
  }
  const { db, close: closeDb } = createDb(config.databaseUrl)
  log.info({ applied: migrations.applied, files: migrations.files }, 'database ready; schema is current')

  // 3. model store
  const model = createModelStore({ db, log: rootLog.child({ module: 'oracle' }), network: config.network })
  await model.reload()
  const prov = model.provenance()
  log.info({ version: prov.version, source: model.source(), rows: prov.trainingRows, fittedAt: prov.fittedAt }, 'oracle model loaded')

  // 4. chain client (+ wallet when a key is set)
  const chain = createChainClient(config)
  log.info({ chainId: chain.chainId, rpcs: chain.rpcUrls, wallet: chain.account?.address ?? null }, 'chain client ready')

  // 5. kill switch
  const kill = new KillSwitch({ killFile: config.killFile, log: rootLog.child({ module: 'kill' }), ...(config.globalKill ? { initialKill: 'env:GLOBAL_KILL' } : {}) })

  // 6. engine
  const bus = new EventBus()
  const engine = createEngine({ config, db, log: rootLog.child({ module: 'engine' }), model, bus, chain, kill })
  await startEngineWithRetry(engine)

  // 7. oracle jobs
  const jobs = startOracleJobs({ db, log: rootLog.child({ module: 'oracle-jobs' }), model, config, chain })
  log.info('oracle jobs scheduled: labels 30m, calibrate 6h, refit 6h')

  // 8. API
  const metrics = createMetrics({ engine, bus })
  const app = createApp({ config, db, log: rootLog, engine, model, bus, metrics })
  const server = serveApp(app, config.port)
  log.info({ port: config.port, webDist: config.webDist, mcp: '/mcp', metrics: '/api/metrics', ready: '/api/ready' }, 'api listening')

  let shuttingDown = false
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    log.warn({ signal, deadlineMs: SHUTDOWN_DEADLINE_MS }, 'shutting down: closing the listener, stopping the engine and the jobs, closing the database')
    const deadline = setTimeout(() => {
      log.error({ signal }, `shutdown did not finish within ${SHUTDOWN_DEADLINE_MS}ms; exiting 1`)
      process.exit(1)
    }, SHUTDOWN_DEADLINE_MS)
    deadline.unref()
    try {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        // Long-lived SSE and MCP streams would hold close() open; drop them now.
        if ('closeAllConnections' in server && typeof server.closeAllConnections === 'function') server.closeAllConnections()
      })
      log.info('listener closed')
      await engine.stop()
      log.info('engine stopped')
      jobs.stop()
      metrics.stop()
      kill.dispose()
      log.info('jobs stopped')
      await closeDb()
      log.info('database closed; bye')
      clearTimeout(deadline)
      process.exit(0)
    } catch (err) {
      log.error({ err: errorText(err) }, 'shutdown failed; exiting 1')
      process.exit(1)
    }
  }
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.once('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((err: unknown) => fatal('boot', err))
