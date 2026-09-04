/**
 * Database rows -> domain types. The API serializes domain types directly
 * (bigint -> decimal string, Date -> ISO) through ./json.ts, so these mappers
 * are the single place a column name meets a field name.
 */
import type { Address, Hash } from 'viem'
import { schema, toBigInt, toBigIntOrNull } from '../db/client.js'
import type {
  Arm, AutonomyTier, Category, Decision, DecisionKind, DecisionMode, ExitReason, FeatureSnapshot, FirewallAssessment,
  FirewallCheck, FirewallVerdict, FirewallLevel, LaunchFeatures, LaunchRecord, Launchpad, Mode, Network, OracleHit, OracleTier,
  Position, PositionStatus, Side, Trade, Trigger, Venue, Head, Pillar,
} from '../types.js'
import type { ScoreRecord } from './contract.js'

export type { ScoreRecord }

type ArmRow = typeof schema.arms.$inferSelect
type LaunchRow = typeof schema.launches.$inferSelect
type FeatureRow = typeof schema.launchFeatures.$inferSelect
type ScoreRow = typeof schema.oracleScores.$inferSelect
type PositionRow = typeof schema.positions.$inferSelect
type TradeRow = typeof schema.trades.$inferSelect
type DecisionRow = typeof schema.decisions.$inferSelect
type FirewallRow = typeof schema.firewallDecisions.$inferSelect

