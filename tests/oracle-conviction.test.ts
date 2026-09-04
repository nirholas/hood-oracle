import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { emptyFeatures } from '../src/engine/features.js'
import { TIERS, TIER_PROBABILITY_ANCHORS, createConviction, modelVersionLabel, normalizeModel, tierForScore } from '../src/oracle/conviction.js'
import { BOOTSTRAP_MODEL } from '../src/oracle/model-store.js'
import type { FeatureSnapshot, LaunchFeatures } from '../src/types.js'

const TOKEN = '0x64f8dfa1d94c711e4d269d81bf0cab6bc3481bc9' as Address

function snapshot(overrides: Partial<LaunchFeatures> = {}, missing: string[] = []): FeatureSnapshot {
  return {
    token: TOKEN, network: 'mainnet', observedAt: new Date('2026-09-03T00:00:00Z'), windowSeconds: 90,
    features: { ...emptyFeatures('meme'), ...overrides }, missing,
  }
}

const strong: Partial<LaunchFeatures> = {
  organic_score: 0.85, bundle_score: 0.02, snipe_ratio: 0.2, coordination_score: 0.05, timing_entropy: 0.7,
  concentration_top1: 0.03, concentration_top5: 0.2, concentration_top10: 0.25,
  unique_buyers: 45, unique_sellers: 0, buy_sell_ratio: 45, buy_volume_eth: 1.2, sell_volume_eth: 0, net_volume_eth: 1.2, trade_count: 45,
  largest_buy_eth: 0.25, avg_buy_eth: 0.026, median_buy_eth: 0.01, mc_eth_first_seen: 1.2,
  dev_buy_eth: 0.03, dev_sell_eth: 0, dev_sold: false, smart_money_count: 3, category: 'meme',
}

const weak: Partial<LaunchFeatures> = {
  organic_score: 0.1, bundle_score: 0.7, snipe_ratio: 0.9, coordination_score: 0.5, timing_entropy: 0.1,
  concentration_top1: 0.6, concentration_top5: 0.95, concentration_top10: 0.97,
  unique_buyers: 1, unique_sellers: 2, buy_sell_ratio: 0.3, buy_volume_eth: 0.005, sell_volume_eth: 0.2, net_volume_eth: -0.19, trade_count: 3,
  largest_buy_eth: 0.005, avg_buy_eth: 0.005, median_buy_eth: 0.005, mc_eth_first_seen: 1.2,
  dev_buy_eth: 0.05, dev_sell_eth: 0.1, dev_sold: true, smart_money_count: 0, category: 'unknown',
}

