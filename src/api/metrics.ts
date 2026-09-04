/**
 * A dependency-free Prometheus text registry plus the process, HTTP and
 * engine collectors that feed GET /api/metrics. Counters and histograms are
 * incremented as events happen; gauges are read at scrape time so the page
 * always reflects the engine as it is now, not as it was on the last tick.
 */
import type { MiddlewareHandler } from 'hono'
import type { EngineApi, EventBusApi } from '../types.js'

type Labels = Record<string, string>

const LATENCY_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]

function labelKey(labels: Labels): string {
  const keys = Object.keys(labels).sort()
  return keys.map((k) => `${k}=${JSON.stringify(labels[k])}`).join(',')
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')
}

function renderLabels(labels: Labels, extra?: Labels): string {
  const all = { ...labels, ...extra }
  const keys = Object.keys(all).sort()
  if (!keys.length) return ''
  return `{${keys.map((k) => `${k}="${escapeLabel(all[k]!)}"`).join(',')}}`
}

function fmt(n: number): string {
  if (n === Number.POSITIVE_INFINITY) return '+Inf'
  if (Number.isInteger(n)) return String(n)
  return String(n)
}

class Counter {
  private readonly series = new Map<string, { labels: Labels; value: number }>()
  constructor(readonly name: string, readonly help: string) {}
  inc(labels: Labels = {}, by = 1): void {
    const key = labelKey(labels)
    const s = this.series.get(key)
    if (s) s.value += by
    else this.series.set(key, { labels, value: by })
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`]
    if (!this.series.size) lines.push(`${this.name} 0`)
    for (const s of this.series.values()) lines.push(`${this.name}${renderLabels(s.labels)} ${fmt(s.value)}`)
    return lines.join('\n')
  }
}

class Gauge {
  constructor(
    readonly name: string,
    readonly help: string,
    private readonly collect: () => { labels?: Labels; value: number | null }[],
  ) {}
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`]
    for (const s of this.collect()) {
      if (s.value == null || Number.isNaN(s.value)) continue
      lines.push(`${this.name}${renderLabels(s.labels ?? {})} ${fmt(s.value)}`)
    }
    return lines.join('\n')
  }
}

