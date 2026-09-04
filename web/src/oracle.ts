/** Oracle board: the live launch tape with tier pills, filters, and the model banner. */
import type { CoinResponse, EngineEventWire, FeedItem, FeedResponse, ModelResponse } from '../../src/api/contract'
import { api, errorMessage } from './api'
import { $, debounce, h, pillarBars, segmented, setHtml, skeletonRows, stateBlock, tierPill, type Raw } from './dom'
import { ago, fmtNum, fmtRatio, shortAddr, symbolOf } from './format'
import { mountShell } from './shell'

const shell = mountShell({ page: 'oracle', filterSelector: '#filterInput' })

interface Pending {
  token: string
  launch: Extract<EngineEventWire, { kind: 'launch' }>['launch'] | null
  snapshot: Extract<EngineEventWire, { kind: 'features' }>['snapshot'] | null
  at: number
}

const state = {
  items: new Map<string, FeedItem>(),
  pending: new Map<string, Pending>(),
  tier: 'all',
  launchpad: 'all',
  sort: 'new',
  query: '',
  loading: true,
  error: null as string | null,
  loadedAt: null as number | null,
  fresh: new Set<string>(),
}

const list = $('#feedList')
const filterInput = $<HTMLInputElement>('#filterInput')

segmented($('#tierSeg'), (v) => { state.tier = v; render() })
const lpSel = $<HTMLSelectElement>('#lpSel')
lpSel.addEventListener('change', () => { state.launchpad = lpSel.value; render() })
segmented($('#sortSeg'), (v) => { state.sort = v; render() })
filterInput.addEventListener('input', debounce(() => { state.query = filterInput.value.trim().toLowerCase(); render() }, 120))

async function load(): Promise<void> {
  state.loading = true
  state.error = null
  list.setAttribute('aria-busy', 'true')
  setHtml(list, skeletonRows(8, [34, 10, 22, 8, 8, 8]))
  const r = await api<FeedResponse>('/api/oracle/feed?limit=250')
  state.loading = false
  list.setAttribute('aria-busy', 'false')
  if (!r.ok || !r.data) {
    state.error = errorMessage(r, 'Could not load the tape.')
    render()
    return
  }
  state.items.clear()
  for (const it of r.data.items) state.items.set(it.token.toLowerCase(), it)
  state.loadedAt = Date.now()
  render()
}

function visibleItems(): FeedItem[] {
  let items = [...state.items.values()]
  if (state.tier !== 'all') items = items.filter((i) => i.score.tier === state.tier)
  if (state.launchpad !== 'all') items = items.filter((i) => i.launchpad === state.launchpad)
  if (state.query) {
    const q = state.query
    items = items.filter((i) => (i.symbol ?? '').toLowerCase().includes(q) || (i.name ?? '').toLowerCase().includes(q) || i.token.toLowerCase().includes(q))
  }
  items.sort(state.sort === 'score'
    ? (a, b) => b.score.score - a.score.score || Date.parse(b.score.scoredAt) - Date.parse(a.score.scoredAt)
    : (a, b) => Date.parse(b.score.scoredAt) - Date.parse(a.score.scoredAt))
  return items
}

function pendingRows(): Raw[] {
  if (state.query || state.tier !== 'all') return []
  const rows: Raw[] = []
  for (const p of [...state.pending.values()].sort((a, b) => b.at - a.at)) {
    const lp = p.launch?.launchpad ?? 'noxa'
    if (state.launchpad !== 'all' && lp !== state.launchpad) continue
    const sym = p.launch ? symbolOf(p.launch) : shortAddr(p.token)
    rows.push(h`<a class="trow feedrow pending" href="/app/coin/${p.token}">
      <div class="sym"><span>${sym}</span><span class="name">${p.launch?.name ?? ''}</span>
        <div class="subline" style="width:100%"><span class="badge b-${lp}">${lp}</span><span>${p.snapshot ? 'features captured, scoring' : 'observing 90s window'}</span><span>${ago(p.at)} ago</span></div></div>
      <div><span class="tierpill tp-watch">pending</span></div>
      ${pillarBars(null, true)}
      <div class="num hide-sm">…<small>rug</small></div>
      <div class="num hide-sm">…<small>conf</small></div>
      <div class="score">scoring</div>
    </a>`)
  }
  return rows
}

