/**
 * Score one token from live chain history and print the verdict with its hits.
 *
 *   npx tsx scripts/score.ts 0xTOKEN [--persist]
 *
 * The launch comes from `launches` when we already hold it, otherwise it is
 * located on chain (NOXA, the Odyssey factories, or a direct v3 pool) and
 * recorded. The 90-second tape is rebuilt from logs, features extracted with
 * the engine's extractor, and the snapshot scored under the active model.
 * `--persist` also writes the feature and score rows.
 */
import { existsSync } from 'node:fs'
import { and, eq } from 'drizzle-orm'
import { getAddress, isAddress } from 'viem'
import { loadConfig } from '../src/config.js'
import { createChainClient, errorText } from '../src/chain/client.js'
import { Prices } from '../src/chain/prices.js'
import { createDb, schema } from '../src/db/client.js'
import { rowToLaunch } from '../src/engine/observe.js'
import { log } from '../src/log.js'
import { createOracleHistory } from '../src/oracle/history.js'
import { createModelStore } from '../src/oracle/model-store.js'
import { launchRecordFor, persistTape, reconstructTape, upsertLaunch } from '../src/oracle/tape.js'

async function main() {
  const raw = process.argv.find((a) => a.startsWith('0x'))
  if (!raw || !isAddress(raw)) {
    console.error('usage: npx tsx scripts/score.ts 0xTOKEN [--persist]')
    process.exit(2)
  }
  const token = getAddress(raw)
  if (existsSync('.env')) process.loadEnvFile('.env')
  const config = loadConfig()
  const { db, close } = createDb(config.databaseUrl, { max: 2 })
  const chain = createChainClient(config)
  const prices = new Prices(chain)
  const history = createOracleHistory({ chain, prices, log })
  const model = createModelStore({ db, log, network: config.network })
  await model.reload()

  const [row] = await db.select().from(schema.launches).where(and(eq(schema.launches.token, token.toLowerCase()), eq(schema.launches.network, config.network))).limit(1)
  let launch = row ? rowToLaunch(row) : null
  if (!launch) {
    log.info({ token }, 'score: launch not recorded; searching chain history')
    const found = await history.findLaunch(token)
    if (!found) {
      console.error(`no launch found for ${token} on NOXA, The Odyssey, or a direct Uniswap v3 pool`)
      await close()
      process.exit(1)
    }
    launch = await launchRecordFor({ history, log }, found, config.network)
    await upsertLaunch(db, launch)
  }

  const tape = await reconstructTape({ db, log, history, model, llm: config.llm }, launch)
  if (process.argv.includes('--persist')) await persistTape(db, tape)
  const v = tape.verdict
  console.log(JSON.stringify({
    token: launch.token,
    launchpad: launch.launchpad,
    venue: launch.venue,
    pool: launch.pool,
    name: launch.name,
    symbol: launch.symbol,
    firstSeenAt: launch.firstSeenAt.toISOString(),
    window: { blocks: `${launch.blockNumber}-${tape.windowEndBlock}`, trades: tape.trades.length, transfers: tape.transfers.length },
    narrative: tape.narrative,
    model: { version: v.modelVersion, source: model.source(), provenance: model.provenance().provenance },
    verdict: {
      score: v.score, tier: v.tier, probabilities: v.probabilities, rugRisk: v.rugRisk, upside: v.upside, giveBackRisk: v.giveBackRisk,
      pillars: v.pillars, confidence: v.confidence, pedigreeCap: v.pedigreeCap, badges: v.badges, reasons: v.reasons,
    },
    hits: v.hits.map((h) => ({ key: h.key, pillar: h.pillar, bucket: h.bucket, w: h.w, present: h.present, n: h.n })),
    features: tape.result.features,
    missing: tape.result.missing,
  }, (_k, val) => (typeof val === 'bigint' ? val.toString() : val), 2))
  await close()
}

main().catch((err) => {
  console.error(errorText(err))
  process.exit(1)
})
