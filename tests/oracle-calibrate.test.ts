import { describe, expect, it } from 'vitest'
import { calibrationTable } from '../src/oracle/calibrate.js'
import { createConviction } from '../src/oracle/conviction.js'
import { BOOTSTRAP_MODEL } from '../src/oracle/model-store.js'

describe('calibration table', () => {
  const engine = createConviction(BOOTSTRAP_MODEL)

  it('reports observed vs claimed per 10-point band, claiming via the anchors and not score/100', () => {
    const rows = [
      ...Array.from({ length: 40 }, (_, i) => ({ score: 5, win: i < 1 })),
      ...Array.from({ length: 20 }, (_, i) => ({ score: 60, win: i < 4 })),
      ...Array.from({ length: 10 }, (_, i) => ({ score: 88, win: i < 5 })),
    ]
    const { bands, baseRate, winsN } = calibrationTable(rows, engine.probabilityFromScore)
    expect(bands.length).toBe(10)
    expect(winsN).toBe(10)
    expect(baseRate).toBeCloseTo(10 / 70, 4)
    const b0 = bands[0]!
    expect(b0).toMatchObject({ lo: 0, hi: 10, n: 40, wins: 1, observed: 0.025 })
    const b6 = bands[6]!
    expect(b6).toMatchObject({ lo: 60, hi: 70, n: 20, wins: 4, observed: 0.2 })
    expect(b6.predicted).toBeCloseTo(engine.probabilityFromScore(60), 4)
    expect(b6.predicted).toBeLessThan(0.6)
    const b8 = bands[8]!
    expect(b8).toMatchObject({ lo: 80, hi: 90, n: 10, wins: 5, observed: 0.5 })
    expect(b8.lift).toBeCloseTo(0.5 / (10 / 70), 1)
    expect(bands[9]).toMatchObject({ lo: 90, hi: 100, n: 0, wins: 0, observed: null, predicted: null, lift: null })
  })

  it('handles an empty set without dividing by zero', () => {
    const { bands, baseRate, winsN } = calibrationTable([], engine.probabilityFromScore)
    expect(baseRate).toBeNull()
    expect(winsN).toBe(0)
    expect(bands.every((b) => b.n === 0 && b.observed === null)).toBe(true)
  })
})
