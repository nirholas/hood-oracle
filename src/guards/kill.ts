/**
 * Global kill switch.
 *
 * A kill HALTS NEW RISK. It never sells, unwinds, or cancels anything on its
 * own: a forced market exit into thin launch liquidity during whatever caused
 * the panic is usually worse than holding, and an operator can always close a
 * position by hand from the dashboard. The engine checks `isKilled()` before
 * every buy and keeps managing exits (stops, ladders, timeouts) while killed.
 *
 * Four independent triggers, each carrying a reason prefix so the dashboard
 * can say which one fired:
 *
 *   signal:SIGINT / signal:SIGTERM   Ctrl-C, `docker compose stop`, Cloud Run
 *                                    shutdown. The process is being asked to
 *                                    stop; a second signal of the same kind
 *                                    force-exits.
 *   file:<path>                      the kill file exists on disk (polled every
 *                                    second). A drop-a-file panic button that
 *                                    works over ssh, a volume mount, or a
 *                                    Cloud Run exec.
 *   env:GLOBAL_KILL                  the engine booted with GLOBAL_KILL=1. The
 *                                    deploy itself is the kill.
 *   api:<text> / operator: <text>    POST /api/kill from an operator. The API
 *                                    route writes `operator: <reason>`; both
 *                                    spellings are recognised as API kills.
 *
 * Only an API kill is clearable at runtime (`clearApiKill`). The other
 * three are not, on purpose: a signal means shutdown is already in progress
 * and there is nothing to resume into; a file kill is re-tripped by the next
 * poll as long as the file exists, and the person who dropped the file is the
 * one who should remove it and restart; an env kill is a deployment decision
 * and is undone by deploying without it. Clearing any of those from a button
 * would let a dashboard override an out-of-band operator action, which is the
 * opposite of what a panic button is for.
 */
import { existsSync } from 'node:fs'

export interface KillLog {
  info(msg: string): void
  warn(msg: string): void
}

export interface KillSwitchOptions {
  /** Path polled every second; its presence trips the switch. */
  killFile: string
  log: KillLog
  /**
   * Reason to trip with at construction, before `arm()`. `src/index.ts` passes
   * `'env:GLOBAL_KILL'` when the GLOBAL_KILL env var is set so the engine
   * never opens a position on a deploy that was meant to be halted.
   */
  initialKill?: string
  /** Poll interval for the kill file, ms. Default 1000. */
  pollMs?: number
}

/** Reason prefixes that mark a kill as operator-initiated through the API, and therefore clearable. */
export const CLEARABLE_KILL_PREFIXES: readonly string[] = ['api:', 'operator:']

export function isApiKillReason(reason: string | null): boolean {
  return reason !== null && CLEARABLE_KILL_PREFIXES.some((p) => reason.startsWith(p))
}

export class KillSwitch {
  private killed = false
  private killReason: string | null = null
  private readonly tripListeners = new Set<(reason: string) => void>()
  private readonly clearListeners = new Set<() => void>()
  private fileTimer: ReturnType<typeof setInterval> | null = null
  private readonly signalHandlers = new Map<NodeJS.Signals, () => void>()
  private readonly killFile: string
  private readonly log: KillLog
  private readonly pollMs: number

  constructor(opts: KillSwitchOptions) {
    this.killFile = opts.killFile
    this.log = opts.log
    this.pollMs = opts.pollMs ?? 1000
    if (opts.initialKill) this.trip(opts.initialKill)
  }

  /**
   * Install SIGINT/SIGTERM handlers and start polling the kill file. If the
   * file already exists at boot the switch trips immediately. Idempotent.
   */
  arm(): void {
    if (this.fileTimer) return
    for (const sig of ['SIGINT', 'SIGTERM'] as const) {
      const handler = () => {
        if (this.killed) {
          // Second signal while already halted: the operator wants out now.
          this.log.warn(`${sig} received while killed (${this.killReason}); exiting`)
          process.exit(sig === 'SIGINT' ? 130 : 143)
        }
        this.trip(`signal:${sig}`)
      }
      this.signalHandlers.set(sig, handler)
      process.on(sig, handler)
    }
    const poll = () => {
      if (!this.killed && existsSync(this.killFile)) this.trip(`file:${this.killFile}`)
    }
    poll()
    this.fileTimer = setInterval(poll, this.pollMs)
    // Never keep the event loop alive solely for this poll.
    this.fileTimer.unref()
  }

  /** Trip the switch. Idempotent: the first reason wins and later trips are logged, not applied. */
  trip(reason: string): void {
    if (this.killed) {
      if (reason !== this.killReason) this.log.info(`kill already tripped (${this.killReason}); ignoring ${reason}`)
      return
    }
    this.killed = true
    this.killReason = reason
    this.log.warn(`kill switch tripped: ${reason}. New buys halted; exits keep managing.`)
    for (const fn of this.tripListeners) {
      try {
        fn(reason)
      } catch (err) {
        this.log.warn(`kill listener threw: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  /**
   * Clear a kill that came from the API. Returns true when the switch is now
   * open. Signal, file and env kills are refused (see the module comment) and
   * a switch that is not killed returns true without doing anything.
   */
  clearApiKill(): boolean {
    if (!this.killed) return true
    if (!isApiKillReason(this.killReason)) {
      this.log.warn(`refusing to clear a ${this.killReason} kill from the API`)
      return false
    }
    const cleared = this.killReason
    this.killed = false
    this.killReason = null
    this.log.info(`kill cleared (${cleared}); buys may resume`)
    for (const fn of this.clearListeners) {
      try {
        fn()
      } catch (err) {
        this.log.warn(`kill clear listener threw: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return true
  }

  isKilled(): boolean {
    return this.killed
  }

  reason(): string | null {
    return this.killReason
  }

  /** Subscribe to the trip event. Returns an unsubscribe function. */
  onTrip(fn: (reason: string) => void): () => void {
    this.tripListeners.add(fn)
    return () => this.tripListeners.delete(fn)
  }

  /** Subscribe to a successful `clearApiKill`. Returns an unsubscribe function. */
  onClear(fn: () => void): () => void {
    this.clearListeners.add(fn)
    return () => this.clearListeners.delete(fn)
  }

  /** Stop polling and remove the signal handlers. The killed state is kept. */
  dispose(): void {
    if (this.fileTimer) clearInterval(this.fileTimer)
    this.fileTimer = null
    for (const [sig, handler] of this.signalHandlers) process.off(sig, handler)
    this.signalHandlers.clear()
    this.tripListeners.clear()
    this.clearListeners.clear()
  }
}