describe('conviction engine', () => {
  const engine = createConviction(BOOTSTRAP_MODEL)

  it('is deterministic: the same snapshot scores identically every time', () => {
    const now = new Date('2026-09-03T00:01:30Z')
    const a = engine.convict(snapshot(strong), { creatorLaunches: 1, creatorWins: 0 }, { now })
    const b = engine.convict(snapshot(strong), { creatorLaunches: 1, creatorWins: 0 }, { now })
    expect(a).toEqual(b)
    expect(a.modelVersion).toBe(modelVersionLabel(BOOTSTRAP_MODEL))
    expect(a.scoredAt).toEqual(now)
  })

  it('ranks a clean, well-bid launch far above a sniped, dumped one', () => {
    const good = engine.convict(snapshot(strong), { creatorLaunches: 1, creatorWins: 0 })
    const bad = engine.convict(snapshot(weak), { creatorLaunches: 1, creatorWins: 0 })
    expect(good.score).toBeGreaterThan(bad.score + 20)
    expect(good.probabilities.win).toBeGreaterThan(bad.probabilities.win)
    expect(bad.upside).toBeLessThan(good.upside)
    expect(good.reasons.length).toBeGreaterThan(0)
    const emDash = String.fromCharCode(0x2014)
    expect(good.reasons.every((r) => !r.includes(emDash))).toBe(true)
  })

  it('maps the tier anchors onto the public ladder and back', () => {
    expect(engine.scoreFromProbability(TIER_PROBABILITY_ANCHORS.watch)).toBe(34)
    expect(engine.scoreFromProbability(TIER_PROBABILITY_ANCHORS.lean)).toBe(56)
    expect(engine.scoreFromProbability(TIER_PROBABILITY_ANCHORS.strong)).toBe(72)
    expect(engine.scoreFromProbability(TIER_PROBABILITY_ANCHORS.prime)).toBe(86)
    expect(engine.scoreFromProbability(0)).toBe(0)
    expect(engine.scoreFromProbability(1)).toBe(100)
    for (const p of [0.01, 0.05, 0.1, 0.3, 0.45, 0.8]) {
      expect(engine.probabilityFromScore(engine.scoreFromProbability(p))).toBeCloseTo(p, 1)
    }
    expect(engine.probabilityFromScore(86)).toBeCloseTo(0.45, 6)
  })

  it('tiers on the fixed 86/72/56/34 thresholds', () => {
    expect(tierForScore(100)).toBe('prime')
    expect(tierForScore(86)).toBe('prime')
    expect(tierForScore(85)).toBe('strong')
    expect(tierForScore(72)).toBe('strong')
    expect(tierForScore(71)).toBe('lean')
    expect(tierForScore(56)).toBe('lean')
    expect(tierForScore(55)).toBe('watch')
    expect(tierForScore(34)).toBe('watch')
    expect(tierForScore(33)).toBe('avoid')
    expect(tierForScore(0)).toBe('avoid')
    expect(TIERS.map((t) => t.min)).toEqual([86, 72, 56, 34, 0])
  })

  it('keeps P(win) <= P(moon) and publishes rug risk as a probability', () => {
    for (const f of [strong, weak, {}]) {
      const v = engine.convict(snapshot(f))
      expect(v.probabilities.win).toBeLessThanOrEqual(v.probabilities.moon)
      expect(v.rugRisk).toBeGreaterThanOrEqual(0)
      expect(v.rugRisk).toBeLessThanOrEqual(1)
      expect(v.rugRisk).toBe(v.probabilities.rug)
      expect(v.tier).toBe(tierForScore(v.score))
    }
  })

  it('ceilings a serial-rugger creator at 45 whatever the tape says', () => {
    const capped = engine.convict(snapshot(strong), { creatorLaunches: 6, creatorWins: 0 })
    expect(capped.score).toBeLessThanOrEqual(45)
    expect(capped.pedigreeCap).toBe(45)
    expect(capped.badges).toContain('pedigree-flag')
    expect(capped.reasons[0]).toMatch(/rug pattern/)
    expect(capped.suppressed).toContain('creator_record')
  })

  it('reports confidence as the share of observed features and hits for every model feature', () => {
    const empty = engine.convict(snapshot({}))
    const full = engine.convict(snapshot(strong), { creatorLaunches: 2, creatorWins: 1 })
    expect(empty.confidence).toBeLessThan(full.confidence)
    expect(full.confidence).toBeGreaterThan(0.8)
    expect(full.hits.length).toBe(BOOTSTRAP_MODEL.features.length)
    expect(full.hits.every((h) => typeof h.bucket === 'string' && Number.isFinite(h.w))).toBe(true)
    expect(empty.badges).toContain('thin-data')
  })

  it('refuses a malformed model document', () => {
    expect(() => normalizeModel({})).toThrow()
    expect(() => normalizeModel({ version: 3, features: [] })).toThrow()
    expect(() => normalizeModel({ version: 3, features: [{ key: 'x', pillar: 'momentum', buckets: {} }], heads: { win: { intercept: 0 } } })).toThrow(/head/)
    const ok = normalizeModel(BOOTSTRAP_MODEL)
    expect(ok.features.length).toBe(BOOTSTRAP_MODEL.features.length)
  })
})
