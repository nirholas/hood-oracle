/**
 * What the MCP tools call. Two implementations of one interface:
 *
 *   directBackend  runs inside the engine process (the /mcp HTTP transport)
 *                  and calls the same handler functions the HTTP routes use.
 *   httpBackend    runs in a separate process (the stdio transport launched
 *                  by Claude Desktop or Claude Code) and calls the running
 *                  engine's HTTP API, so a kill or an arm change lands on the
 *                  live engine rather than on a second copy of the database.
 *
 * Both throw ApiError so a tool answers with the API's own code and message.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { AppDeps } from '../api/deps.js'
import { ApiError } from '../api/errors.js'
import * as h from '../api/handlers/index.js'
import type { ArmListItem, ArmWire, ArmWriteResponse, CoinResponse, DecisionsResponse, FeedResponse, ModelResponse, PositionListItem, PositionWire, StatusResponse, TradeListItem, TradeWire } from '../api/contract.js'
import type { FeedQuery } from '../api/handlers/oracle.js'
import type { KillState } from '../api/handlers/kill.js'
import type { LedgerQuery } from '../api/handlers/ledger.js'
import type { PositionsQuery } from '../api/handlers/positions.js'

export interface DocEntry {
  slug: string
  title: string
  bytes: number
}

export interface OracleBackend {
  status(): Promise<StatusResponse>
  feed(q: FeedQuery): Promise<FeedResponse>
  coin(token: string): Promise<CoinResponse>
  model(): Promise<ModelResponse>
  armsList(): Promise<{ arms: ArmListItem[]; count: number }>
  armGet(id: string): Promise<{ arm: ArmListItem }>
  armCreate(body: unknown): Promise<ArmWriteResponse>
  armUpdate(id: string, body: unknown): Promise<ArmWriteResponse>
  armEnable(id: string): Promise<{ arm: ArmWire }>
  armDisable(id: string): Promise<{ arm: ArmWire }>
  armKill(id: string): Promise<{ arm: ArmWire }>
  killState(): Promise<KillState>
  killTrip(reason: string): Promise<KillState>
  killClear(): Promise<KillState & { cleared: boolean }>
  positionsList(q: PositionsQuery): Promise<{ positions: PositionListItem[]; count: number }>
  positionClose(id: string): Promise<{ trade: TradeWire; position: PositionWire | null }>
  tradesList(q: LedgerQuery): Promise<{ trades: TradeListItem[]; count: number }>
  decisionsList(q: LedgerQuery): Promise<DecisionsResponse>
  docs(): Promise<DocEntry[]>
  doc(slug: string): Promise<{ slug: string; title: string; markdown: string } | null>
}

// ── docs ──────────────────────────────────────────────────────────────────────

const SLUG = /^[a-z0-9-]+$/

function titleOf(markdown: string, slug: string): string {
  const m = /^#\s+(.+)$/m.exec(markdown)
  return m ? m[1]!.trim() : slug
}

/** Read-only view over docs/*.md. `dir` is resolved once; a missing directory lists nothing. */
export function docsReader(dir: string): Pick<OracleBackend, 'docs' | 'doc'> {
  const root = resolve(dir)
  return {
    async docs() {
      if (!existsSync(root)) return []
      return readdirSync(root)
        .filter((f) => f.endsWith('.md'))
        .sort()
        .map((f) => {
          const slug = f.slice(0, -3)
          const text = readFileSync(join(root, f), 'utf8')
          return { slug, title: titleOf(text, slug), bytes: Buffer.byteLength(text) }
        })
    },
    async doc(slug) {
      if (!SLUG.test(slug)) return null
      const path = join(root, `${slug}.md`)
      if (!existsSync(path)) return null
      const markdown = readFileSync(path, 'utf8')
      return { slug, title: titleOf(markdown, slug), markdown }
    },
  }
}

// ── direct ────────────────────────────────────────────────────────────────────

