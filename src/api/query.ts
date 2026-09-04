import { z } from 'zod'
import { badRequest } from './errors.js'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/

export function parseLimit(raw: string | undefined, fallback: number, max: number): number {
  if (raw == null || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) throw badRequest(`limit must be a positive integer (got ${JSON.stringify(raw)})`)
  return Math.min(n, max)
}

export function parseUuid(raw: string, what: string): string {
  const r = z.uuid().safeParse(raw)
  if (!r.success) throw badRequest(`${what} must be a UUID`)
  return r.data
}

export function parseOptionalUuid(raw: string | undefined, what: string): string | null {
  if (raw == null || raw === '') return null
  return parseUuid(raw, what)
}

export function parseAddress(raw: string, what = 'token'): string {
  if (!ADDRESS.test(raw)) throw badRequest(`${what} must be a 0x-prefixed 20-byte address`)
  return raw.toLowerCase()
}

export function parseOptionalAddress(raw: string | undefined, what = 'token'): string | null {
  if (raw == null || raw === '') return null
  return parseAddress(raw, what)
}

export function parseEnum<T extends string>(raw: string | undefined, allowed: readonly T[], what: string): T | null {
  if (raw == null || raw === '' || raw === 'all') return null
  if (!(allowed as readonly string[]).includes(raw)) throw badRequest(`${what} must be one of ${allowed.join(', ')}`)
  return raw as T
}

/** `since` accepts an ISO timestamp, epoch ms, or a duration like 24h / 30m / 7d. */
export function parseSince(raw: string | undefined): Date | null {
  if (raw == null || raw === '') return null
  const dur = /^(\d+)([smhd])$/.exec(raw)
  if (dur) {
    const n = Number(dur[1])
    const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[dur[2] as 's' | 'm' | 'h' | 'd']
    return new Date(Date.now() - n * unit)
  }
  const asNumber = Number(raw)
  const d = Number.isFinite(asNumber) && /^\d+$/.test(raw) ? new Date(asNumber) : new Date(raw)
  if (Number.isNaN(d.getTime())) throw badRequest(`since must be an ISO timestamp, epoch milliseconds, or a duration such as 24h`)
  return d
}
