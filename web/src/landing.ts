/**
 * The landing page. Every number on it is read from the running engine:
 * the stat strip from GET /api/status, the tape and the radar from
 * GET /api/oracle/feed, the model banner from GET /api/oracle/model. The
 * oracle event stream (SSE) refreshes the tape and the counters as new
 * scores land. With no data the page says so; it never invents a blip.
 */
import type { FeedItem, FeedResponse, ModelResponse, StatusResponse } from '../../src/api/contract'
import type { OracleTier } from '../../src/types'
import { api, errorMessage } from './api'
import { $, debounce, h, setHtml, skeletonRows, stateBlock, tierPill } from './dom'
import { ago, fmtNum, fmtRatio, shortAddr, symbolOf } from './format'
import { openStream } from './sse'

const STATUS_POLL_MS = 15_000
const TAPE_ROWS = 12
const RADAR_ROWS = 60
const RADAR_WINDOW_HOURS = 24

const state = {
  status: null as StatusResponse | null,
  items: [] as FeedItem[],
  loading: true,
  error: null as string | null,
  streamConnected: false,
  fresh: new Set<string>(),
}

// ── status strip ─────────────────────────────────────────────────────────────

async function refreshStatus(): Promise<void> {
  const r = await api<StatusResponse>('/api/status', { timeout: 8_000 })
  const note = $('#statNote')
  if (!r.ok || !r.data) {
    for (const id of ['#stScored', '#stLaunches', '#stIndexed', '#stModel']) {
      const el = $(id)
      el.classList.remove('sk')
      el.textContent = 'n/a'
    }
    note.textContent = `Engine unreachable: ${r.error?.message ?? 'no response'}. Counts resume when it answers.`
    note.hidden = false
    renderFeedHealth()
    return
  }
  note.hidden = true
  state.status = r.data
  const s = r.data
  $('#chainBadge').textContent = String(s.chainId)
  $('#heroLive').textContent = `Robinhood Chain · ${s.chainId} · ${s.network}`
  put('#stScored', fmtNum(s.counts.scores24h))
  $('#stScoredSub').textContent = `${fmtNum(s.counts.scores)} scores under ${s.model.source === 'bootstrap' ? 'the bootstrap prior' : 'v' + s.model.version}`
  put('#stLaunches', fmtNum(s.counts.launches24h))
  put('#stIndexed', fmtNum(s.counts.launches))
  $('#stIndexedSub').textContent = s.engine.headBlock != null ? `head block #${s.engine.headBlock.toLocaleString()}` : 'on this network'
  put('#stModel', s.model.source === 'bootstrap' ? 'prior' : 'v' + s.model.version.split('-')[0])
  $('#stModelSub').textContent = s.model.source === 'bootstrap' ? `bootstrap prior, ${s.model.trainingRows.toLocaleString()} rows` : `promoted refit, ${s.model.trainingRows.toLocaleString()} rows`
  renderFeedHealth()
}

function put(sel: string, text: string): void {
  const el = $(sel)
  el.classList.remove('sk')
  el.textContent = text
}

function renderFeedHealth(): void {
  const dot = $('#hsFeedDot')
  const text = $('#hsFeedText')
  const wrap = $('#hsFeed')
  const heroDot = $('#heroDot')
  const s = state.status
  if (!s) {
    dot.className = 'dot off'
    heroDot.className = 'dot off'
    text.textContent = 'engine offline'
    wrap.title = 'The API did not answer'
    return
  }
  const feed = s.engine.feed
  const cls = !state.streamConnected ? 'warn' : feed.connected ? 'live' : 'warn'
  dot.className = 'dot ' + cls
  heroDot.className = 'dot ' + cls
  if (s.engine.killed) {
    text.textContent = 'killed'
    dot.className = 'dot bad'
    wrap.title = s.engine.killReason ?? 'kill switch tripped'
    return
  }
  text.textContent = feed.connected ? `feed ${feed.secondsSinceFrame != null ? feed.secondsSinceFrame + 's' : 'live'}` : 'feed off'
  wrap.title = feed.connected
    ? `Sequencer feed connected${feed.secondsSinceFrame != null ? `, last frame ${feed.secondsSinceFrame}s ago` : ''}`
    : 'Sequencer feed not connected: launches arrive by log polling only'
}

// ── feed: tape + radar ───────────────────────────────────────────────────────

const list = $('#feedList')

