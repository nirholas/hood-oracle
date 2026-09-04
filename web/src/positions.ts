/** Positions: live open book, closed table, trades tape, decision journal, equity sparklines. */
import type { ArmListItem, DecisionsResponse, EquityResponse, PositionListItem, TradeListItem } from '../../src/api/contract'
import { weiToEth } from '../../src/api/wei'
import { api, errorMessage, write } from './api'
import { $, $$, h, setHtml, skeletonRows, stateBlock, toast, type Raw } from './dom'
import { ago, fmtDuration, fmtEth, fmtSignedEth, fmtSignedPct, pnlPct, shortHash, symbolOf } from './format'
import { mountShell } from './shell'

const shell = mountShell({ page: 'positions' })

const state = {
  arm: new URLSearchParams(location.search).get('arm') ?? '',
  arms: [] as ArmListItem[],
  positions: new Map<string, PositionListItem>(),
  trades: [] as TradeListItem[],
  decisions: null as DecisionsResponse | null,
  equity: null as EquityResponse | null,
  errors: { positions: null as string | null, trades: null as string | null, decisions: null as string | null, equity: null as string | null },
  closing: new Set<string>(),
}

const armSel = $<HTMLSelectElement>('#armSel')
armSel.addEventListener('change', () => {
  state.arm = armSel.value
  history.replaceState(null, '', state.arm ? `/app/positions?arm=${state.arm}` : '/app/positions')
  void loadAll()
})

const armQuery = () => (state.arm ? `&arm=${state.arm}` : '')

async function loadArms(): Promise<void> {
  const r = await api<{ arms: ArmListItem[] }>('/api/arms')
  if (!r.ok || !r.data) return
  state.arms = r.data.arms
  const cur = state.arm
  armSel.innerHTML = '<option value="">All arms</option>' + state.arms.map((a) => `<option value="${a.id}">${a.label.replace(/</g, '&lt;')}</option>`).join('')
  armSel.value = state.arms.some((a) => a.id === cur) ? cur : ''
  state.arm = armSel.value
}

async function loadPositions(): Promise<void> {
  const r = await api<{ positions: PositionListItem[] }>(`/api/positions?limit=500${armQuery()}`)
  if (!r.ok || !r.data) {
    state.errors.positions = errorMessage(r)
  } else {
    state.errors.positions = null
    state.positions.clear()
    for (const p of r.data.positions) state.positions.set(p.id, p)
  }
  renderPositions()
}

async function loadTrades(): Promise<void> {
  const r = await api<{ trades: TradeListItem[] }>(`/api/trades?limit=100${armQuery()}`)
  if (!r.ok || !r.data) state.errors.trades = errorMessage(r)
  else {
    state.errors.trades = null
    state.trades = r.data.trades
  }
  renderTrades()
}

async function loadDecisions(): Promise<void> {
  const r = await api<DecisionsResponse>(`/api/decisions?limit=100${armQuery()}`)
  if (!r.ok || !r.data) state.errors.decisions = errorMessage(r)
  else {
    state.errors.decisions = null
    state.decisions = r.data
  }
  renderDecisions()
}

async function loadEquity(): Promise<void> {
  const r = await api<EquityResponse>(`/api/equity?limit=600${armQuery()}`)
  if (!r.ok || !r.data) state.errors.equity = errorMessage(r)
  else {
    state.errors.equity = null
    state.equity = r.data
  }
  renderEquity()
}

async function loadAll(): Promise<void> {
  for (const id of ['#openList', '#tradeList', '#decList']) setHtml($(id), skeletonRows(4))
  setHtml($('#closedTable'), skeletonRows(3, [30, 14, 14, 14, 14]))
  setHtml($('#equity'), skeletonRows(2, [60, 20]))
  await Promise.all([loadPositions(), loadTrades(), loadDecisions(), loadEquity()])
}

// ── positions ────────────────────────────────────────────────────────────────

function armLabel(id: string): string {
  return state.arms.find((a) => a.id === id)?.label ?? id.slice(0, 8)
}

