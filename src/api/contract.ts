/**
 * Wire shapes of the HTTP API. The dashboard imports these types (type-only,
 * erased at build) so a renamed field fails the web typecheck instead of
 * rendering "undefined".
 */
import type {
  AccountPolicy, AccountStatus, Arm, Decision, EngineHealth, FeatureSnapshot, FirewallAssessment, HoldoutMetrics,
  LaunchFeatures, LaunchRecord, Launchpad, Head, OracleHit, OracleTier, Pillar, Position, Trade, Venue, EngineEvent, Address,
} from '../types.js'

/** One stored oracle verdict (an `oracle_scores` row) in domain form. */
export interface ScoreRecord {
  id: string
  token: Address
  score: number
  tier: OracleTier
  rugRisk: number
  probabilities: Record<Head, number>
  pillars: Record<Pillar, number>
  hits: OracleHit[]
  reasons: string[]
  confidence: number
  modelVersion: string
  scoredAt: Date
}

/** JSON view of a domain type: bigint -> decimal string, Date -> ISO string. */
export type Wire<T> = T extends bigint
  ? string
  : T extends Date
    ? string
    : T extends (infer U)[]
      ? Wire<U>[]
      : T extends object
        ? { [K in keyof T]: Wire<T[K]> }
        : T

export type ArmWire = Wire<Arm>
export type PositionWire = Wire<Position>
export type TradeWire = Wire<Trade>
export type DecisionWire = Wire<Decision>
export type LaunchWire = Wire<LaunchRecord>
export type SnapshotWire = Wire<FeatureSnapshot>
export type ScoreWire = Wire<ScoreRecord>
export type FirewallWire = Wire<FirewallAssessment & { id: string }>
export type HealthWire = Wire<EngineHealth>
export type EngineEventWire = Wire<EngineEvent>

export interface ArmSummary {
  open: number
  closed: number
  wins: number
  realizedPnlWei: string
  lastTradeAt: string | null
}

export interface ArmListItem extends ArmWire {
  summary: ArmSummary
}

/** POST /api/arms and PATCH /api/arms/:id: the stored row plus what the autonomy-tier clamp changed or dropped. */
export interface ArmWriteResponse {
  arm: ArmWire
  clamped: { knob: string; from: string | number | null; to: string | number }[]
  refused: { knob: string; reason: string }[]
}

export interface ApiErrorBody {
  error: string
  message: string
  detail?: Record<string, unknown>
}

export interface HealthResponse {
  ok: true
  uptimeSeconds: number
  startedAt: string
  now: string
}

export interface StatusResponse {
  ok: true
  now: string
  uptimeSeconds: number
  network: string
  chainId: number
  explorerUrl: string
  /** The chain's public RPC, so a wallet can add the network without the operator's private endpoints. */
  publicRpcUrl: string
  /** Every launchpad literal the intake can record, for filters and arm chips. */
  launchpads: Launchpad[]
  operatorTokenSet: boolean
  engine: HealthWire
  model: { version: string; provenance: string; trainingRows: number; fittedAt: string | null; source: 'bootstrap' | 'promoted' }
  counts: {
    arms: { total: number; enabled: number; live: number }
    positions: { open: number; closed: number }
    launches: number
    launches24h: number
    scores: number
    scores24h: number
    trades: number
    decisions: number
  }
}

export interface FeedItem {
  token: string
  network: string
  launchpad: Launchpad
  venue: Venue
  pool: string | null
  creator: string
  name: string | null
  symbol: string | null
  decimals: number
  metadata: Record<string, unknown>
  blockNumber: string
  firstSeenAt: string
  graduatedAt: string | null
  feedLeadMs: number | null
  score: ScoreWire
  features: Wire<LaunchFeatures> | null
  missing: string[]
  observedAt: string | null
}

export interface FeedResponse {
  items: FeedItem[]
  count: number
  filters: { tier: OracleTier | null; launchpad: Launchpad | null; since: string | null; limit: number }
  generatedAt: string
}

export interface CoinResponse {
  launch: LaunchWire
  features: SnapshotWire | null
  latest: ScoreWire | null
  scores: ScoreWire[]
  firewall: FirewallWire[]
  positions: (PositionWire & { armLabel: string })[]
  decisions: DecisionWire[]
  creator: { launches: number; wins: number; rugs: number; lastLaunchAt: string | null } | null
  outcome: {
    win: boolean
    rug: boolean
    moon: boolean
    athMultiple: number | null
    realizedWin: boolean | null
    realizedPnlPct: number | null
    resolvedAt: string
  } | null
}

export interface ModelFeatureSummary {
  key: string
  pillar: Pillar
  categorical: boolean
  edges: number[]
  bucketCount: number
  buckets: Record<string, number>
}

export interface ModelResponse {
  version: string
  provenance: string
  source: 'bootstrap' | 'promoted'
  trainingRows: number
  fittedAt: string | null
  scoreHead: Head
  heads: Record<Head, { intercept: number; base_rate: number }>
  tierAnchors: Record<OracleTier, number>
  holdout: Record<Head, HoldoutMetrics> | null
  features: ModelFeatureSummary[]
}

export interface ModelHistoryItem {
  id: string
  version: string
  status: string
  reason: string | null
  trainingRows: number
  fittedAt: string
  featureCount: number
  holdout: Record<string, unknown> | null
  checks: unknown[]
}

