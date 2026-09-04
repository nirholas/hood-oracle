import { Hono } from 'hono'
import { and, desc, eq, sql } from 'drizzle-orm'
import { schema } from '../../db/client.js'
import type { AppDeps } from '../deps.js'
import { respond } from '../json.js'
import { notFound } from '../errors.js'
import { parseAddress, parseEnum, parseLimit, parseSince } from '../query.js'
import { rowToDecision, rowToFirewall, rowToLaunch, rowToPosition, rowToScore, rowToSnapshot } from '../serialize.js'
import { modelSource } from './status.js'
import { ALL_LAUNCHPADS } from '../../chain/launchpads.js'
import type { CalibrationResponse, FeedItem, FeedResponse, ModelHistoryItem, ModelResponse } from '../contract.js'
import type { Launchpad, OracleTier, Head, Pillar, OracleHit } from '../../types.js'

const TIERS = ['prime', 'strong', 'lean', 'watch', 'avoid'] as const

interface FeedRow {
  token: string
  network: string
  launchpad: string
  venue: string
  pool: string | null
  creator: string
  name: string | null
  symbol: string | null
  decimals: number
  metadata: Record<string, unknown>
  block_number: string
  first_seen_at: Date
  graduated_at: Date | null
  feed_lead_ms: number | null
  score_id: string
  score: number
  tier: string
  rug_risk: number
  probabilities: Record<string, number>
  pillars: Record<string, number>
  hits: unknown[]
  reasons: string[]
  confidence: number
  model_version: string
  scored_at: Date
  features: Record<string, unknown> | null
  missing: string[] | null
  observed_at: Date | null
}

function feedRowToItem(r: FeedRow): FeedItem {
  return {
    token: r.token,
    network: r.network,
    launchpad: r.launchpad as Launchpad,
    venue: r.venue as FeedItem['venue'],
    pool: r.pool,
    creator: r.creator,
    name: r.name,
    symbol: r.symbol,
    decimals: r.decimals,
    metadata: r.metadata ?? {},
    blockNumber: String(r.block_number),
    firstSeenAt: new Date(r.first_seen_at).toISOString(),
    graduatedAt: r.graduated_at ? new Date(r.graduated_at).toISOString() : null,
    feedLeadMs: r.feed_lead_ms,
    score: {
      id: r.score_id,
      token: r.token as FeedItem['score']['token'],
      score: r.score,
      tier: r.tier as OracleTier,
      rugRisk: r.rug_risk,
      probabilities: r.probabilities as Record<Head, number>,
      pillars: r.pillars as Record<Pillar, number>,
      hits: r.hits as OracleHit[],
      reasons: r.reasons ?? [],
      confidence: r.confidence,
      modelVersion: r.model_version,
      scoredAt: new Date(r.scored_at).toISOString(),
    },
    features: (r.features as FeedItem['features']) ?? null,
    missing: r.missing ?? [],
    observedAt: r.observed_at ? new Date(r.observed_at).toISOString() : null,
  }
}

