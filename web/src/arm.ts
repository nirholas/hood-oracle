/** Arms: list + editor for every Arm knob, arm/disarm/kill, 24h preview, ledger. */
import type { ApiErrorBody, ArmListItem, ArmWire, ArmWriteResponse, FeedItem, FeedResponse, PositionListItem } from '../../src/api/contract'
import type { Launchpad } from '../../src/types'
import { ethToWei, weiToEth, weiToEthString } from '../../src/api/wei'
import { api, errorMessage, write } from './api'
import { $, $$, debounce, h, segmented, setHtml, skeletonRows, stateBlock, switchControl, tierPill, toast } from './dom'
import { ago, fmtEth, fmtSignedEth, fmtSignedPct, symbolOf } from './format'
import { mountShell } from './shell'

const shell = mountShell({ page: 'arm' })

const CATEGORIES = ['meme', 'tech', 'ai', 'culture', 'community', 'political', 'news', 'animal', 'celebrity', 'utility', 'stock', 'unknown'] as const

interface ArmPayload {
  label: string
  mode: 'simulate' | 'live'
  trigger: 'new_launch' | 'graduation' | 'oracle_crossing'
  launchpads: Launchpad[]
  perTradeEth: string
  dailyBudgetEth: string
  maxConcurrentPositions: number
  cooldownSeconds: number
  slippageBps: number
  maxPriceImpactPct: number
  firewallLevel: 'block' | 'warn' | 'off'
  buyDelayMs: number
  minOracleScore: number | null
  maxRugRisk: number | null
  minUniqueBuyers: number | null
  maxCreatorLaunches: number | null
  maxDeployerPct: number | null
  maxBundleScore: number | null
  maxConcentrationTop1: number | null
  minMarketCapEth: number | null
  maxMarketCapEth: number | null
  requireSocials: boolean
  avoidDevDump: boolean
  allowedCategories: string[] | null
  stopLossPct: number
  takeProfitPct: number | null
  trailingStopPct: number | null
  maxHoldSeconds: number
  liquidityDecaySeconds: number | null
  initialsOutMultiple: number | null
  moonbagMinPct: number
  moonbagAlways: boolean
  decisionMode: 'rules' | 'llm'
  llmMinConfidence: number | null
  autoOptimize: boolean
  autonomyTier: 'probation' | 'standard' | 'trusted' | 'autonomous'
  telegramChatId: string | null
  experimentGroup: string | null
}

const DEFAULTS: ArmPayload = {
  label: '',
  mode: 'simulate',
  trigger: 'new_launch',
  launchpads: ['noxa', 'odyssey'],
  perTradeEth: '0.01',
  dailyBudgetEth: '0.1',
  maxConcurrentPositions: 1,
  cooldownSeconds: 0,
  slippageBps: 500,
  maxPriceImpactPct: 10,
  firewallLevel: 'block',
  buyDelayMs: 0,
  minOracleScore: null,
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
  trailingStopPct: null,
  maxHoldSeconds: 1800,
  liquidityDecaySeconds: null,
  initialsOutMultiple: null,
  moonbagMinPct: 15,
  moonbagAlways: false,
  decisionMode: 'rules',
  llmMinConfidence: null,
  autoOptimize: false,
  autonomyTier: 'standard',
  telegramChatId: null,
  experimentGroup: null,
}

/** Every launchpad the intake can record; refreshed from /api/status. */
let knownLaunchpads: Launchpad[] = ['noxa', 'odyssey', 'direct']

const state = {
  arms: [] as ArmListItem[],
  selectedId: null as string | null,
  isNew: false,
  dirty: false,
  saving: false,
  feed: [] as FeedItem[],
  feedAt: null as number | null,
  confirmKill: false,
  confirmDelete: false,
}

// ── controls ──────────────────────────────────────────────────────────────────

const form = $<HTMLFormElement>('#armForm')
const input = (id: string) => $<HTMLInputElement>(id)
const fields = {
  label: input('#fLabel'), perTrade: input('#fPerTrade'), daily: input('#fDaily'), maxConc: input('#fMaxConc'), cooldown: input('#fCooldown'),
  buyDelay: input('#fBuyDelay'), slippage: input('#fSlippage'), impact: input('#fImpact'), minScore: input('#fMinScore'), maxRug: input('#fMaxRug'),
  minBuyers: input('#fMinBuyers'), maxCreator: input('#fMaxCreator'), maxDeployer: input('#fMaxDeployer'), maxBundle: input('#fMaxBundle'),
  maxTop1: input('#fMaxTop1'), minMcap: input('#fMinMcap'), maxMcap: input('#fMaxMcap'), stop: input('#fStop'), tp: input('#fTp'), trail: input('#fTrail'),
  hold: input('#fHold'), decay: input('#fDecay'), initials: input('#fInitials'), moonbag: input('#fMoonbag'), llmConf: input('#fLlmConf'),
  telegram: input('#fTelegram'), group: input('#fGroup'),
}
const modeCtl = segmented($('#modeSeg'), (v) => {
  if (v === 'live') {
    void shell.ensureRiskAck().then((ok) => {
      if (!ok) {
        modeCtl.set('simulate')
        toast('Staying in simulate mode', 'info')
      }
      markDirty()
      renderState()
    })
    return
  }
  markDirty()
  renderState()
})
const triggerCtl = segmented($('#triggerSeg'), () => { markDirty(); renderPreview() })
const fwCtl = segmented($('#fwSeg'), markDirty)
const dmCtl = segmented($('#dmSeg'), markDirty)
const autoCtl = segmented($('#autoSeg'), markDirty)
const swSocials = switchControl($('#swSocials'), () => { markDirty(); renderPreview() })
const swDevDump = switchControl($('#swDevDump'), () => { markDirty(); renderPreview() })
const swMoonbagAlways = switchControl($('#swMoonbagAlways'), markDirty)
const swAutoOpt = switchControl($('#swAutoOpt'), markDirty)

