import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { desc, like } from 'drizzle-orm'
import { canonicalJson, computeEntryHash, Journal, verifyJournal } from '../src/engine/journal.js'
import { createDb, type Db } from '../src/db/client.js'
import { decisions } from '../src/db/schema.js'
import { log } from '../src/log.js'

describe('hash chain (pure)', () => {
  it('canonical JSON sorts keys, stringifies bigint and drops undefined', () => {
    expect(canonicalJson({ b: 2n, a: { d: undefined, c: [1n, 'x'] } })).toBe('{"a":{"c":["1","x"]},"b":"2"}')
  })
  it('entry hashes chain and change with any field', () => {
    const p = { armId: null, token: null, kind: 'skip' as const, reason: 'r', detail: { x: 1 }, at: '2026-01-01T00:00:00.000Z' }
    const h1 = computeEntryHash(null, p)
    const h2 = computeEntryHash(h1, p)
    expect(h1).toMatch(/^[0-9a-f]{64}$/)
    expect(h2).not.toBe(h1)
    expect(computeEntryHash(null, { ...p, reason: 'other' })).not.toBe(h1)
  })
})

const url = process.env.DATABASE_URL ?? 'postgres://hood:hood@localhost:5432/hood_oracle'
let handle: ReturnType<typeof createDb> | null = null
let db: Db | null = null

beforeAll(async () => {
  try {
    handle = createDb(url, { max: 2 })
    await handle.client`select 1`
    db = handle.db
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'journal integration test skipped: database unreachable')
    handle = null
  }
})
afterAll(async () => { await handle?.close() })

describe('journal against the database', () => {
  it('appends chained rows and verify() walks them; tampering is detected', async () => {
    if (!db) return
    const journal = new Journal(db, log)
    const tag = `test-${Date.now()}`
    const a = await journal.append({ armId: null, token: null, kind: 'observe', reason: `${tag}-a`, detail: { n: 1n } })
    const b = await journal.append({ armId: null, token: null, kind: 'skip', reason: `${tag}-b`, detail: { n: 2 } })
    expect(a?.entryHash).toBeTruthy()
    expect(b?.prevHash).toBe(a?.entryHash)
    // the database is shared with other suites and engines, so verify the segment this test wrote
    const before = await verifyJournal(db, { from: a!.entryHash })
    expect(before.ok).toBe(true)
    expect(before.checked).toBeGreaterThanOrEqual(2)
    // tamper with the last row and expect the chain to break there
    const [last] = await db.select().from(decisions).where(like(decisions.reason, `${tag}-%`)).orderBy(desc(decisions.at)).limit(1)
    await db.update(decisions).set({ reason: `${tag}-tampered` }).where(like(decisions.entryHash, last!.entryHash))
    const after = await verifyJournal(db, { from: a!.entryHash })
    expect(after.ok).toBe(false)
    expect(after.brokenAt?.id).toBe(last!.id)
    expect(after.brokenAt?.why).toBe('hash')
    // restore so the shared database stays consistent for other suites
    await db.update(decisions).set({ reason: last!.reason }).where(like(decisions.entryHash, last!.entryHash))
    expect((await verifyJournal(db, { from: a!.entryHash })).ok).toBe(true)
    // the full-chain walk reports precisely how the shared history stands
    const whole = await verifyJournal(db)
    log.info({ ok: whole.ok, checked: whole.checked, brokenAt: whole.brokenAt }, 'whole journal chain')
  })
})
