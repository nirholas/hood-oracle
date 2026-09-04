/**
 * Real in-process implementations of EngineApi and ModelStoreApi for API
 * tests. Both read and write the local Postgres: arms, positions, trades and
 * counts are what the database holds, not canned values. What they leave out
 * is the chain: no sequencer feed, no RPC, no signing.
 */
import { randomBytes } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import type { Address, Hash } from 'viem'
import { createDb, schema, toBigInt, weiStr, type Db } from '../src/db/client.js'
import { loadConfig, type Config } from '../src/config.js'
import { EventBus } from '../src/engine/bus.js'
import { log } from '../src/log.js'
import { createApp } from '../src/api/app.js'
import { rowToArm, rowToPosition, rowToTrade } from '../src/api/serialize.js'
import type {
  Arm, EngineApi, EngineHealth, EventBusApi, ExitReason, FeatureSnapshot, Head, Launchpad, ModelStoreApi, OracleHit, OracleModelDocument,
  OracleTier, OracleVerdict, Pillar, Trade,
} from '../src/types.js'

export const TEST_DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://hood:hood@localhost:5432/hood_oracle'
export const TEST_OPERATOR_TOKEN = 'test-operator-' + randomBytes(12).toString('hex')

export function testConfig(overrides: Partial<Config> = {}): Config {
  const base = loadConfig({
    DATABASE_URL: TEST_DATABASE_URL,
    HOOD_NETWORK: 'mainnet',
    OPERATOR_TOKEN: TEST_OPERATOR_TOKEN,
    LOG_LEVEL: 'silent',
    WEB_DIST: 'web/dist',
  })
  return { ...base, ...overrides }
}

export function syntheticAddress(): Address {
  return ('0x' + randomBytes(20).toString('hex')) as Address
}

export function syntheticHash(): Hash {
  return ('0x' + randomBytes(32).toString('hex')) as Hash
}

// ── engine ────────────────────────────────────────────────────────────────────

type KillSource = 'api' | 'external'

export class DbEngine implements EngineApi {
  private arms: Arm[] = []
  private openPositions = 0
  private killed = false
  private killReason: string | null = null
  private killSource: KillSource | null = null
  private readonly verdicts = new Map<string, OracleVerdict>()
  private wallet: EngineHealth['wallet'] = { address: null, ethWei: null, live: false }
  private launchpads: Record<string, number> = {}
  private readonly startedAt = new Date().toISOString()

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly bus: EventBusApi,
  ) {}

  setWallet(wallet: EngineHealth['wallet']): void {
    this.wallet = wallet
  }

  /** Simulates an external (signal / KILL file) kill, which the API must refuse to clear. */
  killExternally(reason: string): void {
    this.killed = true
    this.killReason = reason
    this.killSource = 'external'
  }

  resetKill(): void {
    this.killed = false
    this.killReason = null
    this.killSource = null
  }

  recordVerdict(verdict: OracleVerdict): void {
    this.verdicts.set(verdict.token.toLowerCase(), verdict)
  }

  async start(): Promise<void> {
    await this.refreshArms()
  }

  async stop(): Promise<void> {
    this.arms = []
  }

  health(): EngineHealth {
    return {
      network: this.config.network,
      chainId: this.config.chainId,
      headBlock: null,
      feed: { connected: false, lastSequence: null, secondsSinceFrame: null },
      wallet: this.wallet,
      killed: this.killed,
      killReason: this.killReason,
      arms: {
        total: this.arms.length,
        enabled: this.arms.filter((a) => a.enabled).length,
        live: this.arms.filter((a) => a.enabled && a.mode === 'live').length,
      },
      positions: { open: this.openPositions },
      model: { version: 'n/a', provenance: 'engine has no model of its own', trainingRows: 0, fittedAt: null },
      launchpads: this.launchpads,
      startedAt: this.startedAt,
    }
  }

  kill(reason: string): void {
    this.killed = true
    this.killReason = reason
    this.killSource = reason.startsWith('operator:') ? 'api' : 'external'
    this.bus.emit({ kind: 'kill', at: Date.now(), reason })
  }

  unkill(): boolean {
    if (!this.killed) return true
    if (this.killSource !== 'api') return false
    this.resetKill()
    return true
  }

  async closePosition(positionId: string, reason: ExitReason): Promise<Trade> {
    const [row] = await this.db.select().from(schema.positions).where(eq(schema.positions.id, positionId)).limit(1)
    if (!row) throw new Error(`position ${positionId} not found`)
    if (row.status !== 'open') throw new Error(`position ${positionId} is ${row.status}`)
    const position = rowToPosition(row)
    const valueWei = position.lastValueWei ?? position.entryWei
    const pnlWei = valueWei - position.entryWei
    const pnlPct = position.entryWei > 0n ? Number((pnlWei * 10_000n) / position.entryWei) / 100 : 0
    const now = new Date()
    const [tradeRow] = await this.db
      .insert(schema.trades)
      .values({
        armId: position.armId,
        positionId: position.id,
        token: position.token,
        network: position.network,
        side: 'sell',
        mode: position.mode,
        venue: position.venue,
        amountIn: weiStr(position.tokenAmount),
        amountOut: weiStr(valueWei),
        txHash: 'SIMULATED',
        gasWei: null,
        priceImpactPct: null,
        slippageBps: 0,
        at: now,
        meta: { reason },
      })
      .returning()
    await this.db
      .update(schema.positions)
      .set({
        status: 'closed',
        closedAt: now,
        sellTx: 'SIMULATED',
        lastValueWei: weiStr(valueWei),
        realizedPnlWei: weiStr(pnlWei),
        realizedPnlPct: pnlPct,
        exitReason: reason,
      })
      .where(eq(schema.positions.id, positionId))
    const trade = rowToTrade(tradeRow)
    const [after] = await this.db.select().from(schema.positions).where(eq(schema.positions.id, positionId)).limit(1)
    this.bus.emit({ kind: 'trade', at: now.getTime(), trade })
    this.bus.emit({ kind: 'position', at: now.getTime(), position: rowToPosition(after) })
    await this.refreshCounts()
    return trade
  }

  async refreshArms(): Promise<void> {
    const rows = await this.db.select().from(schema.arms).where(eq(schema.arms.network, this.config.network))
    this.arms = rows.map(rowToArm)
    await this.refreshCounts()
  }

  lastVerdict(token: Address): OracleVerdict | null {
    return this.verdicts.get(token.toLowerCase()) ?? null
  }

  private async refreshCounts(): Promise<void> {
    const [row] = (await this.db.execute(
      sql`select count(*)::text as open from positions where network = ${this.config.network} and status = 'open'`,
    )) as unknown as { open: string }[]
    this.openPositions = Number(row?.open ?? 0)
    const pads = (await this.db.execute(
      sql`select launchpad, count(*)::text as n from launches where network = ${this.config.network} and first_seen_at > now() - interval '1 hour' group by launchpad`,
    )) as unknown as { launchpad: string; n: string }[]
    this.launchpads = Object.fromEntries(pads.map((r) => [r.launchpad, Number(r.n)]))
  }
}

