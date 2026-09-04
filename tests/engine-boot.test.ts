/**
 * Boots the whole engine (real chain client, real sequencer feed, real
 * database, the real model store) in simulate mode with no arms armed, checks
 * its health report, and stops it. Skips with a logged reason when the RPC or
 * the database is unreachable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { createDb } from '../src/db/client.js'
import { EventBus } from '../src/engine/bus.js'
import { createEngine } from '../src/engine/index.js'
import { probeRpcUrls } from '../src/chain/client.js'
import { createModelStore } from '../src/oracle/model-store.js'
import { log } from '../src/log.js'
import { withLiveLock } from './live-lock.js'
import type { EngineApi, EngineEvent } from '../src/types.js'

let engine: EngineApi | null = null
let handle: ReturnType<typeof createDb> | null = null
let skip = ''
const events: EngineEvent[] = []

beforeAll(async () => {
  const config = loadConfig({ ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://hood:hood@localhost:5432/hood_oracle', HOOD_NETWORK: 'mainnet', KILL_FILE: `KILL.test.${process.pid}` })
  const [probe] = await probeRpcUrls(config.rpcUrls)
  if (!probe?.ok) {
    skip = `RPC unreachable: ${probe?.error}`
    log.warn({ skip }, 'engine boot test skipped')
    return
  }
  try {
    handle = createDb(config.databaseUrl, { max: 3 })
    await handle.client`select 1`
  } catch (err) {
    skip = `database unreachable: ${(err as Error).message}`
    log.warn({ skip }, 'engine boot test skipped')
    handle = null
    return
  }
  const model = createModelStore({ db: handle.db, log, network: config.network })
  const bus = new EventBus()
  bus.subscribe((e) => events.push(e))
  engine = createEngine({ config, db: handle.db, log, model, bus })
}, 30_000)

afterAll(async () => {
  await engine?.stop()
  await handle?.close()
})

describe('engine boot', () => {
  it('starts, reports live health, and stops cleanly', async () => {
    if (!engine) return
    await withLiveLock(async () => {
    await engine!.start()
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const h = engine!.health()
      if (h.headBlock != null && h.feed.connected && h.feed.lastSequence != null) break
      await new Promise((r) => setTimeout(r, 200))
    }
    const h = engine!.health()
    expect(h.chainId).toBe(4663)
    expect(h.network).toBe('mainnet')
    expect(h.headBlock).not.toBeNull()
    expect(h.headBlock!).toBeGreaterThan(50_000_000)
    expect(h.feed.connected).toBe(true)
    expect(h.feed.lastSequence).not.toBeNull()
    expect(h.killed).toBe(false)
    expect(h.model.version).toBeTruthy()
    expect(typeof h.arms.total).toBe('number')
    expect(engine!.lastVerdict('0x0000000000000000000000000000000000000001')).toBeNull()
    engine!.kill('api: boot test')
    expect(engine!.health().killed).toBe(true)
    expect(engine!.unkill()).toBe(true)
    expect(engine!.health().killed).toBe(false)
    expect(events.some((e) => e.kind === 'status' && e.source === 'engine')).toBe(true)
    expect(events.some((e) => e.kind === 'kill')).toBe(true)
    log.info({ health: { ...h, wallet: { ...h.wallet, ethWei: h.wallet.ethWei?.toString() ?? null } } }, 'engine health')
    })
  }, 300_000)
})
