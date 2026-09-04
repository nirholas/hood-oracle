/**
 * Oracle: narrative classifier.
 *
 * Not just "is it a meme": which kind of thesis is it? A news-riding meme, a
 * community coin, an AI play, an animal, a celebrity, a tokenized stock. Each
 * flavour behaves differently after launch, and the conviction model fits the
 * category as its own feature (see ./features.ts), so the read has to be
 * consistent between the backfill and the live engine.
 *
 * Two paths, both real:
 *   1. An LLM (whichever provider config.llm names) prompted for strict JSON,
 *      with a timeout and one retry. Ported from hood-traders' provider-agnostic
 *      fetch client: no SDK dependency, the response is parsed with a tolerant
 *      extractor and validated field by field.
 *   2. A deterministic keyword classifier when no LLM is configured or the
 *      call fails. It only needs to be directionally right.
 *
 * Never throws. A launch we cannot classify is 'unknown' with low confidence,
 * which is itself a fact the model can fit.
 */
import type { Category, NarrativeRead } from '../types.js'
import type { Config } from '../config.js'

export const CATEGORIES: readonly Category[] = Object.freeze([
  'meme', 'tech', 'ai', 'culture', 'community', 'political', 'news', 'animal', 'celebrity', 'utility', 'stock', 'unknown',
])
const CATEGORY_SET = new Set<string>(CATEGORIES)

export interface LaunchMeta {
  name?: string | null
  symbol?: string | null
  description?: string | null
  website?: string | null
  twitter?: string | null
  telegram?: string | null
}

export type LlmConfig = NonNullable<Config['llm']>

// Keyword lexicons for the deterministic fallback. Deliberately broad. Order
// matters for ties: more specific categories are tested first.
const LEXICON: Record<Exclude<Category, 'unknown'>, string[]> = {
  stock: ['stock', 'shares', 'equity', 'etf', 'nasdaq', 'nyse', 'tsla', 'nvda', 'aapl', 'amzn', 'msft', 'spy', 'earnings', 'ipo', 'ticker'],
  ai: ['ai', 'agent', 'gpt', 'llm', 'neural', 'model', 'machine learning', 'inference', 'agentic', 'autonomous', 'claude', 'openai'],
  tech: ['protocol', 'chain', 'zk', 'rollup', 'defi', 'staking', 'oracle', 'infra', 'sdk', 'api', 'l2', 'rwa', 'depin', 'bridge', 'wallet'],
  political: ['trump', 'biden', 'maga', 'election', 'president', 'senate', 'kamala', 'vance', 'government', 'vote', 'congress', 'tariff'],
  celebrity: ['elon', 'musk', 'kanye', 'taylor', 'drake', 'mrbeast', 'ronaldo', 'messi', 'celebrity', 'star', 'vlad', 'tenev'],
  animal: ['dog', 'cat', 'shiba', 'inu', 'frog', 'pepe', 'doge', 'wif', 'hat', 'bonk', 'monkey', 'ape', 'bird', 'penguin', 'hippo', 'capybara', 'goat', 'duck', 'fox', 'bear', 'bull'],
  news: ['breaking', 'just in', 'announced', 'launches', 'report', 'headline', 'today', 'news', 'leaked', 'confirmed', 'official'],
  community: ['community', 'dao', 'cto', 'takeover', 'family', 'army', 'holders', 'together', 'movement', 'frens'],
  culture: ['vibe', 'aesthetic', 'core', 'lore', 'meta', 'based', 'gigachad', 'sigma', 'brainrot', 'skibidi', 'rizz', 'wagmi', 'gm'],
  utility: ['tool', 'utility', 'dashboard', 'tracker', 'bot', 'scanner', 'terminal', 'app', 'platform', 'launchpad', 'swap'],
  meme: ['meme', 'coin', 'moon', 'pump', 'lol', 'kek', '420', '69', 'wojak', 'chad', 'hood', 'robinhood', 'degen'],
}
const HEURISTIC_ORDER: Exclude<Category, 'unknown'>[] = [
  'stock', 'ai', 'tech', 'political', 'celebrity', 'animal', 'news', 'community', 'culture', 'utility', 'meme',
]

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

function corpus(meta: LaunchMeta): string {
  return [meta.name, meta.symbol, meta.description].filter(Boolean).join(' ').toLowerCase()
}

/** Whole-word match so 'ai' does not fire on 'chain' and 'gm' does not fire on 'sigma'. */
function hasKeyword(text: string, kw: string): boolean {
  if (kw.includes(' ')) return text.includes(kw)
  const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(text)
}

/**
 * Deterministic keyword classifier. Scores each category by keyword hits,
 * picks the best, and derives confidence from how many hits agreed.
 */
export function heuristicNarrative(meta: LaunchMeta = {}): NarrativeRead {
  const text = corpus(meta)
  const tags: string[] = []
  let best: Category = 'unknown'
  let bestHits = 0
  for (const cat of HEURISTIC_ORDER) {
    let hits = 0
    for (const kw of LEXICON[cat]) {
      if (hasKeyword(text, kw)) {
        hits += 1
        if (tags.length < 6 && !tags.includes(kw)) tags.push(kw)
      }
    }
    if (hits > bestHits) {
      bestHits = hits
      best = cat
    }
  }
  return {
    category: best,
    narrative: bestHits ? `Keyword read: ${best} (${tags.slice(0, 3).join(', ')})` : 'Unclassified: no strong narrative keywords detected',
    confidence: bestHits ? clamp01(0.3 + bestHits * 0.12) : 0.2,
    tags,
    source: 'heuristic',
  }
}

