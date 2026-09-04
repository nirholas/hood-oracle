/**
 * The process entry.
 *
 * Boot order (docs/architecture.md, "Process shape"). Everything that can
 * fail because of a bad deploy fails fast and loudly BEFORE the listener
 * opens; everything that depends on a third party comes up behind it:
 *
 *   1. config
 *   2. database + pending-migration check (exit 4)
 *   3. model store
 *   4. chain client (+ wallet when TRADER_PRIVATE_KEY is set)
 *   5. kill switch, event bus, engine construction (no I/O yet)
 *   6. Hono API on PORT: /api/health answers 200 from here on
 *   7. engine start in the background, retried; oracle jobs once it is running
 *
 * Steps 6 and 7 are in that order on purpose. `engine.start()` probes the
 * RPC, and the public Robinhood Chain endpoint rate-limits per address
 * ("Rate Limit Hit, limit will reset in 60 seconds"). Starting the engine
 * first left the listener closed for up to 90 seconds, which fails a Cloud
 * Run startup probe and rolls the revision back: a throttled RPC at deploy
 * time took the whole deploy down. Now the listener is up in milliseconds,
 * `/api/health` (liveness) answers immediately, and `/api/ready`
 * (readiness) reports not-ready with the engine's reason until the engine
 * is actually running, so a rollout waits for the engine instead of dying
 * with it.
 *
 * Shutdown on SIGTERM/SIGINT: stop accepting connections, stop the engine
 * (interrupting a start still in flight), stop the jobs, close the
 * database, exit 0; or exit 1 after 25 seconds. An unhandled rejection or
 * uncaught exception is logged with its module and the process exits
 * non-zero so the platform restarts a clean one, rather than limping on
 * with a half-broken trading loop.
 */
import { fileURLToPath } from 'node:url'
import { loadConfig } from './config.js'
import { log as rootLog, type Logger } from './log.js'
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
import type { EngineStartupState } from './api/deps.js'
import type { EngineApi } from './types.js'

export const SHUTDOWN_DEADLINE_MS = 25_000
export const EXIT_PENDING_MIGRATIONS = 4
/** Attempts before the phase is called `failed`. Retries continue after that, more slowly. */
export const ENGINE_START_ATTEMPTS = 6
export const ENGINE_START_RETRY_MS = 15_000
export const ENGINE_START_BACKOFF_MS = 60_000
/**
 * How long a shutdown waits for an `engine.start()` already in flight before
 * it stops the engine anyway. A start that is most of the way through has
 * a live feed and running watchers, and its last steps are RPC calls that a
 * throttled endpoint can sit on for a long time; the shutdown must not.
 */
export const ENGINE_STOP_GRACE_MS = 5_000

export interface EngineSupervisorOptions {
  engine: EngineApi
  log: Logger
  /** Run once the engine is running. The oracle jobs start here, so they never run against a dead engine. */
  onRunning?: () => void
  attempts?: number
  retryMs?: number
  backoffMs?: number
  /** How long `stop()` waits for a start in flight before stopping the engine anyway. */
  stopGraceMs?: number
}

export interface EngineSupervisor {
  /** What `/api/ready` reports. */
  state(): EngineStartupState
  /** Resolves when the engine is running, or when the supervisor is stopped. Never rejects. */
  settled: Promise<void>
  /** Stop retrying, interrupt a wait in flight, and stop the engine if it ever started. */
  stop(): Promise<void>
}

/**
 * Starts the engine in the background and keeps trying. A throttled or
 * briefly unreachable RPC must not be fatal: crash-looping on it is slower
 * than waiting it out, and with the listener already up the platform can
 * see exactly why the instance is not ready. After `attempts` failures the
 * phase becomes `failed` (so a probe stops waiting and a rollout rolls
 * back) but the loop keeps retrying at `backoffMs`, so an instance that is
 * left running recovers by itself the moment the chain does.
 */
