import type { EngineEventWire } from '../../src/api/contract'

export const EVENT_KINDS = ['launch', 'features', 'score', 'decision', 'trade', 'position', 'graduation', 'status', 'kill'] as const
export type EventKind = (typeof EVENT_KINDS)[number]

export interface HelloFrame {
  at: number
  network: string
  chainId: number
  replay: number
  heartbeatMs: number
}

export interface StreamOptions {
  onEvent(event: EngineEventWire): void
  onHello?(hello: HelloFrame): void
  /** connected flips false while reconnecting. */
  onState?(connected: boolean): void
}

export interface StreamHandle {
  close(): void
  readonly connected: boolean
}

const MIN_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 15_000

/**
 * EventSource with explicit reconnect. The browser retries a dropped
 * connection on its own; when the server answers with an error the source
 * goes CLOSED and stays there, so that case is reopened here with backoff.
 * A missed heartbeat (2x the server interval) also forces a reopen.
 */
export function openStream(path: string, opts: StreamOptions): StreamHandle {
  let es: EventSource | null = null
  let closed = false
  let connected = false
  let backoff = MIN_BACKOFF_MS
  let reconnectTimer: number | null = null
  let watchdog: number | null = null
  let heartbeatMs = 15_000
  let lastFrame = Date.now()

  const setConnected = (on: boolean) => {
    if (connected === on) return
    connected = on
    opts.onState?.(on)
  }

  const scheduleReopen = () => {
    if (closed || reconnectTimer != null) return
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null
      backoff = Math.min(MAX_BACKOFF_MS, backoff * 2)
      open()
    }, backoff)
  }

  const teardown = () => {
    if (watchdog != null) {
      clearInterval(watchdog)
      watchdog = null
    }
    if (es) {
      es.close()
      es = null
    }
  }

  const open = () => {
    if (closed) return
    teardown()
    es = new EventSource(path)
    lastFrame = Date.now()
    es.addEventListener('hello', (e) => {
      lastFrame = Date.now()
      backoff = MIN_BACKOFF_MS
      setConnected(true)
      try {
        const hello = JSON.parse((e as MessageEvent).data) as HelloFrame
        heartbeatMs = hello.heartbeatMs || heartbeatMs
        opts.onHello?.(hello)
      } catch {
        // a malformed hello still means the socket is up
      }
    })
    es.addEventListener('ping', () => {
      lastFrame = Date.now()
    })
    for (const kind of EVENT_KINDS) {
      es.addEventListener(kind, (e) => {
        lastFrame = Date.now()
        try {
          opts.onEvent(JSON.parse((e as MessageEvent).data) as EngineEventWire)
        } catch {
          // skip a frame the server could not encode; the next one still counts
        }
      })
    }
    es.onerror = () => {
      setConnected(false)
      if (es && es.readyState === EventSource.CLOSED) {
        teardown()
        scheduleReopen()
      }
    }
    watchdog = window.setInterval(() => {
      if (Date.now() - lastFrame > heartbeatMs * 2 + 2_000) {
        setConnected(false)
        teardown()
        scheduleReopen()
      }
    }, 5_000)
  }

  open()
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !closed && (!es || es.readyState === EventSource.CLOSED)) open()
  })

  return {
    close() {
      closed = true
      if (reconnectTimer != null) clearTimeout(reconnectTimer)
      teardown()
      setConnected(false)
    },
    get connected() {
      return connected
    },
  }
}