// ── LLM path ──────────────────────────────────────────────────────────────────

const DEFAULT_MODELS: Record<LlmConfig['provider'], string> = {
  anthropic: 'claude-haiku-4-5-20251001',
  openai: 'gpt-4o-mini',
  groq: 'llama-3.3-70b-versatile',
  openrouter: 'openrouter/auto',
}

const SYSTEM_PROMPT = [
  'You are Oracle, a Robinhood Chain token-launch analyst. Classify a new token\'s CULTURAL NARRATIVE from its metadata.',
  'Return ONLY minified JSON, no prose, with exactly these keys:',
  `{"category": one of [${CATEGORIES.map((c) => `"${c}"`).join(',')}],`,
  ' "narrative": "one crisp sentence naming the actual thesis (e.g. \'rides today\'s tariff headline\', \'CTO community revival\', \'tokenized NVDA exposure\')",',
  ' "tags": array of up to 5 short lowercase tags,',
  ' "confidence": number 0-1}',
  'Be decisive. A meme riding a current event is "news". A community takeover is "community". Anything about tokenized equities or a listed company is "stock". Empty or spam metadata is "unknown" with low confidence.',
].join('\n')

/** Extract the first {...} blob from free text; models occasionally wrap JSON in prose or fences. */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const parsed: unknown = JSON.parse(match[0])
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function openAiCompatibleEndpoint(provider: 'openai' | 'groq' | 'openrouter'): { url: string; extraHeaders: Record<string, string> } {
  switch (provider) {
    case 'openai':
      return { url: 'https://api.openai.com/v1/chat/completions', extraHeaders: {} }
    case 'groq':
      return { url: 'https://api.groq.com/openai/v1/chat/completions', extraHeaders: {} }
    case 'openrouter':
      return {
        url: 'https://openrouter.ai/api/v1/chat/completions',
        extraHeaders: { 'HTTP-Referer': 'https://github.com/nirholas/hood-oracle', 'X-Title': 'hood-oracle' },
      }
  }
}

async function callProvider(cfg: LlmConfig, user: string, signal: AbortSignal): Promise<string> {
  const model = cfg.model ?? DEFAULT_MODELS[cfg.provider]
  if (cfg.provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 220, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: user }] }),
    })
    const body = await res.text()
    if (!res.ok) throw new Error(`anthropic rejected request (HTTP ${res.status}, model=${model}): ${body.slice(0, 200)}`)
    const data = JSON.parse(body) as { content?: { text?: string }[] }
    const text = data.content?.[0]?.text
    if (!text) throw new Error('anthropic response had no content text')
    return text
  }
  const { url, extraHeaders } = openAiCompatibleEndpoint(cfg.provider)
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}`, ...extraHeaders },
    body: JSON.stringify({
      model,
      max_tokens: 220,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: user }],
    }),
  })
  const body = await res.text()
  if (!res.ok) throw new Error(`${cfg.provider} rejected request (HTTP ${res.status}, model=${model}): ${body.slice(0, 200)}`)
  const data = JSON.parse(body) as { choices?: { message?: { content?: string } }[] }
  const text = data.choices?.[0]?.message?.content
  if (!text) throw new Error(`${cfg.provider} response had no message content`)
  return text
}

async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fn(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

/** Validate a parsed LLM reply into a NarrativeRead, or null when it does not meet the contract. */
export function narrativeFromLlmJson(parsed: Record<string, unknown> | null): NarrativeRead | null {
  if (!parsed) return null
  const category = String(parsed.category ?? '').toLowerCase()
  if (!CATEGORY_SET.has(category)) return null
  const confidence = Number(parsed.confidence)
  if (!Number.isFinite(confidence)) return null
  const narrative = String(parsed.narrative ?? '').trim().slice(0, 200)
  return {
    category: category as Category,
    confidence: clamp01(confidence),
    narrative: narrative || 'No narrative provided',
    tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 5).map((t) => String(t).toLowerCase().slice(0, 24)) : [],
    source: 'llm',
  }
}

export interface ClassifyOptions {
  llm?: LlmConfig | null
  timeoutMs?: number
  /** Injectable for tests; defaults to the real provider call. */
  complete?: (cfg: LlmConfig, user: string, signal: AbortSignal) => Promise<string>
}

/**
 * Classify a launch's narrative. Uses the LLM when one is configured (strict
 * JSON, timeout, one retry), otherwise the heuristic. Never throws.
 */
export async function classifyNarrative(meta: LaunchMeta = {}, opts: ClassifyOptions = {}): Promise<NarrativeRead> {
  const llm = opts.llm ?? null
  if (!llm) return heuristicNarrative(meta)
  const complete = opts.complete ?? callProvider
  const timeoutMs = opts.timeoutMs ?? 12_000
  const user = JSON.stringify({
    name: meta.name ?? null,
    symbol: meta.symbol ?? null,
    description: (meta.description ?? '').slice(0, 600) || null,
    links: { twitter: meta.twitter ?? null, telegram: meta.telegram ?? null, website: meta.website ?? null },
  })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = await withTimeout(timeoutMs, (signal) => complete(llm, user, signal))
      const read = narrativeFromLlmJson(parseJsonObject(text))
      if (read) return read
    } catch {
      // fall through to the retry, then to the heuristic
    }
  }
  return heuristicNarrative(meta)
}
