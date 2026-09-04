/** One launch: header, score gauge + pillars + hits, feature table, score history, firewall, positions, journal. */
import type { CoinResponse, ScoreWire } from '../../src/api/contract'
import { api, errorMessage } from './api'
import { $, $$, copyText, h, pillarBars, setHtml, stateBlock, tierPill, toast, type Raw } from './dom'
import { ago, fmtDate, fmtEth, fmtRatio, fmtSignedEth, fmtSignedPct, pnlPct, shortAddr, shortHash, symbolOf } from './format'
import { mountShell } from './shell'

const shell = mountShell({ page: 'coin' })

const token = decodeURIComponent(location.pathname.replace(/^\/app\/coin\/?/, '')).trim()
const page = $('#page')
let data: CoinResponse | null = null

const FEATURE_GROUPS: { pillar: string; keys: string[] }[] = [
  { pillar: 'structure', keys: ['organic_score', 'bundle_score', 'snipe_ratio', 'coordination_score', 'timing_entropy', 'concentration_top1', 'concentration_top5', 'concentration_top10', 'fresh_wallet_ratio', 'bubblemap_connectivity'] },
  { pillar: 'momentum', keys: ['unique_buyers', 'unique_sellers', 'buy_sell_ratio', 'buy_volume_eth', 'sell_volume_eth', 'net_volume_eth', 'trade_count', 'largest_buy_eth', 'avg_buy_eth', 'median_buy_eth', 'mc_eth_first_seen'] },
  { pillar: 'pedigree', keys: ['dev_buy_eth', 'dev_sell_eth', 'dev_sold', 'smart_money_count', 'creator_launches', 'creator_wins', 'deployer_holding_pct'] },
  { pillar: 'narrative', keys: ['category', 'narrative_confidence'] },
]
const RATIO_KEYS = new Set(['snipe_ratio', 'concentration_top1', 'concentration_top5', 'concentration_top10', 'fresh_wallet_ratio', 'bubblemap_connectivity', 'deployer_holding_pct', 'narrative_confidence', 'timing_entropy'])

if (!/^0x[0-9a-fA-F]{40}$/.test(token)) {
  page.setAttribute('aria-busy', 'false')
  stateBlock(page, { kind: 'error', title: 'That is not a token address', body: 'Open a launch from the tape, or use /app/coin/0x… with a 20-byte address.', href: { label: 'Back to the tape', url: '/app' } })
} else {
  $('#crumbToken').textContent = shortAddr(token)
  void load()
}

async function load(): Promise<void> {
  const r = await api<CoinResponse>(`/api/oracle/coin/${token}`)
  page.setAttribute('aria-busy', 'false')
  if (!r.ok || !r.data) {
    if (r.status === 404) {
      stateBlock(page, {
        title: 'Not seen by the engine',
        body: 'This token has not been picked up as a NOXA or Odyssey launch on this network. The engine only scores launches it saw at first sight or backfilled from chain history.',
        href: { label: 'Back to the tape', url: '/app' },
      })
    } else {
      stateBlock(page, { kind: 'error', title: 'Could not load this launch', body: errorMessage(r), action: { label: 'Retry', onClick: () => void load() } })
    }
    return
  }
  data = r.data
  render()
  drawHistory()
}

