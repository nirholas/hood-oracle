/**
 * Arm rows in and out of the database. The engine caches arms and refreshes
 * them every 15 seconds and whenever the API says it wrote one.
 */
import { eq } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { toBigInt } from '../db/client.js'
import { arms } from '../db/schema.js'
import type { Arm, Network } from '../types.js'

export function rowToArm(r: typeof arms.$inferSelect): Arm {
  return {
    id: r.id, label: r.label, network: r.network as Network, enabled: r.enabled, killSwitch: r.killSwitch, mode: r.mode as Arm['mode'], trigger: r.trigger as Arm['trigger'],
    launchpads: r.launchpads as Arm['launchpads'], perTradeWei: toBigInt(r.perTradeWei), dailyBudgetWei: toBigInt(r.dailyBudgetWei), maxConcurrentPositions: r.maxConcurrentPositions,
    cooldownSeconds: r.cooldownSeconds, slippageBps: r.slippageBps, maxPriceImpactPct: r.maxPriceImpactPct, firewallLevel: r.firewallLevel as Arm['firewallLevel'], buyDelayMs: r.buyDelayMs,
    minOracleScore: r.minOracleScore, maxRugRisk: r.maxRugRisk, minUniqueBuyers: r.minUniqueBuyers, maxCreatorLaunches: r.maxCreatorLaunches, maxDeployerPct: r.maxDeployerPct,
    maxBundleScore: r.maxBundleScore, maxConcentrationTop1: r.maxConcentrationTop1, minMarketCapEth: r.minMarketCapEth, maxMarketCapEth: r.maxMarketCapEth, requireSocials: r.requireSocials,
    avoidDevDump: r.avoidDevDump, allowedCategories: r.allowedCategories as Arm['allowedCategories'], stopLossPct: r.stopLossPct, takeProfitPct: r.takeProfitPct, trailingStopPct: r.trailingStopPct,
    maxHoldSeconds: r.maxHoldSeconds, liquidityDecaySeconds: r.liquidityDecaySeconds, initialsOutMultiple: r.initialsOutMultiple, moonbagMinPct: r.moonbagMinPct, moonbagAlways: r.moonbagAlways,
    decisionMode: r.decisionMode as Arm['decisionMode'], llmMinConfidence: r.llmMinConfidence, autoOptimize: r.autoOptimize, autonomyTier: r.autonomyTier as Arm['autonomyTier'],
    telegramChatId: r.telegramChatId, experimentGroup: r.experimentGroup, createdAt: r.createdAt, updatedAt: r.updatedAt,
  }
}

export async function loadArms(db: Db, network: Network): Promise<Arm[]> {
  const rows = await db.select().from(arms).where(eq(arms.network, network))
  return rows.map(rowToArm)
}