function row(it: FeedItem): Raw {
  const f = it.features
  const s = it.score
  const buyers = f?.unique_buyers
  const net = f?.net_volume_eth
  const cat = f?.category
  const fresh = state.fresh.has(it.token.toLowerCase())
  return h`<a class="trow feedrow ${fresh ? 'flash' : ''}" href="/app/coin/${it.token}" data-token="${it.token.toLowerCase()}">
    <div class="sym"><span>${symbolOf(it)}</span><span class="name">${it.name && it.name !== it.symbol ? it.name : ''}</span>
      <div class="subline" style="width:100%">
        <span class="badge b-${it.launchpad}">${it.launchpad}</span>
        <span>${it.venue}${it.graduatedAt ? ' · graduated' : ''}</span>
        ${cat && cat !== 'unknown' ? h`<span>${cat}</span>` : ''}
        ${buyers != null ? h`<span>${fmtNum(buyers)} buyers</span>` : ''}
        ${net != null ? h`<span class="${net >= 0 ? 'up' : 'dn'}">${net >= 0 ? '+' : ''}${net.toFixed(3)} Ξ net</span>` : ''}
        <span title="${s.scoredAt}">${ago(s.scoredAt)} ago</span>
      </div>
    </div>
    <div>${tierPill(s.tier)}</div>
    ${pillarBars(s.pillars, true)}
    <div class="num hide-sm ${s.rugRisk >= 0.5 ? 'dn' : ''}">${fmtRatio(s.rugRisk)}<small>rug</small></div>
    <div class="num hide-sm">${fmtRatio(s.confidence)}<small>conf</small></div>
    <div class="score ${s.score >= 70 ? 'hi' : ''}">${Math.round(s.score)}</div>
  </a>`
}

function render(): void {
  if (state.loading) return
  const items = visibleItems()
  const pending = pendingRows()
  $('#feedCount').textContent = state.items.size ? `${items.length}${items.length !== state.items.size ? ' / ' + state.items.size : ''}` : ''
  const top = items.filter((i) => i.score.tier === 'prime' || i.score.tier === 'strong').length
  const stTop = $('#stTop')
  stTop.classList.remove('sk')
  stTop.textContent = String(top)
  $('#stTopSub').textContent = items.length ? `of ${items.length} in view` : 'nothing in view'

  if (state.error) {
    stateBlock(list, { kind: 'error', title: 'Could not reach the oracle', body: state.error, action: { label: 'Retry', onClick: () => void load() } })
    return
  }
  if (!items.length && !pending.length) {
    if (!state.items.size) {
      stateBlock(list, {
        title: 'Waiting for the next launch on 4663',
        body: shell.streamConnected
          ? 'The tape is live. The first NOXA or Odyssey launch the engine sees will land here within about 90 seconds of first sight, scored.'
          : 'The dashboard stream is reconnecting. Scores will appear as soon as the engine reports one.',
      })
    } else {
      stateBlock(list, {
        title: 'Nothing matches these filters',
        body: 'Loosen the tier, launchpad, or search to see more of the tape.',
        action: { label: 'Clear filters', onClick: clearFilters },
      })
    }
    return
  }
  setHtml(list, h`${pending}${items.map(row)}`)
  state.fresh.clear()
}

function clearFilters(): void {
  state.tier = 'all'
  state.launchpad = 'all'
  state.query = ''
  filterInput.value = ''
  segmented($('#tierSeg')).set('all')
  lpSel.value = 'all'
  render()
}

// ── live events ────────────────────────────────────────────────────────────

shell.on('launch', (e) => {
  if (e.kind !== 'launch') return
  const key = e.launch.token.toLowerCase()
  if (state.items.has(key)) return
  state.pending.set(key, { token: e.launch.token, launch: e.launch, snapshot: null, at: e.at })
  render()
})

shell.on('features', (e) => {
  if (e.kind !== 'features') return
  const key = e.snapshot.token.toLowerCase()
  const existing = state.items.get(key)
  if (existing) {
    existing.features = e.snapshot.features
    existing.missing = e.snapshot.missing
    existing.observedAt = e.snapshot.observedAt
    render()
    return
  }
  const p = state.pending.get(key) ?? { token: e.snapshot.token, launch: null, snapshot: null, at: e.at }
  p.snapshot = e.snapshot
  state.pending.set(key, p)
  render()
})

shell.on('score', (e) => {
  if (e.kind !== 'score') return
  const v = e.verdict
  const key = v.token.toLowerCase()
  const existing = state.items.get(key)
  const scoreWire: FeedItem['score'] = {
    id: `live-${e.at}`,
    token: v.token,
    score: v.score,
    tier: v.tier,
    rugRisk: v.rugRisk,
    probabilities: v.probabilities,
    pillars: v.pillars,
    hits: v.hits,
    reasons: v.reasons,
    confidence: v.confidence,
    modelVersion: v.modelVersion,
    scoredAt: v.scoredAt,
  }
  if (existing) {
    existing.score = scoreWire
    state.fresh.add(key)
    render()
    return
  }
  const p = state.pending.get(key)
  if (p?.launch) {
    const l = p.launch
    state.items.set(key, {
      token: l.token,
      network: l.network,
      launchpad: l.launchpad,
      venue: l.venue,
      pool: l.pool,
      creator: l.creator,
      name: l.name,
      symbol: l.symbol,
      decimals: l.decimals,
      metadata: l.metadata,
      blockNumber: l.blockNumber,
      firstSeenAt: l.firstSeenAt,
      graduatedAt: l.graduatedAt,
      feedLeadMs: l.feedLeadMs,
      score: scoreWire,
      features: p.snapshot?.features ?? null,
      missing: p.snapshot?.missing ?? [],
      observedAt: p.snapshot?.observedAt ?? null,
    })
    state.pending.delete(key)
    state.fresh.add(key)
    render()
    return
  }
  // Scored before this page saw its launch: pull the launch row once.
  void api<CoinResponse>(`/api/oracle/coin/${v.token}`).then((r) => {
    if (!r.ok || !r.data) return
    const l = r.data.launch
    state.items.set(key, {
      token: l.token,
      network: l.network,
      launchpad: l.launchpad,
      venue: l.venue,
      pool: l.pool,
      creator: l.creator,
      name: l.name,
      symbol: l.symbol,
      decimals: l.decimals,
      metadata: l.metadata,
      blockNumber: l.blockNumber,
      firstSeenAt: l.firstSeenAt,
      graduatedAt: l.graduatedAt,
      feedLeadMs: l.feedLeadMs,
      score: scoreWire,
      features: r.data.features?.features ?? null,
      missing: r.data.features?.missing ?? [],
      observedAt: r.data.features?.observedAt ?? null,
    })
    state.pending.delete(key)
    state.fresh.add(key)
    render()
  })
})