export interface CalibrationResponse {
  key: 'oracle:calibration'
  value: unknown
  updatedAt: string | null
}

export interface PositionListItem extends PositionWire {
  symbol: string | null
  name: string | null
  armLabel: string
}

export interface TradeListItem extends TradeWire {
  symbol: string | null
  armLabel: string
}

export interface DecisionsResponse {
  items: (DecisionWire & { armLabel: string | null })[]
  chain: { ok: boolean; rows: number; breaks: { id: string; at: string }[]; verifiedAt: string }
}

export interface EquityPoint {
  at: string
  realizedWei: string
  openValueWei: string
  equityWei: string
}

export interface EquityResponse {
  series: { armId: string; armLabel: string; points: EquityPoint[] }[]
}

/** GET /api/ready. 200 when every check passes, else 503 with the failing reasons. */
export interface ReadyCheck {
  ok: boolean
  detail: string
}

export interface ReadyResponse {
  ok: boolean
  checks: { engine: ReadyCheck; db: ReadyCheck; dataPath: ReadyCheck; model: ReadyCheck }
  now: string
}

/** GET /api/x402/pricing: how the paid score route is priced and paid. */
export interface X402PricingResponse {
  enabled: boolean
  resource: string
  method: 'GET'
  price: { usdg: string; atomic: string; decimals: number }
  network: { id: string; chainId: number }
  asset: { symbol: 'USDG'; address: string; eip712: { name: string; version: string } }
  scheme: 'exact'
  x402Version: 1
  payTo: string | null
  facilitator: string
  description: string
  freeAlternative: string
  howToPay: string
}

/** GET /api/x402/score/:token after a settled payment. */
export interface X402ScoreResponse {
  token: string
  verdict: ScoreWire
  features: SnapshotWire | null
  firewall: FirewallWire | null
  /** How many verdicts this token has received so far. */
  history: number
  paidAt: string
}

// ── wallet sign-in and on-chain arm accounts ─────────────────────────────────

/**
 * A transaction the server built for the owner's wallet to sign. The server
 * never holds an owner key, so every account create and every policy change
 * comes back as one of these and is signed in the browser.
 */
export interface UnsignedTx {
  to: Address
  data: `0x${string}`
  value: string
  chainId: number
  /** What the user is about to sign, in one sentence, for the wallet confirmation screen. */
  summary: string
}

/** JSON view of the on-chain `Policy` struct: wei as decimal strings. */
export type AccountPolicyWire = Wire<AccountPolicy>

/** One HoodArmAccount as the API renders it. `address` is the clone; `ownerAddress` withdraws. */
export interface AccountWire {
  id: string
  address: Address
  ownerAddress: Address
  chainId: number
  factoryAddress: Address
  operatorAddress: Address | null
  deployedTx: string | null
  status: AccountStatus
  label: string | null
  policy: AccountPolicyWire | null
  revokedReason: string | null
  ethBalanceWei: string
  wethBalanceWei: string
  createdAt: string
  lastSyncedAt: string | null
}

/** GET /api/auth/nonce: everything the browser needs to build the EIP-4361 message. */
export interface NonceResponse {
  nonce: string
  expiresAt: string
  domain: string
  uri: string
  chainId: number
  statement: string
}

/** POST /api/auth/verify on a good signature. */
export interface VerifyResponse {
  address: Address
  chainId: number
  expiresAt: string
}

/** GET /api/auth/me. `address` is null when nobody is signed in. */
export interface MeResponse {
  address: Address | null
  chainId: number
  expiresAt?: string
  operator: Address | null
  factory: Address | null
  accounts: { id: string; address: Address; status: AccountStatus; label: string | null; lastSyncedAt: string | null }[]
}

/** GET /api/accounts. */
export interface AccountsResponse {
  accounts: AccountWire[]
  factory: Address
  operator: Address | null
  chainId: number
  defaultPolicy: AccountPolicyWire | null
}

/** POST /api/accounts/prepare: the create transaction, unsigned. */
export interface PrepareCreateResponse {
  tx: UnsignedTx
  policy: AccountPolicyWire
  operator: Address
  factory: Address
  note: string
}

/** Live chain state of one account, read at request time. */
export interface AccountChainWire {
  owner: Address
  operator: Address
  killed: boolean
  policy: AccountPolicyWire
  spentTodayWei: string
  remainingDailyBudgetWei: string
  cooldownRemainingSeconds: number
  openPositionCount: number
  feesAccruedWei: string
  ethBalanceWei: string
  wethBalanceWei: string
  readAt: string
}

/** GET /api/accounts/:address. `chain` is null when the read failed; `chainError` says why. */
export interface AccountDetailResponse {
  account: AccountWire
  chain: AccountChainWire | null
  chainError: string | null
  arms: { id: string; label: string; enabled: boolean; mode: string; perTradeWei: string; dailyBudgetWei: string }[]
  positions: PositionWire[]
  realized: { closed: number; wins: number; realizedPnlWei: string }
}

/** POST /api/accounts/:address/policy/prepare. `immediate` is false when the change loosens a bound and has to queue. */
export interface PreparePolicyResponse {
  tx: UnsignedTx
  policy: AccountPolicyWire
  immediate: boolean
  note: string
}
