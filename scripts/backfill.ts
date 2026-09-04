/**
 * Backfill the oracle's training set from chain history.
 *
 *   npm run oracle:backfill -- --days 3 [--limit 500] [--from-block N --to-block M] [--no-labels] [--no-scan]
 *
 * For a block range (the last `--days` days by default):
 *   1. discover every launch through the engine's own watchers and intake
 *      (NOXA, the four Odyssey factories, and every Uniswap v3 PoolCreated /
 *      v4 Initialize pairing a fresh token with WETH, USDG or ETH), plus the
 *      graduations in the same range;
 *   2. upsert `launches` and `creator_stats` (rows shaped exactly like live ones);
 *   3. for each launch without a feature row, rebuild its 90-second tape,
 *      extract features with the engine's extractor, score it under the
 *      active model, and write `launch_features` + `oracle_scores`;
 *   4. resolve labels for every launch past the 24-hour horizon.
 *
 * Resumable: tokens that already carry a feature row are skipped, and the
 * label resolver only touches launches without an outcome row. Rate-limit
 * aware through the chain client's retry and the chunker's backoff.
 */
import { existsSync } from 'node:fs'
import { loadConfig } from '../src/config.js'
import { holdEventLoop } from '../src/oracle/keepalive.js'
import { createChainClient, errorText } from '../src/chain/client.js'
import { Prices } from '../src/chain/prices.js'
import { createDb } from '../src/db/client.js'
import { log } from '../src/log.js'
import { createOracleHistory, BLOCKS_PER_SECOND } from '../src/oracle/history.js'
import { LABEL_HORIZON_MS, bridgeRealized, resolveLabels } from '../src/oracle/labels.js'
import { createModelStore } from '../src/oracle/model-store.js'
import { featuredTokens, launchRecordFor, persistTape, reconstructTape, recordGraduation, upsertLaunch } from '../src/oracle/tape.js'
import { schema } from '../src/db/client.js'
import { and, eq } from 'drizzle-orm'

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return null
  const v = process.argv[i + 1]
  return v && !v.startsWith('--') ? v : ''
}
const flag = (name: string) => process.argv.includes(`--${name}`)

async function main() {
  const release = holdEventLoop()
  if (existsSync('.env')) process.loadEnvFile('.env')
  const config = loadConfig()
  const days = Number(arg('days') ?? 3)
  const limit = arg('limit') ? Number(arg('limit')) : Infinity
  const doLabels = !flag('no-labels')
  const doScan = !flag('no-scan')
  const started = Date.now()

  const { db, close } = createDb(config.databaseUrl, { max: 4 })
  const chain = createChainClient(config)
  const prices = new Prices(chain)
  const history = createOracleHistory({ chain, prices, log })
  const model = createModelStore({ db, log, network: config.network })
  await model.reload()
  const network = config.network
  log.info({ network, model: model.provenance().version, source: model.source() }, 'backfill: model ready')

  const head = await history.headBlock()
  const toBlock = arg('to-block') ? BigInt(arg('to-block')!) : head
  const fromBlock = arg('from-block')
    ? BigInt(arg('from-block')!)
    : await history.blockAtTime(Date.now() - days * 86_400_000)
  log.info({ fromBlock: fromBlock.toString(), toBlock: toBlock.toString(), blocks: (toBlock - fromBlock).toString(), days }, 'backfill: range')

  const known = await db.select({ token: schema.launches.token }).from(schema.launches).where(eq(schema.launches.network, network))
  const knownTokens = new Set(known.map((r) => r.token.toLowerCase()))
  const featured = await featuredTokens(db, network)

  let found = 0
  let inserted = 0
  let featuredNow = 0
  let failed = 0
  if (doScan) {
    const scan = await history.scanLaunches(fromBlock, toBlock, {
      isKnownToken: (t) => knownTokens.has(t.toLowerCase()),
      onProgress: (p) => log.info({ from: p.from.toString(), to: p.to.toString(), launches: p.launches }, 'backfill: slice scanned'),
    })
    found = scan.launches.length
    log.info({ found, graduations: scan.graduations.length, intake: scan.intake }, 'backfill: launches discovered')

    for (const e of scan.launches) {
      try {
        const launch = await launchRecordFor({ history, log }, e, network)
        if (await upsertLaunch(db, launch)) inserted++
        knownTokens.add(launch.token.toLowerCase())
      } catch (err) {
        failed++
        log.warn({ token: e.token, err: errorText(err) }, 'backfill: launch record failed')
      }
    }
    for (const g of scan.graduations) {
      try {
        await recordGraduation(db, network, g.token, g.pool, new Date(await history.blockTimeMs(g.blockNumber)))
      } catch (err) {
        log.warn({ token: g.token, err: errorText(err) }, 'backfill: graduation record failed')
      }
    }
  }

  // Feature every recorded launch in range that has no feature row yet,
  // oldest first, so pedigree and smart-money reads stay time-consistent.
  const minSeen = new Date((await history.blockTimeMs(fromBlock)) - 1)
  const rows = await db.select().from(schema.launches)
    .where(and(eq(schema.launches.network, network)))
    .orderBy(schema.launches.firstSeenAt, schema.launches.token)
  const todo = rows.filter((r) => r.firstSeenAt >= minSeen && BigInt(r.blockNumber) <= toBlock && !featured.has(r.token.toLowerCase()))
  log.info({ candidates: todo.length, alreadyFeatured: rows.length - todo.length }, 'backfill: feature pass')
  const { rowToLaunch } = await import('../src/engine/observe.js')
  let n = 0
  for (const row of todo) {
    if (featuredNow >= limit) break
    n++
    const launch = rowToLaunch(row)
    try {
      const tape = await reconstructTape({ db, log, history, model, llm: config.llm }, launch)
      await persistTape(db, tape)
      featuredNow++
      if (n % 10 === 0 || n === todo.length) {
        log.info({ done: n, of: todo.length, featured: featuredNow, failed, elapsedMin: Math.round((Date.now() - started) / 60_000) }, 'backfill: progress')
      }
      log.info({ token: launch.token, launchpad: launch.launchpad, trades: tape.trades.length, score: tape.verdict.score, tier: tape.verdict.tier, missing: tape.result.missing.length }, 'backfill: featured')
    } catch (err) {
      failed++
      log.warn({ token: launch.token, err: errorText(err) }, 'backfill: feature failed')
    }
  }

  let labeled = 0
  let unlabelable = 0
  if (doLabels) {
    const bridged = await bridgeRealized({ db, network, log })
    for (let i = 0; i < 50; i++) {
      const r = await resolveLabels({ db, history, network, log, limit: 100 })
      labeled += r.resolved
      unlabelable += r.unlabelable
      if (r.resolved === 0) break
    }
    log.info({ bridged, labeled, unlabelable }, 'backfill: label pass')
  }

  const eligibleForLabels = rows.filter((r) => Date.now() - r.firstSeenAt.getTime() > LABEL_HORIZON_MS).length
  console.log(JSON.stringify({
    network, fromBlock: fromBlock.toString(), toBlock: toBlock.toString(), days,
    blocksPerDay: Math.round(BLOCKS_PER_SECOND * 86_400),
    launchesFound: found, launchesInserted: inserted, featured: featuredNow, featureFailures: failed,
    labeled, unlabelable, launchesOlderThanHorizon: eligibleForLabels, tookMin: Math.round((Date.now() - started) / 60_000),
  }, null, 2))
  await close()
  release()
}

main().catch((err) => {
  console.error(errorText(err))
  process.exit(1)
})