shell.on('graduation', (e) => {
  if (e.kind !== 'graduation') return
  const it = state.items.get(e.token.toLowerCase())
  if (!it) return
  it.venue = 'pool'
  it.pool = e.pool
  it.graduatedAt = new Date(e.at).toISOString()
  render()
})

shell.onStreamState((connected) => {
  $('#tapeDot').className = 'dot ' + (connected ? 'live' : 'off')
  $('#tapeStatus').textContent = connected ? 'Live · scores stream in as the engine produces them' : 'Reconnecting to the engine…'
  $('#heroDot').className = 'dot ' + (connected ? 'live' : 'off')
  if (!state.loading && !state.items.size) render()
})

shell.onStatus((s) => {
  if (s.launchpads.length && lpSel.options.length !== s.launchpads.length + 1) {
    const cur = lpSel.value
    lpSel.innerHTML = '<option value="all">All launchpads</option>' + s.launchpads.map((p) => `<option value="${p}">${p}</option>`).join('')
    lpSel.value = s.launchpads.includes(cur as (typeof s.launchpads)[number]) ? cur : 'all'
  }
  $('#heroLive').textContent = `${connectedLabel(s.engine.feed.connected)} · Robinhood Chain ${s.chainId}`
  const set = (id: string, v: string) => {
    const el = $(id)
    el.classList.remove('sk')
    el.textContent = v
  }
  set('#stScored', s.counts.scores24h.toLocaleString())
  $('#stScoredSub').textContent = `${s.counts.scores.toLocaleString()} all time · ${s.model.source === 'bootstrap' ? 'bootstrap prior' : 'model v' + s.model.version}`
  set('#stLaunches', s.counts.launches24h.toLocaleString())
  set('#stOpen', String(s.engine.positions.open))
  $('#stOpenSub').textContent = `${s.counts.arms.enabled} of ${s.counts.arms.total} arms enabled${s.counts.arms.live ? `, ${s.counts.arms.live} live` : ''}`
  $('#tapeMeta').textContent = state.loadedAt ? `${state.items.size} tokens · head ${s.engine.headBlock != null ? '#' + s.engine.headBlock : 'n/a'}` : ''
})

function connectedLabel(feed: boolean): string {
  return feed ? 'Sequencer feed live' : 'Log polling'
}

async function loadModelBanner(): Promise<void> {
  const r = await api<ModelResponse>('/api/oracle/model')
  const el = $('#modelBanner')
  if (!r.ok || !r.data) {
    setHtml(el, h`<div class="banner red"><span class="b-icon">!</span><div><span class="b-title">Model unavailable</span>${errorMessage(r)}</div></div>`)
    return
  }
  const m = r.data
  const auc = m.holdout?.win?.auc
  if (m.source === 'bootstrap') {
    setHtml(el, h`<div class="banner amber"><span class="b-icon">PRIOR</span><div>
      <span class="b-title">Bootstrap prior active: these scores are not yet fitted on Robinhood Chain outcomes.</span>
      ${m.provenance} Model v${m.version}, ${m.trainingRows.toLocaleString()} training rows${m.fittedAt ? `, fitted ${new Date(m.fittedAt).toLocaleDateString()}` : ''}${auc != null ? `, holdout AUC ${auc.toFixed(3)}` : ''}. The first promoted refit from realized 4663 labels replaces it automatically; until then treat tiers as a prior, size small, and prefer simulate mode.
    </div></div>`)
  } else {
    setHtml(el, h`<div class="banner"><span class="b-icon" style="color:var(--up)">FIT</span><div>
      <span class="b-title">Model v${m.version} promoted from ${m.trainingRows.toLocaleString()} realized Robinhood Chain outcomes${m.fittedAt ? ` (fitted ${ago(m.fittedAt)} ago)` : ''}.</span>
      ${m.provenance}${auc != null ? ` Holdout AUC ${auc.toFixed(3)} on the win head.` : ''} ${m.features.length} features across four pillars.
    </div></div>`)
  }
}

void load()
void loadModelBanner()
setInterval(() => { if (!document.hidden && !state.loading) render() }, 30_000)