// ── model store ───────────────────────────────────────────────────────────────

/**
 * Three-feature logistic prior, hand-set so the test store can score a
 * snapshot for real (bucket lookup, three heads, tier anchors) without the
 * fitter. Its provenance string says exactly that.
 */
export const TEST_PRIOR: OracleModelDocument = {
  version: 0,
  fitted_at: '2026-09-01T00:00:00.000Z',
  training_rows: 0,
  score_head: 'win',
  heads: {
    win: { intercept: -1.4, base_rate: 0.2 },
    rug: { intercept: -0.4, base_rate: 0.4 },
    moon: { intercept: -2.2, base_rate: 0.1 },
  },
  tier_probability_anchors: { prime: 0.5, strong: 0.35, lean: 0.22, watch: 0.12, avoid: 0 },
  features: [
    {
      key: 'unique_buyers',
      pillar: 'momentum',
      categorical: false,
      edges: [5, 20, 60],
      buckets: {
        '0': { n: 100, w: { win: -0.9, rug: 0.5, moon: -0.8 } },
        '1': { n: 100, w: { win: -0.2, rug: 0.1, moon: -0.2 } },
        '2': { n: 100, w: { win: 0.6, rug: -0.3, moon: 0.4 } },
        '3': { n: 100, w: { win: 1.3, rug: -0.7, moon: 1.1 } },
      },
    },
    {
      key: 'bundle_score',
      pillar: 'structure',
      categorical: false,
      edges: [0.3, 0.6],
      buckets: {
        '0': { n: 100, w: { win: 0.5, rug: -0.4, moon: 0.3 } },
        '1': { n: 100, w: { win: -0.1, rug: 0.2, moon: -0.1 } },
        '2': { n: 100, w: { win: -1.1, rug: 0.9, moon: -0.9 } },
      },
    },
    {
      key: 'category',
      pillar: 'narrative',
      categorical: true,
      edges: [],
      buckets: {
        meme: { n: 100, w: { win: 0.2, rug: 0.0, moon: 0.3 } },
        ai: { n: 100, w: { win: 0.3, rug: -0.1, moon: 0.2 } },
        unknown: { n: 100, w: { win: -0.3, rug: 0.2, moon: -0.3 } },
      },
    },
  ],
  holdout: null,
  provenance: 'test prior: three hand-set logistic features for API tests',
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x))
const TIER_ORDER: OracleTier[] = ['prime', 'strong', 'lean', 'watch', 'avoid']

