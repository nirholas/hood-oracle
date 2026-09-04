import { describe, expect, it } from 'vitest'
import { ETH_EDGE_BASIS, FEATURES, bucketLabel, bucketLabels, creatorRecord, featureByKey } from '../src/oracle/features.js'
import { FEATURE_KEYS } from '../src/engine/features.js'

describe('oracle features', () => {
  it('buckets on edges exactly as the fitter and scorer both expect', () => {
    const f = { categorical: false, edges: [0.2, 0.4, 0.6, 0.8] }
    expect(bucketLabel(f, null)).toBe('null')
    expect(bucketLabel(f, 0)).toBe('<0.2')
    expect(bucketLabel(f, 0.19999)).toBe('<0.2')
    expect(bucketLabel(f, 0.2)).toBe('0.2-0.4')
    expect(bucketLabel(f, 0.4)).toBe('0.4-0.6')
    expect(bucketLabel(f, 0.79)).toBe('0.6-0.8')
    expect(bucketLabel(f, 0.8)).toBe('>=0.8')
    expect(bucketLabel(f, 99)).toBe('>=0.8')
    expect(bucketLabels(f)).toEqual(['<0.2', '0.2-0.4', '0.4-0.6', '0.6-0.8', '>=0.8'])
  })

  it('treats a categorical value as its own bucket and a missing one as unknown', () => {
    const f = { categorical: true, edges: [] }
    expect(bucketLabel(f, 'meme')).toBe('meme')
    expect(bucketLabel(f, null)).toBe('unknown')
  })

  it('handles a zero first edge (net flow) without collapsing the below band', () => {
    const f = featureByKey('net_volume_eth')!
    expect(bucketLabel(f, -0.01)).toBe('<0')
    expect(bucketLabel(f, 0)).toBe(`0-${f.edges[1]}`)
  })

  it('covers every extractor key, with creator pedigree folded into creator_record', () => {
    const keys = new Set(FEATURES.map((f) => f.key))
    for (const k of FEATURE_KEYS) {
      if (k === 'creator_launches' || k === 'creator_wins') continue
      expect(keys.has(k), `feature ${k} has no definition`).toBe(true)
    }
    expect(keys.has('creator_record')).toBe(true)
    expect(new Set(FEATURES.map((f) => f.pillar))).toEqual(new Set(['structure', 'momentum', 'pedigree', 'narrative']))
  })

  it('re-denominates the SOL edges to ETH at a recorded rate, three significant figures, strictly increasing', () => {
    expect(ETH_EDGE_BASIS.factor).toBeGreaterThan(0)
    expect(ETH_EDGE_BASIS.factor).toBeLessThan(1)
    expect(ETH_EDGE_BASIS.source).toContain('coingecko')
    for (const f of FEATURES) {
      if (!f.key.endsWith('_eth')) continue
      for (let i = 0; i < f.edges.length; i++) {
        const e = f.edges[i]!
        if (e !== 0) expect(Number(e.toPrecision(3))).toBe(e)
        if (i > 0) expect(e).toBeGreaterThan(f.edges[i - 1]!)
      }
    }
    const buy = featureByKey('buy_volume_eth')!
    expect(buy.edges[0]).toBeCloseTo(0.5 * ETH_EDGE_BASIS.factor, 3)
    const mc = featureByKey('mc_eth_first_seen')!
    expect(mc.edges[0]).toBeCloseTo(28 * ETH_EDGE_BASIS.factor, 2)
  })

  it('reads creator pedigree from the row, with the feature blob as fallback', () => {
    const f = featureByKey('creator_record')!
    expect(f.get({ features: {}, creator_launches: null, creator_wins: null, category: null })).toBe('unknown')
    expect(f.get({ features: {}, creator_launches: 1, creator_wins: 0, category: null })).toBe('first_launch')
    expect(f.get({ features: {}, creator_launches: 3, creator_wins: 0, category: null })).toBe('repeat_no_wins')
    expect(f.get({ features: {}, creator_launches: 7, creator_wins: 0, category: null })).toBe('serial_no_wins')
    expect(f.get({ features: {}, creator_launches: 7, creator_wins: 2, category: null })).toBe('has_wins')
    expect(f.get({ features: { creator_launches: 2, creator_wins: 1 }, creator_launches: null, creator_wins: null, category: null })).toBe('has_wins')
    expect(creatorRecord(0, 0)).toBe('first_launch')
  })

  it('reads dev_sold as a 0/1 flag', () => {
    const f = featureByKey('dev_sold')!
    expect(bucketLabel(f, f.get({ features: { dev_sold: true }, creator_launches: null, creator_wins: null, category: null }))).toBe('>=0.5')
    expect(bucketLabel(f, f.get({ features: { dev_sold: false }, creator_launches: null, creator_wins: null, category: null }))).toBe('<0.5')
    expect(bucketLabel(f, f.get({ features: {}, creator_launches: null, creator_wins: null, category: null }))).toBe('null')
  })
})