$('#catChips').innerHTML = CATEGORIES.map((c) => `<button type="button" class="cchip" data-v="${c}">${c}</button>`).join('')
function renderLaunchpadChips(pads: Launchpad[]): void {
  const selected = new Set(chipsOn('#lpChips'))
  const fresh = $$<HTMLButtonElement>('.cchip', $('#lpChips')).length === 0
  setHtml($('#lpChips'), h`${pads.map((p) => h`<button type="button" class="cchip ${fresh || selected.has(p) ? 'on' : ''}" data-v="${p}">${p}</button>`)}`)
}
for (const id of ['#catChips', '#lpChips']) {
  $(id).addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.cchip')
    if (!b) return
    b.classList.toggle('on')
    markDirty()
    renderPreview()
  })
}
const chipsOn = (id: string) => $$<HTMLButtonElement>('.cchip.on', $(id)).map((b) => b.dataset.v as string)
const setChips = (id: string, on: readonly string[]) => { for (const b of $$<HTMLButtonElement>('.cchip', $(id))) b.classList.toggle('on', on.includes(b.dataset.v as string)) }
renderLaunchpadChips(knownLaunchpads)

form.addEventListener('input', (e) => {
  markDirty()
  const t = e.target as HTMLInputElement
  if (t === fields.slippage || t === fields.impact || t === fields.minScore || t === fields.maxRug) renderRangeOutputs()
  renderRisk()
  renderPreviewDebounced()
})
form.addEventListener('submit', (e) => { e.preventDefault(); void save() })
$('#saveBtn').addEventListener('click', () => void save())
$('#armBtn').addEventListener('click', () => void toggleArm())
$('#killBtn').addEventListener('click', () => void killArm())
$('#deleteBtn').addEventListener('click', () => void deleteArm())
$('#newArmBtn').addEventListener('click', () => selectNew())
window.addEventListener('beforeunload', (e) => { if (state.dirty) e.preventDefault() })

function renderRangeOutputs(): void {
  $('#oSlippage').textContent = `${(Number(fields.slippage.value) / 100).toFixed(2)}%`
  $('#oImpact').textContent = `${Number(fields.impact.value)}%`
  const ms = Number(fields.minScore.value)
  $('#oMinScore').textContent = ms > 0 ? `≥ ${ms}` : 'off'
  const mr = Number(fields.maxRug.value)
  $('#oMaxRug').textContent = mr < 100 ? `≤ ${mr}%` : 'off'
}

// ── form <-> payload ─────────────────────────────────────────────────────────