export function directBackend(deps: AppDeps, startedAt: Date, docsDir: string): OracleBackend {
  const docs = docsReader(docsDir)
  return {
    status: () => h.statusBody(deps, startedAt),
    feed: (q) => h.oracleFeed(deps, q),
    coin: (token) => h.oracleCoin(deps, token),
    model: () => h.oracleModel(deps),
    armsList: () => h.listArms(deps),
    armGet: (id) => h.getArm(deps, id),
    armCreate: (body) => h.createArm(deps, body),
    armUpdate: (id, body) => h.patchArm(deps, id, body),
    armEnable: (id) => h.enableArm(deps, id),
    armDisable: (id) => h.disableArm(deps, id),
    armKill: (id) => h.killArm(deps, id),
    killState: async () => h.killState(deps),
    killTrip: async (reason) => h.tripKill(deps, { reason }),
    killClear: async () => h.clearKill(deps),
    positionsList: (q) => h.listPositions(deps, q),
    positionClose: (id) => h.closePosition(deps, id),
    tradesList: (q) => h.listTrades(deps, q),
    decisionsList: (q) => h.listDecisions(deps, q),
    docs: docs.docs,
    doc: docs.doc,
  }
}

// ── http ──────────────────────────────────────────────────────────────────────

export interface HttpBackendOptions {
  baseUrl: string
  operatorToken?: string | null
  fetch?: typeof fetch
  docsDir: string
}

function query(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') qs.set(k, String(v))
  const s = qs.toString()
  return s ? `?${s}` : ''
}

export function httpBackend(opts: HttpBackendOptions): OracleBackend {
  const base = opts.baseUrl.replace(/\/+$/, '')
  const fetchImpl = opts.fetch ?? fetch
  const docs = docsReader(opts.docsDir)

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (opts.operatorToken) headers.authorization = `Bearer ${opts.operatorToken}`
    let res: Response
    try {
      res = await fetchImpl(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    } catch (err) {
      throw new ApiError(502, 'engine_unreachable', `Could not reach the hood-oracle API at ${base}: ${err instanceof Error ? err.message : String(err)}. Is the engine running, and is HOOD_ORACLE_URL right?`)
    }
    const text = await res.text()
    let parsed: unknown = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = null
    }
    if (!res.ok) {
      const e = (parsed ?? {}) as { error?: string; message?: string; detail?: Record<string, unknown> }
      throw new ApiError(res.status as 400, e.error ?? `http_${res.status}`, e.message ?? `${method} ${path} answered ${res.status}`, e.detail)
    }
    return parsed as T
  }

  return {
    status: () => call('GET', '/api/status'),
    feed: (q) => call('GET', `/api/oracle/feed${query({ limit: q.limit, tier: q.tier, launchpad: q.launchpad, since: q.since })}`),
    coin: (token) => call('GET', `/api/oracle/coin/${encodeURIComponent(token)}`),
    model: () => call('GET', '/api/oracle/model'),
    armsList: () => call('GET', '/api/arms'),
    armGet: (id) => call('GET', `/api/arms/${encodeURIComponent(id)}`),
    armCreate: (body) => call('POST', '/api/arms', body),
    armUpdate: (id, body) => call('PATCH', `/api/arms/${encodeURIComponent(id)}`, body),
    armEnable: (id) => call('POST', `/api/arms/${encodeURIComponent(id)}/arm`),
    armDisable: (id) => call('POST', `/api/arms/${encodeURIComponent(id)}/disarm`),
    armKill: (id) => call('POST', `/api/arms/${encodeURIComponent(id)}/kill`),
    killState: () => call('GET', '/api/kill'),
    killTrip: (reason) => call('POST', '/api/kill', { reason }),
    killClear: () => call('DELETE', '/api/kill'),
    positionsList: (q) => call('GET', `/api/positions${query({ status: q.status, arm: q.arm, limit: q.limit })}`),
    positionClose: (id) => call('POST', `/api/positions/${encodeURIComponent(id)}/close`),
    tradesList: (q) => call('GET', `/api/trades${query({ arm: q.arm, token: q.token, limit: q.limit })}`),
    decisionsList: (q) => call('GET', `/api/decisions${query({ arm: q.arm, token: q.token, limit: q.limit })}`),
    docs: docs.docs,
    doc: docs.doc,
  }
}