function render(): void {
  if (!data) return
  const d = data
  const l = d.launch
  const s = d.latest
  const sym = symbolOf(l)
  document.title = `${sym} · ${s ? Math.round(s.score) + ' ' + s.tier : 'unscored'} · hood-oracle`
  $('#crumbToken').textContent = sym
  const meta = l.metadata
  const link = (label: string, url: unknown) => (typeof url === 'string' && /^https?:\/\//.test(url) ? h`<span class="chip"><a href="${url}" target="_blank" rel="noopener">${label}</a></span>` : '')

  setHtml(page, h`
    <div class="hero coin-head">
      <div>
        <div class="coin-meta">
          <span class="badge b-${l.launchpad}">${l.launchpad}</span>
          <span class="badge">${l.venue}${l.graduatedAt ? ' · graduated ' + ago(l.graduatedAt) + ' ago' : ''}</span>
          ${s ? tierPill(s.tier) : h`<span class="tierpill tp-watch">unscored</span>`}
        </div>
        <h1>${sym}${l.name && l.name !== l.symbol ? h`<span class="muted" style="font-weight:500;font-size:.6em">${l.name}</span>` : ''}</h1>
        <div class="coin-meta">
          <span class="chip">token <a class="addr" href="${shell.explorerUrl('token', l.token)}" target="_blank" rel="noopener">${shortAddr(l.token, 8, 6)}</a><button type="button" class="copy" data-copy="${l.token}">copy</button></span>
          <span class="chip">creator <a class="addr" href="${shell.explorerUrl('address', l.creator)}" target="_blank" rel="noopener">${shortAddr(l.creator)}</a></span>
          ${l.pool ? h`<span class="chip">pool <a class="addr" href="${shell.explorerUrl('address', l.pool)}" target="_blank" rel="noopener">${shortAddr(l.pool)}</a></span>` : ''}
          <span class="chip">first seen <b title="${l.firstSeenAt}">${ago(l.firstSeenAt)} ago</b> · block <b>${l.blockNumber}</b>${l.feedLeadMs != null ? h` · feed lead <b>${l.feedLeadMs}ms</b>` : ''}</span>
          ${link('website', meta.website)}${link('x', meta.twitter)}${link('telegram', meta.telegram)}
        </div>
      </div>
      <div class="btn-row"><a class="btn sm" href="/app/arm">Arm on this</a><a class="btn sm ghost" href="/app">Tape</a></div>
    </div>
    ${d.outcome ? outcomeBanner(d) : ''}
    <div class="layout">
      <div class="col">
        <div class="card" id="scoreCard">${scoreCard(d)}</div>
        <div class="card"><div class="card-head"><div><h3>Features</h3><p class="sub">The 90-second snapshot the score was computed from${d.features ? h`, observed ${ago(d.features.observedAt)} ago over ${d.features.windowSeconds}s` : ''}. Missing keys were never fabricated.</p></div></div><div id="featureTable">${featureTable(d)}</div></div>
        <div class="card"><div class="card-head"><div><h3>Score history <span class="badge">${d.scores.length}</span></h3><p class="sub">Every score under every model version, newest first.</p></div></div>${history(d.scores)}</div>
      </div>
      <div class="col">
        <div class="card" id="firewallCard">${firewallCard(d)}</div>
        <div class="card"><div class="card-head"><div><h3>Positions on it <span class="badge">${d.positions.length || ''}</span></h3><p class="sub">Every arm that took this launch.</p></div></div><div id="positionsBlock">${positionsBlock(d)}</div></div>
        <div class="card"><div class="card-head"><div><h3>Journal <span class="badge">${d.decisions.length || ''}</span></h3><p class="sub">Decisions the engine recorded for this token.</p></div></div>${journal(d)}</div>
        ${d.creator ? h`<div class="card"><h3>Creator record</h3><p class="sub">${shortAddr(l.creator)} across every launch the engine has labeled.</p><div class="kv"><div>launches</div><div>${d.creator.launches}</div><div>wins</div><div class="up">${d.creator.wins}</div><div>rugs</div><div class="dn">${d.creator.rugs}</div><div>last launch</div><div>${d.creator.lastLaunchAt ? ago(d.creator.lastLaunchAt) + ' ago' : 'n/a'}</div></div></div>` : ''}
      </div>
    </div>`)
  for (const b of $$<HTMLButtonElement>('[data-copy]', page)) b.addEventListener('click', () => void copyText(b.dataset.copy as string))
}

function outcomeBanner(d: CoinResponse): Raw {
  const o = d.outcome!
  const cls = o.rug ? 'red' : o.win ? '' : 'amber'
  return h`<div class="banner ${cls}"><span class="b-icon">${o.rug ? 'RUG' : o.win ? 'WIN' : 'FLAT'}</span><div><span class="b-title">Outcome resolved ${ago(o.resolvedAt)} ago: ${o.rug ? 'a first-sight holder ended down more than half.' : o.win ? 'it ran and a first-sight holder is still up.' : 'it neither ran nor rugged.'}</span>${o.athMultiple != null ? `Peak ${o.athMultiple.toFixed(2)}x from first sight. ` : ''}${o.moon ? 'Counted as a moon. ' : ''}${o.realizedWin != null ? `Our own trades: ${o.realizedWin ? 'won' : 'lost'}${o.realizedPnlPct != null ? ` (${fmtSignedPct(o.realizedPnlPct)})` : ''}.` : ''}</div></div>`
}

function scoreCard(d: CoinResponse): Raw {
  const s = d.latest
  if (!s) {
    return h`<div class="state compact"><b>Not scored yet</b>${d.features ? 'Features are in; the score follows on the next scoring tick.' : 'The 90-second observation window has not closed. The score lands once features are captured.'}</div>`
  }
  const r = 62
  const c = 2 * Math.PI * r
  const off = c * (1 - Math.max(0, Math.min(100, s.score)) / 100)
  const hits = [...s.hits].sort((a, b) => Number(b.present) - Number(a.present) || Math.abs(b.w) - Math.abs(a.w))
  return h`<div class="card-head"><div><h3>Conviction</h3><p class="sub">Model ${s.modelVersion} · scored ${ago(s.scoredAt)} ago · ${fmtRatio(s.confidence)} of features observed</p></div>${tierPill(s.tier)}</div>
    <div class="score-grid">
      <div class="gauge ${s.tier}"><svg viewBox="0 0 150 150"><circle class="g-track" cx="75" cy="75" r="${r}"></circle><circle class="g-fill" cx="75" cy="75" r="${r}" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"></circle></svg><div class="g-val"><div><b>${Math.round(s.score)}</b><span>${s.tier}</span></div></div></div>
      <div class="score-side">
        <div class="line"><span>Rug risk (published separately)</span><b class="${s.rugRisk >= 0.5 ? 'dn' : ''}">${fmtRatio(s.rugRisk)}</b></div>
        <div class="line"><span>P(win)</span><b>${fmtRatio(s.probabilities.win)}</b></div>
        <div class="line"><span>P(moon)</span><b>${fmtRatio(s.probabilities.moon)}</b></div>
        <div class="line"><span>P(rug)</span><b>${fmtRatio(s.probabilities.rug)}</b></div>
        ${pillarBars(s.pillars)}
      </div>
    </div>
    ${s.reasons.length ? h`<ul class="reasons">${s.reasons.map((x) => h`<li>${x}</li>`)}</ul>` : ''}
    <ul class="hits">${hits.slice(0, 14).map((x) => h`<li class="${x.present ? '' : 'absent'}" title="${x.pillar} · bucket ${x.bucket}${x.n != null ? ' · n=' + x.n : ''}"><span class="hk">${x.key}</span><span class="hb">${x.present ? x.bucket : 'not observed'}</span><span class="hw ${x.present ? (x.w > 0 ? 'up' : x.w < 0 ? 'dn' : '') : ''}">${x.present ? (x.w > 0 ? '+' : '') + x.w.toFixed(2) : '0'}</span></li>`)}</ul>`
}

function fmtFeature(key: string, v: unknown): string {
  if (v == null) return 'not observed'
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  if (typeof v === 'number') {
    if (RATIO_KEYS.has(key)) return fmtRatio(v, 1)
    if (key.endsWith('_eth')) return `${v.toFixed(v >= 1 ? 3 : 5)} Ξ`
    return Number.isInteger(v) ? String(v) : v.toFixed(2)
  }
  return String(v)
}

function featureTable(d: CoinResponse): Raw {
  if (!d.features) return h`<div class="state compact"><b>No snapshot yet</b>The observation window runs 90 seconds from first sight.</div>`
  const f = d.features.features as unknown as Record<string, unknown>
  const missing = new Set(d.features.missing)
  return h`${FEATURE_GROUPS.map((g) => h`<div class="kv-group">${g.pillar}</div><div class="kv">${g.keys.map((k) => {
    const absent = missing.has(k) || f[k] == null
    return h`<div>${k}</div><div class="${absent ? 'missing' : ''}">${absent ? 'not observed' : fmtFeature(k, f[k])}</div>`
  })}</div>`)}`
}

function history(scores: ScoreWire[]): Raw {
  if (!scores.length) return h`<div class="state compact">No scores yet.</div>`
  const vals = [...scores].reverse().map((s) => s.score)
  return h`<div class="hist">${vals.length > 1 ? h`<canvas class="spark" id="histSpark" height="60" aria-label="Score history"></canvas>` : ''}<div class="hist-list">${scores.slice(0, 12).map((s) => h`<div><span><b>${Math.round(s.score)}</b> ${tierPill(s.tier)}</span><span>rug ${fmtRatio(s.rugRisk)}</span><span>${s.modelVersion}</span><span title="${s.scoredAt}">${fmtDate(s.scoredAt)}</span></div>`)}</div></div>`
}

function firewallCard(d: CoinResponse): Raw {
  const fw = d.firewall[0]
  if (!fw) {
    return h`<div class="card-head"><div><h3>Firewall</h3><p class="sub">Simulated buy-then-sell round trip before every live buy.</p></div></div><div class="state compact"><b>No firewall run yet</b>The firewall runs when an arm at level block or warn is about to buy. A token that can be bought but not sold is blocked, not flagged.</div>`
  }
  return h`<div class="card-head"><div><h3>Firewall</h3><p class="sub">${fw.venue} · ${fw.latencyMs}ms · ${ago(fw.assessedAt)} ago${d.firewall.length > 1 ? ` · ${d.firewall.length} runs` : ''}</p></div><span class="badge b-${fw.verdict === 'allow' ? 'pass' : fw.verdict === 'warn' ? 'warn' : 'fail'}">${fw.verdict}</span></div>
    <div class="score-side" style="margin-bottom:10px">
      <div class="line"><span>Clean score</span><b>${Math.round(fw.score)} / 100</b></div>
      <div class="line"><span>Round-trip loss</span><b class="${fw.roundTripLossPct != null && fw.roundTripLossPct > 0.15 ? 'dn' : ''}">${fw.roundTripLossPct != null ? fmtRatio(fw.roundTripLossPct, 1) : 'could not simulate'}</b></div>
    </div>
    ${fw.checks.map((c) => h`<div class="fw-check"><span class="badge b-${c.status}">${c.status}</span><div><div class="fk">${c.check}</div><div class="fr">${c.reason}</div></div><span class="fwt">w ${c.weight}</span></div>`)}`
}

function positionsBlock(d: CoinResponse): Raw {
  if (!d.positions.length) return h`<div class="state compact"><b>No arm took it</b>${d.latest ? 'Either no armed arm cleared its filters on this score, or a guard refused. The journal below says which.' : 'Nothing can buy before the score exists.'}</div>`
  return h`<div class="tape"><div class="tape-list">${d.positions.map((p) => {
    const pct = p.status === 'open' ? pnlPct(p.entryWei, p.lastValueWei) : p.realizedPnlPct
    const cls = pct == null ? '' : pct >= 0 ? 'up' : 'dn'
    return h`<div class="trow posrow"><div class="sym"><span>${p.armLabel}</span><span class="badge ${p.mode === 'live' ? 'b-live' : 'b-sim'}">${p.mode}</span><span class="badge ${p.status === 'open' ? 'b-on' : 'b-off'}">${p.status === 'open' ? 'open' : p.exitReason ?? p.status}</span><div class="subline" style="width:100%"><span>buy ${p.buyTx === 'SIMULATED' ? 'simulated' : shortHash(p.buyTx)}</span>${p.sellTx ? h`<span>sell ${p.sellTx === 'SIMULATED' ? 'simulated' : shortHash(p.sellTx)}</span>` : ''}</div></div>
      <div class="num">${fmtEth(p.entryWei, '')}<small>entry Ξ</small></div>
      <div class="num ${cls}">${p.status === 'open' ? fmtSignedPct(pct) : fmtSignedEth(p.realizedPnlWei)}<small>${p.status === 'open' ? 'unrealized' : 'realized'}</small></div>
      <div class="when" title="${p.openedAt}">${ago(p.openedAt)}</div></div>`
  })}</div></div>`
}

function journal(d: CoinResponse): Raw {
  if (!d.decisions.length) return h`<div class="state compact">No decisions recorded for this token.</div>`
  return h`<div class="tape"><div class="tape-list">${d.decisions.map((x) => h`<div class="trow decrow" title="${x.entryHash}"><div><span class="kind k-${x.kind}">${x.kind}</span></div><div style="min-width:0"><div style="font-size:12.5px">${x.reason}</div><div class="subline">${Object.entries(x.detail ?? {}).slice(0, 4).map(([k, v]) => h`<span>${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>`)}</div></div><div class="when" title="${x.at}">${ago(x.at)}</div></div>`)}</div></div>`
}

function drawHistory(): void {
  const canvas = document.getElementById('histSpark') as HTMLCanvasElement | null
  if (!canvas || !data) return
  const values = [...data.scores].reverse().map((s) => s.score)
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth || 300
  canvas.width = w * dpr
  canvas.height = 60 * dpr
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.scale(dpr, dpr)
  const css = getComputedStyle(document.documentElement)
  const color = css.getPropertyValue('--cyan').trim() || '#cdd2e0'
  const x = (i: number) => (i / Math.max(1, values.length - 1)) * (w - 2) + 1
  const y = (v: number) => 56 - (v / 100) * 52
  ctx.strokeStyle = css.getPropertyValue('--line').trim()
  ctx.beginPath()
  for (const g of [0, 50, 100]) { ctx.moveTo(0, y(g)); ctx.lineTo(w, y(g)) }
  ctx.stroke()
  ctx.strokeStyle = color
  ctx.lineWidth = 1.6
  ctx.beginPath()
  values.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))))
  ctx.stroke()
  ctx.fillStyle = color
  values.forEach((v, i) => { ctx.beginPath(); ctx.arc(x(i), y(v), 2.2, 0, Math.PI * 2); ctx.fill() })
}

const sameToken = (t: string) => t.toLowerCase() === token.toLowerCase()
shell.on('score', (e) => { if (e.kind === 'score' && sameToken(e.verdict.token)) { toast(`New score: ${Math.round(e.verdict.score)} ${e.verdict.tier}`, 'info'); void load() } })
shell.on('features', (e) => { if (e.kind === 'features' && sameToken(e.snapshot.token)) void load() })
shell.on('graduation', (e) => { if (e.kind === 'graduation' && sameToken(e.token)) void load() })
shell.on('position', (e) => { if (e.kind === 'position' && sameToken(e.position.token)) void load() })
shell.on('decision', (e) => { if (e.kind === 'decision' && e.decision.token && sameToken(e.decision.token)) void load() })
window.addEventListener('resize', drawHistory)