const numOrNull = (el: HTMLInputElement): number | null => {
  const v = el.value.trim()
  if (v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const numOr = (el: HTMLInputElement, fallback: number): number => numOrNull(el) ?? fallback
const strOrNull = (el: HTMLInputElement): string | null => el.value.trim() || null

function readForm(): ArmPayload {
  const minScore = Number(fields.minScore.value)
  const maxRug = Number(fields.maxRug.value)
  const cats = chipsOn('#catChips')
  return {
    label: fields.label.value.trim(),
    mode: modeCtl.get() as ArmPayload['mode'],
    trigger: triggerCtl.get() as ArmPayload['trigger'],
    launchpads: chipsOn('#lpChips') as Launchpad[],
    perTradeEth: fields.perTrade.value.trim() || '0',
    dailyBudgetEth: fields.daily.value.trim() || '0',
    maxConcurrentPositions: Math.max(1, Math.round(numOr(fields.maxConc, 1))),
    cooldownSeconds: Math.max(0, Math.round(numOr(fields.cooldown, 0))),
    slippageBps: Math.round(numOr(fields.slippage, 500)),
    maxPriceImpactPct: numOr(fields.impact, 10),
    firewallLevel: fwCtl.get() as ArmPayload['firewallLevel'],
    buyDelayMs: Math.max(0, Math.round(numOr(fields.buyDelay, 0))),
    minOracleScore: minScore > 0 ? minScore : null,
    maxRugRisk: maxRug < 100 ? maxRug / 100 : null,
    minUniqueBuyers: numOrNull(fields.minBuyers),
    maxCreatorLaunches: numOrNull(fields.maxCreator),
    maxDeployerPct: numOrNull(fields.maxDeployer),
    maxBundleScore: numOrNull(fields.maxBundle),
    maxConcentrationTop1: numOrNull(fields.maxTop1) == null ? null : (numOrNull(fields.maxTop1) as number) / 100,
    minMarketCapEth: numOrNull(fields.minMcap),
    maxMarketCapEth: numOrNull(fields.maxMcap),
    requireSocials: swSocials.get(),
    avoidDevDump: swDevDump.get(),
    allowedCategories: cats.length ? cats : null,
    stopLossPct: numOr(fields.stop, 0),
    takeProfitPct: numOrNull(fields.tp),
    trailingStopPct: numOrNull(fields.trail),
    maxHoldSeconds: Math.round(numOr(fields.hold, 1800)),
    liquidityDecaySeconds: numOrNull(fields.decay) == null ? null : Math.round(numOrNull(fields.decay) as number),
    initialsOutMultiple: numOrNull(fields.initials),
    moonbagMinPct: numOr(fields.moonbag, 15),
    moonbagAlways: swMoonbagAlways.get(),
    decisionMode: dmCtl.get() as ArmPayload['decisionMode'],
    llmMinConfidence: numOrNull(fields.llmConf) == null ? null : (numOrNull(fields.llmConf) as number) / 100,
    autoOptimize: swAutoOpt.get(),
    autonomyTier: autoCtl.get() as ArmPayload['autonomyTier'],
    telegramChatId: strOrNull(fields.telegram),
    experimentGroup: strOrNull(fields.group),
  }
}

function fillForm(arm: ArmWire | null): void {
  const p: ArmPayload = arm
    ? {
        ...DEFAULTS,
        label: arm.label,
        mode: arm.mode,
        trigger: arm.trigger,
        launchpads: arm.launchpads,
        perTradeEth: weiToEthString(arm.perTradeWei),
        dailyBudgetEth: weiToEthString(arm.dailyBudgetWei),
        maxConcurrentPositions: arm.maxConcurrentPositions,
        cooldownSeconds: arm.cooldownSeconds,
        slippageBps: arm.slippageBps,
        maxPriceImpactPct: arm.maxPriceImpactPct,
        firewallLevel: arm.firewallLevel,
        buyDelayMs: arm.buyDelayMs,
        minOracleScore: arm.minOracleScore,
        maxRugRisk: arm.maxRugRisk,
        minUniqueBuyers: arm.minUniqueBuyers,
        maxCreatorLaunches: arm.maxCreatorLaunches,
        maxDeployerPct: arm.maxDeployerPct,
        maxBundleScore: arm.maxBundleScore,
        maxConcentrationTop1: arm.maxConcentrationTop1,
        minMarketCapEth: arm.minMarketCapEth,
        maxMarketCapEth: arm.maxMarketCapEth,
        requireSocials: arm.requireSocials,
        avoidDevDump: arm.avoidDevDump,
        allowedCategories: arm.allowedCategories,
        stopLossPct: arm.stopLossPct,
        takeProfitPct: arm.takeProfitPct,
        trailingStopPct: arm.trailingStopPct,
        maxHoldSeconds: arm.maxHoldSeconds,
        liquidityDecaySeconds: arm.liquidityDecaySeconds,
        initialsOutMultiple: arm.initialsOutMultiple,
        moonbagMinPct: arm.moonbagMinPct,
        moonbagAlways: arm.moonbagAlways,
        decisionMode: arm.decisionMode,
        llmMinConfidence: arm.llmMinConfidence,
        autoOptimize: arm.autoOptimize,
        autonomyTier: arm.autonomyTier,
        telegramChatId: arm.telegramChatId,
        experimentGroup: arm.experimentGroup,
      }
    : { ...DEFAULTS, launchpads: knownLaunchpads }
  fields.label.value = p.label
  modeCtl.set(p.mode)
  triggerCtl.set(p.trigger)
  setChips('#lpChips', p.launchpads)
  fields.perTrade.value = p.perTradeEth
  fields.daily.value = p.dailyBudgetEth
  fields.maxConc.value = String(p.maxConcurrentPositions)
  fields.cooldown.value = String(p.cooldownSeconds)
  fields.buyDelay.value = String(p.buyDelayMs)
  fields.slippage.value = String(p.slippageBps)
  fields.impact.value = String(p.maxPriceImpactPct)
  fwCtl.set(p.firewallLevel)
  fields.minScore.value = String(p.minOracleScore ?? 0)
  fields.maxRug.value = String(p.maxRugRisk == null ? 100 : Math.round(p.maxRugRisk * 100))
  fields.minBuyers.value = p.minUniqueBuyers == null ? '' : String(p.minUniqueBuyers)
  fields.maxCreator.value = p.maxCreatorLaunches == null ? '' : String(p.maxCreatorLaunches)
  fields.maxDeployer.value = p.maxDeployerPct == null ? '' : String(p.maxDeployerPct)
  fields.maxBundle.value = p.maxBundleScore == null ? '' : String(p.maxBundleScore)
  fields.maxTop1.value = p.maxConcentrationTop1 == null ? '' : String(Math.round(p.maxConcentrationTop1 * 1000) / 10)
  fields.minMcap.value = p.minMarketCapEth == null ? '' : String(p.minMarketCapEth)
  fields.maxMcap.value = p.maxMarketCapEth == null ? '' : String(p.maxMarketCapEth)
  swSocials.set(p.requireSocials)
  swDevDump.set(p.avoidDevDump)
  setChips('#catChips', p.allowedCategories ?? [])
  fields.stop.value = String(p.stopLossPct)
  fields.tp.value = p.takeProfitPct == null ? '' : String(p.takeProfitPct)
  fields.trail.value = p.trailingStopPct == null ? '' : String(p.trailingStopPct)
  fields.hold.value = String(p.maxHoldSeconds)
  fields.decay.value = p.liquidityDecaySeconds == null ? '' : String(p.liquidityDecaySeconds)
  fields.initials.value = p.initialsOutMultiple == null ? '' : String(p.initialsOutMultiple)
  fields.moonbag.value = String(p.moonbagMinPct)
  swMoonbagAlways.set(p.moonbagAlways)
  dmCtl.set(p.decisionMode)
  fields.llmConf.value = p.llmMinConfidence == null ? '' : String(Math.round(p.llmMinConfidence * 100))
  swAutoOpt.set(p.autoOptimize)
  autoCtl.set(p.autonomyTier)
  fields.telegram.value = p.telegramChatId ?? ''
  fields.group.value = p.experimentGroup ?? ''
  renderRangeOutputs()
  renderRisk()
  state.dirty = false
  $('#saveBtn').classList.remove('dirty')
}

function markDirty(): void {
  if (state.dirty) return
  state.dirty = true
  $('#saveBtn').classList.add('dirty')
  note('')
}

// ── selection / list ─────────────────────────────────────────────────────────

function current(): ArmListItem | null {
  return state.arms.find((a) => a.id === state.selectedId) ?? null
}

async function loadArms(quiet = false): Promise<void> {
  const list = $('#armList')
  if (!quiet) setHtml(list, skeletonRows(3, [60, 20]))
  const r = await api<{ arms: ArmListItem[] }>('/api/arms')
  list.setAttribute('aria-busy', 'false')
  if (!r.ok || !r.data) {
    stateBlock(list, { kind: 'error', compact: true, title: 'Could not load arms', body: errorMessage(r), action: { label: 'Retry', onClick: () => void loadArms() } })
    return
  }
  state.arms = r.data.arms
  renderList()
  if (!quiet) {
    const params = new URLSearchParams(location.search)
    const wanted = params.get('id')
    if (params.get('new') === '1' || (!state.arms.length && !wanted)) selectNew(false)
    else selectArm(wanted && state.arms.some((a) => a.id === wanted) ? wanted : state.arms[0]?.id ?? null, false)
  } else {
    renderState()
  }
}

function renderList(): void {
  const list = $('#armList')
  $('#armCount').textContent = state.arms.length ? String(state.arms.length) : ''
  const empty = $('#armEmpty')
  if (!state.arms.length) {
    empty.classList.remove('hidden')
    setHtml(empty, h`<div class="card"><div class="state"><b>Create your first arm</b>An arm is a strategy with guardrails: sizing, entry filters, an exit ladder. Start in simulate mode; every play gets journaled and graded so you can trust it before going live.<div><button type="button" class="btn sm primary" id="emptyNew">New arm</button></div></div></div>`)
    $('#emptyNew').addEventListener('click', () => selectNew())
    stateBlock(list, { compact: true, title: 'No arms yet', body: 'Nothing is watching the tape.' })
    return
  }
  empty.classList.add('hidden')
  setHtml(list, h`${state.arms.map((a) => {
    const dot = a.killSwitch ? 'kill' : a.enabled ? (a.mode === 'live' ? 'live' : 'sim') : ''
    return h`<button type="button" class="arm-card ${a.id === state.selectedId ? 'on' : ''}" data-id="${a.id}">
      <div class="ac-top"><span class="arm-dot ${dot}"></span><b>${a.label}</b><span class="badge ${a.mode === 'live' ? 'b-live' : 'b-sim'}">${a.mode}</span></div>
      <div class="ac-sub"><span>${a.enabled ? 'armed' : a.killSwitch ? 'killed' : 'disarmed'}</span><span>${fmtEth(a.perTradeWei)} / trade</span><span>${a.summary.open} open</span><span class="${BigInt(a.summary.realizedPnlWei) >= 0n ? 'up' : 'dn'}">${fmtSignedEth(a.summary.realizedPnlWei)}</span></div>
    </button>`
  })}`)
  for (const b of $$<HTMLButtonElement>('.arm-card', list)) b.addEventListener('click', () => selectArm(b.dataset.id as string))
}

function confirmDiscard(): boolean {
  if (!state.dirty) return true
  return window.confirm('Discard unsaved changes to this arm?')
}

function selectArm(id: string | null, sync = true): void {
  if (sync && !confirmDiscard()) return
  state.selectedId = id
  state.isNew = false
  const arm = current()
  fillForm(arm)
  if (sync) history.replaceState(null, '', id ? `/app/arm?id=${id}` : '/app/arm')
  renderList()
  renderState()
  void loadLedger()
  renderPreview()
}

function selectNew(sync = true): void {
  if (sync && !confirmDiscard()) return
  state.selectedId = null
  state.isNew = true
  fillForm(null)
  if (sync) history.replaceState(null, '', '/app/arm?new=1')
  renderList()
  renderState()
  setHtml($('#ledgerBody'), h`<div class="state compact">Save the arm to start its ledger.</div>`)
  renderPreview()
  fields.label.focus()
}

// ── side panel ───────────────────────────────────────────────────────────────

function note(text: string, kind: 'ok' | 'warn' | 'bad' | '' = ''): void {
  const el = $('#saveNote')
  el.className = `note ${kind}`
  el.textContent = text
}

function showProblems(err: ApiErrorBody | null): void {
  const el = $('#problems')
  const problems = (err?.detail?.problems as { code: string; message: string }[] | undefined) ?? []
  el.classList.toggle('hidden', !problems.length)
  setHtml(el, h`${problems.map((p) => h`<li>${p.message}</li>`)}`)
}

function renderState(): void {
  const arm = current()
  const dot = $('#armDot')
  const lab = $('#armLab')
  const sub = $('#armSub')
  const armBtn = $<HTMLButtonElement>('#armBtn')
  const killBtn = $<HTMLButtonElement>('#killBtn')
  const delBtn = $<HTMLButtonElement>('#deleteBtn')
  const mode = modeCtl.get()
  const health = shell.status?.engine
  if (state.isNew) {
    dot.className = 'arm-dot'
    setHtml(lab, h`New arm <span class="badge ${mode === 'live' ? 'b-live' : 'b-sim'}">${mode}</span>`)
    sub.textContent = 'Not saved yet. Save, then arm it.'
    armBtn.textContent = 'Save and arm'
    armBtn.className = 'btn arm'
    killBtn.disabled = true
    delBtn.disabled = true
  } else if (arm) {
    dot.className = 'arm-dot ' + (arm.killSwitch ? 'kill' : arm.enabled ? (arm.mode === 'live' ? 'live' : 'sim') : '')
    setHtml(lab, h`${arm.label} <span class="badge ${arm.mode === 'live' ? 'b-live' : 'b-sim'}">${arm.mode}</span>${arm.enabled ? h`<span class="badge b-on">armed</span>` : ''}${arm.killSwitch ? h`<span class="badge b-kill">killed</span>` : ''}`)
    sub.textContent = arm.killSwitch
      ? 'Kill switch tripped. Arming again clears it.'
      : arm.enabled
        ? arm.mode === 'live'
          ? 'Spending real ETH from the server wallet when a launch clears every filter, inside the caps.'
          : 'Logging every play it would take. Outcomes are graded so you can trust it before going live.'
        : 'Idle. Arm it to start watching the tape.'
    armBtn.textContent = arm.enabled ? 'Disarm' : state.dirty ? 'Save and arm' : 'Arm'
    armBtn.className = 'btn ' + (arm.enabled ? '' : mode === 'live' ? 'live' : 'arm')
    killBtn.disabled = false
    delBtn.disabled = false
  } else {
    dot.className = 'arm-dot'
    lab.textContent = 'No arm selected'
    sub.textContent = 'Pick an arm on the left or create one.'
    armBtn.disabled = true
    killBtn.disabled = true
    delBtn.disabled = true
    return
  }
  armBtn.disabled = state.saving
  const s = arm?.summary
  $('#msOpen').textContent = String(s?.open ?? 0)
  $('#msClosed').textContent = String(s?.closed ?? 0)
  $('#msWins').textContent = String(s?.wins ?? 0)
  const pnl = $('#msPnl')
  pnl.textContent = s ? fmtSignedEth(s.realizedPnlWei) : '0'
  pnl.className = s && BigInt(s.realizedPnlWei) < 0n ? 'dn' : s && BigInt(s.realizedPnlWei) > 0n ? 'up' : ''
  if (mode === 'live' && health && !health.wallet.live) {
    note(health.wallet.address ? 'The server wallet is not live (below MIN_WALLET_ETH or no key). Live arming will be refused until it is funded.' : 'No TRADER_PRIVATE_KEY on the server: live arming will be refused. Simulate works.', 'warn')
  }
}

function renderRisk(): void {
  const el = $('#riskSummary')
  const per = Number(fields.perTrade.value) || 0
  const daily = Number(fields.daily.value) || 0
  const open = Math.max(1, Number(fields.maxConc.value) || 1)
  const stop = Number(fields.stop.value) || 0
  if (!(per > 0 && daily > 0)) {
    el.textContent = 'Set a per-trade size and daily budget to see the exposure.'
    return
  }
  const trades = Math.floor(daily / per)
  const parts = [
    `≈ <b>${trades}</b> ${trades === 1 ? 'buy' : 'buys'}/day max`,
    `up to <b>${daily} ETH</b> deployed`,
    `<b>${open}</b> open at once`,
    stop > 0 ? `worst case <b>-${((per * open * stop) / 100).toFixed(4)} ETH</b> across open positions at the stop` : `<b style="color:var(--amber)">no stop loss: arming will be refused</b>`,
  ]
  if (daily < per) parts.push('<b style="color:var(--amber)">daily budget below one trade</b>')
  const w = shell.status?.engine.wallet
  if (w?.ethWei != null && modeCtl.get() === 'live') {
    const bal = weiToEth(w.ethWei)
    if (bal < per) parts.push(`<b style="color:var(--amber)">wallet holds ${bal.toFixed(4)} ETH, below one trade</b>`)
    else parts.push(`wallet covers ≈ ${Math.floor(bal / per)} trades`)
  }
  el.innerHTML = parts.join(' · ')
}

// ── actions ──────────────────────────────────────────────────────────────────

function validate(p: ArmPayload): string | null {
  if (!p.label) return 'Give the arm a label.'
  let per: bigint
  let daily: bigint
  try {
    per = ethToWei(p.perTradeEth)
    daily = ethToWei(p.dailyBudgetEth)
  } catch {
    return 'Per-trade size and daily budget must be ETH amounts.'
  }
  if (per <= 0n) return 'Per-trade size must be above 0 ETH.'
  if (daily < per) return 'The daily budget must cover at least one trade.'
  if (!p.launchpads.length) return 'Pick at least one launchpad.'
  if (p.minMarketCapEth != null && p.maxMarketCapEth != null && p.minMarketCapEth > p.maxMarketCapEth) return 'Market cap minimum is above the maximum.'
  return null
}

async function save(): Promise<ArmWire | null> {
  if (state.saving) return null
  if (!state.isNew && !current()) return null
  const payload = readForm()
  const problem = validate(payload)
  if (problem) {
    note(problem, 'warn')
    return null
  }
  state.saving = true
  const btn = $<HTMLButtonElement>('#saveBtn')
  btn.disabled = true
  btn.textContent = 'Saving…'
  const r = state.isNew
    ? await write<ArmWriteResponse>('/api/arms', payload)
    : await write<ArmWriteResponse>(`/api/arms/${state.selectedId}`, payload, 'PATCH')
  state.saving = false
  btn.disabled = false
  btn.textContent = 'Save'
  if (!r.ok || !r.data) {
    note(errorMessage(r, 'Could not save.'), 'bad')
    showProblems(r.error)
    renderState()
    return null
  }
  showProblems(null)
  const arm = r.data.arm
  state.dirty = false
  btn.classList.remove('dirty')
  state.isNew = false
  state.selectedId = arm.id
  history.replaceState(null, '', `/app/arm?id=${arm.id}`)
  await loadArms(true)
  fillForm(current() ?? arm)
  const clamped = r.data.clamped ?? []
  const refused = r.data.refused ?? []
  if (refused.length) {
    note(`Saved ${arm.label}, but ${refused.length} knob${refused.length === 1 ? ' was' : 's were'} refused: ${refused.map((x) => x.reason).join(' ')}`, 'warn')
  } else if (clamped.length) {
    note(`Saved ${arm.label}. Pulled inside the ${arm.autonomyTier} tier's bounds: ${clamped.map(describeClamp).join(', ')}.`, 'warn')
  } else {
    note(`Saved ${arm.label}.`, 'ok')
  }
  void loadLedger()
  return arm
}

function describeClamp(x: ArmWriteResponse['clamped'][number]): string {
  const fmt = (v: string | number | null) => (v == null ? 'unset' : x.knob.endsWith('Wei') ? fmtEth(String(v)) : String(v))
  return `${x.knob} ${fmt(x.from)} to ${fmt(x.to)}`
}

async function toggleArm(): Promise<void> {
  const arm = current()
  if (arm?.enabled) {
    const r = await write<{ arm: ArmWire }>(`/api/arms/${arm.id}/disarm`)
    if (!r.ok) return note(errorMessage(r), 'bad')
    await loadArms(true)
    fillForm(current())
    note(`${arm.label} disarmed.`, 'ok')
    return
  }
  let target = arm
  if (state.isNew || state.dirty) {
    const saved = await save()
    if (!saved) return
    target = current()
  }
  if (!target) return
  if (target.mode === 'live' && !(await shell.ensureRiskAck())) return note('Live arming cancelled.', 'warn')
  const r = await write<{ arm: ArmWire }>(`/api/arms/${target.id}/arm`)
  if (!r.ok) {
    note(errorMessage(r, 'Could not arm.'), 'bad')
    showProblems(r.error)
    return
  }
  showProblems(null)
  await loadArms(true)
  fillForm(current())
  note(`${target.label} armed in ${r.data?.arm.mode} mode.`, 'ok')
  toast(`Armed: ${target.label}`, 'ok')
}

async function killArm(): Promise<void> {
  const arm = current()
  if (!arm) return
  const btn = $<HTMLButtonElement>('#killBtn')
  if (!state.confirmKill) {
    state.confirmKill = true
    btn.textContent = 'Confirm kill'
    setTimeout(() => { state.confirmKill = false; btn.textContent = 'Kill' }, 4000)
    return
  }
  state.confirmKill = false
  btn.textContent = 'Kill'
  const r = await write<{ arm: ArmWire }>(`/api/arms/${arm.id}/kill`)
  if (!r.ok) return note(errorMessage(r), 'bad')
  await loadArms(true)
  fillForm(current())
  note(`${arm.label} killed: no new buys, exits keep managing.`, 'warn')
}

async function deleteArm(): Promise<void> {
  const arm = current()
  if (!arm) return
  const btn = $<HTMLButtonElement>('#deleteBtn')
  if (!state.confirmDelete) {
    state.confirmDelete = true
    btn.textContent = 'Confirm delete'
    setTimeout(() => { state.confirmDelete = false; btn.textContent = 'Delete' }, 4000)
    return
  }
  state.confirmDelete = false
  btn.textContent = 'Delete'
  if (arm.summary.open > 0) return note('Close its open positions before deleting this arm.', 'warn')
  const r = await write<{ ok: boolean }>(`/api/arms/${arm.id}`, undefined, 'DELETE')
  if (!r.ok) return note(errorMessage(r), 'bad')
  toast(`Deleted ${arm.label}`, 'info')
  state.dirty = false
  await loadArms(true)
  if (state.arms.length) selectArm(state.arms[0].id)
  else selectNew(false)
}

// ── 24h preview ──────────────────────────────────────────────────────────────

async function loadFeed(): Promise<void> {
  const r = await api<FeedResponse>('/api/oracle/feed?since=24h&limit=500')
  if (r.ok && r.data) {
    state.feed = r.data.items
    state.feedAt = Date.now()
  } else if (!state.feedAt) {
    $('#qualCount').textContent = 'Preview unavailable'
    setHtml($('#qualBody'), h`<div class="state compact">${errorMessage(r)}</div>`)
    return
  }
  renderPreview()
}

const renderPreviewDebounced = debounce(renderPreview, 150)

function socials(meta: Record<string, unknown>): boolean {
  return Boolean(meta.website || meta.twitter || meta.telegram)
}

function matches(item: FeedItem, p: ArmPayload): boolean {
  const f = item.features
  const s = item.score
  if (!p.launchpads.includes(item.launchpad)) return false
  if (p.trigger === 'graduation' && !item.graduatedAt) return false
  if (p.minOracleScore != null && s.score < p.minOracleScore) return false
  if (p.maxRugRisk != null && s.rugRisk > p.maxRugRisk) return false
  const need = (v: number | null | undefined, ok: (n: number) => boolean) => v != null && ok(v)
  if (p.minUniqueBuyers != null && !need(f?.unique_buyers, (n) => n >= (p.minUniqueBuyers as number))) return false
  if (p.maxCreatorLaunches != null && !need(f?.creator_launches, (n) => n <= (p.maxCreatorLaunches as number))) return false
  if (p.maxDeployerPct != null && !need(f?.deployer_holding_pct, (n) => n * 100 <= (p.maxDeployerPct as number))) return false
  if (p.maxBundleScore != null && !need(f?.bundle_score, (n) => n <= (p.maxBundleScore as number))) return false
  if (p.maxConcentrationTop1 != null && !need(f?.concentration_top1, (n) => n <= (p.maxConcentrationTop1 as number))) return false
  if (p.minMarketCapEth != null && !need(f?.mc_eth_first_seen, (n) => n >= (p.minMarketCapEth as number))) return false
  if (p.maxMarketCapEth != null && !need(f?.mc_eth_first_seen, (n) => n <= (p.maxMarketCapEth as number))) return false
  if (p.requireSocials && !socials(item.metadata)) return false
  if (p.avoidDevDump && f?.dev_sold === true) return false
  if (p.allowedCategories && !p.allowedCategories.includes(f?.category ?? 'unknown')) return false
  return true
}

function renderPreview(): void {
  if (!state.feedAt) return
  const p = readForm()
  const per = Number(p.perTradeEth) || 0
  const daily = Number(p.dailyBudgetEth) || 0
  const hits = state.feed.filter((it) => matches(it, p)).sort((a, b) => b.score.score - a.score.score)
  const countEl = $('#qualCount')
  const metaEl = $('#qualMeta')
  const body = $('#qualBody')
  metaEl.textContent = `${state.feed.length} scored / 24h`
  if (!state.feed.length) {
    countEl.textContent = 'No launches scored in the last 24h'
    setHtml(body, h`<div class="state compact">The preview fills in as launches get scored. Nothing has been scored on 4663 in the last day.</div>`)
    return
  }
  if (!hits.length) {
    countEl.textContent = 'Nothing would have cleared these filters'
    setHtml(body, h`<div class="state compact">No launch in the last 24h meets every filter. Normal for a tight bar. Loosen the score floor, rug ceiling, or narratives to see more flow, or keep it strict and let the arm wait.</div>`)
    return
  }
  const deployed = Math.min(hits.length * per, daily)
  const capped = hits.length * per > daily && daily > 0
  countEl.textContent = `${hits.length} would have been bought`
  setHtml(body, h`<div class="risk" style="margin:0 0 10px">≈ <b>${deployed.toFixed(4)} ETH</b> deployed${capped ? h` (daily budget caps ${hits.length} × ${per} ETH)` : ''}${p.maxConcurrentPositions < hits.length ? h` · concurrency cap <b>${p.maxConcurrentPositions}</b> would queue the rest` : ''}</div>${hits.slice(0, 8).map((it) => h`<div class="qrow">
    <div><div class="q-sym"><a href="/app/coin/${it.token}">${symbolOf(it)}</a>${tierPill(it.score.tier)}<span class="badge b-${it.launchpad}">${it.launchpad}</span></div>
      <div class="q-sub"><span>${it.features?.category ?? 'unknown'}</span><span>rug ${Math.round(it.score.rugRisk * 100)}%</span><span>${it.features?.unique_buyers ?? 'n/a'} buyers</span><span>${ago(it.score.scoredAt)} ago</span></div></div>
    <div class="q-score ${it.score.score >= 70 ? 'hi' : ''}">${Math.round(it.score.score)}</div>
    <div class="q-size"><span>would buy</span>${per} ETH</div>
  </div>`)}${hits.length > 8 ? h`<div class="field-hint" style="text-align:center">and ${hits.length - 8} more</div>` : ''}`)
}

// ── ledger ───────────────────────────────────────────────────────────────────

async function loadLedger(): Promise<void> {
  const body = $('#ledgerBody')
  const id = state.selectedId
  if (!id) return
  $<HTMLAnchorElement>('#ledgerLink').href = `/app/positions?arm=${id}`
  setHtml(body, skeletonRows(3, [50, 16, 16, 10]))
  const r = await api<{ positions: PositionListItem[] }>(`/api/positions?arm=${id}&limit=12`)
  if (state.selectedId !== id) return
  if (!r.ok || !r.data) return stateBlock(body, { kind: 'error', compact: true, title: 'Ledger unavailable', body: errorMessage(r) })
  const rows = r.data.positions
  if (!rows.length) return stateBlock(body, { compact: true, title: 'No plays yet', body: 'Once armed, every buy lands here and gets graded against the outcome in real time.' })
  setHtml(body, h`<div class="tape"><div class="tape-list">${rows.map((p) => {
    const pct = p.status === 'open' ? unrealized(p) : p.realizedPnlPct
    const cls = pct == null ? '' : pct >= 0 ? 'up' : 'dn'
    return h`<a class="trow ledgerrow" href="/app/coin/${p.token}">
      <div class="sym"><span>${symbolOf(p)}</span><span class="badge ${p.mode === 'live' ? 'b-live' : 'b-sim'}">${p.mode}</span><span class="badge ${p.status === 'open' ? 'b-on' : 'b-off'}">${p.status === 'open' ? 'open' : p.exitReason ?? 'closed'}</span></div>
      <div class="num">${fmtEth(p.entryWei, '')}<small>entry Ξ</small></div>
      <div class="num ${cls}">${fmtSignedPct(pct)}<small>pnl</small></div>
      <div class="when">${ago(p.openedAt)}</div>
    </a>`
  })}</div></div>`)
}

function unrealized(p: PositionListItem): number | null {
  if (p.lastValueWei == null) return null
  const entry = BigInt(p.entryWei)
  if (entry === 0n) return null
  return Number(((BigInt(p.lastValueWei) - entry) * 10_000n) / entry) / 100
}

// ── live ─────────────────────────────────────────────────────────────────────

shell.on('position', (e) => {
  if (e.kind === 'position' && e.position.armId === state.selectedId) {
    void loadLedger()
    void loadArms(true)
  }
})
shell.on('score', debounce(() => void loadFeed(), 3_000))
shell.on('kill', () => void loadArms(true))
shell.onStatus((st) => {
  if (st.launchpads.length && st.launchpads.join() !== knownLaunchpads.join()) {
    knownLaunchpads = st.launchpads
    const arm = current()
    renderLaunchpadChips(knownLaunchpads)
    setChips('#lpChips', state.isNew && !state.dirty ? knownLaunchpads : arm ? arm.launchpads : chipsOn('#lpChips'))
  }
  renderRisk()
  renderState()
})

void loadArms()
void loadFeed()
setInterval(() => { if (!document.hidden) void loadFeed() }, 30_000)
