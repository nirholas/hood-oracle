/**
 * Per-arm entry evaluation. Every filter an arm carries is checked in a fixed
 * order and the FIRST failing filter is named in the verdict, so a dashboard
 * can show "skipped: min_unique_buyers (3 < 8)" instead of "skipped". A
 * filter that is set but whose feature was not observed fails closed: the
 * arm asked for a bound and we could not prove it holds.
 *
 * The optional LLM decision arm (decisionMode 'llm') speaks to one provider
 * over fetch and demands a strict JSON verdict. Malformed output is a skip
 * with an alert, never an implicit buy.
 */
import type { Arm, FeatureSnapshot, GuardVerdict, LaunchRecord, OracleVerdict, Trigger } from '../types.js'
import type { Config } from '../config.js'

export interface GateInput {
  arm: Arm
  launch: LaunchRecord
  trigger: Trigger
  snapshot: FeatureSnapshot | null
  verdict: OracleVerdict | null
  /** Live market cap in ETH when the caller has it; falls back to the snapshot's first-seen cap. */
  marketCapEth: number | null
}

const fail = (reason: GuardVerdict['reason'], detail: string): GuardVerdict => ({ ok: false, reason, detail })
const pass = (detail: string): GuardVerdict => ({ ok: true, detail })

export function launchHasSocials(launch: LaunchRecord): boolean {
  const m = launch.metadata
  return Boolean(m.website || m.twitter || m.telegram)
}

export function evaluateEntry(input: GateInput): GuardVerdict {
  const { arm, launch, trigger, snapshot, verdict } = input
  if (!arm.enabled) return fail('disarmed', `arm ${arm.label} is not armed`)
  if (arm.killSwitch) return fail('kill_switch', `arm ${arm.label} has its kill switch set`)
  if (arm.network !== launch.network) return fail('entry_filter', `network: arm is ${arm.network}, launch is ${launch.network}`)
  if (arm.trigger !== trigger) return fail('entry_filter', `trigger: arm fires on ${arm.trigger}, this is ${trigger}`)
  if (!arm.launchpads.includes(launch.launchpad)) return fail('entry_filter', `launchpads: ${launch.launchpad} not in [${arm.launchpads.join(', ')}]`)

  const f = snapshot?.features ?? null

  if (arm.minOracleScore != null) {
    if (!verdict) return fail('oracle_gate', `min_oracle_score ${arm.minOracleScore}: launch is unscored`)
    if (verdict.score < arm.minOracleScore) return fail('oracle_gate', `min_oracle_score: ${verdict.score.toFixed(1)} < ${arm.minOracleScore}`)
  }
  if (arm.maxRugRisk != null) {
    if (!verdict) return fail('oracle_gate', `max_rug_risk ${arm.maxRugRisk}: launch is unscored`)
    if (verdict.rugRisk > arm.maxRugRisk) return fail('oracle_gate', `max_rug_risk: ${verdict.rugRisk.toFixed(3)} > ${arm.maxRugRisk}`)
  }
  if (arm.minUniqueBuyers != null) {
    if (f?.unique_buyers == null) return fail('entry_filter', `min_unique_buyers ${arm.minUniqueBuyers}: unique_buyers not observed`)
    if (f.unique_buyers < arm.minUniqueBuyers) return fail('entry_filter', `min_unique_buyers: ${f.unique_buyers} < ${arm.minUniqueBuyers}`)
  }
  if (arm.maxCreatorLaunches != null) {
    if (f?.creator_launches == null) return fail('entry_filter', `max_creator_launches ${arm.maxCreatorLaunches}: creator history unavailable`)
    if (f.creator_launches > arm.maxCreatorLaunches) return fail('entry_filter', `max_creator_launches: ${f.creator_launches} > ${arm.maxCreatorLaunches}`)
  }
  if (arm.maxDeployerPct != null) {
    if (f?.deployer_holding_pct == null) return fail('entry_filter', `max_deployer_pct ${arm.maxDeployerPct}: deployer holding unavailable`)
    const pct = f.deployer_holding_pct * 100
    if (pct > arm.maxDeployerPct) return fail('entry_filter', `max_deployer_pct: deployer holds ${pct.toFixed(1)}% > ${arm.maxDeployerPct}%`)
  }
  if (arm.maxBundleScore != null) {
    if (f?.bundle_score == null) return fail('entry_filter', `max_bundle_score ${arm.maxBundleScore}: bundle_score not observed`)
    if (f.bundle_score > arm.maxBundleScore) return fail('entry_filter', `max_bundle_score: ${f.bundle_score.toFixed(2)} > ${arm.maxBundleScore}`)
  }
  if (arm.maxConcentrationTop1 != null) {
    if (f?.concentration_top1 == null) return fail('entry_filter', `max_concentration_top1 ${arm.maxConcentrationTop1}: holder concentration not observed`)
    if (f.concentration_top1 > arm.maxConcentrationTop1) return fail('entry_filter', `max_concentration_top1: ${f.concentration_top1.toFixed(2)} > ${arm.maxConcentrationTop1}`)
  }
  if (arm.minMarketCapEth != null || arm.maxMarketCapEth != null) {
    const mc = input.marketCapEth ?? f?.mc_eth_first_seen ?? null
    if (mc == null) return fail('entry_filter', 'market cap band: market cap unavailable')
    if (arm.minMarketCapEth != null && mc < arm.minMarketCapEth) return fail('entry_filter', `min_market_cap_eth: ${mc.toFixed(4)} < ${arm.minMarketCapEth}`)
    if (arm.maxMarketCapEth != null && mc > arm.maxMarketCapEth) return fail('entry_filter', `max_market_cap_eth: ${mc.toFixed(4)} > ${arm.maxMarketCapEth}`)
  }
  if (arm.requireSocials && !launchHasSocials(launch)) return fail('entry_filter', 'require_socials: launch carries no website, twitter or telegram')
  if (arm.avoidDevDump) {
    if (f?.dev_sold == null) return fail('entry_filter', 'avoid_dev_dump: creator activity not observed')
    if (f.dev_sold) return fail('entry_filter', 'avoid_dev_dump: creator sold or moved tokens inside the window')
  }
  if (arm.allowedCategories && arm.allowedCategories.length) {
    const cat = f?.category ?? 'unknown'
    if (!arm.allowedCategories.includes(cat)) return fail('entry_filter', `allowed_categories: ${cat} not in [${arm.allowedCategories.join(', ')}]`)
  }
  return pass(`entry filters passed${verdict ? ` (oracle ${verdict.score.toFixed(1)} ${verdict.tier})` : ''}`)
}