function renderPositions(): void {
  const all = [...state.positions.values()]
  const open = all.filter((p) => p.status === 'open').sort((a, b) => Date.parse(b.openedAt) - Date.parse(a.openedAt))
  const closed = all.filter((p) => p.status !== 'open').sort((a, b) => Date.parse(b.closedAt ?? b.openedAt) - Date.parse(a.closedAt ?? a.openedAt))
  const openList = $('#openList')
  openList.setAttribute('aria-busy', 'false')
  $('#openCount').textContent = open.length ? String(open.length) : ''
  $('#closedCount').textContent = closed.length ? String(closed.length) : ''
  renderStats(open, closed)

  if (state.errors.positions) {
    stateBlock(openList, { kind: 'error', compact: true, title: 'Positions unavailable', body: state.errors.positions, action: { label: 'Retry', onClick: () => void loadPositions() } })
  } else if (!open.length) {
    stateBlock(openList, {
      compact: true,
      title: 'No open positions',
      body: state.arms.some((a) => a.enabled) ? 'Armed arms are watching the tape. The next launch that clears their filters opens a position here.' : 'No arm is armed. Arm one to start taking positions in simulate mode.',
      href: state.arms.some((a) => a.enabled) ? undefined : { label: 'Arm a strategy', url: '/app/arm' },
    })
  } else {
    setHtml(openList, h`${open.map(openRow)}`)
    for (const b of $$<HTMLButtonElement>('[data-close]', openList)) b.addEventListener('click', () => void closePosition(b.dataset.close as string))
  }

  const table = $('#closedTable')
  table.setAttribute('aria-busy', 'false')
  if (state.errors.positions) setHtml(table, '')
  else if (!closed.length) stateBlock(table, { compact: true, title: 'Nothing closed yet', body: 'Closed positions land here with the exit that fired and the realized result.' })
  else {
    setHtml(table, h`<div class="twrap"><table class="t"><thead><tr><th>Token</th><th>Arm</th><th class="r">Entry</th><th class="r">Realized</th><th class="r">PnL</th><th>Exit</th><th class="r">Held</th><th class="r">Closed</th></tr></thead><tbody>${closed.slice(0, 100).map((p) => {
      const pct = p.realizedPnlPct
      const cls = pct == null ? '' : pct >= 0 ? 'up' : 'dn'
      const held = p.closedAt ? (Date.parse(p.closedAt) - Date.parse(p.openedAt)) / 1000 : null
      return h`<tr><td><a href="/app/coin/${p.token}"><b>${symbolOf(p)}</b></a> <span class="badge ${p.mode === 'live' ? 'b-live' : 'b-sim'}">${p.mode}</span></td><td class="muted">${p.armLabel}</td><td class="r m">${fmtEth(p.entryWei, '')}</td><td class="r m ${cls}">${fmtSignedEth(p.realizedPnlWei)}</td><td class="r m ${cls}">${fmtSignedPct(pct)}</td><td><span class="badge ${p.exitReason === 'stop_loss' || p.exitReason === 'rug_detected' ? 'b-fail' : p.exitReason === 'take_profit' || p.exitReason === 'take_initials' ? 'b-pass' : ''}">${p.exitReason ?? p.status}</span></td><td class="r m muted">${fmtDuration(held)}</td><td class="r m muted" title="${p.closedAt ?? ''}">${ago(p.closedAt)} ago</td></tr>`
    })}</tbody></table></div>`)
  }
}

