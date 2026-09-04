import { describe, expect, it } from 'vitest'
import { CATEGORIES, classifyNarrative, heuristicNarrative, narrativeFromLlmJson, parseJsonObject } from '../src/oracle/narrative.js'

describe('narrative classifier', () => {
  it('heuristic: reads categories from keywords with whole-word matching', () => {
    expect(heuristicNarrative({ name: 'Doge Hood', symbol: 'DOGE' }).category).toBe('animal')
    expect(heuristicNarrative({ name: 'Agent Terminal', symbol: 'AGNT', description: 'an autonomous AI agent' }).category).toBe('ai')
    expect(heuristicNarrative({ name: 'Tesla Shares', symbol: 'TSLAX', description: 'tokenized stock exposure' }).category).toBe('stock')
    expect(heuristicNarrative({ name: 'Trump 2028', symbol: 'MAGA' }).category).toBe('political')
    expect(heuristicNarrative({ name: 'Chain', symbol: 'CHN' }).category).toBe('tech')
    expect(heuristicNarrative({ name: 'zzz', symbol: 'QQQQ' })).toMatchObject({ category: 'unknown', confidence: 0.2, source: 'heuristic' })
  })

  it('heuristic: confidence grows with agreeing hits and stays within 0..1', () => {
    const one = heuristicNarrative({ name: 'Pepe', symbol: 'PEPE' })
    const many = heuristicNarrative({ name: 'Pepe the frog', symbol: 'PEPE', description: 'a frog, a dog, a cat and a doge walk into a bar' })
    expect(many.confidence).toBeGreaterThan(one.confidence)
    expect(many.confidence).toBeLessThanOrEqual(1)
    expect(many.tags.length).toBeGreaterThan(0)
  })

  it('falls back to the heuristic with no LLM configured', async () => {
    const read = await classifyNarrative({ name: 'Bonk Cat', symbol: 'BCAT' })
    expect(read.source).toBe('heuristic')
    expect(read.category).toBe('animal')
  })

  it('uses a strict JSON verdict from the LLM, retries once, then falls back', async () => {
    const llm = { provider: 'openai' as const, apiKey: 'k', model: null }
    let calls = 0
    const good = await classifyNarrative({ name: 'Hood News', symbol: 'HN' }, {
      llm,
      complete: async () => {
        calls++
        return 'Sure: {"category":"news","narrative":"rides today\'s Robinhood Chain headline","tags":["news","Robinhood"],"confidence":0.9}'
      },
    })
    expect(calls).toBe(1)
    expect(good).toMatchObject({ category: 'news', confidence: 0.9, source: 'llm', tags: ['news', 'robinhood'] })

    let attempts = 0
    const bad = await classifyNarrative({ name: 'Doge', symbol: 'DOGE' }, {
      llm,
      complete: async () => {
        attempts++
        if (attempts === 1) throw new Error('HTTP 500')
        return '{"category":"galactic","confidence":1}'
      },
    })
    expect(attempts).toBe(2)
    expect(bad.source).toBe('heuristic')
    expect(bad.category).toBe('animal')

    const slow = await classifyNarrative({ name: 'Doge', symbol: 'DOGE' }, {
      llm,
      timeoutMs: 20,
      complete: (_cfg, _user, signal) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('aborted'))) }),
    })
    expect(slow.source).toBe('heuristic')
  })

  it('validates the LLM shape field by field', () => {
    expect(parseJsonObject('no json here')).toBeNull()
    expect(parseJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(narrativeFromLlmJson(null)).toBeNull()
    expect(narrativeFromLlmJson({ category: 'meme' })).toBeNull()
    expect(narrativeFromLlmJson({ category: 'meme', confidence: 'high' })).toBeNull()
    expect(narrativeFromLlmJson({ category: 'MEME', confidence: 7 })).toMatchObject({ category: 'meme', confidence: 1, narrative: 'No narrative provided' })
    expect(CATEGORIES).toContain('stock')
  })
})
