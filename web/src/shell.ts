/**
 * Page chrome shared by every dashboard page: brand + nav, the health strip
 * (feed, head block, wallet, kill state, model source), the operator key
 * dialog, the live-mode risk acknowledgement, keyboard shortcuts, one SSE
 * connection per page that pages subscribe to by event kind.
 */
import type { EngineEventWire, StatusResponse } from '../../src/api/contract'
import { api, getToken, onTokenChange, setToken, setTokenPrompt } from './api'
import { $, $$, h, maybe, setHtml, toast } from './dom'
import { fmtEth, shortAddr } from './format'
import { openStream, type EventKind, type StreamHandle } from './sse'

export type PageId = 'oracle' | 'arm' | 'positions' | 'coin' | 'connect'

const RISK_ACK_KEY = 'hood-oracle:risk-ack'
const RISK_ACK_VERSION = 'v1'
const STATUS_POLL_MS = 10_000

export interface Shell {
  readonly status: StatusResponse | null
  readonly streamConnected: boolean
  onStatus(fn: (s: StatusResponse) => void): () => void
  on(kind: EventKind, fn: (e: EngineEventWire) => void): () => void
  onAny(fn: (e: EngineEventWire) => void): () => void
  onStreamState(fn: (connected: boolean) => void): () => void
  refreshStatus(): Promise<StatusResponse | null>
  ensureRiskAck(): Promise<boolean>
  requestToken(reason: string): Promise<boolean>
  hasToken(): boolean
  explorerUrl(kind: 'address' | 'tx' | 'token', value: string): string
}