function openRow(p: PositionListItem): Raw {
  const pct = pnlPct(p.entryWei, p.lastValueWei)
  const cls = pct == null ? '' : pct >= 0 ? 'up' : 'dn'
  const peakPct = pnlPct(p.entryWei, p.peakValueWei)
  const closing = state.closing.has(p.id)
  return h`<div class="trow posrow" data-id="${p.id}">
    <div class="sym"><a href="/app/coin/${p.token}">${symbolOf(p)}</a><span class="badge ${p.mode === 'live' ? 'b-live' : 'b-sim'}">${p.mode}</span>
      <div class="subline" style="width:100%"><span>${p.armLabel}</span><span class="badge b-${p.launchpad}">${p.launchpad}</span><span>${p.venue}</span>${p.oracleScoreAtEntry != null ? h`<span>score ${Math.round(p.oracleScoreAtEntry)} at entry</span>` : ''}${p.staleSince ? h`<span class="warn">stale mark</span>` : ''}${p.initialsRecovered ? h`<span class="up">initials out</span>` : ''}</div></div>
    <div class="num">${fmtEth(p.entryWei, '')}<small>entry Ξ</small></div>
    <div class="num hide-sm">${p.lastValueWei != null ? fmtEth(p.lastValueWei, '') : 'n/a'}<small>value Ξ</small></div>
    <div class="num hide-sm">${fmtEth(p.peakValueWei, '')}<small>peak ${peakPct != null ? fmtSignedPct(peakPct, 0) : ''}</small></div>
    <div class="num ${cls}">${fmtSignedPct(pct)}<small>pnl</small></div>
    <div class="when hide-sm" title="${p.openedAt}">${ago(p.openedAt)}</div>
    <div><button type="button" class="btn xs danger" data-close="${p.id}" ${closing ? 'disabled' : ''}>${closing ? 'Closing…' : 'Close'}</button></div>
  </div>`
}

function renderStats(open: PositionListItem[], closed: PositionListItem[]): void {
  const set = (id: string, v: string, cls = '') => {
    const el = $(id)
    el.className = 'stat-val ' + cls
    el.textContent = v
  }
  set('#stOpen', String(open.length))
  $('#stOpenSub').textContent = `${open.filter((p) => p.mode === 'live').length} live, ${open.filter((p) => p.mode === 'simulate').length} simulated`
  let unreal = 0n
  for (const p of open) if (p.lastValueWei != null) unreal += BigInt(p.lastValueWei) - BigInt(p.entryWei)
  set('#stUnreal', fmtSignedEth(unreal.toString()), unreal > 0n ? 'up' : unreal < 0n ? 'dn' : '')
  let real = 0n
  let wins = 0
  for (const p of closed) {
    if (p.realizedPnlWei != null) {
      real += BigInt(p.realizedPnlWei)
      if (BigInt(p.realizedPnlWei) > 0n) wins++
    }
  }
  set('#stReal', fmtSignedEth(real.toString()), real > 0n ? 'up' : real < 0n ? 'dn' : '')
  $('#stRealSub').textContent = `${closed.length} closed position${closed.length === 1 ? '' : 's'}`
  set('#stWin', closed.length ? `${Math.round((wins / closed.length) * 100)}%` : 'n/a')
  $('#stWinSub').textContent = closed.length ? `${wins} of ${closed.length} closed above entry` : 'no closed positions yet'
}

async function closePosition(id: string): Promise<void> {
  const p = state.positions.get(id)
  if (!p || state.closing.has(id)) return
  if (!window.confirm(`Close ${symbolOf(p)} at market now?${p.mode === 'live' ? ' This sends a real sell.' : ''}`)) return
  state.closing.add(id)
  renderPositions()
  const r = await write<{ trade: TradeListItem; position: PositionListItem | null }>(`/api/positions/${id}/close`)
  state.closing.delete(id)
  if (!r.ok) {
    toast(errorMessage(r, 'Close failed'), 'bad', 7000)
    renderPositions()
    return
  }
  toast(`Closed ${symbolOf(p)}`, 'ok')
  await Promise.all([loadPositions(), loadTrades()])
}

// ── trades ───────────────────────────────────────────────────────────────────

