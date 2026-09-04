/**
 * Run one oracle refit and print the promotion gate's decision.
 *
 *   npm run oracle:fit [-- --epochs 14 --max-rows 200000]
 *
 * Same code path as the scheduled job (src/oracle/refit.ts): load labeled
 * rows, fit with a time-split holdout, judge, persist the candidate with its
 * checks, promote if it clears the gate.
 */
import { existsSync } from 'node:fs'
import { loadConfig } from '../src/config.js'
import { errorText } from '../src/chain/client.js'
import { createDb } from '../src/db/client.js'
import { log } from '../src/log.js'
import { createModelStore } from '../src/oracle/model-store.js'
import { runRefit } from '../src/oracle/refit.js'

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? null : (process.argv[i + 1] ?? null)
}

async function main() {
  if (existsSync('.env')) process.loadEnvFile('.env')
  const config = loadConfig()
  const { db, close } = createDb(config.databaseUrl, { max: 2 })
  const model = createModelStore({ db, log, network: config.network })
  await model.reload()
  const before = model.provenance()
  const result = await runRefit({
    db, log, network: config.network, model,
    epochs: arg('epochs') ? Number(arg('epochs')) : 14,
    maxRows: arg('max-rows') ? Number(arg('max-rows')) : undefined,
  })
  const after = model.provenance()
  console.log(JSON.stringify({
    fitted: result.fitted,
    promoted: result.promoted,
    status: result.status,
    reason: result.reason,
    rows: result.rows,
    version: result.version,
    holdout: result.holdout,
    dropped: result.dropped.map((d) => `${d.key} (${d.bucket} ${Math.round(d.share * 100)}%)`),
    checks: result.checks,
    activeBefore: before.version,
    activeAfter: after.version,
    tookMs: result.tookMs,
  }, null, 2))
  await close()
}

main().catch((err) => {
  console.error(errorText(err))
  process.exit(1)
})
