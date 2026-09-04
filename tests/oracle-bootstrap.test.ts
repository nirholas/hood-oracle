import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { bucketLabels, featureByKey, ETH_EDGE_BASIS } from '../src/oracle/features.js'
import { modelBucketLabels } from '../src/oracle/conviction.js'
import { BOOTSTRAP_MODEL } from '../src/oracle/model-store.js'

const raw = JSON.parse(readFileSync(new URL('../src/oracle/bootstrap-model.json', import.meta.url), 'utf8')) as Record<string, unknown>

describe('bootstrap model', () => {
  it('is the three.ws v3 win-headed prior with its conversion recorded in the provenance', () => {
    expect(BOOTSTRAP_MODEL.version).toBe(3)
    expect(BOOTSTRAP_MODEL.score_head).toBe('win')
    expect(BOOTSTRAP_MODEL.training_rows).toBe(296843)
    expect(BOOTSTRAP_MODEL.provenance).toMatch(/^bootstrap:three\.ws pump\.fun corpus 296,843 rows, fitted 2026-08-28, SOL to ETH edge factor /)
    expect(BOOTSTRAP_MODEL.provenance).toContain(String(ETH_EDGE_BASIS.factor))
    expect(BOOTSTRAP_MODEL.provenance).toContain('via CoinGecko simple/price')
    expect(BOOTSTRAP_MODEL.tier_probability_anchors).toEqual({ avoid: 0, watch: 0.05, lean: 0.12, strong: 0.25, prime: 0.45 })
    expect(BOOTSTRAP_MODEL.holdout?.win.auc).toBeGreaterThan(0.8)
    expect(raw.conversion).toMatchObject({ factor: ETH_EDGE_BASIS.factor, sol_usd: ETH_EDGE_BASIS.solUsd, eth_usd: ETH_EDGE_BASIS.ethUsd })
  })

  it('carries no SOL-denominated key and every feature matches FEATURES in key, pillar, and edges', () => {
    expect(BOOTSTRAP_MODEL.features.length).toBe(25)
    for (const f of BOOTSTRAP_MODEL.features) {
      expect(f.key.endsWith('_sol')).toBe(false)
      expect(f.key).not.toBe('mc_sol_first_seen')
      const def = featureByKey(f.key)
      expect(def, `model feature ${f.key} has no definition`).not.toBeNull()
      expect(def!.pillar).toBe(f.pillar)
      expect(def!.categorical).toBe(f.categorical)
      expect(def!.edges).toEqual(f.edges)
    }
  })

  it('has every fitted bucket reachable from the definition\'s own labels', () => {
    for (const f of BOOTSTRAP_MODEL.features) {
      if (f.categorical) continue
      const def = featureByKey(f.key)!
      const allowed = new Set([...bucketLabels(def), 'null'])
      for (const label of Object.keys(f.buckets)) expect(allowed.has(label), `${f.key} bucket ${label} unreachable`).toBe(true)
      expect(modelBucketLabels(f)).toEqual([...bucketLabels(def), 'null'])
    }
  })

  it('keeps the two features the corpus could not measure out of the prior so a refit can add them', () => {
    const keys = new Set(BOOTSTRAP_MODEL.features.map((f) => f.key))
    expect(keys.has('fresh_wallet_ratio')).toBe(false)
    expect(keys.has('bubblemap_connectivity')).toBe(false)
    expect(keys.has('deployer_holding_pct')).toBe(false)
    expect(keys.has('smart_money_count')).toBe(true)
    expect(keys.has('creator_record')).toBe(true)
    expect(keys.has('buy_volume_eth')).toBe(true)
  })
})