export class DbModelStore implements ModelStoreApi {
  private doc: OracleModelDocument = TEST_PRIOR
  private versionLabel = 'bootstrap-test'

  constructor(
    private readonly db: Db,
    private readonly network: string,
  ) {}

  active(): OracleModelDocument {
    return this.doc
  }

  provenance(): { version: string; provenance: string; trainingRows: number; fittedAt: string | null } {
    return { version: this.versionLabel, provenance: this.doc.provenance, trainingRows: this.doc.training_rows, fittedAt: this.doc.fitted_at }
  }

  async reload(): Promise<void> {
    const [row] = await this.db
      .select()
      .from(schema.oracleModels)
      .where(and(eq(schema.oracleModels.network, this.network), eq(schema.oracleModels.status, 'active')))
      .limit(1)
    if (row) {
      this.doc = row.model as unknown as OracleModelDocument
      this.versionLabel = row.version
    } else {
      this.doc = TEST_PRIOR
      this.versionLabel = 'bootstrap-test'
    }
  }

  convict(snapshot: FeatureSnapshot): OracleVerdict {
    const features = snapshot.features as unknown as Record<string, unknown>
    const logits: Record<Head, number> = { win: this.doc.heads.win.intercept, rug: this.doc.heads.rug.intercept, moon: this.doc.heads.moon.intercept }
    const pillarLogit: Record<Pillar, number> = { structure: 0, momentum: 0, pedigree: 0, narrative: 0 }
    const hits: OracleHit[] = []
    let present = 0
    for (const f of this.doc.features) {
      const raw = features[f.key]
      const has = raw != null && !snapshot.missing.includes(f.key)
      let bucket: string | null = null
      if (has) {
        bucket = f.categorical ? String(raw) : String(f.edges.filter((e) => Number(raw) >= e).length)
      }
      const b = bucket != null ? f.buckets[bucket] : undefined
      if (b) {
        present++
        for (const head of ['win', 'rug', 'moon'] as Head[]) logits[head] += b.w[head]
        pillarLogit[f.pillar] += b.w.win
      }
      hits.push({ key: f.key, pillar: f.pillar, bucket: bucket ?? 'missing', w: b ? b.w.win : 0, present: Boolean(b), n: b ? b.n : null })
    }
    const probabilities: Record<Head, number> = { win: sigmoid(logits.win), rug: sigmoid(logits.rug), moon: sigmoid(logits.moon) }
    const p = probabilities[this.doc.score_head]
    const anchors = this.doc.tier_probability_anchors
    const tier = TIER_ORDER.find((t) => p >= anchors[t]) ?? 'avoid'
    const pillars = Object.fromEntries(
      (Object.keys(pillarLogit) as Pillar[]).map((k) => [k, Math.round(100 * sigmoid(pillarLogit[k]))]),
    ) as Record<Pillar, number>
    return {
      token: snapshot.token,
      score: Math.round(100 * p),
      tier,
      probabilities,
      rugRisk: probabilities.rug,
      pillars,
      hits,
      reasons: hits.filter((h) => h.present && Math.abs(h.w) >= 0.5).map((h) => `${h.key} in bucket ${h.bucket} (${h.w > 0 ? '+' : ''}${h.w.toFixed(2)})`),
      confidence: this.doc.features.length ? present / this.doc.features.length : 0,
      modelVersion: this.versionLabel,
      scoredAt: new Date(),
    }
  }
}

// ── harness ───────────────────────────────────────────────────────────────────

export interface Harness {
  config: Config
  db: Db
  bus: EventBus
  engine: DbEngine
  model: DbModelStore
  app: ReturnType<typeof createApp>
  /** Same deps, but with OPERATOR_TOKEN unset: writes must answer 503. */
  appWithoutToken: ReturnType<typeof createApp>
  authHeaders: Record<string, string>
  close(): Promise<void>
}

export async function createHarness(): Promise<Harness> {
  const config = testConfig()
  const { db, close } = createDb(config.databaseUrl, { max: 4 })
  const bus = new EventBus()
  const engine = new DbEngine(db, config, bus)
  const model = new DbModelStore(db, config.network)
  await model.reload()
  await engine.start()
  const silent = log.child({ test: true })
  silent.level = 'silent'
  // Every in-process request shares one rate-limit bucket (there is no socket
  // to read a client address from), so the harness lifts the throttles; the
  // hardening suite builds its own apps with tight limits to test them.
  // The sign-in routes carry their own tighter limiter (20 reads, 10 writes a
  // minute), which one shared in-process bucket would trip inside a single
  // test file; the accounts suite signs in a dozen times on purpose.
  const limits = { writesPerMinute: 100_000, readsPerMinute: 1_000_000, authReadsPerMinute: 100_000, authWritesPerMinute: 100_000 }
  const app = createApp({ config, db, log: silent, engine, model, bus, limits })
  const appWithoutToken = createApp({ config: { ...config, operatorToken: null }, db, log: silent, engine, model, bus, limits })
  return {
    config,
    db,
    bus,
    engine,
    model,
    app,
    appWithoutToken,
    authHeaders: { authorization: `Bearer ${config.operatorToken}`, 'content-type': 'application/json' },
    close: async () => {
      await engine.stop()
      await close()
    },
  }
}