export function oracleRoutes(deps: AppDeps): Hono {
  const app = new Hono()
  const { db, config, model } = deps
  const net = config.network

  /** Latest score per token, joined to its launch and 90s feature snapshot, newest first. */
  app.get('/feed', async (c) => {
    const limit = parseLimit(c.req.query('limit'), 100, 500)
    const tier = parseEnum(c.req.query('tier'), TIERS, 'tier')
    const launchpad = parseEnum(c.req.query('launchpad'), ALL_LAUNCHPADS, 'launchpad')
    const since = parseSince(c.req.query('since'))
    const sinceIso = since ? since.toISOString() : null
    const rows = (await db.execute(sql`
      with latest as (
        select distinct on (s.token) s.*
        from oracle_scores s
        where s.network = ${net}
        order by s.token, s.scored_at desc
      )
      select l.token, l.network, l.launchpad, l.venue, l.pool, l.creator, l.name, l.symbol, l.decimals, l.metadata,
             l.block_number::text as block_number, l.first_seen_at, l.graduated_at, l.feed_lead_ms,
             s.id as score_id, s.score, s.tier, s.rug_risk, s.probabilities, s.pillars, s.hits, s.reasons, s.confidence,
             s.model_version, s.scored_at,
             f.features, f.missing, f.observed_at
      from latest s
      join launches l on l.token = s.token and l.network = s.network
      left join launch_features f on f.token = s.token and f.network = s.network
      where (${tier}::text is null or s.tier = ${tier})
        and (${launchpad}::text is null or l.launchpad = ${launchpad})
        and (${sinceIso}::timestamptz is null or s.scored_at > ${sinceIso}::timestamptz)
      order by s.scored_at desc
      limit ${limit}
    `)) as unknown as FeedRow[]
    const body: FeedResponse = {
      items: rows.map(feedRowToItem),
      count: rows.length,
      filters: { tier, launchpad, since: since ? since.toISOString() : null, limit },
      generatedAt: new Date().toISOString(),
    }
    return respond(c, body)
  })

  app.get('/coin/:token', async (c) => {
    const token = parseAddress(c.req.param('token'))
    const tokenMatch = sql`lower(${schema.launches.token}) = ${token}`
    const [launchRow] = await db.select().from(schema.launches).where(and(tokenMatch, eq(schema.launches.network, net))).limit(1)
    if (!launchRow) throw notFound(`launch ${token}`)
    const exact = launchRow.token
    const [featureRows, scoreRows, firewallRows, positionRows, decisionRows, creatorRows, outcomeRows] = await Promise.all([
      db.select().from(schema.launchFeatures).where(and(eq(schema.launchFeatures.token, exact), eq(schema.launchFeatures.network, net))).limit(1),
      db.select().from(schema.oracleScores).where(and(eq(schema.oracleScores.token, exact), eq(schema.oracleScores.network, net))).orderBy(desc(schema.oracleScores.scoredAt)).limit(200),
      db.select().from(schema.firewallDecisions).where(and(eq(schema.firewallDecisions.token, exact), eq(schema.firewallDecisions.network, net))).orderBy(desc(schema.firewallDecisions.at)).limit(20),
      db
        .select({ position: schema.positions, armLabel: schema.arms.label })
        .from(schema.positions)
        .innerJoin(schema.arms, eq(schema.arms.id, schema.positions.armId))
        .where(and(eq(schema.positions.token, exact), eq(schema.positions.network, net)))
        .orderBy(desc(schema.positions.openedAt))
        .limit(100),
      db.select().from(schema.decisions).where(eq(schema.decisions.token, exact)).orderBy(desc(schema.decisions.at)).limit(100),
      db.select().from(schema.creatorStats).where(and(eq(schema.creatorStats.creator, launchRow.creator), eq(schema.creatorStats.network, net))).limit(1),
      db.select().from(schema.oracleOutcomes).where(and(eq(schema.oracleOutcomes.token, exact), eq(schema.oracleOutcomes.network, net))).limit(1),
    ])
    const scores = scoreRows.map(rowToScore)
    const creator = creatorRows[0]
    const outcome = outcomeRows[0]
    return respond(c, {
      launch: rowToLaunch(launchRow),
      features: featureRows[0] ? rowToSnapshot(featureRows[0]) : null,
      latest: scores[0] ?? null,
      scores,
      firewall: firewallRows.map(rowToFirewall),
      positions: positionRows.map((r) => ({ ...rowToPosition(r.position), armLabel: r.armLabel })),
      decisions: decisionRows.map(rowToDecision),
      creator: creator
        ? { launches: creator.launches, wins: creator.wins, rugs: creator.rugs, lastLaunchAt: creator.lastLaunchAt ? creator.lastLaunchAt.toISOString() : null }
        : null,
      outcome: outcome
        ? {
            win: outcome.win,
            rug: outcome.rug,
            moon: outcome.moon,
            athMultiple: outcome.athMultiple,
            realizedWin: outcome.realizedWin,
            realizedPnlPct: outcome.realizedPnlPct,
            resolvedAt: outcome.resolvedAt.toISOString(),
          }
        : null,
    })
  })

  app.get('/model', async (c) => {
    const doc = model.active()
    const prov = model.provenance()
    const source = await modelSource(deps)
    const body: ModelResponse = {
      version: prov.version,
      provenance: doc.provenance,
      source,
      trainingRows: doc.training_rows,
      fittedAt: doc.fitted_at ?? prov.fittedAt,
      scoreHead: doc.score_head,
      heads: doc.heads,
      tierAnchors: doc.tier_probability_anchors,
      holdout: doc.holdout ?? null,
      features: doc.features.map((f) => ({
        key: f.key,
        pillar: f.pillar,
        categorical: f.categorical,
        edges: f.edges,
        bucketCount: Object.keys(f.buckets).length,
        buckets: Object.fromEntries(Object.entries(f.buckets).map(([b, v]) => [b, v.n])),
      })),
    }
    return respond(c, body)
  })

  app.get('/calibration', async (c) => {
    const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, 'oracle:calibration')).limit(1)
    const body: CalibrationResponse = {
      key: 'oracle:calibration',
      value: row ? row.value : null,
      updatedAt: row ? row.updatedAt.toISOString() : null,
    }
    return respond(c, body)
  })

  app.get('/models', async (c) => {
    const limit = parseLimit(c.req.query('limit'), 50, 200)
    const rows = (await db.execute(sql`
      select id, version, status, reason, training_rows, fitted_at, holdout, checks,
             coalesce(jsonb_array_length(model -> 'features'), 0) as feature_count
      from oracle_models
      where network = ${net}
      order by fitted_at desc
      limit ${limit}
    `)) as unknown as {
      id: string
      version: string
      status: string
      reason: string | null
      training_rows: number
      fitted_at: Date
      holdout: Record<string, unknown> | null
      checks: unknown[]
      feature_count: number
    }[]
    const items: ModelHistoryItem[] = rows.map((r) => ({
      id: r.id,
      version: r.version,
      status: r.status,
      reason: r.reason,
      trainingRows: Number(r.training_rows),
      fittedAt: new Date(r.fitted_at).toISOString(),
      featureCount: Number(r.feature_count),
      holdout: r.holdout,
      checks: r.checks ?? [],
    }))
    return respond(c, { items, count: items.length, active: model.provenance() })
  })

  return app
}
