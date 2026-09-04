import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BASE_WRITABLE,
  DAILY_LOSS_FRACTION_OF_BUDGET,
  GAS_HEADROOM_WEI,
  GATES,
  KillSwitch,
  MIN_ENTRY_WEI,
  MIN_SAMPLE,
  MIN_SAMPLE_WINLESS,
  RiskEngine,
  TIER_BOUNDS,
  TIER_ORDER,
  atLeast,
  bestOracleThreshold,
  boundsFor,
  canonicalJson,
  clampToTier,
  netEdgePct,
  proposeMutation,
  recordFromPositions,
  resolveEntrySize,
  statsFromPositions,
  stepsFor,
  tierFor,
  writableFor,
  type ArmRecord,
  type RiskContext,
} from '../src/guards/index.js'
import type { Arm, AutonomyTier, ExitReason, Position, RefusalReason } from '../src/types.js'

const ETH = 10n ** 18n
const eth = (n: number) => (ETH * BigInt(Math.round(n * 1_000_000))) / 1_000_000n
const TOKEN = '0x1111111111111111111111111111111111111111' as const

function makeArm(over: Partial<Arm> = {}): Arm {
  const now = new Date('2026-09-01T00:00:00Z')
  return {
    id: '3f2b1c1e-0000-4000-8000-000000000001',
    label: 'test-arm',
    network: 'mainnet',
    enabled: true,
    killSwitch: false,
    mode: 'simulate',
    trigger: 'new_launch',
    launchpads: ['noxa', 'odyssey'],
    perTradeWei: eth(0.01),
    dailyBudgetWei: eth(0.05),
    maxConcurrentPositions: 2,
    cooldownSeconds: 30,
    slippageBps: 500,
    maxPriceImpactPct: 10,
    firewallLevel: 'block',
    buyDelayMs: 0,
    minOracleScore: 56,
    maxRugRisk: null,
    minUniqueBuyers: null,
    maxCreatorLaunches: null,
    maxDeployerPct: null,
    maxBundleScore: null,
    maxConcentrationTop1: null,
    minMarketCapEth: null,
    maxMarketCapEth: null,
    requireSocials: false,
    avoidDevDump: true,
    allowedCategories: null,
    stopLossPct: 30,
    takeProfitPct: null,
    trailingStopPct: 20,
    maxHoldSeconds: 1800,
    liquidityDecaySeconds: null,
    initialsOutMultiple: null,
    moonbagMinPct: 15,
    moonbagAlways: false,
    decisionMode: 'rules',
    llmMinConfidence: null,
    autoOptimize: true,
    autonomyTier: 'standard',
    telegramChatId: null,
    experimentGroup: null,
    accountId: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  }
}

const NOW = Date.parse('2026-09-01T12:00:00Z')

function ctx(over: Partial<RiskContext> = {}): RiskContext {
  return {
    side: 'buy',
    arm: makeArm(),
    amountWei: eth(0.005),
    walletWei: eth(1),
    minWalletWei: eth(0.005),
    spentTodayWei: 0n,
    realizedLossTodayWei: 0n,
    openPositions: 0,
    lastTradeAt: null,
    slippageBps: 300,
    priceImpactPct: 2,
    killed: false,
    now: NOW,
    ...over,
  }
}

const quietLog = { info: () => {}, warn: () => {} }