export function superviseEngineStart(opts: EngineSupervisorOptions): EngineSupervisor {
  const { engine, log } = opts
  const attempts = opts.attempts ?? ENGINE_START_ATTEMPTS
  const retryMs = opts.retryMs ?? ENGINE_START_RETRY_MS
  const backoffMs = opts.backoffMs ?? ENGINE_START_BACKOFF_MS

  const stopGraceMs = opts.stopGraceMs ?? ENGINE_STOP_GRACE_MS
  let state: EngineStartupState = { phase: 'starting', attempt: 0, attempts, error: null, since: new Date().toISOString() }
  let stopping = false
  /**
   * Set before the first `engine.start()` call, not after it returns: a start
   * that got as far as connecting the feed and arming the watchers still owns
   * timers and sockets, so shutdown has to stop it even if it never returned.
   */
  let startAttempted = false
  let wake: (() => void) | null = null

  /** A wait that a shutdown can cut short, so a signal never sits through a retry delay. */
  const waitOrWake = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wake = null
        resolve()
      }, ms)
      timer.unref?.()
      wake = () => {
        clearTimeout(timer)
        wake = null
        resolve()
      }
    })

  const settled = (async () => {
    for (let attempt = 1; !stopping; attempt++) {
      state = { ...state, attempt }
      try {
        startAttempted = true
        await engine.start()
        if (stopping) return
        state = { phase: 'running', attempt, attempts, error: null, since: new Date().toISOString() }
        opts.onRunning?.()
        return
      } catch (err) {
        const error = errorText(err)
        if (stopping) return
        const phase = attempt >= attempts ? 'failed' : 'starting'
        state = { phase, attempt, attempts, error, since: phase === state.phase ? state.since : new Date().toISOString() }
        const retryInMs = attempt >= attempts ? backoffMs : retryMs
        const fields = { attempt, of: attempts, retryInMs, err: error }
        if (phase === 'failed') log.error(fields, 'engine start still failing; the API stays up and reports not-ready, and the engine keeps retrying')
        else log.warn(fields, 'engine start failed; retrying while the API serves reads')
        await waitOrWake(retryInMs)
      }
    }
  })().catch((err: unknown) => {
    // The loop already catches start failures; anything here is a bug in the supervisor itself.
    state = { phase: 'failed', attempt: state.attempt, attempts, error: errorText(err), since: new Date().toISOString() }
    log.error({ err: errorText(err) }, 'engine supervisor failed')
  })

  return {
    state: () => state,
    settled,
    async stop() {
      stopping = true
      wake?.()
      // A retry wait ends immediately; a start already in flight gets a grace
      // period and then the engine is stopped out from under it regardless.
      let timer: NodeJS.Timeout | null = null
      const grace = new Promise<'grace'>((resolve) => {
        timer = setTimeout(() => resolve('grace'), stopGraceMs)
        timer.unref?.()
      })
      const outcome = await Promise.race([settled.then(() => 'settled' as const), grace])
      if (timer) clearTimeout(timer)
      if (outcome === 'grace') log.warn({ graceMs: stopGraceMs, phase: state.phase }, 'engine start still in flight at shutdown; stopping the engine anyway')
      if (startAttempted) await engine.stop()
    },
  }
}

let exiting = false

/** Log once with the module that failed, then leave. Never limp on with a half-broken trading loop. */
function fatal(module: string, err: unknown, code = 1): void {
  if (exiting) return
  exiting = true
  rootLog.child({ module }).fatal({ err: errorText(err), stack: err instanceof Error ? err.stack : undefined }, 'fatal; exiting so the platform restarts a clean process')
  // Give pino one tick to flush before the process goes away.
  setTimeout(() => process.exit(code), 50).unref()
}

export async function main(): Promise<void> {
  process.on('unhandledRejection', (reason) => fatal('unhandledRejection', reason))
  process.on('uncaughtException', (err) => fatal('uncaughtException', err))
  const log = rootLog.child({ module: 'boot' })

  // 1. config
  const config = loadConfig()
  rootLog.level = config.logLevel
  log.info({ network: config.network, chainId: config.chainId, rpcs: config.rpcUrls.length, feed: config.disableFeed ? 'disabled' : config.feedUrl, wallet: config.traderPrivateKey ? 'key set' : 'none', operatorToken: config.operatorToken ? 'set' : 'unset', x402: config.x402.payTo ? 'enabled' : 'disabled', accounts: config.accounts.factory ?? 'single-tenant (no HOOD_ARM_FACTORY)' }, 'config loaded')

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

  // 4. chain client (+ wallet when a key is set). Builds clients; talks to nobody yet.
  const chain = createChainClient(config)
  log.info({ chainId: chain.chainId, rpcs: chain.rpcUrls, wallet: chain.account?.address ?? null }, 'chain client ready')

  // 5. kill switch, bus, engine construction
  const kill = new KillSwitch({ killFile: config.killFile, log: rootLog.child({ module: 'kill' }), ...(config.globalKill ? { initialKill: 'env:GLOBAL_KILL' } : {}) })
  const bus = new EventBus()
  const engine = createEngine({ config, db, log: rootLog.child({ module: 'engine' }), model, bus, chain, kill })

  // 6. API. From here /api/health answers 200 and /api/ready reports why it is not ready yet.
  const metrics = createMetrics({ engine, bus })
  let jobs: ReturnType<typeof startOracleJobs> | null = null
  const supervisor = superviseEngineStart({
    engine,
    log,
    onRunning: () => {
      jobs = startOracleJobs({ db, log: rootLog.child({ module: 'oracle-jobs' }), model, config, chain })
      log.info('engine running; oracle jobs scheduled: labels 30m, calibrate 6h, refit 6h')
    },
  })
  const app = createApp({
    config, db, log: rootLog, engine, model, bus, metrics, engineStartup: supervisor.state,
    // Present only when HOOD_ARM_FACTORY is set: the same registry the engine
    // trades through, so the API and the executor can never disagree about an
    // account's policy or whether we are still its operator.
    accounts: engine.accounts ? { registry: engine.accounts, publicClient: chain.publicClient } : undefined,
  })
  const server = serveApp(app, config.port)
  log.info({ port: config.port, webDist: config.webDist, mcp: '/mcp', metrics: '/api/metrics', ready: '/api/ready' }, 'api listening; starting the engine in the background')

  let shuttingDown = false
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    log.warn({ signal, deadlineMs: SHUTDOWN_DEADLINE_MS, engine: supervisor.state().phase }, 'shutting down: closing the listener, stopping the engine and the jobs, closing the database')
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
      // Interrupts a retry wait and stops the engine only if it ever started.
      await supervisor.stop()
      log.info('engine stopped')
      jobs?.stop()
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

// Importing this module (tests do) must not boot a process; running it must.
const invokedDirectly = process.argv[1] != null && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) main().catch((err: unknown) => fatal('boot', err))