export function mountShell(opts: { page: PageId; filterSelector?: string }): Shell {
  const header = $('#top')
  setHtml(
    header,
    h`<div class="top-in">
      <a class="brand" href="/" aria-label="hood-oracle home" title="hood-oracle: the site"><i></i>hood-oracle <span class="chain" id="chainBadge">4663</span></a>
      <nav class="nav" aria-label="Sections">
        <a href="/app" class="${opts.page === 'oracle' ? 'on' : ''}">Oracle</a>
        <a href="/app/arm" class="${opts.page === 'arm' ? 'on' : ''}">Arms</a>
        <a href="/app/positions" class="${opts.page === 'positions' ? 'on' : ''}">Positions</a>
        <a href="/app/connect" class="${opts.page === 'connect' ? 'on' : ''}">Accounts</a>
        <a href="/docs" class="nav-docs">Docs</a>
      </nav>
      <div class="top-right">
        <div class="hs" id="healthStrip" aria-live="polite">
          <span class="hs-item" id="hsFeed"><span class="dot" id="hsFeedDot"></span>feed</span>
          <span class="hs-item" id="hsBlock">head <b>…</b></span>
          <span class="hs-item" id="hsWallet">wallet <b>…</b></span>
          <span class="hs-item hidden" id="hsKill"><span class="dot bad"></span><b>KILLED</b></span>
          <span class="hs-item hidden" id="hsIntake">intake 1h <b>…</b></span>
          <span class="hs-item hidden" id="hsModel">model <b>…</b></span>
        </div>
        <button type="button" class="btn xs" id="keyBtn" title="Operator token (stored in this browser only)">key: <b id="keyState">unset</b></button>
      </div>
    </div>`,
  )
  mountDialogs()

  let status: StatusResponse | null = null
  const statusListeners = new Set<(s: StatusResponse) => void>()
  const kindListeners = new Map<EventKind, Set<(e: EngineEventWire) => void>>()
  const anyListeners = new Set<(e: EngineEventWire) => void>()
  const stateListeners = new Set<(c: boolean) => void>()
  let stream: StreamHandle | null = null

  const keyState = $('#keyState')
  const renderKey = (token: string | null) => {
    keyState.textContent = token ? 'set' : 'unset'
  }
  renderKey(getToken())
  onTokenChange(renderKey)
  $('#keyBtn').addEventListener('click', () => void promptForToken('Paste the OPERATOR_TOKEN configured on the server. It stays in this browser (localStorage) and is only sent as a bearer header on writes.'))

  async function refreshStatus(): Promise<StatusResponse | null> {
    const r = await api<StatusResponse>('/api/status', { timeout: 8_000 })
    if (r.ok && r.data) {
      status = r.data
      renderHealth(status, stream?.connected ?? false)
      for (const fn of statusListeners) fn(status)
    } else {
      renderUnreachable(r.error?.message ?? 'unreachable')
    }
    return status
  }

  stream = openStream('/api/stream', {
    onEvent(e) {
      const set = kindListeners.get(e.kind as EventKind)
      if (set) for (const fn of set) fn(e)
      for (const fn of anyListeners) fn(e)
      if (e.kind === 'kill') {
        toast(`Kill switch: ${e.reason}`, 'bad', 8_000, 'kill')
        void refreshStatus()
      }
      // Keyed by source: a watcher retrying against a throttled RPC updates one
      // toast instead of burying the page under a dozen identical ones.
      if (e.kind === 'status' && e.level === 'error') toast(`${e.source}: ${e.message}`, 'bad', 6_000, `status:${e.source}`)
    },
    onState(connected) {
      $('#hsFeedDot').className = 'dot ' + (connected ? (status?.engine.feed.connected ? 'live' : 'warn') : 'off')
      if (status) renderHealth(status, connected)
      for (const fn of stateListeners) fn(connected)
    },
  })

  void refreshStatus()
  let poll = window.setInterval(() => void refreshStatus(), STATUS_POLL_MS)
  document.addEventListener('visibilitychange', () => {
    clearInterval(poll)
    if (!document.hidden) {
      void refreshStatus()
      poll = window.setInterval(() => void refreshStatus(), STATUS_POLL_MS)
    }
  })

  document.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement | null
    const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)
    if (e.key === 'Escape') {
      for (const d of $$<HTMLDialogElement>('dialog[open]')) d.close('cancel')
      if (typing && target) target.blur()
      return
    }
    if (e.key === '/' && !typing && opts.filterSelector) {
      const el = maybe<HTMLInputElement>(opts.filterSelector)
      if (el) {
        e.preventDefault()
        el.focus()
        el.select()
      }
    }
  })

  const shell: Shell = {
    get status() {
      return status
    },
    get streamConnected() {
      return stream?.connected ?? false
    },
    onStatus(fn) {
      statusListeners.add(fn)
      if (status) fn(status)
      return () => statusListeners.delete(fn)
    },
    on(kind, fn) {
      if (!kindListeners.has(kind)) kindListeners.set(kind, new Set())
      kindListeners.get(kind)!.add(fn)
      return () => kindListeners.get(kind)?.delete(fn)
    },
    onAny(fn) {
      anyListeners.add(fn)
      return () => anyListeners.delete(fn)
    },
    onStreamState(fn) {
      stateListeners.add(fn)
      fn(stream?.connected ?? false)
      return () => stateListeners.delete(fn)
    },
    refreshStatus,
    ensureRiskAck,
    requestToken: promptForToken,
    hasToken: () => Boolean(getToken()),
    explorerUrl(kind, value) {
      const base = status?.explorerUrl ?? 'https://robinhoodchain.blockscout.com'
      return `${base}/${kind === 'tx' ? 'tx' : kind === 'token' ? 'token' : 'address'}/${value}`
    },
  }
  return shell
}

