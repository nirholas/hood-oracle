/**
 * Hash-chained decision journal. Every buy, sell, skip, refusal, observation
 * and error is a `decisions` row whose entryHash = sha256(prevHash + canonical
 * JSON of the row). A row edited or deleted after the fact breaks the chain,
 * and verify() says exactly where.
 */
import { createHash } from 'node:crypto'
import { asc, desc, sql } from 'drizzle-orm'
import type { Address } from 'viem'
import type { Db } from '../db/client.js'
import { decisions } from '../db/schema.js'
import type { Decision, DecisionKind, EventBusApi } from '../types.js'
import type { Logger } from '../log.js'

export interface JournalEntry {
  armId: string | null
  token: Address | null
  kind: DecisionKind
  reason: string
  detail?: Record<string, unknown>
}

/** JSON with sorted keys and bigint as decimal strings, so the hash is deterministic. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString()
  if (v instanceof Date) return v.toISOString()
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const x = (v as Record<string, unknown>)[k]
      if (x === undefined) continue
      out[k] = sortKeys(x)
    }
    return out
  }
  return v
}

export interface HashedPayload {
  armId: string | null
  token: string | null
  kind: DecisionKind
  reason: string
  detail: Record<string, unknown>
  at: string
}

export function computeEntryHash(prevHash: string | null, payload: HashedPayload): string {
  return createHash('sha256').update((prevHash ?? '') + canonicalJson(payload)).digest('hex')
}

/** Advisory lock key that serializes journal appends across every process sharing the database. */
const JOURNAL_LOCK_KEY = 0x686f6f64_6a6f7572n // "hoodjour"

export class Journal {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly db: Db, private readonly log: Logger, private readonly bus?: EventBusApi) {}

  /**
   * Append one row. The previous hash is read inside a transaction that holds
   * a database advisory lock, so two engine processes (or a test and the
   * engine) appending at once still produce one chain rather than a fork.
   * In-process calls are queued as well. Never throws into the trade path: a
   * failed write is logged and returns null.
   */
  append(entry: JournalEntry): Promise<Decision | null> {
    const run = async (): Promise<Decision | null> => {
      const at = new Date()
      const payload: HashedPayload = {
        armId: entry.armId,
        token: entry.token ? entry.token.toLowerCase() : null,
        kind: entry.kind,
        reason: entry.reason,
        detail: JSON.parse(canonicalJson(entry.detail ?? {})) as Record<string, unknown>,
        at: at.toISOString(),
      }
      try {
        return await this.db.transaction(async (tx) => {
          await tx.execute(sql`select pg_advisory_xact_lock(${JOURNAL_LOCK_KEY})`)
          const tail = await tx.select({ entryHash: decisions.entryHash }).from(decisions).orderBy(desc(decisions.at), desc(decisions.id)).limit(1)
          const prevHash = tail[0]?.entryHash ?? null
          const entryHash = computeEntryHash(prevHash, payload)
          const [row] = await tx.insert(decisions).values({
            armId: entry.armId, token: payload.token, kind: entry.kind, reason: entry.reason, detail: payload.detail, prevHash, entryHash, at,
          }).returning({ id: decisions.id })
          const decision: Decision = {
            id: row!.id, armId: entry.armId, token: entry.token, kind: entry.kind, reason: entry.reason,
            detail: payload.detail, prevHash, entryHash, at,
          }
          this.bus?.emit({ kind: 'decision', at: at.getTime(), decision })
          return decision
        })
      } catch (err) {
        this.log.warn({ err: (err as Error).message, kind: entry.kind, reason: entry.reason }, 'journal write failed')
        return null
      }
    }
    const next: Promise<Decision | null> = this.queue.then(run, run)
    this.queue = next.catch(() => undefined)
    return next
  }
}

export interface VerifyResult {
  ok: boolean
  checked: number
  /** First row that fails: its hash does not recompute, its predecessor is missing, or two rows claim the same predecessor (a fork). */
  brokenAt: { id: string; at: Date; expected: string; actual: string; why: 'hash' | 'missing_prev' | 'fork' | 'multiple_genesis' } | null
}

export interface VerifyOptions {
  limit?: number
  /** Start the walk at the row with this entryHash (treated as genesis); verifies a segment of a long chain. */
  from?: string
}

/**
 * Walk the chain by its prevHash links (not by timestamp, which two writers
 * can interleave) and recompute every hash. Reports the first hash mismatch,
 * dangling predecessor, fork, or second genesis it meets.
 */
export async function verifyJournal(db: Db, opts: VerifyOptions | number = {}): Promise<VerifyResult> {
  const o = typeof opts === 'number' ? { limit: opts } : opts
  const rows = await db.select().from(decisions).orderBy(asc(decisions.at), asc(decisions.id)).limit(o.limit ?? 100_000)
  const byHash = new Map(rows.map((r) => [r.entryHash, r]))
  const children = new Map<string | null, typeof rows>()
  for (const r of rows) children.set(r.prevHash, [...(children.get(r.prevHash) ?? []), r])
  const fail = (r: (typeof rows)[number], expected: string, why: NonNullable<VerifyResult['brokenAt']>['why'], checked: number): VerifyResult =>
    ({ ok: false, checked, brokenAt: { id: r.id, at: r.at, expected, actual: r.entryHash, why } })
  let current: (typeof rows)[number] | undefined
  let prev: string | null
  if (o.from) {
    current = byHash.get(o.from)
    if (!current) return { ok: false, checked: 0, brokenAt: null }
    prev = current.prevHash
  } else {
    const genesis = children.get(null) ?? []
    if (genesis.length > 1) return fail(genesis[1]!, '', 'multiple_genesis', 0)
    current = genesis[0]
    prev = null
  }
  let checked = 0
  while (current) {
    const expected = computeEntryHash(prev, {
      armId: current.armId, token: current.token, kind: current.kind as DecisionKind, reason: current.reason, detail: current.detail, at: current.at.toISOString(),
    })
    if (expected !== current.entryHash) return fail(current, expected, 'hash', checked)
    checked++
    const next: typeof rows = children.get(current.entryHash) ?? []
    if (next.length > 1) return fail(next[1]!, current.entryHash, 'fork', checked)
    prev = current.entryHash
    current = next[0]
  }
  for (const r of rows) if (r.prevHash && !byHash.has(r.prevHash)) return fail(r, r.prevHash, 'missing_prev', checked)
  return { ok: true, checked, brokenAt: null }
}
