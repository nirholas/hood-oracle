/**
 * The hood-oracle client. One `createClient({ baseUrl })` gives you a typed
 * method for every route, an async iterator over the SSE stream, and a
 * `waitForScore` that resolves the moment the oracle scores a token.
 *
 * Runtime dependencies: `fetch`, `ReadableStream`, `TextDecoder`, `URL`. Node
 * 18+ and every modern browser have all four. The x402 helper additionally
 * loads `hood402/client` on demand (an optional peer dependency).
 */
import type {
  AccountDetailResponse, AccountPolicyWire, AccountWire, ArmListItem, ArmWire, ArmWriteResponse, CalibrationResponse, CoinResponse,
  DecisionsResponse, EngineEventWire, EquityResponse, FeedResponse, HealthResponse, ModelHistoryItem, ModelResponse, PositionListItem,
  PositionWire, PreparePolicyResponse, ReadyResponse, ScoreWire, StatusResponse, TradeListItem, TradeWire,
  X402PricingResponse, X402ScoreResponse,
} from './contract.js'
import type { Launchpad, OracleTier, PositionStatus } from './types.js'
import { HoodOracleError } from './errors.js'
import { parseSse } from './sse.js'
import { payForScore, type X402PayOptions, type X402PayResult } from './x402.js'

/** Anything fetch-shaped. A Hono app's `request` (which may return a bare Response) qualifies, so tests can run in-process. */
export type FetchLike = (input: string, init?: RequestInit) => Response | Promise<Response>

export interface ClientOptions {
  /** Where the engine's API lives, e.g. `http://localhost:8080` or the Cloud Run URL. */
  baseUrl: string
  /** The server's OPERATOR_TOKEN. Needed for every write (arms, kill, close). */
  operatorToken?: string | null
  /** Custom fetch (tests inject `app.request`; Node users may pass an agent-bound fetch). */
  fetch?: FetchLike
  /** Extra headers on every request. */
  headers?: Record<string, string>
}

/** Arm knobs accepted by create and update: the wire shape minus server-owned fields, plus the ETH spellings of the sizing fields. */
export type ArmInput = Partial<Omit<ArmWire, 'id' | 'createdAt' | 'updatedAt' | 'killSwitch'>> & {
  perTradeEth?: number | string
  dailyBudgetEth?: number | string
}
export type ArmCreateInput = ArmInput & { label: string }

export interface FeedQuery {
  limit?: number
  tier?: OracleTier
  launchpad?: Launchpad
  /** ISO timestamp, epoch ms, or a duration such as `24h`. */
  since?: string
}

export interface PositionsQuery {
  status?: PositionStatus
  arm?: string
  limit?: number
}

export interface LedgerQuery {
  arm?: string
  token?: string
  limit?: number
}

export interface KillState {
  killed: boolean
  reason: string | null
}

/** The `hello` frame every stream opens with. */
export interface HelloEvent {
  kind: 'hello'
  at: number
  network: string
  chainId: number
  /** How many ring-buffer events are replayed before live ones. */
  replay: number
  heartbeatMs: number
}

export interface PingEvent {
  kind: 'ping'
  at: number
}

export type StreamEvent = HelloEvent | PingEvent | EngineEventWire

export interface StreamOptions {
  /** `/api/oracle/stream` (launch, features, score only) instead of `/api/stream`. */
  oracleOnly?: boolean
  /** Only yield these event kinds (`hello` and `ping` are always yielded). */
  kinds?: EngineEventWire['kind'][]
  signal?: AbortSignal
}

export interface WaitForScoreOptions {
  /** Give up after this long. Default 120000 (a launch is scored about 90s after first sight). */
  timeoutMs?: number
  signal?: AbortSignal
}

function qs(params: object): string {
  const u = new URLSearchParams()
  for (const [k, v] of Object.entries(params) as [string, string | number | undefined][]) if (v != null && v !== '') u.set(k, String(v))
  const s = u.toString()
  return s ? `?${s}` : ''
}

