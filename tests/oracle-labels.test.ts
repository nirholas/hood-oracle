import { describe, expect, it } from 'vitest'
import { LABEL_HORIZON_MS, labelFromPath } from '../src/oracle/labels.js'

const T0 = Date.parse('2026-09-01T00:00:00Z')
const h = (hours: number) => T0 + hours * 3_600_000

describe('label maths', () => {
  it('is unknowable with no trade in the horizon', () => {
    expect(labelFromPath([], { firstSeenAt: T0 })).toBeNull()
    expect(labelFromPath([{ at: T0 - 1, priceEth: 1 }], { firstSeenAt: T0 })).toBeNull()
    expect(labelFromPath([{ at: T0 + LABEL_HORIZON_MS + 1, priceEth: 1 }], { firstSeenAt: T0 })).toBeNull()
  })

  it('win: ran 2x and a first-sight holder is still up at 24h', () => {
    const r = labelFromPath([
      { at: h(0), priceEth: 1e-9 }, { at: h(2), priceEth: 3e-9 }, { at: h(10), priceEth: 2.5e-9 }, { at: h(23), priceEth: 1.4e-9 },
    ], { firstSeenAt: T0 })!
    expect(r.athMultiple).toBe(3)
    expect(r).toMatchObject({ win: true, rug: false, moon: true, samples: 4 })
    expect(r.firstSightPrice).toBe(1e-9)
    expect(r.price24h).toBe(1.4e-9)
  })

  it('moon but not win: ran 2x then gave it back', () => {
    const r = labelFromPath([
      { at: h(0), priceEth: 1 }, { at: h(1), priceEth: 2.2 }, { at: h(20), priceEth: 0.8 },
    ], { firstSeenAt: T0 })!
    expect(r).toMatchObject({ win: false, rug: false, moon: true })
    expect(r.athMultiple).toBe(2.2)
  })

  it('rug: down more than half at 24h, or liquidity gone', () => {
    const down = labelFromPath([{ at: h(0), priceEth: 1 }, { at: h(5), priceEth: 0.49 }], { firstSeenAt: T0 })!
    expect(down).toMatchObject({ win: false, rug: true, moon: false })
    const exactlyHalf = labelFromPath([{ at: h(0), priceEth: 1 }, { at: h(5), priceEth: 0.5 }], { firstSeenAt: T0 })!
    expect(exactlyHalf.rug).toBe(false)
    const drained = labelFromPath([{ at: h(0), priceEth: 1 }, { at: h(1), priceEth: 3 }, { at: h(2), priceEth: 3 }], { firstSeenAt: T0, liquidityGone: true })!
    expect(drained).toMatchObject({ win: false, rug: true, moon: true })
  })

  it('ran 2x AND rugged is a moon-rug, never a win', () => {
    const r = labelFromPath([{ at: h(0), priceEth: 1 }, { at: h(1), priceEth: 5 }, { at: h(23), priceEth: 0.1 }], { firstSeenAt: T0 })!
    expect(r).toMatchObject({ win: false, rug: true, moon: true })
    expect(r.athMultiple).toBe(5)
  })

  it('only reads trades inside the horizon and ignores unpriced points', () => {
    const r = labelFromPath([
      { at: h(0), priceEth: 1 }, { at: h(12), priceEth: 0 }, { at: h(12), priceEth: Number.NaN },
      { at: h(23.9), priceEth: 1.1 }, { at: h(25), priceEth: 100 },
    ], { firstSeenAt: T0 })!
    expect(r.samples).toBe(2)
    expect(r.athMultiple).toBe(1.1)
    expect(r).toMatchObject({ win: false, rug: false, moon: false })
  })

  it('is independent of the ETH price: scaling every price leaves every label unchanged', () => {
    const path = [{ at: h(0), priceEth: 2e-8 }, { at: h(3), priceEth: 5e-8 }, { at: h(22), priceEth: 2.4e-8 }]
    const a = labelFromPath(path, { firstSeenAt: T0 })!
    const b = labelFromPath(path.map((p) => ({ ...p, priceEth: p.priceEth * 37 })), { firstSeenAt: T0 })!
    expect({ win: b.win, rug: b.rug, moon: b.moon, ath: b.athMultiple }).toEqual({ win: a.win, rug: a.rug, moon: a.moon, ath: a.athMultiple })
  })
})