describe('RiskEngine', () => {
  const engine = new RiskEngine()

  it('allows a clean buy', () => {
    const v = engine.check(ctx())
    expect(v.ok).toBe(true)
    expect(v.reason).toBeUndefined()
  })

  const refusals: [RefusalReason, Partial<RiskContext>][] = [
    ['kill_switch', { killed: true }],
    ['zero_amount', { amountWei: 0n }],
    ['slippage_bound', { slippageBps: 600 }],
    ['cooldown', { lastTradeAt: NOW - 10_000 }],
    ['disarmed', { arm: makeArm({ enabled: false }) }],
    ['disarmed', { arm: makeArm({ killSwitch: true }) }],
    ['concurrency', { openPositions: 2 }],
    ['per_trade_cap', { amountWei: eth(0.02) }],
    ['per_trade_cap', { arm: makeArm({ perTradeWei: 0n }) }],
    ['daily_budget', { spentTodayWei: eth(0.046) }],
    ['daily_budget', { arm: makeArm({ dailyBudgetWei: 0n }) }],
    ['daily_loss', { realizedLossTodayWei: eth(0.025) }],
    ['wallet_floor', { walletWei: null }],
    ['wallet_floor', { walletWei: eth(0.01) }],
    ['price_impact', { priceImpactPct: null }],
    ['price_impact', { priceImpactPct: Number.NaN }],
    ['price_impact', { priceImpactPct: 12 }],
  ]

  for (const [reason, over] of refusals) {
    it(`refuses with ${reason}`, () => {
      const v = engine.check(ctx(over))
      expect(v.ok).toBe(false)
      expect(v.reason).toBe(reason)
      expect(v.detail.length).toBeGreaterThan(10)
      expect(v.detail).not.toMatch(/undefined|NaN|\[object/)
    })
  }

  it('orders refusals: the kill switch outranks every cap', () => {
    const v = engine.check(ctx({ killed: true, amountWei: 0n, openPositions: 9, priceImpactPct: null }))
    expect(v.reason).toBe('kill_switch')
  })

  it('exempts sells from exposure caps but not from the kill switch, cooldown or slippage', () => {
    const capped = ctx({
      side: 'sell',
      arm: makeArm({ enabled: false, perTradeWei: 0n, dailyBudgetWei: 0n }),
      amountWei: eth(5),
      walletWei: null,
      openPositions: 99,
      spentTodayWei: eth(99),
      realizedLossTodayWei: eth(99),
      priceImpactPct: null,
    })
    expect(engine.check(capped).ok).toBe(true)
    expect(engine.check({ ...capped, killed: true }).reason).toBe('kill_switch')
    expect(engine.check({ ...capped, lastTradeAt: NOW - 1000 }).reason).toBe('cooldown')
    expect(engine.check({ ...capped, slippageBps: 5000 }).reason).toBe('slippage_bound')
  })

  it('cooldown maths: refuses inside the window, allows at the boundary', () => {
    const arm = makeArm({ cooldownSeconds: 30 })
    const inside = engine.check(ctx({ arm, lastTradeAt: NOW - 29_500 }))
    expect(inside.reason).toBe('cooldown')
    expect(inside.detail).toContain('0.5s')
    expect(engine.check(ctx({ arm, lastTradeAt: NOW - 30_000 })).ok).toBe(true)
    expect(engine.check(ctx({ arm: makeArm({ cooldownSeconds: 0 }), lastTradeAt: NOW })).ok).toBe(true)
  })

  it('daily loss breaker fires at the configured fraction of the budget', () => {
    const limit = (eth(0.05) * BigInt(Math.round(DAILY_LOSS_FRACTION_OF_BUDGET * 10_000))) / 10_000n
    expect(engine.check(ctx({ realizedLossTodayWei: limit - 1n })).ok).toBe(true)
    expect(engine.check(ctx({ realizedLossTodayWei: limit })).reason).toBe('daily_loss')
    const strict = new RiskEngine({ dailyLossFractionOfBudget: 0.1 })
    expect(strict.check(ctx({ realizedLossTodayWei: eth(0.005) })).reason).toBe('daily_loss')
  })

  it('wallet floor reserves the operator floor plus gas headroom', () => {
    const exact = eth(0.005) + eth(0.005) + GAS_HEADROOM_WEI
    expect(engine.check(ctx({ walletWei: exact })).ok).toBe(true)
    expect(engine.check(ctx({ walletWei: exact - 1n })).reason).toBe('wallet_floor')
  })

  it('price impact fails closed on null and allows at the ceiling', () => {
    expect(engine.check(ctx({ priceImpactPct: 10 })).ok).toBe(true)
    expect(engine.check(ctx({ priceImpactPct: 10.01 })).reason).toBe('price_impact')
    expect(engine.check(ctx({ priceImpactPct: null })).reason).toBe('price_impact')
  })
})

describe('resolveEntrySize', () => {
  const minWallet = eth(0.005)
  it('funds the full size when the wallet covers it plus the floors', () => {
    const r = resolveEntrySize(eth(1), eth(0.01), minWallet)
    expect('sizeWei' in r && r.sizeWei).toBe(eth(0.01))
    expect('shrunk' in r && r.shrunk).toBe(false)
  })
  it('shrinks to what is free above the floor', () => {
    const wallet = minWallet + GAS_HEADROOM_WEI + eth(0.004)
    const r = resolveEntrySize(wallet, eth(0.01), minWallet)
    expect('sizeWei' in r && r.sizeWei).toBe(eth(0.004))
    expect('shrunk' in r && r.shrunk).toBe(true)
  })
  it('sits out under the minimum entry instead of placing dust', () => {
    const wallet = minWallet + GAS_HEADROOM_WEI + MIN_ENTRY_WEI - 1n
    const r = resolveEntrySize(wallet, eth(0.01), minWallet)
    expect('skip' in r && r.skip).toBe('wallet_floor')
    const r2 = resolveEntrySize(0n, eth(0.01), minWallet)
    expect('skip' in r2 && r2.skip).toBe('wallet_floor')
    expect(r2.detail).toContain('0 ETH')
  })
  it('refuses a zero request', () => {
    const r = resolveEntrySize(eth(1), 0n, minWallet)
    expect('skip' in r && r.skip).toBe('zero_amount')
  })
})

describe('KillSwitch', () => {
  const dirs: string[] = []
  const switches: KillSwitch[] = []
  afterEach(() => {
    for (const s of switches.splice(0)) s.dispose()
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const tempDir = () => {
    const d = mkdtempSync(join(tmpdir(), 'hood-kill-'))
    dirs.push(d)
    return d
  }
  const make = (over: { initialKill?: string; killFile?: string } = {}) => {
    const s = new KillSwitch({ killFile: over.killFile ?? join(tempDir(), 'KILL'), log: quietLog, pollMs: 20, initialKill: over.initialKill })
    switches.push(s)
    return s
  }
  const until = async (pred: () => boolean, ms = 2000) => {
    const start = Date.now()
    while (!pred()) {
      if (Date.now() - start > ms) throw new Error('timed out waiting')
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  it('starts open, trips once, keeps the first reason', () => {
    const s = make()
    expect(s.isKilled()).toBe(false)
    expect(s.reason()).toBeNull()
    const seen: string[] = []
    s.onTrip((r) => seen.push(r))
    s.trip('api:first')
    s.trip('api:second')
    expect(s.isKilled()).toBe(true)
    expect(s.reason()).toBe('api:first')
    expect(seen).toEqual(['api:first'])
  })

  it('clears only an api kill', () => {
    const s = make()
    let cleared = 0
    s.onClear(() => cleared++)
    expect(s.clearApiKill()).toBe(true)
    s.trip('api:operator')
    expect(s.clearApiKill()).toBe(true)
    expect(s.isKilled()).toBe(false)
    expect(cleared).toBe(1)
    s.trip('operator: dashboard button')
    expect(s.clearApiKill()).toBe(true)
    expect(cleared).toBe(2)
    s.trip('signal:SIGTERM')
    expect(s.clearApiKill()).toBe(false)
    expect(s.isKilled()).toBe(true)
    expect(s.reason()).toBe('signal:SIGTERM')
  })

  it('honors the env kill at construction and refuses to clear it', () => {
    const s = make({ initialKill: 'env:GLOBAL_KILL' })
    expect(s.isKilled()).toBe(true)
    expect(s.reason()).toBe('env:GLOBAL_KILL')
    expect(s.clearApiKill()).toBe(false)
  })

  it('trips on a kill file that appears after arming, and will not clear it', async () => {
    const dir = tempDir()
    const killFile = join(dir, 'KILL')
    const s = make({ killFile })
    s.arm()
    expect(s.isKilled()).toBe(false)
    writeFileSync(killFile, 'panic')
    await until(() => s.isKilled())
    expect(s.reason()).toBe(`file:${killFile}`)
    expect(s.clearApiKill()).toBe(false)
  })

  it('trips immediately when the kill file already exists at boot', () => {
    const dir = tempDir()
    const killFile = join(dir, 'KILL')
    writeFileSync(killFile, '')
    const s = make({ killFile })
    s.arm()
    expect(s.isKilled()).toBe(true)
  })

  it('installs and removes the signal handlers', () => {
    const before = process.listenerCount('SIGINT')
    const s = make()
    s.arm()
    s.arm()
    expect(process.listenerCount('SIGINT')).toBe(before + 1)
    expect(process.listenerCount('SIGTERM')).toBeGreaterThan(0)
    s.dispose()
    expect(process.listenerCount('SIGINT')).toBe(before)
  })
})

function record(over: Partial<ArmRecord> = {}): ArmRecord {
  return {
    closedTrades: 0,
    wins: 0,
    netPnlWei: 0n,
    grossSpentWei: eth(1),
    maxDrawdownPct: 0,
    firstTradeAt: null,
    ...over,
  }
}

describe('autonomy tiers', () => {
  it('computes a size-weighted net edge', () => {
    expect(netEdgePct(record({ netPnlWei: eth(0.05), grossSpentWei: eth(1) }))).toBeCloseTo(5)
    expect(netEdgePct(record({ netPnlWei: -eth(0.01), grossSpentWei: eth(2) }))).toBeCloseTo(-0.5)
    expect(netEdgePct(record({ grossSpentWei: 0n }))).toBe(0)
  })

  it('needs evidence before granting anything', () => {
    expect(tierFor(record()).tier).toBe('standard')
    expect(tierFor(record({ closedTrades: 11, wins: 9, netPnlWei: eth(0.5) })).tier).toBe('standard')
  })

  it('grants trusted on a profitable real sample', () => {
    const v = tierFor(record({ closedTrades: GATES.trusted.closedTrades, wins: 5, netPnlWei: eth(0.02) }))
    expect(v.tier).toBe('trusted')
    expect(v.evidence.netEdgePct).toBe(2)
  })

  it('grants autonomous on sustained profit with a shallow drawdown', () => {
    const v = tierFor(record({ closedTrades: 40, wins: 15, netPnlWei: eth(0.06), maxDrawdownPct: 20 }))
    expect(v.tier).toBe('autonomous')
    expect(tierFor(record({ closedTrades: 40, wins: 15, netPnlWei: eth(0.06), maxDrawdownPct: 30 })).tier).toBe('trusted')
    expect(tierFor(record({ closedTrades: 40, wins: 15, netPnlWei: eth(0.06), maxDrawdownPct: 40 })).tier).toBe('standard')
  })

  it('demotes a proven bleed to probation, not a small losing sample', () => {
    expect(tierFor(record({ closedTrades: 15, wins: 9, netPnlWei: -eth(0.03) })).tier).toBe('probation')
    expect(tierFor(record({ closedTrades: 14, wins: 0, netPnlWei: -eth(0.03) })).tier).toBe('standard')
  })

  it('treats a near-zero edge as noise', () => {
    const v = tierFor(record({ closedTrades: 30, wins: 20, netPnlWei: eth(0.001) }))
    expect(v.tier).toBe('standard')
    expect(v.reason).toContain('No decisive edge')
  })

  it('orders tiers and scales steps', () => {
    expect(atLeast('trusted', 'autonomous')).toBe(true)
    expect(atLeast('trusted', 'standard')).toBe(false)
    expect(atLeast('standard', 'bogus')).toBe(true)
    expect(stepsFor('probation').stopLossPct).toBe(2.5)
    expect(stepsFor('autonomous').perTradeFraction).toBe(0.5)
    expect(stepsFor('autonomous').takeProfitPct).toBe(37.5)
  })

  it('every tier keeps a bounded stop loss and no safety rail is writable', () => {
    for (const tier of TIER_ORDER) {
      const b = boundsFor(tier)
      expect(b.stopLossPct.min).toBeGreaterThan(0)
      expect(b.stopLossPct.max).toBeLessThan(100)
      const w = writableFor(tier)
      for (const rail of ['dailyBudgetWei', 'maxConcurrentPositions', 'slippageBps', 'maxPriceImpactPct', 'firewallLevel', 'mode', 'enabled'] as const) {
        expect(w.has(rail)).toBe(false)
      }
      for (const k of BASE_WRITABLE) expect(w.has(k)).toBe(true)
    }
    expect(writableFor('standard').has('llmMinConfidence')).toBe(false)
    expect(writableFor('trusted').has('llmMinConfidence')).toBe(true)
    expect(writableFor('trusted').has('maxCreatorLaunches')).toBe(false)
    expect(writableFor('autonomous').has('maxCreatorLaunches')).toBe(true)
  })

  it('bounds widen monotonically with tier', () => {
    for (let i = 1; i < TIER_ORDER.length; i++) {
      const lo = TIER_BOUNDS[TIER_ORDER[i - 1]!]
      const hi = TIER_BOUNDS[TIER_ORDER[i]!]
      expect(hi.perTradeWei.max).toBeGreaterThanOrEqual(lo.perTradeWei.max)
      expect(hi.dailyBudgetWei.max).toBeGreaterThanOrEqual(lo.dailyBudgetWei.max)
      expect(hi.maxConcurrentPositions.max).toBeGreaterThanOrEqual(lo.maxConcurrentPositions.max)
      expect(hi.minOracleScore.min).toBeLessThanOrEqual(lo.minOracleScore.min)
    }
  })
})

describe('clampToTier', () => {
  const arm = makeArm()
  it('never widens beyond the tier bounds, in either direction', () => {
    for (const tier of TIER_ORDER) {
      const b = boundsFor(tier)
      const r = clampToTier(
        arm,
        { perTradeWei: eth(100), dailyBudgetWei: eth(1000), stopLossPct: 99, takeProfitPct: 1, maxConcurrentPositions: 50, slippageBps: 9999, maxPriceImpactPct: 90, minOracleScore: -5, maxHoldSeconds: 1 },
        tier,
      )
      expect(r.patch.perTradeWei).toBe(b.perTradeWei.max)
      expect(r.patch.dailyBudgetWei).toBe(b.dailyBudgetWei.max)
      expect(r.patch.stopLossPct).toBe(b.stopLossPct.max)
      expect(r.patch.takeProfitPct).toBe(b.takeProfitPct.min)
      expect(r.patch.maxConcurrentPositions).toBe(b.maxConcurrentPositions.max)
      expect(r.patch.slippageBps).toBe(b.slippageBps.max)
      expect(r.patch.maxPriceImpactPct).toBe(b.maxPriceImpactPct.max)
      expect(r.patch.minOracleScore).toBe(b.minOracleScore.min)
      expect(r.patch.maxHoldSeconds).toBe(b.maxHoldSeconds.min)
      expect(r.clamped.length).toBeGreaterThan(0)
    }
  })

  it('passes in-range values through untouched and leaves unbounded fields alone', () => {
    const r = clampToTier(arm, { stopLossPct: 25, label: 'renamed', launchpads: ['noxa'] }, 'standard')
    expect(r.patch).toEqual({ stopLossPct: 25, label: 'renamed', launchpads: ['noxa'] })
    expect(r.clamped).toEqual([])
    expect(r.refused).toEqual([])
  })

  it('refuses a null stop loss and lifts a null oracle gate to the tier floor', () => {
    const r = clampToTier(arm, { stopLossPct: null as unknown as number, minOracleScore: null }, 'probation')
    expect(r.refused.map((x) => x.knob)).toEqual(['stopLossPct'])
    expect(r.patch.stopLossPct).toBeUndefined()
    expect(r.patch.minOracleScore).toBe(TIER_BOUNDS.probation.minOracleScore.min)
    const open = clampToTier(arm, { minOracleScore: null }, 'trusted')
    expect(open.patch.minOracleScore).toBeNull()
  })

  it('keeps per-trade at or under the daily budget', () => {
    const r = clampToTier(makeArm({ dailyBudgetWei: eth(0.02) }), { perTradeWei: eth(0.04) }, 'standard')
    expect(r.patch.perTradeWei).toBe(eth(0.02))
    const r2 = clampToTier(makeArm({ perTradeWei: eth(0.04) }), { dailyBudgetWei: eth(0.02) }, 'standard')
    expect(r2.patch.perTradeWei).toBe(eth(0.02))
  })

  it('refuses non-numeric and non-wei values', () => {
    const r = clampToTier(arm, { perTradeWei: 5 as unknown as bigint, stopLossPct: 'x' as unknown as number }, 'standard')
    expect(r.refused.map((x) => x.knob).sort()).toEqual(['perTradeWei', 'stopLossPct'])
    expect(r.patch).toEqual({})
  })
})

let positionSeq = 0
function makePosition(over: Partial<Position> & { pnlPct: number; exitReason: ExitReason; score?: number; entry?: number }): Position {
  const { pnlPct, exitReason, score, entry, ...rest } = over
  const entryWei = eth(entry ?? 0.01)
  const pnlWei = (entryWei * BigInt(Math.round(pnlPct * 100))) / 10_000n
  const openedAt = new Date(Date.UTC(2026, 7, 1, 0, positionSeq++))
  return {
    id: `pos-${positionSeq}`,
    armId: makeArm().id,
    token: TOKEN,
    network: 'mainnet',
    launchpad: 'noxa',
    venue: 'pool',
    mode: 'simulate',
    status: 'closed',
    entryWei,
    tokenAmount: 1_000_000n,
    tokenDecimals: 18,
    buyTx: 'SIMULATED',
    sellTx: 'SIMULATED',
    openedAt,
    closedAt: new Date(openedAt.getTime() + 600_000),
    peakValueWei: entryWei,
    lastValueWei: entryWei + pnlWei,
    staleSince: null,
    initialsRecovered: false,
    realizedPnlWei: pnlWei,
    realizedPnlPct: pnlPct,
    exitReason,
    oracleScoreAtEntry: score ?? null,
    meta: {},
    ...rest,
  }
}

const repeat = (n: number, f: (i: number) => Position) => Array.from({ length: n }, (_, i) => f(i))

describe('optimizer', () => {
  it('derives stats and a record from positions', () => {
    const positions = [
      ...repeat(3, () => makePosition({ pnlPct: 40, exitReason: 'take_profit' })),
      ...repeat(2, () => makePosition({ pnlPct: -30, exitReason: 'stop_loss' })),
      makePosition({ pnlPct: 0, exitReason: 'manual', status: 'open', closedAt: null }),
    ]
    const s = statsFromPositions(positions)
    expect(s.closed).toBe(5)
    expect(s.wins).toBe(3)
    expect(s.exitReasons.take_profit).toBe(3)
    expect(s.avgHoldSeconds).toBe(600)
    const r = recordFromPositions(positions)
    expect(r.closedTrades).toBe(5)
    expect(r.netPnlWei).toBe(eth(0.012) - eth(0.006))
    expect(r.maxDrawdownPct).toBeCloseTo(50)
    expect(r.firstTradeAt).not.toBeNull()
  })

  it('stays quiet under the sample floor', () => {
    const arm = makeArm()
    const few = repeat(MIN_SAMPLE - 1, (i) => makePosition({ pnlPct: i === 0 ? 5 : -20, exitReason: 'stop_loss' }))
    expect(proposeMutation(arm, recordFromPositions(few), few)).toBeNull()
    const mixed = repeat(MIN_SAMPLE_WINLESS, (i) => makePosition({ pnlPct: i === 0 ? 5 : -20, exitReason: 'stop_loss' }))
    expect(proposeMutation(arm, recordFromPositions(mixed), mixed)).toBeNull()
  })

  it('shrinks a winless bleeder below the general floor', () => {
    const arm = makeArm()
    const winless = repeat(MIN_SAMPLE_WINLESS, () => makePosition({ pnlPct: -20, exitReason: 'stop_loss' }))
    const m = proposeMutation(arm, recordFromPositions(winless), winless)
    expect(m?.rule).toBe('W')
    expect(m?.knob).toBe('perTradeWei')
    expect(m?.to).toBe(eth(0.008))
    expect(m?.patch).toEqual({ perTradeWei: eth(0.008) })
  })

  it('raises the oracle floor where realized wins concentrate (Rule O)', () => {
    const arm = makeArm({ minOracleScore: 34 })
    const positions = [
      ...repeat(6, () => makePosition({ pnlPct: -20, exitReason: 'stop_loss', score: 40 })),
      ...repeat(6, () => makePosition({ pnlPct: 50, exitReason: 'take_profit', score: 80 })),
    ]
    const m = proposeMutation(arm, recordFromPositions(positions), positions)
    expect(m?.rule).toBe('O')
    expect(m?.knob).toBe('minOracleScore')
    expect(m?.to).toBe(39)
    expect(bestOracleThreshold(statsFromPositions(positions).oracleBuckets)).toBe(72)
  })

  it('sets a take-profit when winners time out (Rule A)', () => {
    const arm = makeArm({ takeProfitPct: null })
    const positions = repeat(10, (i) => makePosition({ pnlPct: i < 6 ? 30 : -10, exitReason: i < 6 ? 'timeout' : 'stop_loss' }))
    const m = proposeMutation(arm, recordFromPositions(positions), positions)
    expect(m?.rule).toBe('A')
    expect(m?.knob).toBe('takeProfitPct')
    expect(m?.from).toBeNull()
    expect(m?.to).toBe(21)
  })

  it('shrinks the bet on size-weighted divergence before ever growing it (Rule S)', () => {
    const arm = makeArm({ autonomyTier: 'trusted' })
    const positions = [
      ...repeat(8, () => makePosition({ pnlPct: 20, exitReason: 'take_profit', entry: 0.002 })),
      ...repeat(4, () => makePosition({ pnlPct: -30, exitReason: 'stop_loss', entry: 0.02 })),
    ]
    const m = proposeMutation(arm, recordFromPositions(positions), positions)
    expect(m?.rule).toBe('S')
    expect(m?.knob).toBe('perTradeWei')
    expect(m!.to < arm.perTradeWei).toBe(true)
  })

  it('scales a proven arm up but never past the tier ceiling or the daily budget (Rule D)', () => {
    const positions = repeat(12, (i) => makePosition({ pnlPct: i < 8 ? 40 : -15, exitReason: i < 8 ? 'take_profit' : 'stop_loss' }))
    const rec = recordFromPositions(positions)
    const m = proposeMutation(makeArm(), rec, positions)
    expect(m?.rule).toBe('D')
    expect(m?.to).toBe(eth(0.0115))
    const atCap = makeArm({ perTradeWei: TIER_BOUNDS.standard.perTradeWei.max, dailyBudgetWei: eth(10) })
    expect(proposeMutation(atCap, rec, positions)).toBeNull()
    const budgetBound = makeArm({ perTradeWei: eth(0.01), dailyBudgetWei: eth(0.0105) })
    const m2 = proposeMutation(budgetBound, rec, positions)
    expect(m2?.to).toBe(eth(0.0105))
  })

  it('does not hand a losing arm a tier-unlocked knob', () => {
    const positions = repeat(12, (i) => makePosition({ pnlPct: i < 8 ? 40 : -15, exitReason: i < 8 ? 'take_profit' : 'stop_loss' }))
    const arm = makeArm({ decisionMode: 'llm', llmMinConfidence: 0.7, perTradeWei: TIER_BOUNDS.standard.perTradeWei.max, dailyBudgetWei: eth(10) })
    expect(proposeMutation(arm, recordFromPositions(positions), positions)).toBeNull()
    const trusted = makeArm({ ...arm, autonomyTier: 'trusted', perTradeWei: TIER_BOUNDS.trusted.perTradeWei.max })
    const m = proposeMutation(trusted, recordFromPositions(positions), positions)
    expect(m?.rule).toBe('F')
    expect(m?.to).toBe(0.61)
  })

  it('turns on the ladder for a profitable arm whose winners run (Rule H)', () => {
    const positions = repeat(12, (i) => makePosition({ pnlPct: i < 3 ? 120 : i < 8 ? 5 : -10, exitReason: i < 8 ? 'trailing_stop' : 'stop_loss' }))
    const arm = makeArm({ autonomyTier: 'trusted', perTradeWei: TIER_BOUNDS.trusted.perTradeWei.max, dailyBudgetWei: eth(10), trailingStopPct: null })
    const m = proposeMutation(arm, recordFromPositions(positions), positions)
    expect(m?.rule).toBe('H')
    expect(m?.knob).toBe('initialsOutMultiple')
    expect(m?.to).toBe(2)
  })

  it('every proposal stays inside the tier bounds and is deterministic', () => {
    const scenarios = [
      repeat(12, (i) => makePosition({ pnlPct: i < 8 ? 40 : -15, exitReason: i < 8 ? 'take_profit' : 'stop_loss' })),
      repeat(12, (i) => makePosition({ pnlPct: i < 2 ? 10 : -25, exitReason: 'stop_loss', score: 60 })),
      repeat(12, (i) => makePosition({ pnlPct: i < 7 ? 25 : -10, exitReason: i < 7 ? 'timeout' : 'trailing_stop' })),
      repeat(12, (i) => makePosition({ pnlPct: i % 2 ? 60 : -5, exitReason: 'trailing_stop' })),
    ]
    for (const tier of TIER_ORDER) {
      for (const positions of scenarios) {
        const arm = makeArm({ autonomyTier: tier as AutonomyTier, takeProfitPct: 50, minOracleScore: 40 })
        const rec = recordFromPositions(positions)
        const a = proposeMutation(arm, rec, positions)
        const b = proposeMutation(arm, rec, positions)
        expect(canonicalJson(a)).toBe(canonicalJson(b))
        if (!a) continue
        const bounds = boundsFor(tier) as unknown as Record<string, { min: number | bigint; max: number | bigint }>
        const bound = bounds[a.knob]
        expect(bound).toBeDefined()
        expect(a.to >= bound!.min).toBe(true)
        expect(a.to <= bound!.max).toBe(true)
        expect(writableFor(tier).has(a.knob)).toBe(true)
        expect(a.rationale.length).toBeGreaterThan(20)
      }
    }
  })

  it('canonical json is key-sorted and bigint-safe', () => {
    expect(canonicalJson({ b: 1n, a: { z: new Date(0), y: [2n] } })).toBe('{"a":{"y":["2"],"z":"1970-01-01T00:00:00.000Z"},"b":"1"}')
  })
})
