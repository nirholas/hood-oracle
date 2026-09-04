/**
 * Cross-process mutex for the live suites. vitest runs test files in parallel
 * workers, and the public Robinhood Chain RPC rate-limits by source, so four
 * files firing at once turn into 429s and Cloudflare challenges. Every live
 * test takes this lock, which serialises them across workers while the pure
 * suites keep running in parallel. A lock older than STALE_MS is treated as
 * abandoned (a crashed worker) and reclaimed.
 */
import { closeSync, openSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const LOCK_PATH = join(tmpdir(), 'hood-oracle-live-tests.lock')
const STALE_MS = 5 * 60 * 1000
const POLL_MS = 150

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function tryAcquire(): boolean {
  try {
    const fd = openSync(LOCK_PATH, 'wx')
    writeSync(fd, `${process.pid} ${new Date().toISOString()}`)
    closeSync(fd)
    return true
  } catch (err) {
    if ((err as { code?: string }).code !== 'EEXIST') throw err
    try {
      if (Date.now() - statSync(LOCK_PATH).mtimeMs > STALE_MS) unlinkSync(LOCK_PATH)
    } catch {
      // the holder released it between our checks
    }
    return false
  }
}

/** Run `fn` while holding the live-test lock. */
export async function withLiveLock<T>(fn: () => Promise<T>): Promise<T> {
  while (!tryAcquire()) await sleep(POLL_MS)
  try {
    return await fn()
  } finally {
    try { unlinkSync(LOCK_PATH) } catch { /* already gone */ }
  }
}