class Histogram {
  private readonly series = new Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>()
  constructor(
    readonly name: string,
    readonly help: string,
    private readonly buckets: number[],
  ) {}
  observe(value: number, labels: Labels = {}): void {
    const key = labelKey(labels)
    let s = this.series.get(key)
    if (!s) {
      s = { labels, counts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 }
      this.series.set(key, s)
    }
    for (let i = 0; i < this.buckets.length; i++) if (value <= this.buckets[i]!) s.counts[i]!++
    s.sum += value
    s.count++
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`]
    for (const s of this.series.values()) {
      for (let i = 0; i < this.buckets.length; i++) lines.push(`${this.name}_bucket${renderLabels(s.labels, { le: fmt(this.buckets[i]!) })} ${s.counts[i]}`)
      lines.push(`${this.name}_bucket${renderLabels(s.labels, { le: '+Inf' })} ${s.count}`)
      lines.push(`${this.name}_sum${renderLabels(s.labels)} ${fmt(s.sum)}`)
      lines.push(`${this.name}_count${renderLabels(s.labels)} ${s.count}`)
    }
    return lines.join('\n')
  }
}

export class Registry {
  private readonly collectors: { render(): string }[] = []
  counter(name: string, help: string): Counter {
    const c = new Counter(name, help)
    this.collectors.push(c)
    return c
  }
  gauge(name: string, help: string, collect: () => { labels?: Labels; value: number | null }[]): Gauge {
    const g = new Gauge(name, help, collect)
    this.collectors.push(g)
    return g
  }
  histogram(name: string, help: string, buckets: number[]): Histogram {
    const h = new Histogram(name, help, buckets)
    this.collectors.push(h)
    return h
  }
  /** Prometheus text exposition format 0.0.4. */
  render(): string {
    return this.collectors.map((c) => c.render()).join('\n\n') + '\n'
  }
}

export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8'

export interface MetricsOptions {
  engine: EngineApi
  bus: EventBusApi
  /** Event-loop lag sample period, ms. */
  lagSampleMs?: number
  /** How often the head block is sampled for the watcher watchdog, ms. */
  headSampleMs?: number
  now?: () => number
}

export interface Metrics {
  registry: Registry
  /** Records request count and latency per matched route. Mount before the routes. */
  httpMiddleware: MiddlewareHandler
  /** Last measured event-loop lag, ms. */
  eventLoopLagMs(): number
  /**
   * The engine's data path is alive: the sequencer feed is connected, or the
   * log watchers advanced the head block within `withinMs`.
   */
  dataPathHealthy(withinMs?: number): { ok: boolean; feedConnected: boolean; headBlock: number | null; headAdvancedAgoMs: number | null }
  stop(): void
}

export function createMetrics(opts: MetricsOptions): Metrics {
  const { engine, bus } = opts
  const now = opts.now ?? (() => Date.now())
  const registry = new Registry()
  const startedAt = now()

  // process
  registry.gauge('process_uptime_seconds', 'Seconds since the process started.', () => [{ value: (now() - startedAt) / 1000 }])
  registry.gauge('process_start_time_seconds', 'Unix time the process started.', () => [{ value: startedAt / 1000 }])
  registry.gauge('process_resident_memory_bytes', 'Resident set size.', () => [{ value: process.memoryUsage().rss }])
  registry.gauge('nodejs_heap_size_used_bytes', 'V8 heap in use.', () => [{ value: process.memoryUsage().heapUsed }])
  registry.gauge('nodejs_heap_size_total_bytes', 'V8 heap allocated.', () => [{ value: process.memoryUsage().heapTotal }])
  registry.gauge('nodejs_external_memory_bytes', 'Memory held by C++ objects bound to JS.', () => [{ value: process.memoryUsage().external }])

  // event loop lag: a timer asked for `period` ms that fires late by the lag
  const period = opts.lagSampleMs ?? 500
  let lagMs = 0
  let lagMaxMs = 0
  let expectedAt = now() + period
  const lagTimer = setInterval(() => {
    const t = now()
    lagMs = Math.max(0, t - expectedAt)
    lagMaxMs = Math.max(lagMaxMs, lagMs)
    expectedAt = t + period
  }, period)
  lagTimer.unref()
  registry.gauge('nodejs_eventloop_lag_seconds', 'Event-loop lag measured by a 500ms timer, last sample.', () => [{ value: lagMs / 1000 }])
  registry.gauge('nodejs_eventloop_lag_max_seconds', 'Largest event-loop lag observed since boot.', () => [{ value: lagMaxMs / 1000 }])

  // http
  const httpRequests = registry.counter('http_requests_total', 'HTTP requests by method, matched route and status.')
  const httpLatency = registry.histogram('http_request_duration_ms', 'HTTP request latency in milliseconds (time to headers for streams).', LATENCY_BUCKETS_MS)
  const httpMiddleware: MiddlewareHandler = async (c, next) => {
    const started = performance.now()
    await next()
    const route = c.req.routePath && c.req.routePath !== '/*' ? c.req.routePath : c.req.path.startsWith('/api/') ? c.req.path : 'static'
    const labels = { method: c.req.method, route, status: String(c.res.status) }
    httpRequests.inc(labels)
    httpLatency.observe(performance.now() - started, { method: c.req.method, route })
  }

  // engine gauges, read live from engine.health() at scrape time
  const health = () => engine.health()
  registry.gauge('hood_feed_connected', 'Sequencer feed websocket connected (1) or not (0).', () => [{ value: health().feed.connected ? 1 : 0 }])
  registry.gauge('hood_feed_seconds_since_frame', 'Seconds since the last sequencer frame; absent until one arrives.', () => [{ value: health().feed.secondsSinceFrame }])
  registry.gauge('hood_feed_last_sequence', 'Last sequencer sequence number seen.', () => [{ value: health().feed.lastSequence }])
  registry.gauge('hood_head_block', 'Latest block the log watchers have seen.', () => [{ value: health().headBlock }])
  registry.gauge('hood_positions_open', 'Open positions across every arm.', () => [{ value: health().positions.open }])
  registry.gauge('hood_killed', 'Global kill switch tripped (1) or clear (0).', () => [{ value: health().killed ? 1 : 0 }])
  registry.gauge('hood_arms', 'Arms by state.', () => {
    const a = health().arms
    return [
      { labels: { state: 'total' }, value: a.total },
      { labels: { state: 'enabled' }, value: a.enabled },
      { labels: { state: 'live' }, value: a.live },
    ]
  })
  registry.gauge('hood_wallet_live', 'A signing wallet is loaded and an arm is live (1) or not (0).', () => [{ value: health().wallet.live ? 1 : 0 }])
  registry.gauge('hood_wallet_eth_wei', 'Signing wallet balance in wei; absent when there is no wallet.', () => {
    const w = health().wallet.ethWei
    return [{ value: w == null ? null : Number(w) }]
  })
  registry.gauge('hood_launches_last_hour', 'Launches taken in during the trailing hour, by launchpad.', () =>
    Object.entries(health().launchpads).map(([launchpad, n]) => ({ labels: { launchpad }, value: n })),
  )

  // engine counters from the bus
  const events = registry.counter('hood_engine_events_total', 'Engine bus events by kind.')
  const launches = registry.counter('hood_launches_total', 'Launches taken in, by launchpad and venue.')
  const scores = registry.counter('hood_scores_total', 'Oracle verdicts, by tier.')
  const trades = registry.counter('hood_trades_total', 'Trades executed, by side and mode.')
  const decisions = registry.counter('hood_decisions_total', 'Journal decisions, by kind.')
  const refusals = registry.counter('hood_refusals_total', 'Buys refused by the guards, by reason.')
  const skips = registry.counter('hood_skips_total', 'Launches an arm skipped at the entry gate, by reason.')
  const kills = registry.counter('hood_kill_trips_total', 'Kill switch trips.')
  const unsubscribe = bus.subscribe((e) => {
    events.inc({ kind: e.kind })
    switch (e.kind) {
      case 'launch':
        launches.inc({ launchpad: e.launch.launchpad, venue: e.launch.venue })
        break
      case 'score':
        scores.inc({ tier: e.verdict.tier })
        break
      case 'trade':
        trades.inc({ side: e.trade.side, mode: e.trade.mode })
        break
      case 'decision':
        decisions.inc({ kind: e.decision.kind })
        if (e.decision.kind === 'refused') refusals.inc({ reason: e.decision.reason })
        if (e.decision.kind === 'skip') skips.inc({ reason: e.decision.reason })
        break
      case 'kill':
        kills.inc()
        break
      default:
        break
    }
  })

  // watcher watchdog: when did the head block last advance?
  let lastHead: number | null = null
  let lastHeadAdvanceAt: number | null = null
  const sampleHead = () => {
    const head = health().headBlock
    if (head != null && head !== lastHead) {
      lastHead = head
      lastHeadAdvanceAt = now()
    }
  }
  sampleHead()
  const headTimer = setInterval(sampleHead, opts.headSampleMs ?? 5_000)
  headTimer.unref()

  return {
    registry,
    httpMiddleware,
    eventLoopLagMs: () => lagMs,
    dataPathHealthy(withinMs = 60_000) {
      sampleHead()
      const h = health()
      const ago = lastHeadAdvanceAt == null ? null : now() - lastHeadAdvanceAt
      return { ok: h.feed.connected || (ago != null && ago <= withinMs), feedConnected: h.feed.connected, headBlock: h.headBlock, headAdvancedAgoMs: ago }
    },
    stop() {
      clearInterval(lagTimer)
      clearInterval(headTimer)
      unsubscribe()
    },
  }
}