// ── LLM decision arm ──────────────────────────────────────────────────────────

export interface LlmVerdict {
  buy: boolean
  /** Clamped to [0, 1]. */
  confidence: number
  thesis: string
  model: string
}

const DEFAULT_MODELS = {
  anthropic: 'claude-haiku-4-5-20251001',
  openai: 'gpt-4o-mini',
  groq: 'llama-3.3-70b-versatile',
  openrouter: 'openrouter/auto',
} as const

const SYSTEM_PROMPT = [
  'You are a risk-averse trading analyst judging a brand-new token launch on Robinhood Chain,',
  'a 24/7 permissionless DEX environment where most launches are worthless or scams.',
  'You will be given real on-chain facts about one launch: launchpad, observed 90-second tape',
  'features (buyers, volumes, concentration, bundling, creator behaviour), and the conviction',
  "oracle's score and reasons. You have no access to socials or off-chain information.",
  '',
  'Reply with ONLY a single JSON object, no prose before or after it, matching exactly:',
  '{"buy": boolean, "confidence": number between 0 and 1, "thesis": "one sentence"}',
  '',
  '"buy" should be true only when the facts suggest this launch is unusually clean and has',
  'organic demand; most launches should get buy:false. "confidence" reflects how sure you are',
  'given how thin the available signal is.',
].join('\n')

export function buildLaunchBrief(input: GateInput): string {
  const { launch, snapshot, verdict } = input
  const lines = [
    `launchpad: ${launch.launchpad}; venue: ${launch.venue}; name: ${launch.name ?? 'unknown'} (${launch.symbol ?? '?'})`,
    `creator: ${launch.creator}; socials: ${launchHasSocials(launch) ? 'present' : 'none'}`,
  ]
  if (snapshot) {
    const f = snapshot.features
    lines.push(`window ${snapshot.windowSeconds}s features: ${JSON.stringify(f)}`)
    if (snapshot.missing.length) lines.push(`unobserved features: ${snapshot.missing.join(', ')}`)
  } else {
    lines.push('no feature snapshot yet (pre-observation)')
  }
  if (verdict) {
    lines.push(`oracle: score ${verdict.score.toFixed(1)} tier ${verdict.tier} rugRisk ${verdict.rugRisk.toFixed(3)} confidence ${verdict.confidence.toFixed(2)} model ${verdict.modelVersion}`)
    lines.push(`oracle reasons: ${verdict.reasons.join(' | ')}`)
  }
  return lines.join('\n')
}