function renderTrades(): void {
  const list = $('#tradeList')
  list.setAttribute('aria-busy', 'false')
  $('#tradeCount').textContent = state.trades.length ? String(state.trades.length) : ''
  if (state.errors.trades) return stateBlock(list, { kind: 'error', compact: true, title: 'Trades unavailable', body: state.errors.trades, action: { label: 'Retry', onClick: () => void loadTrades() } })
  if (!state.trades.length) return stateBlock(list, { compact: true, title: 'No fills yet', body: 'Every buy and sell the engine executes prints here with its tx hash.' })
  setHtml(list, h`${state.trades.map((t) => {
    const isBuy = t.side === 'buy'
    const eth = isBuy ? t.amountIn : t.amountOut
    return h`<div class="trow traderow">
      <div><span class="badge ${isBuy ? 'b-buy' : 'b-sell'}">${t.side}</span></div>
      <div class="sym"><a href="/app/coin/${t.token}">${t.symbol ?? t.token.slice(0, 8)}</a><span class="badge ${t.mode === 'live' ? 'b-live' : 'b-sim'}">${t.mode}</span>
        <div class="subline" style="width:100%"><span>${t.armLabel}</span><span>${t.venue}</span>${t.priceImpactPct != null ? h`<span>impact ${t.priceImpactPct.toFixed(2)}%</span>` : ''}${t.txHash === 'SIMULATED' ? h`<span>simulated</span>` : h`<a class="addr" href="${shell.explorerUrl('tx', t.txHash)}" target="_blank" rel="noopener">${shortHash(t.txHash)}</a>`}</div></div>
      <div class="num ${isBuy ? 'dn' : 'up'}">${isBuy ? '-' : '+'}${fmtEth(eth, '')}<small>Ξ</small></div>
      <div class="num">${t.gasWei != null ? fmtEth(t.gasWei, '') : 'n/a'}<small>gas Ξ</small></div>
      <div class="when" title="${t.at}">${ago(t.at)}</div>
    </div>`
  })}`)
}

// ── decisions ────────────────────────────────────────────────────────────────

function renderDecisions(): void {
  const list = $('#decList')
  list.setAttribute('aria-busy', 'false')
  const badge = $('#journalChain')
  const d = state.decisions
  $('#decCount').textContent = d?.items.length ? String(d.items.length) : ''
  if (state.errors.decisions) {
    badge.innerHTML = ''
    return stateBlock(list, { kind: 'error', compact: true, title: 'Journal unavailable', body: state.errors.decisions, action: { label: 'Retry', onClick: () => void loadDecisions() } })
  }
  if (!d) return
  badge.innerHTML = d.chain.ok
    ? `<span class="badge b-pass" title="Every row's prevHash matches the entryHash before it (${d.chain.rows} rows, checked ${new Date(d.chain.verifiedAt).toLocaleTimeString()})">chain verified · ${d.chain.rows}</span>`
    : `<span class="badge b-fail" title="${d.chain.breaks.length} link break(s); first at ${d.chain.breaks[0]?.at ?? 'n/a'}">chain broken · ${d.chain.breaks.length}</span>`
  if (!d.items.length) return stateBlock(list, { compact: true, title: 'Journal is empty', body: 'Every decision the engine takes, including skips and refusals with their reason, is appended here as a hash-chained row.' })
  setHtml(list, h`${d.items.map((x) => {
    const detail = Object.entries(x.detail ?? {}).slice(0, 4).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join('  ')
    return h`<div class="trow decrow" title="${x.entryHash}">
      <div><span class="kind k-${x.kind}">${x.kind}</span></div>
      <div style="min-width:0"><div class="reason">${x.token ? h`<a href="/app/coin/${x.token}"><b>${x.token.slice(0, 10)}…</b></a> ` : ''}${x.reason}</div><div class="detail">${x.armLabel ? x.armLabel + ' · ' : ''}${detail}</div></div>
      <div class="when" title="${x.at}">${ago(x.at)}</div>
    </div>`
  })}`)
}

// ── equity ───────────────────────────────────────────────────────────────────