export class HoodOracleClient {
  readonly baseUrl: string
  private readonly token: string | null
  private readonly fetchImpl: FetchLike
  private readonly extraHeaders: Record<string, string>

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.token = opts.operatorToken ?? null
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init))
    this.extraHeaders = opts.headers ?? {}
  }

  /** Absolute URL for an API path. */
  url(path: string): string {
    return `${this.baseUrl}${path}`
  }

  /** A raw request with auth and JSON handling; every method below goes through it. */
  async request<T>(method: string, path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
    const res = await this.raw(method, path, body, init)
    if (!res.ok) throw await HoodOracleError.fromResponse(res)
    const text = await res.text()
    return (text ? JSON.parse(text) : null) as T
  }

  async raw(method: string, path: string, body?: unknown, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    for (const [k, v] of Object.entries(this.extraHeaders)) headers.set(k, v)
    headers.set('accept', headers.get('accept') ?? 'application/json')
    if (body !== undefined) headers.set('content-type', 'application/json')
    if (this.token) headers.set('authorization', `Bearer ${this.token}`)
    try {
      return await this.fetchImpl(this.url(path), { ...init, method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    } catch (err) {
      throw new HoodOracleError(0, 'network', `Could not reach ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ── status ──
  health(): Promise<HealthResponse> {
    return this.request('GET', '/api/health')
  }

  /** Readiness. Resolves with the body on both 200 and 503; `ok` says which. */
  async ready(): Promise<ReadyResponse> {
    const res = await this.raw('GET', '/api/ready')
    if (res.status !== 200 && res.status !== 503) throw await HoodOracleError.fromResponse(res)
    return (await res.json()) as ReadyResponse
  }

  status(): Promise<StatusResponse> {
    return this.request('GET', '/api/status')
  }

  /** Prometheus text exposition. */
  async metrics(): Promise<string> {
    const res = await this.raw('GET', '/api/metrics', undefined, { headers: { accept: 'text/plain' } })
    if (!res.ok) throw await HoodOracleError.fromResponse(res)
    return res.text()
  }

  // ── arms ──
  readonly arms = {
    list: (): Promise<{ arms: ArmListItem[]; count: number }> => this.request('GET', '/api/arms'),
    get: (id: string): Promise<{ arm: ArmListItem }> => this.request('GET', `/api/arms/${encodeURIComponent(id)}`),
    create: (input: ArmCreateInput): Promise<ArmWriteResponse> => this.request('POST', '/api/arms', input),
    update: (id: string, patch: ArmInput): Promise<ArmWriteResponse> => this.request('PATCH', `/api/arms/${encodeURIComponent(id)}`, patch),
    delete: (id: string): Promise<{ ok: true; id: string }> => this.request('DELETE', `/api/arms/${encodeURIComponent(id)}`),
    enable: (id: string): Promise<{ arm: ArmWire }> => this.request('POST', `/api/arms/${encodeURIComponent(id)}/arm`),
    disable: (id: string): Promise<{ arm: ArmWire }> => this.request('POST', `/api/arms/${encodeURIComponent(id)}/disarm`),
    kill: (id: string): Promise<{ arm: ArmWire }> => this.request('POST', `/api/arms/${encodeURIComponent(id)}/kill`),
  }

  /**
   * On-chain arm accounts, through the operator-token admin path.
   *
   * The routes that CREATE an account (`GET /api/accounts`,
   * `POST /api/accounts/prepare`, `POST /api/accounts/register`) are bound to
   * a wallet sign-in and are deliberately absent here: they need an EIP-4361
   * session and an owner key to sign with, which a server-side client holding
   * an operator token has neither of. Deploy an account from the dashboard at
   * `/app/connect` (or any wallet), then operate it from here.
   *
   * `preparePolicy` returns UNSIGNED calldata, exactly as the HTTP route does.
   * Nothing in this SDK can sign it: only the account's owner can.
   */
  readonly accounts = {
    /** One account: the cached row, the live chain read, its arms and realized record. */
    get: (address: string): Promise<AccountDetailResponse> => this.request('GET', `/api/accounts/${encodeURIComponent(address)}`),
    /** Unsigned `setPolicy` calldata, and whether it lands now or queues for an hour. */
    preparePolicy: (address: string, policy: Partial<AccountPolicyWire>): Promise<PreparePolicyResponse> =>
      this.request('POST', `/api/accounts/${encodeURIComponent(address)}/policy/prepare`, { policy }),
    /** Re-read the account from the chain now, instead of waiting for the 60s sweep. */
    refresh: (address: string): Promise<{ account: AccountWire }> =>
      this.request('POST', `/api/accounts/${encodeURIComponent(address)}/refresh`),
  }

  // ── kill switch ──
  readonly kill = {
    get: (): Promise<KillState> => this.request('GET', '/api/kill'),
    trip: (reason: string): Promise<KillState> => this.request('POST', '/api/kill', { reason }),
    clear: (): Promise<KillState & { cleared: boolean }> => this.request('DELETE', '/api/kill'),
  }

  // ── oracle ──
  readonly oracle = {
    feed: (q: FeedQuery = {}): Promise<FeedResponse> => this.request('GET', `/api/oracle/feed${qs(q)}`),
    coin: (token: string): Promise<CoinResponse> => this.request('GET', `/api/oracle/coin/${encodeURIComponent(token)}`),
    model: (): Promise<ModelResponse> => this.request('GET', '/api/oracle/model'),
    models: (limit?: number): Promise<{ items: ModelHistoryItem[]; count: number; active: StatusResponse['model'] }> => this.request('GET', `/api/oracle/models${qs({ limit })}`),
    calibration: (): Promise<CalibrationResponse> => this.request('GET', '/api/oracle/calibration'),
  }

  // ── positions and the ledger ──
  readonly positions = {
    list: (q: PositionsQuery = {}): Promise<{ positions: PositionListItem[]; count: number }> => this.request('GET', `/api/positions${qs(q)}`),
    close: (id: string): Promise<{ trade: TradeWire; position: PositionWire | null }> => this.request('POST', `/api/positions/${encodeURIComponent(id)}/close`),
  }

  trades(q: LedgerQuery = {}): Promise<{ trades: TradeListItem[]; count: number }> {
    return this.request('GET', `/api/trades${qs(q)}`)
  }

  decisions(q: LedgerQuery = {}): Promise<DecisionsResponse> {
    return this.request('GET', `/api/decisions${qs(q)}`)
  }

  equity(q: { arm?: string; limit?: number } = {}): Promise<EquityResponse> {
    return this.request('GET', `/api/equity${qs(q)}`)
  }

  // ── x402 ──
  readonly x402 = {
    /** Free: what the paid route costs and how to pay. */
    pricing: (): Promise<X402PricingResponse> => this.request('GET', '/api/x402/pricing'),
    /** Pay for one verdict with USDG on Robinhood Chain and return it. See ./x402.ts. */
    score: (token: string, opts: X402PayOptions): Promise<X402PayResult<X402ScoreResponse>> => payForScore(this, token, opts),
  }

  // ── streams ──
  /**
   * The engine's SSE stream as an async iterator. Yields the `hello` frame,
   * then the ring-buffer replay, then live events, with `ping` heartbeats.
   * Break out of the loop or abort the signal to close the connection.
   */
  async *stream(opts: StreamOptions = {}): AsyncGenerator<StreamEvent> {
    const path = opts.oracleOnly ? '/api/oracle/stream' : '/api/stream'
    const res = await this.raw('GET', path, undefined, { headers: { accept: 'text/event-stream' }, signal: opts.signal })
    if (!res.ok) throw await HoodOracleError.fromResponse(res)
    if (!res.body) throw new HoodOracleError(res.status, 'no_body', `${path} answered without a body`)
    const wanted = opts.kinds ? new Set<string>(opts.kinds) : null
    for await (const frame of parseSse(res.body, opts.signal)) {
      if (frame.event === 'hello') {
        yield { kind: 'hello', ...(JSON.parse(frame.data) as Omit<HelloEvent, 'kind'>) }
        continue
      }
      if (frame.event === 'ping') {
        yield { kind: 'ping', ...(JSON.parse(frame.data) as Omit<PingEvent, 'kind'>) }
        continue
      }
      if (wanted && !wanted.has(frame.event)) continue
      yield JSON.parse(frame.data) as EngineEventWire
    }
  }

  /**
   * Resolve with the oracle's verdict for a token: immediately when it has
   * already been scored, otherwise the moment the `score` event arrives on
   * the oracle stream. The stream replays its ring buffer on connect, so a
   * score landing between the lookup and the subscription is not missed.
   */
  async waitForScore(token: string, opts: WaitForScoreOptions = {}): Promise<ScoreWire> {
    const want = token.toLowerCase()
    try {
      const coin = await this.oracle.coin(token)
      if (coin.latest) return coin.latest
    } catch (err) {
      if (!(err instanceof HoodOracleError && err.status === 404)) throw err
    }
    const timeoutMs = opts.timeoutMs ?? 120_000
    const controller = new AbortController()
    const onOuterAbort = () => controller.abort()
    opts.signal?.addEventListener('abort', onOuterAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      for await (const e of this.stream({ oracleOnly: true, kinds: ['score'], signal: controller.signal })) {
        if (e.kind === 'score' && e.verdict.token.toLowerCase() === want) return e.verdict as unknown as ScoreWire
      }
    } catch (err) {
      if (!controller.signal.aborted) throw err
    } finally {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onOuterAbort)
    }
    if (opts.signal?.aborted) throw new HoodOracleError(0, 'aborted', `waitForScore(${token}) was aborted`)
    throw new HoodOracleError(0, 'timeout', `${token} was not scored within ${timeoutMs}ms. It is scored about 90 seconds after first sight; is the engine's feed connected?`)
  }
}

export function createClient(opts: ClientOptions): HoodOracleClient {
  return new HoodOracleClient(opts)
}
