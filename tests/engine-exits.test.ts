import { describe, expect, it } from 'vitest'
import { decideExit, decideLadderedExit, decideLiquidityDecay, moonbagExitFraction, moonbagFraction, sellAmountForFraction, shouldGiveUpReconcile, updateStaleClock, type ExitParams } from '../src/engine/exits.js'

const ETH = 10n ** 18n
const base = (over: Partial<ExitParams> = {}): ExitParams => ({
  entryWei: ETH, stopLossPct: 30, trailingStopPct: 20, takeProfitPct: 100, maxHoldSeconds: 1800, openedAt: 0,
  initialsOutMultiple: 2, moonbagMinPct: 15, moonbagAlways: true, initialsRecovered: false, ...over,
})
const pct = (n: number) => (ETH * BigInt(Math.round(n * 1000))) / 1000n

describe('decideExit', () => {
  it('prioritises stop loss, arms the trailing stop only after being green, then take profit, then timeout', () => {
    expect(decideExit(base(), pct(0.7), ETH, 1000)).toBe('stop_loss')
    // underwater trail: peak == entry, value down 25% but above the stop: hold
    expect(decideExit(base({ stopLossPct: 40 }), pct(0.75), ETH, 1000)).toBeNull()
    // green then down 20% from peak
    expect(decideExit(base(), pct(1.2), pct(1.5), 1000)).toBe('trailing_stop')
    expect(decideExit(base({ trailingStopPct: null }), pct(2.0), pct(2.0), 1000)).toBe('take_profit')
    expect(decideExit(base({ takeProfitPct: null, trailingStopPct: null }), pct(1.1), pct(1.1), 1800_000)).toBe('timeout')
    expect(decideExit(base({ takeProfitPct: null, trailingStopPct: null }), pct(1.1), pct(1.1), 1000)).toBeNull()
  })
})

describe('decideLadderedExit', () => {
  it('takes initials once at the multiple, selling exactly the cost basis capped by the moon bag', () => {
    const d = decideLadderedExit(base(), pct(2), pct(2), 1000)
    expect(d).toEqual({ reason: 'take_initials', sellFraction: 0.5, recoversInitials: true })
    const d5 = decideLadderedExit(base(), pct(5), pct(5), 1000)
    expect(d5?.sellFraction).toBeCloseTo(0.2)
    const d1 = decideLadderedExit(base({ initialsOutMultiple: 1.05 }), pct(1.05), pct(1.05), 1000)
    expect(d1?.sellFraction).toBeCloseTo(0.85) // cap at 1 - moonbag
  })
  it('never fires take-profit before initials are out, and exits the remainder to the moon-bag floor after', () => {
    expect(decideLadderedExit(base({ initialsOutMultiple: 3 }), pct(2.5), pct(2.5), 1000)).toBeNull()
    const after = decideLadderedExit(base({ initialsRecovered: true }), pct(2.5), pct(2.5), 1000)
    expect(after?.reason).toBe('take_profit')
    expect(after?.sellFraction).toBeCloseTo(0.85)
    expect(after?.keepsMoonbag).toBe(true)
  })
  it('stop loss on money at risk is a full exit; a profitable trailing stop keeps the bag', () => {
    expect(decideLadderedExit(base(), pct(0.6), ETH, 1000)).toEqual({ reason: 'stop_loss', sellFraction: 1 })
    const trail = decideLadderedExit(base(), pct(1.4), pct(1.9), 1000)
    expect(trail?.reason).toBe('trailing_stop')
    expect(trail?.sellFraction).toBeCloseTo(1 / 1.4)
    expect(trail?.keepsMoonbag).toBe(true)
  })
  it('classic full exits when moonbagAlways is off', () => {
    expect(decideLadderedExit(base({ moonbagAlways: false, initialsOutMultiple: null }), pct(2.5), pct(2.5), 1000)).toEqual({ reason: 'take_profit', sellFraction: 1 })
  })
})

describe('stale clock and liquidity decay', () => {
  it('runs only while underwater and unchanged, and resets on any move', () => {
    expect(updateStaleClock(null, pct(0.8), ETH, null, 10)).toBeNull()
    expect(updateStaleClock(pct(0.8), pct(0.8), ETH, null, 20)).toBe(20)
    expect(updateStaleClock(pct(0.8), pct(0.8), ETH, 20, 30)).toBe(20)
    expect(updateStaleClock(pct(0.8), pct(0.81), ETH, 20, 40)).toBeNull()
    expect(updateStaleClock(pct(1.2), pct(1.2), ETH, null, 50)).toBeNull()
    expect(decideLiquidityDecay(20, 300, 20 + 299_000)).toBe(false)
    expect(decideLiquidityDecay(20, 300, 20 + 300_000)).toBe(true)
    expect(decideLiquidityDecay(20, null, 1e12)).toBe(false)
  })
})

describe('moon bag maths and helpers', () => {
  it('clamps the floor and computes exit fractions', () => {
    expect(moonbagFraction(null)).toBe(0.15)
    expect(moonbagFraction(200)).toBe(0.95)
    expect(moonbagExitFraction(ETH, pct(4), 0.15, false)).toBeCloseTo(0.25)
    expect(moonbagExitFraction(ETH, pct(4), 0.15, true)).toBeCloseTo(0.85)
  })
  it('sellAmountForFraction is exact in ppm', () => {
    const r = sellAmountForFraction(1_000_000n, 0.5)
    expect(r).toEqual({ amount: 500_000n, ppm: 500_000n, partial: true })
    expect(sellAmountForFraction(10n, 1).partial).toBe(false)
    expect(sellAmountForFraction(10n, 0).amount).toBe(10n)
  })
  it('shouldGiveUpReconcile honours the bound and ignores a healthy position', () => {
    expect(shouldGiveUpReconcile(null, 1000, 5000)).toBe(false)
    expect(shouldGiveUpReconcile(new Date(0), 1000, 999)).toBe(false)
    expect(shouldGiveUpReconcile(0, 1000, 1000)).toBe(true)
  })
})