function renderEquity(): void {
  const host = $('#equity')
  host.setAttribute('aria-busy', 'false')
  if (state.errors.equity) return stateBlock(host, { kind: 'error', compact: true, title: 'Equity unavailable', body: state.errors.equity, action: { label: 'Retry', onClick: () => void loadEquity() } })
  const series = (state.equity?.series ?? []).filter((s) => s.points.length)
  if (!series.length) return stateBlock(host, { compact: true, title: 'No equity marks yet', body: 'The equity job marks every arm every 60 seconds once it has a position or a realized result.' })
  setHtml(host, h`${series.map((s) => {
    const last = s.points[s.points.length - 1]
    const first = s.points[0]
    const delta = BigInt(last.equityWei) - BigInt(first.equityWei)
    return h`<div class="eq-item"><div class="eq-head"><span class="eq-lab">${s.armLabel}</span><span><b>${fmtEth(last.equityWei)}</b> <span class="${delta >= 0n ? 'up' : 'dn'} mono" style="font-size:11px">${fmtSignedEth(delta.toString())}</span></span></div><canvas class="spark" data-arm="${s.armId}" height="60" aria-label="Equity curve for ${s.armLabel}"></canvas><div class="field-hint">${s.points.length} marks · realized ${fmtEth(last.realizedWei)} · open ${fmtEth(last.openValueWei)} · last ${ago(last.at)} ago</div></div>`
  })}`)
  for (const s of series) {
    const canvas = host.querySelector<HTMLCanvasElement>(`canvas[data-arm="${s.armId}"]`)
    if (canvas) drawSpark(canvas, s.points.map((p) => weiToEth(p.equityWei)))
  }
}

function drawSpark(canvas: HTMLCanvasElement, values: number[]): void {
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth || 300
  const hgt = 60
  canvas.width = w * dpr
  canvas.height = hgt * dpr
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.scale(dpr, dpr)
  const css = getComputedStyle(document.documentElement)
  const up = css.getPropertyValue('--up').trim() || '#e4e8f2'
  const down = css.getPropertyValue('--down').trim() || '#6c7280'
  const line = css.getPropertyValue('--line').trim() || 'rgba(255,255,255,0.09)'
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const x = (i: number) => (values.length === 1 ? w / 2 : (i / (values.length - 1)) * (w - 2) + 1)
  const y = (v: number) => hgt - 4 - ((v - min) / span) * (hgt - 8)
  ctx.strokeStyle = line
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, y(values[0]))
  ctx.lineTo(w, y(values[0]))
  ctx.stroke()
  const color = values[values.length - 1] >= values[0] ? up : down
  const grad = ctx.createLinearGradient(0, 0, 0, hgt)
  grad.addColorStop(0, color + '55')
  grad.addColorStop(1, color + '00')
  ctx.beginPath()
  ctx.moveTo(x(0), y(values[0]))
  for (let i = 1; i < values.length; i++) ctx.lineTo(x(i), y(values[i]))
  ctx.strokeStyle = color
  ctx.lineWidth = 1.6
  ctx.lineJoin = 'round'
  ctx.stroke()
  ctx.lineTo(x(values.length - 1), hgt)
  ctx.lineTo(x(0), hgt)
  ctx.closePath()
  ctx.fillStyle = grad
  ctx.fill()
}

// ── live ─────────────────────────────────────────────────────────────────────

shell.on('position', (e) => {
  if (e.kind !== 'position') return
  const p = e.position
  if (state.arm && p.armId !== state.arm) return
  const existing = state.positions.get(p.id)
  state.positions.set(p.id, { ...p, symbol: existing?.symbol ?? null, name: existing?.name ?? null, armLabel: existing?.armLabel ?? armLabel(p.armId) })
  renderPositions()
  if (!existing) void loadPositions()
})
shell.on('trade', (e) => {
  if (e.kind !== 'trade') return
  if (state.arm && e.trade.armId !== state.arm) return
  state.trades.unshift({ ...e.trade, symbol: state.positions.get(e.trade.positionId ?? '')?.symbol ?? null, armLabel: armLabel(e.trade.armId) })
  state.trades = state.trades.slice(0, 100)
  renderTrades()
})
shell.on('decision', (e) => {
  if (e.kind !== 'decision' || !state.decisions) return
  if (state.arm && e.decision.armId !== state.arm) return
  state.decisions.items.unshift({ ...e.decision, armLabel: e.decision.armId ? armLabel(e.decision.armId) : null })
  state.decisions.items = state.decisions.items.slice(0, 100)
  state.decisions.chain.rows += 1
  renderDecisions()
})

window.addEventListener('resize', () => renderEquity())
setInterval(() => { if (!document.hidden) { void loadEquity(); void loadDecisions() } }, 60_000)
setInterval(() => { if (!document.hidden) renderPositions() }, 20_000)

void loadArms().then(loadAll)