/** Insert a launch + 90s feature snapshot + a score computed by the test model. Returns the token. */
export async function seedScoredLaunch(
  h: Harness,
  opts: { launchpad?: Launchpad; uniqueBuyers?: number; bundleScore?: number | null; category?: string; symbol?: string } = {},
): Promise<{ token: Address; verdict: OracleVerdict }> {
  const token = syntheticAddress()
  const creator = syntheticAddress()
  const launchpad = opts.launchpad ?? 'noxa'
  await h.db.insert(schema.launches).values({
    token,
    network: h.config.network,
    launchpad,
    creator,
    pool: launchpad === 'odyssey' ? null : syntheticAddress(),
    venue: launchpad === 'odyssey' ? 'curve' : 'pool',
    blockNumber: '1',
    txHash: syntheticHash(),
    firstSeenAt: new Date(),
    feedLeadMs: 180,
    name: `Test ${opts.symbol ?? 'TKN'}`,
    symbol: opts.symbol ?? 'TKN',
    decimals: 18,
    metadata: { website: 'https://example.invalid' },
  })
  const missing = opts.bundleScore === null ? ['bundle_score'] : []
  const features = {
    unique_buyers: opts.uniqueBuyers ?? 25,
    bundle_score: opts.bundleScore === undefined ? 0.1 : opts.bundleScore,
    category: opts.category ?? 'meme',
  }
  await h.db.insert(schema.launchFeatures).values({ token, network: h.config.network, observedAt: new Date(), windowSeconds: 90, features, missing })
  const verdict = await scoreToken(h, token, features, missing)
  return { token, verdict }
}

export async function scoreToken(h: Harness, token: Address, features: Record<string, unknown>, missing: string[]): Promise<OracleVerdict> {
  const snapshot: FeatureSnapshot = {
    token,
    network: h.config.network,
    observedAt: new Date(),
    windowSeconds: 90,
    features: features as unknown as FeatureSnapshot['features'],
    missing,
  }
  const verdict = h.model.convict(snapshot)
  await h.db.insert(schema.oracleScores).values({
    token,
    network: h.config.network,
    scoredAt: verdict.scoredAt,
    modelVersion: verdict.modelVersion,
    score: verdict.score,
    tier: verdict.tier,
    rugRisk: verdict.rugRisk,
    probabilities: verdict.probabilities,
    pillars: verdict.pillars,
    hits: verdict.hits,
    reasons: verdict.reasons,
    confidence: verdict.confidence,
  })
  h.engine.recordVerdict(verdict)
  h.bus.emit({ kind: 'score', at: Date.now(), verdict })
  return verdict
}

export async function seedOpenPosition(h: Harness, armId: string, token: Address, entryWei: bigint, lastValueWei: bigint): Promise<string> {
  const [row] = await h.db
    .insert(schema.positions)
    .values({
      armId,
      token,
      network: h.config.network,
      launchpad: 'noxa',
      venue: 'pool',
      mode: 'simulate',
      status: 'open',
      entryWei: weiStr(entryWei),
      tokenAmount: '1000000000000000000000',
      tokenDecimals: 18,
      buyTx: 'SIMULATED',
      peakValueWei: weiStr(lastValueWei > entryWei ? lastValueWei : entryWei),
      lastValueWei: weiStr(lastValueWei),
      oracleScoreAtEntry: 61,
    })
    .returning({ id: schema.positions.id })
  await h.engine.refreshArms()
  return row.id
}

export async function cleanupTokens(h: Harness, tokens: string[]): Promise<void> {
  for (const token of tokens) {
    await h.db.delete(schema.oracleScores).where(eq(schema.oracleScores.token, token))
    await h.db.delete(schema.launchFeatures).where(eq(schema.launchFeatures.token, token))
    await h.db.delete(schema.firewallDecisions).where(eq(schema.firewallDecisions.token, token))
    await h.db.delete(schema.launches).where(eq(schema.launches.token, token))
  }
}

export async function cleanupArms(h: Harness, armIds: string[]): Promise<void> {
  for (const id of armIds) await h.db.delete(schema.arms).where(eq(schema.arms.id, id))
  await h.engine.refreshArms()
}

export { toBigInt }
