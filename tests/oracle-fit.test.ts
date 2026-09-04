import { describe, expect, it } from 'vitest'
import { emptyFeatures } from '../src/engine/features.js'
import { createConviction } from '../src/oracle/conviction.js'
import { MIN_TRAINING_ROWS, auc, buildModel, encode, pruneDegenerate, reliability, type FitRow } from '../src/oracle/fit.js'
import { FEATURES } from '../src/oracle/features.js'
import { MIN_ABSOLUTE_AUC, judgeCandidate, toFitRow } from '../src/oracle/refit.js'
import type { OracleModelDocument } from '../src/types.js'

/** Seeded LCG so the dataset is the same on every run. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => ((s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff)
}

/**
 * A separable synthetic corpus: organic demand and buyer count drive wins,
 * dev dumping and bundling drive rugs, with a little label noise so the fit
 * is not trivially perfect.
 */
export function syntheticRows(n: number, seed = 7): FitRow[] {
  const rand = rng(seed)
  const rows: FitRow[] = []
  for (let i = 0; i < n; i++) {
    const organic = rand()
    const buyers = Math.floor(rand() * 60)
    const bundle = rand() * 0.8
    const devSold = rand() < 0.3
    const buyVol = rand() * 2
    const quality = organic * 0.6 + Math.min(1, buyers / 40) * 0.4 - bundle * 0.3 - (devSold ? 0.25 : 0)
    const noise = rand() < 0.04
    const moon = quality > 0.45 !== noise
    const win = moon && !devSold !== (rand() < 0.03)
    const rug = (bundle > 0.5 || devSold) && quality < 0.5 !== noise
    const f = emptyFeatures(rand() < 0.5 ? 'meme' : rand() < 0.5 ? 'ai' : 'animal')
    f.organic_score = organic
    f.bundle_score = bundle
    f.snipe_ratio = rand()
    f.coordination_score = bundle * 0.5
    f.timing_entropy = rand()
    f.concentration_top1 = rand() * 0.5
    f.concentration_top5 = 0.3 + rand() * 0.6
    f.concentration_top10 = 0.4 + rand() * 0.6
    f.unique_buyers = buyers
    f.unique_sellers = Math.floor(rand() * 8)
    f.buy_sell_ratio = rand() * 5
    f.buy_volume_eth = buyVol
    f.sell_volume_eth = buyVol * rand() * 0.5
    f.net_volume_eth = f.buy_volume_eth - f.sell_volume_eth
    f.trade_count = buyers + f.unique_sellers
    f.largest_buy_eth = buyVol * 0.3
    f.avg_buy_eth = buyers ? buyVol / buyers : 0
    f.median_buy_eth = f.avg_buy_eth * 0.6
    f.mc_eth_first_seen = 1 + rand()
    f.dev_buy_eth = rand() * 0.1
    f.dev_sell_eth = devSold ? rand() * 0.1 : 0
    f.dev_sold = devSold
    f.smart_money_count = rand() < 0.05 ? 1 : 0
    f.deployer_holding_pct = rand() * 0.3
    f.narrative_confidence = 0.3 + rand() * 0.6
    const launches = Math.floor(rand() * 6)
    rows.push({ features: f, creator_launches: launches, creator_wins: launches > 2 && rand() < 0.3 ? 1 : 0, category: f.category, win, rug, moon })
  }
  return rows
}