async function loadFeed(): Promise<void> {
  if (state.loading) setHtml(list, skeletonRows(6, [34, 10, 22, 8, 8, 8]))
  list.setAttribute('aria-busy', 'true')
  const r = await api<FeedResponse>(`/api/oracle/feed?limit=${RADAR_ROWS}`)
  state.loading = false
  list.setAttribute('aria-busy', 'false')
  if (!r.ok || !r.data) {
    state.error = errorMessage(r, 'Could not load the tape.')
    renderTape()
    return
  }
  state.error = null
  const before = new Set(state.items.map((i) => i.token))
  state.items = r.data.items
  for (const it of state.items) if (before.size && !before.has(it.token)) state.fresh.add(it.token)
  renderTape()
  radar.setItems(state.items)
  setTimeout(() => {
    state.fresh.clear()
  }, 1_200)
}

function renderTape(): void {
  const dot = $('#tapeDot')
  const status = $('#tapeStatus')
  const meta = $('#tapeMeta')
  dot.className = 'dot ' + (state.streamConnected ? 'live' : 'off')
  status.textContent = state.streamConnected ? 'Live: oracle stream connected' : 'Stream reconnecting; polling'
  if (state.error) {
    stateBlock(list, { kind: 'error', title: 'Could not load the tape', body: state.error, action: { label: 'Retry', onClick: () => void loadFeed() } })
    meta.textContent = ''
    return
  }
  const rows = state.items.slice(0, TAPE_ROWS)
  meta.textContent = rows.length ? `${rows.length} of the latest ${state.items.length} scores` : ''
  if (!rows.length) {
    stateBlock(list, {
      title: 'No launches scored yet on this network',
      body: 'The tape fills as the sequencer feed delivers launches and the oracle scores them. A fresh install can backfill from chain history with npm run oracle:backfill.',
      href: { label: 'How intake works', url: '/docs/architecture' },
    })
    return
  }
  setHtml(list, h`${rows.map(row)}`)
}

function row(it: FeedItem) {
  const s = it.score
  const fresh = state.fresh.has(it.token)
  return h`<a class="trow feedrow ${fresh ? 'flash' : ''}" href="/app/coin/${it.token}" data-token="${it.token.toLowerCase()}" aria-label="${symbolOf(it)}, ${s.tier}, score ${Math.round(s.score)}">
    <div class="sym"><span>${symbolOf(it)}</span>${it.name && it.name !== it.symbol ? h`<span class="name">${it.name}</span>` : ''}</div>
    <div>${tierPill(s.tier)}</div>
    <div class="subline hide-sm"><span class="badge b-${it.launchpad}">${it.launchpad}</span><span>${it.venue}</span><span title="${it.creator}">by ${shortAddr(it.creator, 4, 4)}</span></div>
    <div class="score ${s.tier === 'prime' || s.tier === 'strong' ? 'hi' : ''}">${Math.round(s.score)}</div>
    <div class="rr hide-sm ${s.rugRisk >= 0.5 ? 'bad' : 'muted'}" title="rug risk">${fmtRatio(s.rugRisk)}</div>
    <div class="when" title="${it.firstSeenAt}">${ago(it.firstSeenAt)}</div>
  </a>`
}

// ── model banner ─────────────────────────────────────────────────────────────

async function loadModel(): Promise<void> {
  const banner = $('#modelBanner')
  const r = await api<ModelResponse>('/api/oracle/model')
  if (!r.ok || !r.data) {
    banner.className = 'banner model-banner red'
    setHtml(banner, h`<span class="b-icon">model</span><div><span class="b-title">The active model could not be read</span>${errorMessage(r)}</div>`)
    return
  }
  const m = r.data
  const win = m.holdout?.win
  const metrics = []
  metrics.push(h`<span class="metric">version <b>${m.version}</b></span>`)
  metrics.push(h`<span class="metric">rows <b>${m.trainingRows.toLocaleString()}</b></span>`)
  metrics.push(h`<span class="metric">features <b>${m.features.length}</b></span>`)
  if (win && typeof win.auc === 'number') metrics.push(h`<span class="metric">holdout win AUC <b>${win.auc.toFixed(3)}</b></span>`)
  const rug = m.holdout?.rug
  if (rug && typeof rug.auc === 'number') metrics.push(h`<span class="metric">rug AUC <b>${rug.auc.toFixed(3)}</b></span>`)
  if (m.fittedAt) metrics.push(h`<span class="metric">fitted <b>${ago(m.fittedAt)} ago</b></span>`)
  banner.className = 'banner model-banner ' + (m.source === 'bootstrap' ? 'amber' : '')
  setHtml(
    banner,
    h`<span class="b-icon">${m.source}</span><div>
      <span class="b-title">${m.source === 'bootstrap' ? 'Scoring under the bootstrap prior' : 'Scoring under a model promoted on this chain'}</span>
      ${m.source === 'bootstrap'
        ? 'A prior fitted elsewhere and re-denominated to ETH, not a measured Robinhood Chain hit rate. It is replaced the first time a refit passes the promotion gate.'
        : 'Fitted on realized Robinhood Chain outcomes and promoted through the gate below. The holdout numbers describe launches it never saw at fit time.'}
      <code>${m.provenance}</code>
      <div class="metrics">${metrics}</div>
    </div>`,
  )
  for (const el of document.querySelectorAll<HTMLElement>('[data-anchor]')) {
    const tier = el.dataset.anchor as OracleTier
    const p = m.tierAnchors[tier]
    if (typeof p === 'number') el.textContent = `${Math.round(p * 100)}%`
  }
}

