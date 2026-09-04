import { describe, expect, it } from 'vitest'
import type { Address, Hash } from 'viem'
import { evaluateEntry, llmVerdictGate, parseVerdict } from '../src/engine/gate.js'
import type { Arm, FeatureSnapshot, LaunchRecord, OracleVerdict } from '../src/types.js'
import { emptyFeatures } from '../src/engine/features.js'

const A = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}` as Address
const launch: LaunchRecord = {
  token: A(1), network: 'mainnet', launchpad: 'noxa', creator: A(2), pool: A(3), venue: 'pool', blockNumber: 10n, txHash: `0x${'1'.repeat(64)}` as Hash,
  firstSeenAt: new Date(), feedLeadMs: null, name: 'T', symbol: 'T', decimals: 18, metadata: {}, graduatedAt: null,
}
const arm = (over: Partial<Arm> = {}): Arm => ({
  id: 'arm', label: 'test', network: 'mainnet', enabled: true, killSwitch: false, mode: 'simulate', trigger: 'new_launch', launchpads: ['noxa', 'odyssey'],
  perTradeWei: 10n ** 16n, dailyBudgetWei: 10n ** 17n, maxConcurrentPositions: 2, cooldownSeconds: 0, slippageBps: 500, maxPriceImpactPct: 10, firewallLevel: 'block', buyDelayMs: 5000,
  minOracleScore: null, maxRugRisk: null, minUniqueBuyers: null, maxCreatorLaunches: null, maxDeployerPct: null, maxBundleScore: null, maxConcentrationTop1: null, minMarketCapEth: null, maxMarketCapEth: null,
  requireSocials: false, avoidDevDump: false, allowedCategories: null, stopLossPct: 30, takeProfitPct: null, trailingStopPct: null, maxHoldSeconds: 1800, liquidityDecaySeconds: null,
  initialsOutMultiple: 2, moonbagMinPct: 15, moonbagAlways: true, decisionMode: 'rules', llmMinConfidence: null, autoOptimize: false, autonomyTier: 'standard', telegramChatId: null, experimentGroup: null,
  createdAt: new Date(), updatedAt: new Date(), ...over,
})
const snapshot = (over: Partial<ReturnType<typeof emptyFeatures>> = {}): FeatureSnapshot => ({
  token: A(1), network: 'mainnet', observedAt: new Date(), windowSeconds: 5, features: { ...emptyFeatures('meme'), unique_buyers: 5, creator_launches: 1, deployer_holding_pct: 0.1, bundle_score: 0.2, concentration_top1: 0.3, dev_sold: false, mc_eth_first_seen: 50, ...over }, missing: [],
})
const verdict = (score: number, rugRisk = 0.2): OracleVerdict => ({
  token: A(1), score, tier: 'lean', probabilities: { win: 0.3, rug: rugRisk, moon: 0.1 }, rugRisk, pillars: { structure: 0, momentum: 0, pedigree: 0, narrative: 0 }, hits: [], reasons: [], confidence: 0.8, modelVersion: 'v1', scoredAt: new Date(),
})

describe('evaluateEntry', () => {
  it('passes a clean launch and names the first failing filter otherwise', () => {
    expect(evaluateEntry({ arm: arm(), launch, trigger: 'new_launch', snapshot: snapshot(), verdict: verdict(60), marketCapEth: null }).ok).toBe(true)
    const cases: [Partial<Arm>, string, string][] = [
      [{ enabled: false }, 'disarmed', 'not armed'],
      [{ killSwitch: true }, 'kill_switch', 'kill switch'],
      [{ trigger: 'graduation' }, 'entry_filter', 'trigger'],
      [{ launchpads: ['odyssey'] }, 'entry_filter', 'launchpads'],
      [{ minOracleScore: 70 }, 'oracle_gate', 'min_oracle_score'],
      [{ maxRugRisk: 0.1 }, 'oracle_gate', 'max_rug_risk'],
      [{ minUniqueBuyers: 8 }, 'entry_filter', 'min_unique_buyers'],
      [{ maxCreatorLaunches: 0 }, 'entry_filter', 'max_creator_launches'],
      [{ maxDeployerPct: 5 }, 'entry_filter', 'max_deployer_pct'],
      [{ maxBundleScore: 0.1 }, 'entry_filter', 'max_bundle_score'],
      [{ maxConcentrationTop1: 0.2 }, 'entry_filter', 'max_concentration_top1'],
      [{ minMarketCapEth: 100 }, 'entry_filter', 'min_market_cap_eth'],
      [{ maxMarketCapEth: 10 }, 'entry_filter', 'max_market_cap_eth'],
      [{ requireSocials: true }, 'entry_filter', 'require_socials'],
      [{ allowedCategories: ['ai'] }, 'entry_filter', 'allowed_categories'],
    ]
    for (const [over, reason, text] of cases) {
      const v = evaluateEntry({ arm: arm(over), launch, trigger: 'new_launch', snapshot: snapshot(), verdict: verdict(60), marketCapEth: null })
      expect(v.ok, text).toBe(false)
      expect(v.reason, text).toBe(reason)
      expect(v.detail, text).toContain(text)
    }
  })
  it('fails closed when a bound is set but the feature was not observed', () => {
    const v = evaluateEntry({ arm: arm({ minUniqueBuyers: 1 }), launch, trigger: 'new_launch', snapshot: snapshot({ unique_buyers: null }), verdict: verdict(60), marketCapEth: null })
    expect(v.ok).toBe(false)
    expect(v.detail).toContain('not observed')
    const unscored = evaluateEntry({ arm: arm({ minOracleScore: 10 }), launch, trigger: 'new_launch', snapshot: null, verdict: null, marketCapEth: null })
    expect(unscored.reason).toBe('oracle_gate')
  })
  it('avoid_dev_dump refuses a dev sale and a live market cap overrides the first-seen one', () => {
    expect(evaluateEntry({ arm: arm({ avoidDevDump: true }), launch, trigger: 'new_launch', snapshot: snapshot({ dev_sold: true }), verdict: verdict(60), marketCapEth: null }).detail).toContain('avoid_dev_dump')
    expect(evaluateEntry({ arm: arm({ maxMarketCapEth: 60 }), launch, trigger: 'new_launch', snapshot: snapshot(), verdict: verdict(60), marketCapEth: 500 }).ok).toBe(false)
  })
})

describe('LLM verdicts', () => {
  it('parses strict JSON wrapped in prose and rejects malformed output', () => {
    expect(parseVerdict('Sure: {"buy": true, "confidence": 0.9, "thesis": "clean"} done')).toEqual({ buy: true, confidence: 0.9, thesis: 'clean' })
    expect(parseVerdict('{"buy": false, "confidence": 7, "thesis": "x"}').confidence).toBe(1)
    expect(() => parseVerdict('no json here')).toThrow()
    expect(() => parseVerdict('{"buy": "yes", "confidence": 0.5, "thesis": "x"}')).toThrow()
    expect(() => parseVerdict('{"buy": true, "confidence": 0.5}')).toThrow()
  })
  it('gates on buy and the confidence floor', () => {
    expect(llmVerdictGate({ buy: false, confidence: 0.9, thesis: 't', model: 'm' }, arm()).reason).toBe('llm_declined')
    expect(llmVerdictGate({ buy: true, confidence: 0.5, thesis: 't', model: 'm' }, arm({ llmMinConfidence: 0.7 })).reason).toBe('llm_declined')
    expect(llmVerdictGate({ buy: true, confidence: 0.8, thesis: 't', model: 'm' }, arm()).ok).toBe(true)
  })
})
