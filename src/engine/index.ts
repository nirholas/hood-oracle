/**
 * The trading loop, assembled. createEngine wires the chain client, the
 * sequencer feed, the log watchers, the observation windows, the arms, the
 * guards, the executor and the position sweep into one EngineApi.
 */
import { type Address, formatEther } from 'viem'
import { eq } from 'drizzle-orm'
import type { Config } from '../config.js'
import type { Db } from '../db/client.js'
import type { Logger } from '../log.js'
import { createChainClient, errorText, probeRpcUrls, withRpcRetry, type ChainClient } from '../chain/client.js'
import { SequencerFeed } from '../chain/feed.js'
import { Prices } from '../chain/prices.js'
import { Watchers, type GraduationEvent } from '../chain/watchers.js'
import { DirectLaunchIntake } from './intake.js'
import { positions } from '../db/schema.js'
import { KillSwitch } from '../guards/kill.js'
import { RiskEngine } from '../guards/risk.js'
import type { Arm, EngineApi, EngineHealth, EventBusApi, ExitReason, FeatureSnapshot, LaunchRecord, ModelStoreApi, OracleVerdict, Trade, Trigger } from '../types.js'
import { Alerts } from './alerts.js'
import { loadArms } from './arms.js'
import { type EngineContext, WINDOW_SECONDS } from './context.js'
import { Executor, rowToPosition } from './executor.js'
import { createAccountExecutor, withAccountRouting } from './account-executor.js'
import { AccountRegistry, type AccountRegistryApi } from '../accounts/registry.js'
import { buildLaunchBrief, evaluateEntry, judgeLaunch, llmVerdictGate, type GateInput } from './gate.js'
import { Journal } from './journal.js'
import { Observer, type ObservationResult } from './observe.js'
import { PositionSweeper } from './positions.js'

export interface CreateEngineOptions {
  config: Config
  db: Db
  log: Logger
  model: ModelStoreApi
  bus: EventBusApi
  chain?: ChainClient
  risk?: RiskEngine
  kill?: KillSwitch
  /** Global buys-per-minute throttle across every arm (default 6). */
  maxBuysPerMinute?: number
  /**
   * The on-chain account registry. Omitted, one is built from
   * `HOOD_ARM_FACTORY` when that is set; pass `null` to run single-tenant
   * even with a factory configured (tests do).
   */
  accounts?: AccountRegistryApi | null
}

/** The engine, plus the account registry it built, which the API serves `/api/accounts` from. */
export type Engine = EngineApi & { accounts: AccountRegistryApi | null }

const ARM_REFRESH_MS = 15_000
const WALLET_REFRESH_MS = 30_000

/** The delay at which an arm wants its entry snapshot: at least one second, at most the window. */
export function effectiveDelayMs(arm: Arm): number {
  if (arm.buyDelayMs >= WINDOW_SECONDS * 1000) return WINDOW_SECONDS * 1000
  return Math.max(1_000, arm.buyDelayMs)
}

