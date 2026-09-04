import { z } from 'zod'
import type { AppDeps } from '../deps.js'
import { badRequest, conflict } from '../errors.js'

const KILL_BODY = z.object({ reason: z.string().trim().min(1, 'give a reason').max(500) })

export interface KillState {
  killed: boolean
  reason: string | null
}

export function killState(deps: AppDeps): KillState {
  const h = deps.engine.health()
  return { killed: h.killed, reason: h.killReason }
}

/** Trip the global kill switch from an operator. Halts every new buy; exits keep managing; never sells. */
export function tripKill(deps: AppDeps, body: unknown): KillState {
  const parsed = KILL_BODY.safeParse(body)
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'invalid body')
  deps.engine.kill(`operator: ${parsed.data.reason}`)
  deps.log.warn({ reason: parsed.data.reason }, 'kill switch tripped from the API')
  return killState(deps)
}

/** Clear an API kill. Signal, file and env kills are refused with 409. */
export function clearKill(deps: AppDeps): KillState & { cleared: boolean } {
  const before = deps.engine.health()
  if (!before.killed) return { killed: false, reason: null, cleared: false }
  const cleared = deps.engine.unkill()
  if (!cleared) {
    throw conflict(
      'kill_not_clearable',
      `This kill did not come from the API (${before.killReason ?? 'signal or KILL file'}); clear it at the source (remove the KILL file, unset GLOBAL_KILL) and restart.`,
    )
  }
  deps.log.warn('kill switch cleared from the API')
  return { ...killState(deps), cleared: true }
}