describe('oracle fitter', () => {
  const rows = syntheticRows(1600)

  it('needs the young-chain minimum and encodes one column per feature bucket', () => {
    expect(() => buildModel(rows.slice(0, MIN_TRAINING_ROWS - 1))).toThrow(/at least/)
    const { X, stride, columns } = encode(rows.slice(0, 50), FEATURES)
    expect(stride).toBe(FEATURES.length)
    expect(X.length).toBe(50 * stride)
    expect(columns.size).toBeGreaterThan(stride)
  })

  it('drops a feature that cannot support a second weight and keeps the rest', () => {
    const constant = rows.map((r) => ({ ...r, features: { ...r.features, fresh_wallet_ratio: null, bubblemap_connectivity: null } }))
    const { features, dropped } = pruneDegenerate(constant, FEATURES)
    expect(dropped.map((d) => d.key)).toEqual(expect.arrayContaining(['fresh_wallet_ratio', 'bubblemap_connectivity']))
    expect(features.some((f) => f.key === 'organic_score')).toBe(true)
  })

  it('computes a tie-corrected AUC and a reliability table', () => {
    expect(auc([0.1, 0.4, 0.35, 0.8], [0, 0, 1, 1])).toBeCloseTo(0.75, 6)
    expect(auc([0.5, 0.5, 0.5], [1, 0, 1])).toBe(0.5)
    const table = reliability([0.01, 0.02, 0.3, 0.5], [0, 0, 1, 1])
    expect(table.reduce((s, b) => s + b.n, 0)).toBe(4)
    expect(table[0]!.observed).toBe(0)
  })

  it('reaches AUC >= 0.9 on separable data, ships a complete v3 document, and clears the gate', () => {
    const { model, report } = buildModel(rows, { fittedAt: '2026-09-03T00:00:00.000Z', epochs: 14, provenance: 'test' })
    expect(report.complete).toBe(true)
    expect(model.version).toBe(3)
    expect(model.score_head).toBe('win')
    expect(model.holdout.win.auc).toBeGreaterThanOrEqual(0.9)
    expect(model.holdout.rug.auc).toBeGreaterThanOrEqual(0.85)
    expect(model.holdout.moon.auc).toBeGreaterThanOrEqual(0.9)
    expect(model.holdout.win.n).toBe(model.fit.holdout_n)
    expect(model.fit.split_at + model.fit.holdout_n).toBe(rows.length)
    expect(model.training_rows).toBe(rows.length)
    for (const f of model.features) {
      for (const [label, b] of Object.entries(f.buckets)) {
        expect(b.n).toBeGreaterThan(0)
        expect(Number.isFinite(b.w.win) && Number.isFinite(b.w.rug) && Number.isFinite(b.w.moon)).toBe(true)
        expect(label.length).toBeGreaterThan(0)
      }
    }

    const verdict = judgeCandidate(model, null)
    expect(verdict.promote).toBe(true)
    expect(verdict.checks.every((c) => c.pass)).toBe(true)
    expect(verdict.reason).toMatch(/first model/)

    // The fitted model scores through the same engine the bootstrap does.
    const engine = createConviction(model)
    const best = rows.filter((r) => r.win).slice(0, 20)
    const worst = rows.filter((r) => r.rug && !r.moon).slice(0, 20)
    const score = (r: FitRow) => engine.convict({ token: '0x0000000000000000000000000000000000000001', network: 'mainnet', observedAt: new Date(), windowSeconds: 90, features: r.features as never, missing: [] }, { creatorLaunches: r.creator_launches, creatorWins: r.creator_wins }).score
    const meanBest = best.reduce((s, r) => s + score(r), 0) / best.length
    const meanWorst = worst.reduce((s, r) => s + score(r), 0) / worst.length
    expect(meanBest).toBeGreaterThan(meanWorst + 15)
  })

  it('gate: rejects a collapsed feature set, an under-trained fit, a weak AUC, and a no-gain challenger', () => {
    const { model } = buildModel(rows, { fittedAt: '2026-09-03T00:00:00.000Z', epochs: 10 })
    const incumbent: OracleModelDocument = { ...model, features: model.features }

    const collapsed = { ...model, features: model.features.slice(0, model.features.length - 5) }
    const c = judgeCandidate(collapsed, incumbent)
    expect(c.promote).toBe(false)
    expect(c.reason).toMatch(/collapsed/)
    expect(c.checks.find((k) => k.check === 'feature_set')?.pass).toBe(false)

    const truncated = { ...model, fit: { ...model.fit, complete: false, epochs_run: 3 } }
    expect(judgeCandidate(truncated, null).reason).toMatch(/ran out of time/)

    const weak = { ...model, holdout: { ...model.holdout, win: { ...model.holdout.win, auc: MIN_ABSOLUTE_AUC - 0.05 } } }
    expect(judgeCandidate(weak, null).reason).toMatch(/publish floor/)

    const same = judgeCandidate(model, incumbent)
    expect(same.promote).toBe(false)
    expect(same.reason).toMatch(/no material gain/)

    const better = { ...model, holdout: { ...model.holdout, win: { ...model.holdout.win, auc: model.holdout.win.auc + 0.02 } } }
    expect(judgeCandidate(better, incumbent).promote).toBe(true)

    const regressed = { ...better, holdout: { ...better.holdout, rug: { ...model.holdout.rug, auc: model.holdout.rug.auc - 0.05 } } }
    expect(judgeCandidate(regressed, incumbent).reason).toMatch(/rug head regressed/)

    const dishonest = { ...model, holdout: { ...model.holdout, win: { ...model.holdout.win, reliability: model.holdout.win.reliability.map((b) => ({ ...b, n: 100, observed: 0 })) } } }
    expect(judgeCandidate(dishonest, null).reason).toMatch(/do not earn their claim/)
  })

  it('prefers a realized outcome over the chart label when folding a training row', () => {
    const base = { features: { creator_launches: 2, creator_wins: 0, category: 'ai' }, category: 'ai', win: false, rug: true, moon: true, realized_win: null, realized_pnl_pct: null, realized_samples: 0 }
    expect(toFitRow(base)).toMatchObject({ win: false, rug: true, moon: true, creator_launches: 2, creator_wins: 0, category: 'ai' })
    expect(toFitRow({ ...base, realized_win: true, realized_pnl_pct: 40, realized_samples: 2 })).toMatchObject({ win: true, rug: false, moon: true })
    expect(toFitRow({ ...base, realized_win: false, realized_pnl_pct: -70, realized_samples: 1, moon: false })).toMatchObject({ win: false, rug: true, moon: false })
  })
})