export function rowToArm(r: ArmRow): Arm {
  return {
    id: r.id,
    label: r.label,
    network: r.network as Network,
    enabled: r.enabled,
    killSwitch: r.killSwitch,
    mode: r.mode as Mode,
    trigger: r.trigger as Trigger,
    launchpads: r.launchpads as Launchpad[],
    perTradeWei: toBigInt(r.perTradeWei),
    dailyBudgetWei: toBigInt(r.dailyBudgetWei),
    maxConcurrentPositions: r.maxConcurrentPositions,
    cooldownSeconds: r.cooldownSeconds,
    slippageBps: r.slippageBps,
    maxPriceImpactPct: r.maxPriceImpactPct,
    firewallLevel: r.firewallLevel as FirewallLevel,
    buyDelayMs: r.buyDelayMs,
    minOracleScore: r.minOracleScore,
    maxRugRisk: r.maxRugRisk,
    minUniqueBuyers: r.minUniqueBuyers,
    maxCreatorLaunches: r.maxCreatorLaunches,
    maxDeployerPct: r.maxDeployerPct,
    maxBundleScore: r.maxBundleScore,
    maxConcentrationTop1: r.maxConcentrationTop1,
    minMarketCapEth: r.minMarketCapEth,
    maxMarketCapEth: r.maxMarketCapEth,
    requireSocials: r.requireSocials,
    avoidDevDump: r.avoidDevDump,
    allowedCategories: (r.allowedCategories as Category[] | null) ?? null,
    stopLossPct: r.stopLossPct,
    takeProfitPct: r.takeProfitPct,
    trailingStopPct: r.trailingStopPct,
    maxHoldSeconds: r.maxHoldSeconds,
    liquidityDecaySeconds: r.liquidityDecaySeconds,
    initialsOutMultiple: r.initialsOutMultiple,
    moonbagMinPct: r.moonbagMinPct,
    moonbagAlways: r.moonbagAlways,
    decisionMode: r.decisionMode as DecisionMode,
    llmMinConfidence: r.llmMinConfidence,
    autoOptimize: r.autoOptimize,
    autonomyTier: r.autonomyTier as AutonomyTier,
    telegramChatId: r.telegramChatId,
    experimentGroup: r.experimentGroup,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}

export function rowToLaunch(r: LaunchRow): LaunchRecord {
  return {
    token: r.token as Address,
    network: r.network as Network,
    launchpad: r.launchpad as Launchpad,
    creator: r.creator as Address,
    pool: (r.pool as Address | null) ?? null,
    venue: r.venue as Venue,
    blockNumber: toBigInt(r.blockNumber),
    txHash: r.txHash as Hash,
    firstSeenAt: r.firstSeenAt,
    feedLeadMs: r.feedLeadMs,
    name: r.name,
    symbol: r.symbol,
    decimals: r.decimals,
    metadata: r.metadata,
    graduatedAt: r.graduatedAt,
  }
}

export function rowToSnapshot(r: FeatureRow): FeatureSnapshot {
  return {
    token: r.token as Address,
    network: r.network as Network,
    observedAt: r.observedAt,
    windowSeconds: r.windowSeconds,
    features: r.features as unknown as LaunchFeatures,
    missing: r.missing,
  }
}

export function rowToScore(r: ScoreRow): ScoreRecord {
  return {
    id: r.id,
    token: r.token as Address,
    score: r.score,
    tier: r.tier as OracleTier,
    rugRisk: r.rugRisk,
    probabilities: r.probabilities as Record<Head, number>,
    pillars: r.pillars as Record<Pillar, number>,
    hits: r.hits as OracleHit[],
    reasons: r.reasons,
    confidence: r.confidence,
    modelVersion: r.modelVersion,
    scoredAt: r.scoredAt,
  }
}

export function rowToPosition(r: PositionRow): Position {
  return {
    id: r.id,
    armId: r.armId,
    token: r.token as Address,
    network: r.network as Network,
    launchpad: r.launchpad as Launchpad,
    venue: r.venue as Venue,
    mode: r.mode as Mode,
    status: r.status as PositionStatus,
    entryWei: toBigInt(r.entryWei),
    tokenAmount: toBigInt(r.tokenAmount),
    tokenDecimals: r.tokenDecimals,
    buyTx: r.buyTx as Hash | 'SIMULATED',
    sellTx: (r.sellTx as Hash | 'SIMULATED' | null) ?? null,
    openedAt: r.openedAt,
    closedAt: r.closedAt,
    peakValueWei: toBigInt(r.peakValueWei),
    lastValueWei: toBigIntOrNull(r.lastValueWei),
    staleSince: r.staleSince,
    initialsRecovered: r.initialsRecovered,
    realizedPnlWei: toBigIntOrNull(r.realizedPnlWei),
    realizedPnlPct: r.realizedPnlPct,
    exitReason: (r.exitReason as ExitReason | null) ?? null,
    oracleScoreAtEntry: r.oracleScoreAtEntry,
    meta: r.meta,
  }
}

export function rowToTrade(r: TradeRow): Trade {
  return {
    id: r.id,
    armId: r.armId,
    positionId: r.positionId,
    token: r.token as Address,
    network: r.network as Network,
    side: r.side as Side,
    mode: r.mode as Mode,
    venue: r.venue as Venue,
    amountIn: toBigInt(r.amountIn),
    amountOut: toBigInt(r.amountOut),
    txHash: r.txHash as Hash | 'SIMULATED',
    gasWei: toBigIntOrNull(r.gasWei),
    priceImpactPct: r.priceImpactPct,
    slippageBps: r.slippageBps,
    at: r.at,
    meta: r.meta,
  }
}

export function rowToDecision(r: DecisionRow): Decision {
  return {
    id: r.id,
    armId: r.armId,
    token: (r.token as Address | null) ?? null,
    kind: r.kind as DecisionKind,
    reason: r.reason,
    detail: r.detail,
    prevHash: r.prevHash,
    entryHash: r.entryHash,
    at: r.at,
  }
}

export function rowToFirewall(r: FirewallRow): FirewallAssessment & { id: string } {
  return {
    id: r.id,
    token: r.token as Address,
    venue: r.venue as Venue,
    verdict: r.verdict as FirewallVerdict,
    score: r.score,
    checks: r.checks as FirewallCheck[],
    roundTripLossPct: r.roundTripLossPct,
    assessedAt: r.at,
    latencyMs: r.latencyMs,
  }
}
