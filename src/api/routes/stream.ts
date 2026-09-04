import { Hono } from 'hono'
import { streamSSE, type SSEStreamingApi } from 'hono/streaming'
import type { AppDeps } from '../deps.js'
import type { EngineEvent } from '../../types.js'
import { stringify } from '../json.js'

export const HEARTBEAT_MS = 15_000
const ORACLE_KINDS = new Set<EngineEvent['kind']>(['launch', 'features', 'score'])

/**
 * One SSE connection: `hello`, then a replay of the bus ring buffer (so a
 * dashboard opened late still has a tape), then live events as they happen.
 * A heartbeat every 15s keeps proxies from idling the socket out. The
 * subscription and timer are released the moment the client goes away.
 */
function sseHandler(deps: AppDeps, filter: ((e: EngineEvent) => boolean) | null, name: string) {
  return (c: import('hono').Context) =>
    streamSSE(
      c,
      async (stream) => {
        const { bus, log, config } = deps
        let seq = 0
        let open = true
        const send = async (event: string, data: unknown) => {
          if (!open || stream.closed || stream.aborted) return
          try {
            await stream.writeSSE({ event, data: stringify(data), id: String(++seq) })
          } catch (err) {
            open = false
            log.debug({ err: err instanceof Error ? err.message : String(err), stream: name }, 'sse write failed; closing')
          }
        }
        // Writes are serialized through a promise chain so a burst from the bus
        // never interleaves two frames on the wire.
        let queue: Promise<void> = Promise.resolve()
        const enqueue = (event: string, data: unknown) => {
          queue = queue.then(() => send(event, data))
        }

        const replay = bus.recent().filter((e) => (filter ? filter(e) : true))
        enqueue('hello', { at: Date.now(), network: config.network, chainId: config.chainId, replay: replay.length, heartbeatMs: HEARTBEAT_MS })
        for (const e of replay) enqueue(e.kind, e)

        const unsubscribe = bus.subscribe((e) => {
          if (filter && !filter(e)) return
          enqueue(e.kind, e)
        })
        const heartbeat = setInterval(() => enqueue('ping', { at: Date.now() }), HEARTBEAT_MS)

        await new Promise<void>((resolve) => {
          const finish = () => {
            if (!open) return resolve()
            open = false
            resolve()
          }
          stream.onAbort(finish)
          c.req.raw.signal.addEventListener('abort', finish, { once: true })
          // A failed write (peer gone without an abort) also ends the wait.
          const watchdog = setInterval(() => {
            if (!open || stream.closed || stream.aborted) {
              clearInterval(watchdog)
              finish()
            }
          }, 1_000)
        })
        clearInterval(heartbeat)
        unsubscribe()
        await queue.catch(() => undefined)
      },
      async (err, stream: SSEStreamingApi) => {
        deps.log.warn({ err: err.message, stream: name }, 'sse stream error')
        if (!stream.closed) await stream.close()
      },
    )
}

export function streamRoutes(deps: AppDeps): Hono {
  const app = new Hono()
  app.get('/stream', sseHandler(deps, null, 'engine'))
  app.get('/oracle/stream', sseHandler(deps, (e) => ORACLE_KINDS.has(e.kind), 'oracle'))
  return app
}