// ── radar ────────────────────────────────────────────────────────────────────

interface Blip {
  item: FeedItem
  angle: number
  radius: number
  glow: number
}

const TIER_SECTOR: Record<OracleTier, number> = { prime: 0, strong: 1, lean: 2, watch: 3, avoid: 4 }
const SECTOR = (Math.PI * 2) / 5
const TAU = Math.PI * 2

function hashUnit(s: string): number {
  let x = 2166136261
  for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 16777619)
  return ((x >>> 0) % 10_000) / 10_000
}

function createRadar() {
  const canvas = $<HTMLCanvasElement>('#radar')
  const ctx = canvas.getContext('2d')
  const read = $('#radarRead')
  const reduce = matchMedia('(prefers-reduced-motion: reduce)')
  const scheme = matchMedia('(prefers-color-scheme: dark)')
  let blips: Blip[] = []
  let W = 0
  let R = 0
  let sweep = -Math.PI / 2
  let prev = sweep
  let locked: Blip | null = null
  let shown: Blip | null = null
  let raf = 0
  let colors = palette()

  function palette() {
    const css = getComputedStyle(document.documentElement)
    const get = (k: string, fb: string) => css.getPropertyValue(k).trim() || fb
    return {
      ink: get('--ink', '#eaeefa'),
      muted: get('--muted', '#8a92a8'),
      up: get('--up', '#e4e8f2'),
      gold: get('--gold', '#c4c9d6'),
      down: get('--down', '#6c7280'),
      cyan: get('--cyan', '#cdd2e0'),
      dark: scheme.matches,
    }
  }
  scheme.addEventListener('change', () => {
    colors = palette()
    if (reduce.matches) drawFrame()
  })

  function resize(): void {
    const rect = canvas.getBoundingClientRect()
    const dpr = Math.min(devicePixelRatio || 1, 2)
    W = Math.max(1, Math.floor(rect.width))
    canvas.width = Math.floor(rect.width * dpr)
    canvas.height = Math.floor(rect.height * dpr)
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0)
    R = W / 2 - 14
    if (reduce.matches) drawFrame()
  }
  addEventListener('resize', resize)

  const line = (alpha: number) => (colors.dark ? `rgba(234,238,250,${alpha})` : `rgba(16,19,31,${alpha})`)

  function tierColor(tier: OracleTier): string {
    return tier === 'prime' || tier === 'strong' ? colors.up : tier === 'lean' ? colors.gold : tier === 'watch' ? colors.muted : colors.down
  }

  function place(it: FeedItem): Blip {
    const sector = TIER_SECTOR[it.score.tier] ?? 4
    const angle = -Math.PI / 2 - SECTOR / 2 + sector * SECTOR + (0.12 + 0.76 * hashUnit(it.token)) * SECTOR
    return { item: it, angle, radius: radiusFor(it), glow: 0 }
  }

  function radiusFor(it: FeedItem): number {
    const ageH = Math.max(0, (Date.now() - new Date(it.firstSeenAt).getTime()) / 3_600_000)
    return 0.12 + 0.83 * Math.min(1, ageH / RADAR_WINDOW_HOURS)
  }

  function drawStatic(): void {
    if (!ctx) return
    const c = W / 2
    ctx.clearRect(0, 0, W, W)
    ctx.lineWidth = 1
    for (let k = 1; k <= 4; k++) {
      ctx.beginPath()
      ctx.arc(c, c, (R * k) / 4, 0, TAU)
      ctx.strokeStyle = line(k === 4 ? 0.3 : 0.12)
      ctx.stroke()
    }
    ctx.strokeStyle = line(0.1)
    for (let s = 0; s < 5; s++) {
      const a = -Math.PI / 2 - SECTOR / 2 + s * SECTOR
      ctx.beginPath()
      ctx.moveTo(c, c)
      ctx.lineTo(c + Math.cos(a) * R, c + Math.sin(a) * R)
      ctx.stroke()
    }
    ctx.strokeStyle = line(0.22)
    for (let d = 0; d < 360; d += 15) {
      const a = (d * Math.PI) / 180
      const inner = d % 45 === 0 ? R - 11 : R - 5
      ctx.beginPath()
      ctx.moveTo(c + Math.cos(a) * R, c + Math.sin(a) * R)
      ctx.lineTo(c + Math.cos(a) * inner, c + Math.sin(a) * inner)
      ctx.stroke()
    }
    ctx.fillStyle = colors.muted
    ctx.font = '600 9px ui-monospace, Menlo, monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const labels: [string, number][] = [['prime', 0], ['strong', 1], ['lean', 2], ['watch', 3], ['avoid', 4]]
    for (const [name, s] of labels) {
      const a = -Math.PI / 2 + s * SECTOR
      ctx.fillText(name, c + Math.cos(a) * (R + 8) * 0.93, c + Math.sin(a) * (R + 8) * 0.93)
    }
  }

  function drawBlips(): void {
    if (!ctx) return
    const c = W / 2
    for (const b of blips) {
      const x = c + Math.cos(b.angle) * R * b.radius
      const y = c + Math.sin(b.angle) * R * b.radius
      const col = tierColor(b.item.score.tier)
      const active = b === (locked ?? shown)
      if (b.glow > 0.02) {
        ctx.beginPath()
        ctx.arc(x, y, 4 + (1 - b.glow) * 22, 0, TAU)
        ctx.strokeStyle = line(b.glow * 0.5)
        ctx.lineWidth = 1
        ctx.stroke()
      }
      ctx.save()
      if (active || b.glow > 0.1) {
        ctx.shadowColor = col
        ctx.shadowBlur = active ? 12 : 8
      }
      ctx.fillStyle = col
      ctx.beginPath()
      ctx.arc(x, y, active ? 4.8 : b.item.score.tier === 'prime' ? 4 : 3.2, 0, TAU)
      ctx.fill()
      ctx.restore()
      if (active) {
        ctx.strokeStyle = colors.ink
        ctx.lineWidth = 1.2
        const k = 9
        for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
          ctx.beginPath()
          ctx.moveTo(x + sx * k, y + sy * k - sy * 4)
          ctx.lineTo(x + sx * k, y + sy * k)
          ctx.lineTo(x + sx * k - sx * 4, y + sy * k)
          ctx.stroke()
        }
        ctx.fillStyle = colors.ink
        ctx.font = '700 10px ui-monospace, Menlo, monospace'
        ctx.textAlign = x > c ? 'right' : 'left'
        ctx.textBaseline = 'bottom'
        ctx.fillText(symbolOf(b.item), x + (x > c ? -12 : 12), y - 10)
      }
    }
    ctx.fillStyle = colors.ink
    ctx.beginPath()
    ctx.arc(c, c, 2.4, 0, TAU)
    ctx.fill()
  }

  function drawSweep(): void {
    if (!ctx) return
    const c = W / 2
    const n = 44
    for (let i = 0; i < n; i++) {
      const a = sweep - i * 0.032
      ctx.strokeStyle = line((1 - i / n) * 0.2)
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(c, c)
      ctx.lineTo(c + Math.cos(a) * R, c + Math.sin(a) * R)
      ctx.stroke()
    }
    ctx.save()
    ctx.shadowColor = colors.cyan
    ctx.shadowBlur = 8
    ctx.strokeStyle = colors.ink
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(c, c)
    ctx.lineTo(c + Math.cos(sweep) * R, c + Math.sin(sweep) * R)
    ctx.stroke()
    ctx.restore()
  }

  const norm = (a: number) => {
    let x = a
    while (x < -Math.PI) x += TAU
    while (x > Math.PI) x -= TAU
    return x
  }

  function drawFrame(): void {
    drawStatic()
    if (!reduce.matches) drawSweep()
    drawBlips()
  }

  function tick(): void {
    prev = sweep
    sweep += 0.014
    if (sweep > Math.PI * 1.5) {
      sweep -= TAU
      prev -= TAU
    }
    for (const b of blips) {
      const d0 = norm(prev - b.angle)
      const d1 = norm(sweep - b.angle)
      if (d0 < 0 && d1 >= 0 && d1 - d0 < 0.4) {
        b.glow = 1
        if (!locked) show(b, 'sweep')
      }
      b.glow *= 0.955
    }
    drawFrame()
    raf = requestAnimationFrame(tick)
  }

  function show(b: Blip, how: 'sweep' | 'locked' | 'newest'): void {
    shown = b
    const it = b.item
    read.classList.add('hot')
    setTimeout(() => read.classList.remove('hot'), 600)
    $('#rrKicker').innerHTML = ''
    setHtml($('#rrKicker'), h`${how === 'locked' ? 'locked' : how === 'sweep' ? 'sweep' : 'newest'} · ${it.launchpad} · ${ago(it.firstSeenAt)} ago`)
    setHtml(
      $('#rrSym'),
      h`<a href="/app/coin/${it.token}">${symbolOf(it)}</a>${tierPill(it.score.tier)}<span class="mono">${Math.round(it.score.score)}</span><span class="muted mono" style="font-size:12px">rug ${fmtRatio(it.score.rugRisk)}</span>`,
    )
    const reason = it.score.reasons[0]
    setHtml($('#rrSub'), h`${reason ?? `Confidence ${fmtRatio(it.score.confidence)}: share of features actually observed in the window.`}${how === 'locked' ? ' Click empty radar to resume the sweep.' : ''}`)
  }

  function showEmpty(): void {
    shown = null
    locked = null
    $('#rrKicker').textContent = 'sweep'
    $('#rrSym').textContent = 'Waiting for the first scored launch'
    $('#rrSub').textContent = 'The radar draws only launches the oracle has actually scored. Bearing is the tier, distance is age over the last 24 hours.'
  }

  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect()
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top
    const c = W / 2
    let best: Blip | null = null
    let bestD = 14
    for (const b of blips) {
      const x = c + Math.cos(b.angle) * R * b.radius
      const y = c + Math.sin(b.angle) * R * b.radius
      const d = Math.hypot(px - x, py - y)
      if (d < bestD) {
        bestD = d
        best = b
      }
    }
    if (best) {
      locked = best
      show(best, 'locked')
    } else if (locked) {
      locked = null
      show(locked ?? shown ?? blips[0], 'sweep')
    }
    if (reduce.matches) drawFrame()
  })
  canvas.style.cursor = 'crosshair'

  resize()
  if (!reduce.matches) raf = requestAnimationFrame(tick)
  document.addEventListener('visibilitychange', () => {
    if (reduce.matches) return
    if (document.hidden) cancelAnimationFrame(raf)
    else raf = requestAnimationFrame(tick)
  })

  return {
    setItems(items: FeedItem[]) {
      const keep = new Map(blips.map((b) => [b.item.token, b]))
      blips = items.map((it) => {
        const old = keep.get(it.token)
        const b = place(it)
        if (old) b.glow = old.glow
        return b
      })
      if (locked && !blips.some((b) => b.item.token === locked!.item.token)) locked = null
      if (!blips.length) {
        showEmpty()
      } else if (!shown || !blips.some((b) => b.item.token === shown!.item.token)) {
        show(blips[0], 'newest')
      }
      if (reduce.matches) drawFrame()
    },
  }
}

const radar = createRadar()

// ── stream ───────────────────────────────────────────────────────────────────

const refetch = debounce(() => {
  void loadFeed()
  void refreshStatus()
}, 700)

openStream('/api/oracle/stream', {
  onEvent(e) {
    if (e.kind === 'score' || e.kind === 'launch') refetch()
  },
  onState(connected) {
    state.streamConnected = connected
    renderFeedHealth()
    if (!state.loading) renderTape()
  },
})

// ── boot ─────────────────────────────────────────────────────────────────────

void refreshStatus()
void loadFeed()
void loadModel()
let poll = window.setInterval(() => void refreshStatus(), STATUS_POLL_MS)
document.addEventListener('visibilitychange', () => {
  clearInterval(poll)
  if (!document.hidden) {
    void refreshStatus()
    void loadFeed()
    poll = window.setInterval(() => void refreshStatus(), STATUS_POLL_MS)
  }
})

for (const a of document.querySelectorAll<HTMLAnchorElement>('.lnav a[href^="#"]')) {
  a.addEventListener('click', (e) => {
    const target = document.querySelector(a.getAttribute('href') ?? '')
    if (!target) return
    e.preventDefault()
    target.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' })
    history.replaceState(null, '', a.getAttribute('href'))
  })
}