function renderHealth(s: StatusResponse, streamConnected: boolean): void {
  const e = s.engine
  $('#chainBadge').textContent = String(s.chainId)
  const feed = $('#hsFeed')
  const feedDot = $('#hsFeedDot')
  feedDot.className = 'dot ' + (!streamConnected ? 'off' : e.feed.connected ? 'live' : 'warn')
  const since = e.feed.secondsSinceFrame
  feed.title = !streamConnected
    ? 'Dashboard stream disconnected; reconnecting'
    : e.feed.connected
      ? `Sequencer feed connected${since != null ? `, last frame ${since}s ago` : ''}`
      : 'Sequencer feed not connected (log polling only)'
  feed.innerHTML = `<span class="dot ${feedDot.className.replace('dot ', '')}" id="hsFeedDot"></span>feed${
    e.feed.connected && since != null ? ` <b>${since}s</b>` : e.feed.connected ? '' : ' <b>off</b>'
  }`
  $('#hsBlock').innerHTML = `head <b>${e.headBlock != null ? '#' + e.headBlock.toLocaleString() : 'n/a'}</b>`
  const w = $('#hsWallet')
  w.classList.toggle('live', e.wallet.live)
  w.title = e.wallet.address ? `${e.wallet.address} (${e.wallet.live ? 'live signing enabled' : 'not live: below MIN_WALLET_ETH or no live arm'})` : 'No TRADER_PRIVATE_KEY on the server: simulate only'
  w.innerHTML = e.wallet.address
    ? `${shortAddr(e.wallet.address, 4, 4)} <b>${fmtEth(e.wallet.ethWei, '')} ETH</b>${e.wallet.live ? ' <span class="badge b-live">live</span>' : ''}`
    : `wallet <b>none</b>`
  const kill = $('#hsKill')
  kill.classList.toggle('hidden', !e.killed)
  kill.classList.toggle('alert', e.killed)
  kill.title = e.killReason ?? ''
  const intake = $('#hsIntake')
  const pads = Object.entries(e.launchpads ?? {}).sort((a, b) => b[1] - a[1])
  const intakeTotal = pads.reduce((n, [, v]) => n + v, 0)
  intake.classList.toggle('hidden', !e.launchpads)
  intake.title = pads.length ? pads.map(([k, v]) => `${k}: ${v}`).join(', ') : 'No launches taken in during the last hour'
  intake.innerHTML = `intake 1h <b>${intakeTotal}</b>${pads.length ? ` <span class="faint">${pads.slice(0, 3).map(([k, v]) => `${k} ${v}`).join(' · ')}${pads.length > 3 ? ' · …' : ''}</span>` : ''}`
  const model = $('#hsModel')
  model.classList.remove('hidden')
  model.classList.toggle('live', s.model.source === 'bootstrap')
  model.title = `${s.model.provenance} (v${s.model.version}, ${s.model.trainingRows.toLocaleString()} rows)`
  model.innerHTML = `model <b>${s.model.source === 'bootstrap' ? 'bootstrap prior' : 'v' + s.model.version}</b>`
}

function renderUnreachable(message: string): void {
  $('#hsFeedDot').className = 'dot off'
  $('#hsBlock').innerHTML = 'api <b>down</b>'
  $('#hsBlock').title = message
}

// ── dialogs ──────────────────────────────────────────────────────────────────

