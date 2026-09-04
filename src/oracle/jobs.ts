/**
 * Oracle: the learning loop's clock.
 *
 *   labels     every 30 minutes: bridge realized results from closed live
 *              positions, then resolve chart labels for launches past the
 *              24-hour horizon.
 *   calibrate  every 6 hours: observed hit rate per score band.
 *   refit      every 6 hours, offset from calibrate: fit, gate, promote.
 *
 * Each job has overlap protection (a tick that fires while the previous run
 * is still going is skipped, and runNow awaits the run in flight instead of
 * starting a second one). Every failure is logged and swallowed: a job that
 * throws must never take the trading process down with it. Timers are
 * unref'd so they never hold the process open past a shutdown.
 */
import type { Config } from '../config.js'
import { createChainClient, errorText, type ChainClient } from '../chain/client.js'
import { Prices } from '../chain/prices.js'
import type { Db } from '../db/client.js'
import type { Logger } from '../log.js'
import type { OracleJobsApi } from '../types.js'
import { runCalibration } from './calibrate.js'
import { createOracleHistory, type OracleHistory } from './history.js'
import { bridgeRealized, resolveLabels } from './labels.js'
import { holdEventLoop } from './keepalive.js'
import type { ModelStore } from './model-store.js'
import { runRefit } from './refit.js'

export type OracleJobName = 'labels' | 'calibrate' | 'refit'

export interface OracleJobsOptions {
  db: Db
  log: Logger
  model: ModelStore
  config: Config
  /** Reuse the engine's chain client; one is built from config when absent. */
  chain?: ChainClient
  /** Override the schedule (ms). Tests use this. */
  intervals?: Partial<Record<OracleJobName, number>>
  initialDelays?: Partial<Record<OracleJobName, number>>
}

export const DEFAULT_INTERVALS: Record<OracleJobName, number> = {
  labels: 30 * 60_000,
  calibrate: 6 * 60 * 60_000,
  refit: 6 * 60 * 60_000,
}

export const DEFAULT_INITIAL_DELAYS: Record<OracleJobName, number> = {
  labels: 60_000,
  calibrate: 5 * 60_000,
  refit: 10 * 60_000,
}

export function startOracleJobs(opts: OracleJobsOptions): OracleJobsApi & { history: OracleHistory } {
  const { db, log, model, config } = opts
  const chain = opts.chain ?? createChainClient(config)
  const prices = new Prices(chain)
  const history = createOracleHistory({ chain, prices, log })
  const network = config.network
  const intervals = { ...DEFAULT_INTERVALS, ...opts.intervals }
  const delays = { ...DEFAULT_INITIAL_DELAYS, ...opts.initialDelays }

  const runners: Record<OracleJobName, () => Promise<void>> = {
    labels: async () => {
      const bridged = await bridgeRealized({ db, network, log })
      let total = { candidates: 0, resolved: 0, unlabelable: 0, failed: 0 }
      // Keep draining until a batch finds nothing new; failed and unlabelable
      // tokens stay candidates, so a batch of only those ends the loop.
      for (let i = 0; i < 20; i++) {
        const r = await resolveLabels({ db, history, network, log, limit: 100 })
        total = { candidates: total.candidates + r.candidates, resolved: total.resolved + r.resolved, unlabelable: total.unlabelable + r.unlabelable, failed: total.failed + r.failed }
        if (r.resolved === 0) break
      }
      log.info({ network, bridged, ...total }, 'oracle jobs: labels pass done')
    },
    calibrate: async () => {
      await runCalibration({ db, log, network, model })
    },
    refit: async () => {
      const r = await runRefit({ db, log, network, model })
      log.info({ network, fitted: r.fitted, promoted: r.promoted, rows: r.rows, reason: r.reason }, 'oracle jobs: refit pass done')
    },
  }

  const inflight: Partial<Record<OracleJobName, Promise<void>>> = {}
  const timers: NodeJS.Timeout[] = []
  let stopped = false

  function run(job: OracleJobName): Promise<void> {
    const running = inflight[job]
    if (running) return running
    const p = (async () => {
      const t = Date.now()
      const release = holdEventLoop()
      try {
        await runners[job]()
        log.debug({ job, ms: Date.now() - t }, 'oracle jobs: finished')
      } catch (err) {
        log.error({ job, err: errorText(err) }, 'oracle jobs: failed')
      } finally {
        release()
        delete inflight[job]
      }
    })()
    inflight[job] = p
    return p
  }

  for (const job of Object.keys(runners) as OracleJobName[]) {
    const first = setTimeout(() => {
      if (stopped) return
      void run(job)
      const every = setInterval(() => { if (!stopped) void run(job) }, intervals[job])
      every.unref?.()
      timers.push(every)
    }, delays[job])
    first.unref?.()
    timers.push(first)
  }

  return {
    history,
    runNow: (job) => run(job),
    stop: () => {
      stopped = true
      for (const t of timers) clearTimeout(t)
      timers.length = 0
    },
  }
}