export function createEngine(opts: CreateEngineOptions): Engine {
  const { config, db, log, model, bus } = opts
  const chain = opts.chain ?? createChainClient(config)
  const prices = new Prices(chain)
  const journal = new Journal(db, log, bus)
  const alerts = new Alerts(config, log)
  const kill = opts.kill ?? new KillSwitch({ killFile: config.killFile, log, ...(config.globalKill ? { initialKill: 'env:GLOBAL_KILL' } : {}) })
  const risk = opts.risk ?? new RiskEngine()
  let arms: Arm[] = []
  const ctx: EngineContext = { config, db, log, bus, model, chain, prices, journal, alerts, risk, kill, network: config.network, arms: () => arms }
  /**
   * The multi-tenant leg. With a factory configured, arms bound to an on-chain
   * account trade THROUGH that account (the hot key only signs and pays gas),
   * and every other arm keeps the direct path. Without one the engine is
   * single-tenant and nothing here costs anything.
   */
  const accounts = opts.accounts === undefined
    ? config.accounts.factory
      ? new AccountRegistry({
        db,
        log: log.child({ module: 'accounts' }),
        publicClient: chain.publicClient,
        chainId: chain.chainId,
        factory: config.accounts.factory,
        operatorAddress: chain.account?.address ?? null,
        journal,
      })
      : null
    : opts.accounts
  const direct = new Executor(ctx, { maxBuysPerMinute: opts.maxBuysPerMinute ?? 6 })
  const executor = accounts ? withAccountRouting(direct, createAccountExecutor({ ctx, registry: accounts })) : direct
  const startedAt = new Date().toISOString()
  let running = false
  let armTimer: NodeJS.Timeout | null = null
  let walletTimer: NodeJS.Timeout | null = null
  let walletWei: bigint | null = null
  let unsubscribeKill: (() => void) | null = null
  let unsubscribeBus: (() => void) | null = null
  const evaluated = new Set<string>()
  /** Launch intake times per launchpad name, pruned to the trailing hour on read. */
  const intakeLog: { name: string; at: number }[] = []

  const status = (level: 'info' | 'warn' | 'error', source: string, message: string) => {
    bus.emit({ kind: 'status', at: Date.now(), level, source, message })
    log[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info']({ source }, message)
  }

  const watchers = new Watchers(chain, {
    onLaunch: (e) => { observer.onLaunch(e).catch((err) => log.error({ err: errorText(err), token: e.token }, 'launch intake failed')) },
    onCurveTrade: (e) => observer.onCurveTrade(e),
    onSwap: (e) => observer.onSwap(e),
    onV4Swap: (e) => observer.onV4Swap(e),
    onDexPool: (e) => { intake.onDexPool(e).catch((err) => log.error({ err: errorText(err), tx: e.txHash }, 'pool intake failed')) },
    onGraduation: (g) => { onGraduation(g).catch((err) => log.error({ err: errorText(err), token: g.token }, 'graduation handling failed')) },
    onStatus: (level, message) => status(level, 'watchers', message),
  })
  const intake = new DirectLaunchIntake(chain, prices, log, {
    onLaunch: (e) => { observer.onLaunch(e).catch((err) => log.error({ err: errorText(err), token: e.token }, 'direct launch intake failed')) },
    isKnownToken: (token) => observer.isKnownToken(token),
  })
  const feed = config.disableFeed ? null : new SequencerFeed({
    url: config.feedUrl, addresses: chain.addresses, log,
    onSignal: (s) => observer.onPreSignal(s),
    onStatus: (level, message) => status(level, 'feed', message),
  })
  const observer = new Observer(ctx, {
    watchers, feed,
    onResult: (r) => { onObservation(r).catch((err) => log.error({ err: errorText(err), token: r.launch.token }, 'arm evaluation failed')) },
    interimDelaysMs: () => [...new Set(arms.filter((a) => a.enabled && a.trigger === 'new_launch').map(effectiveDelayMs))].filter((d) => d < WINDOW_SECONDS * 1000),
  })
  const sweeper = new PositionSweeper(ctx, { executor, launchOf: (t) => observer.launchOf(t), armById: (id) => arms.find((a) => a.id === id) })

  function launchpadCounts(): Record<string, number> {
    const cutoff = Date.now() - 3_600_000
    while (intakeLog.length && intakeLog[0]!.at < cutoff) intakeLog.shift()
    const out: Record<string, number> = {}
    for (const { name } of intakeLog) out[name] = (out[name] ?? 0) + 1
    return out
  }

  async function refreshArms(): Promise<void> {
    try {
      arms = await loadArms(db, config.network)
    } catch (err) {
      log.error({ err: errorText(err) }, 'arm refresh failed; keeping the cached set')
    }
  }

  async function refreshWallet(): Promise<void> {
    if (!chain.account) return
    try {
      walletWei = await withRpcRetry(() => chain.publicClient.getBalance({ address: chain.account!.address }))
    } catch (err) {
      log.warn({ err: errorText(err) }, 'wallet balance read failed')
    }
  }

  /** Run every matching arm against a fresh snapshot. */
  async function onObservation(r: ObservationResult): Promise<void> {
    if (!running) return
    for (const arm of arms) {
      if (!arm.enabled) continue
      if (arm.trigger === 'new_launch') {
        const want = effectiveDelayMs(arm)
        const matches = r.interim ? r.delayMs === want : want >= WINDOW_SECONDS * 1000 || !evaluated.has(`${arm.id}:${r.launch.token.toLowerCase()}`)
        if (!matches) continue
      } else if (arm.trigger === 'oracle_crossing') {
        if (r.interim) continue
        if (arm.minOracleScore != null && r.verdict.score < arm.minOracleScore) continue
      } else {
        continue
      }
      await evaluateArm(arm, r.launch, arm.trigger, r, 'new_launch')
    }
  }

  async function onGraduation(g: GraduationEvent): Promise<void> {
    await observer.onGraduation(g)
    if (!running || !g.pool) return
    const launch = await observer.launchOf(g.token)
    if (!launch) return
    const verdict = observer.lastVerdict(g.token)
    for (const arm of arms) {
      if (!arm.enabled || arm.trigger !== 'graduation') continue
      await evaluateArm(arm, launch, 'graduation', { snapshot: null, verdict, delayMs: null }, 'graduation')
    }
  }

  async function evaluateArm(arm: Arm, launch: LaunchRecord, trigger: Trigger, r: { snapshot: FeatureSnapshot | null; verdict: OracleVerdict | null; delayMs: number | null }, eventTrigger: Trigger): Promise<void> {
    const key = `${arm.id}:${launch.token.toLowerCase()}:${eventTrigger}`
    if (evaluated.has(key)) return
    evaluated.add(key)
    if (evaluated.size > 20_000) evaluated.delete(evaluated.keys().next().value!)
    let marketCapEth: number | null = null
    if (arm.minMarketCapEth != null || arm.maxMarketCapEth != null) {
      const supply = BigInt(String(launch.metadata.totalSupply ?? '0'))
      const spot = launch.venue === 'pool' && launch.pool ? await prices.poolSpotEth(launch.pool, launch.token, launch.decimals) : await prices.curveSpotEth(launch.token)
      if (spot != null && supply > 0n) marketCapEth = (Number(supply) / 10 ** launch.decimals) * spot
    }
    const input: GateInput = { arm, launch, trigger, snapshot: r.snapshot, verdict: r.verdict, marketCapEth }
    const gate = evaluateEntry(input)
    if (!gate.ok) {
      await journal.append({ armId: arm.id, token: launch.token, kind: 'skip', reason: gate.reason ?? 'entry_filter', detail: { detail: gate.detail, trigger, delayMs: r.delayMs, score: r.verdict?.score ?? null } })
      return
    }
    let gateDetail = gate.detail
    if (arm.decisionMode === 'llm') {
      if (!config.llm) {
        await journal.append({ armId: arm.id, token: launch.token, kind: 'skip', reason: 'llm_declined', detail: { detail: 'arm is in llm mode but no LLM provider is configured', trigger } })
        alerts.warn(`llm-unconfigured:${arm.id}`, `arm ${arm.label} is in llm mode but LLM_PROVIDER / LLM_API_KEY are not set; it will never buy`, arm.telegramChatId)
        return
      }
      try {
        const verdict = await judgeLaunch(config.llm, buildLaunchBrief(input))
        const llmGate = llmVerdictGate(verdict, arm)
        await journal.append({ armId: arm.id, token: launch.token, kind: llmGate.ok ? 'observe' : 'skip', reason: llmGate.ok ? 'llm_buy' : 'llm_declined', detail: { model: verdict.model, buy: verdict.buy, confidence: verdict.confidence, thesis: verdict.thesis } })
        if (!llmGate.ok) return
        gateDetail = `${gate.detail}; ${llmGate.detail}`
      } catch (err) {
        const detail = errorText(err)
        await journal.append({ armId: arm.id, token: launch.token, kind: 'skip', reason: 'llm_declined', detail: { detail: `malformed or failed LLM verdict: ${detail}`, trigger } })
        alerts.warn(`llm-failed:${arm.id}`, `arm ${arm.label}: LLM verdict failed (${detail}); the launch was skipped`, arm.telegramChatId)
        return
      }
    }
    const factory = typeof launch.metadata.factory === 'string' ? (launch.metadata.factory as Address) : null
    const result = await executor.buy({ arm, launch, venue: launch.venue, pool: launch.pool, factory, trigger, snapshot: r.snapshot, verdict: r.verdict, gateDetail })
    if (result.status === 'failed') alerts.error(`buy-failed:${arm.id}`, `arm ${arm.label} buy of ${launch.symbol ?? launch.token} failed: ${result.error}`)
  }

  const api: Engine = {
    accounts,
    async start() {
      if (running) return
      const probes = await probeRpcUrls(chain.rpcUrls)
      for (const p of probes) {
        if (p.ok) log.info({ url: p.url, chainId: p.chainId, ms: p.ms }, 'rpc reachable')
        else log.warn({ url: p.url, error: p.error }, 'rpc unreachable at boot')
      }
      if (!probes.some((p) => p.ok)) throw new Error('no configured RPC answered eth_chainId')
      const wrongChain = probes.find((p) => p.ok && p.chainId != null && p.chainId !== chain.chainId)
      if (wrongChain) throw new Error(`${wrongChain.url} serves chain ${wrongChain.chainId}, expected ${chain.chainId}`)
      await refreshArms()
      await refreshWallet()
      kill.arm()
      unsubscribeKill = kill.onTrip((reason) => {
        bus.emit({ kind: 'kill', at: Date.now(), reason })
        alerts.kill(reason)
        void journal.append({ armId: null, token: null, kind: 'alert', reason: 'kill_switch', detail: { reason } })
      })
      running = true
      unsubscribeBus = bus.subscribe((e) => {
        if (e.kind !== 'launch') return
        intakeLog.push({ name: e.launch.launchpad, at: e.at })
        if (intakeLog.length > 5_000) intakeLog.splice(0, intakeLog.length - 5_000)
      })
      await watchers.start()
      if (feed) await feed.start()
      sweeper.start(2_000)
      armTimer = setInterval(() => { void refreshArms() }, ARM_REFRESH_MS)
      armTimer.unref?.()
      walletTimer = setInterval(() => { void refreshWallet() }, WALLET_REFRESH_MS)
      walletTimer.unref?.()
      const live = arms.filter((a) => a.enabled && a.mode === 'live').length
      alerts.boot({ mode: feed ? 'sequencer + logs' : 'logs only', arms: arms.filter((a) => a.enabled).length, live })
      status('info', 'engine', `started: ${arms.length} arms (${arms.filter((a) => a.enabled).length} enabled, ${live} live), wallet ${chain.account?.address ?? 'none'}${walletWei != null ? ` ${formatEther(walletWei)} ETH` : ''}`)
      if (accounts) {
        accounts.start()
        status('info', 'accounts', `on-chain accounts on: factory ${config.accounts.factory}, operator ${chain.account?.address ?? 'none (no trading key: accounts cannot be operated)'}`)
      }
      const ethUsd = await prices.ethUsd()
      if (ethUsd) log.info({ ethUsd: ethUsd.toFixed(2) }, 'eth/usd from the WETH/USDG pool')
    },

    async stop() {
      running = false
      unsubscribeKill?.()
      unsubscribeKill = null
      unsubscribeBus?.()
      unsubscribeBus = null
      if (armTimer) clearInterval(armTimer)
      if (walletTimer) clearInterval(walletTimer)
      sweeper.stop()
      feed?.stop()
      watchers.stop()
      observer.stop()
      accounts?.stop()
      status('info', 'engine', 'stopped')
    },

    health(): EngineHealth {
      const wh = watchers.health()
      const fh = feed?.health() ?? { connected: false, lastSequence: null, secondsSinceFrame: null }
      const prov = model.provenance()
      return {
        network: config.network,
        chainId: chain.chainId,
        headBlock: wh.headBlock != null ? Number(wh.headBlock) : null,
        feed: { connected: fh.connected, lastSequence: fh.lastSequence, secondsSinceFrame: fh.secondsSinceFrame },
        wallet: { address: chain.account?.address ?? null, ethWei: walletWei, live: Boolean(chain.account) && arms.some((a) => a.enabled && a.mode === 'live') },
        killed: kill.isKilled(),
        killReason: kill.reason(),
        arms: { total: arms.length, enabled: arms.filter((a) => a.enabled).length, live: arms.filter((a) => a.enabled && a.mode === 'live').length },
        positions: { open: sweeper.openCount() },
        model: { version: prov.version, provenance: prov.provenance, trainingRows: prov.trainingRows, fittedAt: prov.fittedAt },
        launchpads: launchpadCounts(),
        startedAt,
      }
    },

    kill(reason: string) {
      kill.trip(reason)
    },

    unkill(): boolean {
      const cleared = kill.clearApiKill()
      if (cleared) status('info', 'engine', 'API kill cleared; buys resume')
      return cleared
    },

    async closePosition(positionId: string, reason: ExitReason): Promise<Trade> {
      const [row] = await db.select().from(positions).where(eq(positions.id, positionId)).limit(1)
      if (!row) throw new Error(`position ${positionId} not found`)
      const position = rowToPosition(row)
      if (position.status === 'closed') throw new Error(`position ${positionId} is already closed`)
      const arm = arms.find((a) => a.id === position.armId)
      if (!arm) throw new Error(`arm ${position.armId} for position ${positionId} is not loaded`)
      const result = await executor.sell({ position, arm, reason, fraction: 1 })
      if (result.status === 'filled') return result.trade
      if (result.status === 'failed') throw new Error(result.error)
      throw new Error(`position ${positionId} could not be sold: ${result.status} (the wallet no longer holds the tokens)`)
    },

    refreshArms,

    lastVerdict(token: Address): OracleVerdict | null {
      return observer.lastVerdict(token)
    },
  }
  return api
}