function mountDialogs(): void {
  if (maybe('#keyDialog')) return
  document.body.insertAdjacentHTML(
    'beforeend',
    `<dialog id="keyDialog" aria-labelledby="keyTitle">
      <form method="dialog">
        <h3 id="keyTitle">Operator token</h3>
        <p id="keyReason"></p>
        <div class="field"><label for="keyInput">OPERATOR_TOKEN</label><input id="keyInput" type="password" autocomplete="off" spellcheck="false" placeholder="paste the server token"></div>
        <div class="btn-row">
          <button type="button" class="btn sm ghost" id="keyClear">Forget stored key</button>
          <button type="button" class="btn sm" value="cancel" id="keyCancel">Cancel</button>
          <button type="submit" class="btn sm primary" id="keySave">Save</button>
        </div>
      </form>
    </dialog>
    <dialog id="riskDialog" aria-labelledby="riskTitle">
      <form method="dialog">
        <h3 id="riskTitle">Live mode spends real ETH</h3>
        <p>A live arm signs real swaps from the server wallet on Robinhood Chain the moment a launch clears its filters. Before you continue:</p>
        <ul>
          <li>Launch tokens can go to zero in seconds. Losses can be total and irreversible.</li>
          <li>The engine trades autonomously inside the caps you set and will not ask again per trade.</li>
          <li>The firewall and stop loss reduce risk; they do not remove it. Nothing here is financial advice.</li>
        </ul>
        <label class="ack"><input type="checkbox" id="riskCheck"> I understand this arm will trade real funds automatically and I accept the risk of total loss.</label>
        <div class="btn-row">
          <button type="button" class="btn sm" id="riskCancel">Keep simulating</button>
          <button type="submit" class="btn sm live" id="riskConfirm" disabled>Enable live mode</button>
        </div>
      </form>
    </dialog>`,
  )
  const keyDialog = $<HTMLDialogElement>('#keyDialog')
  const keyInput = $<HTMLInputElement>('#keyInput')
  $('#keyCancel').addEventListener('click', () => keyDialog.close('cancel'))
  $('#keyClear').addEventListener('click', () => {
    setToken(null)
    keyInput.value = ''
    keyDialog.close('cleared')
    toast('Stored operator key forgotten', 'info')
  })
  $('#keySave').addEventListener('click', (e) => {
    e.preventDefault()
    const v = keyInput.value.trim()
    if (!v) {
      keyInput.classList.add('invalid')
      keyInput.focus()
      return
    }
    setToken(v)
    keyDialog.close('saved')
  })
  keyInput.addEventListener('input', () => keyInput.classList.remove('invalid'))

  const riskDialog = $<HTMLDialogElement>('#riskDialog')
  const riskCheck = $<HTMLInputElement>('#riskCheck')
  const riskConfirm = $<HTMLButtonElement>('#riskConfirm')
  riskCheck.addEventListener('change', () => {
    riskConfirm.disabled = !riskCheck.checked
  })
  $('#riskCancel').addEventListener('click', () => riskDialog.close('cancel'))
  riskConfirm.addEventListener('click', (e) => {
    e.preventDefault()
    if (!riskCheck.checked) return
    riskDialog.close('accepted')
  })
  setTokenPrompt(promptForToken)
}

function promptForToken(reason: string): Promise<boolean> {
  const dialog = $<HTMLDialogElement>('#keyDialog')
  const input = $<HTMLInputElement>('#keyInput')
  $('#keyReason').textContent = reason
  input.value = getToken() ?? ''
  input.classList.remove('invalid')
  return new Promise((resolve) => {
    const done = () => {
      dialog.removeEventListener('close', done)
      resolve(dialog.returnValue === 'saved')
    }
    dialog.addEventListener('close', done)
    dialog.showModal()
    input.focus()
    input.select()
  })
}

function riskAcknowledged(): boolean {
  try {
    return (localStorage.getItem(RISK_ACK_KEY) ?? '').startsWith(RISK_ACK_VERSION + ':')
  } catch {
    return false
  }
}

/** Resolves true once the operator has accepted the live-trading disclosure (remembered per browser). */
export function ensureRiskAck(): Promise<boolean> {
  if (riskAcknowledged()) return Promise.resolve(true)
  const dialog = $<HTMLDialogElement>('#riskDialog')
  const check = $<HTMLInputElement>('#riskCheck')
  check.checked = false
  $<HTMLButtonElement>('#riskConfirm').disabled = true
  return new Promise((resolve) => {
    const done = () => {
      dialog.removeEventListener('close', done)
      const ok = dialog.returnValue === 'accepted'
      if (ok) {
        try {
          localStorage.setItem(RISK_ACK_KEY, `${RISK_ACK_VERSION}:${new Date().toISOString()}`)
        } catch {
          // remembered for this page only
        }
      }
      resolve(ok)
    }
    dialog.addEventListener('close', done)
    dialog.showModal()
  })
}