/** Ask the configured provider. Throws on timeout, HTTP error, or malformed verdict. */
export async function judgeLaunch(llm: NonNullable<Config['llm']>, brief: string, timeoutMs = 9_000): Promise<LlmVerdict> {
  const model = llm.model || DEFAULT_MODELS[llm.provider]
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const text = await callProvider(llm.provider, llm.apiKey, model, brief, controller.signal)
    return { ...parseVerdict(text), model }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw new Error(`${llm.provider} request timed out after ${timeoutMs}ms`)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

async function callProvider(provider: NonNullable<Config['llm']>['provider'], apiKey: string, model: string, brief: string, signal: AbortSignal): Promise<string> {
  if (provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 300, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: brief }] }),
    })
    const body = await res.text()
    if (!res.ok) throw new Error(`anthropic rejected request (HTTP ${res.status}, model ${model}): ${body.slice(0, 300)}`)
    const data = JSON.parse(body) as { content?: { text?: string }[] }
    const text = data.content?.[0]?.text
    if (!text) throw new Error(`anthropic response had no content text: ${body.slice(0, 300)}`)
    return text
  }
  const url = provider === 'openai' ? 'https://api.openai.com/v1/chat/completions'
    : provider === 'groq' ? 'https://api.groq.com/openai/v1/chat/completions'
    : 'https://openrouter.ai/api/v1/chat/completions'
  const res = await fetch(url, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}`, ...(provider === 'openrouter' ? { 'HTTP-Referer': 'https://github.com/nirholas/hood-oracle', 'X-Title': 'hood-oracle' } : {}) },
    body: JSON.stringify({ model, max_tokens: 300, messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: brief }] }),
  })
  const body = await res.text()
  if (!res.ok) throw new Error(`${provider} rejected request (HTTP ${res.status}, model ${model}): ${body.slice(0, 300)}`)
  const data = JSON.parse(body) as { choices?: { message?: { content?: string } }[] }
  const text = data.choices?.[0]?.message?.content
  if (!text) throw new Error(`${provider} response had no message content: ${body.slice(0, 300)}`)
  return text
}

/** Extract the first {...} blob and validate it field by field. Throws on any mismatch. */
export function parseVerdict(text: string): Omit<LlmVerdict, 'model'> {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) throw new Error(`no JSON object found in LLM response: ${text.slice(0, 200)}`)
  let raw: unknown
  try {
    raw = JSON.parse(match[0])
  } catch (err) {
    throw new Error(`LLM response JSON did not parse: ${(err as Error).message}`)
  }
  if (typeof raw !== 'object' || raw === null) throw new Error('LLM verdict was not a JSON object')
  const v = raw as Record<string, unknown>
  if (typeof v.buy !== 'boolean') throw new Error(`LLM verdict missing boolean "buy": ${JSON.stringify(v).slice(0, 200)}`)
  if (typeof v.thesis !== 'string' || !v.thesis.trim()) throw new Error('LLM verdict missing non-empty "thesis"')
  const c = typeof v.confidence === 'number' ? v.confidence : Number(v.confidence)
  if (!Number.isFinite(c)) throw new Error('LLM verdict has non-numeric "confidence"')
  return { buy: v.buy, confidence: Math.min(1, Math.max(0, c)), thesis: v.thesis.trim() }
}

/** Turn an LLM verdict into a guard verdict under the arm's confidence floor. */
export function llmVerdictGate(verdict: LlmVerdict, arm: Arm): GuardVerdict {
  const floor = arm.llmMinConfidence ?? 0.6
  if (!verdict.buy) return fail('llm_declined', `${verdict.model} declined (confidence ${verdict.confidence.toFixed(2)}): ${verdict.thesis}`)
  if (verdict.confidence < floor) return fail('llm_declined', `${verdict.model} said buy at ${verdict.confidence.toFixed(2)} < floor ${floor}: ${verdict.thesis}`)
  return pass(`${verdict.model} buy at ${verdict.confidence.toFixed(2)}: ${verdict.thesis}`)
}
