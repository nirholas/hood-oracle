// GENERATED from src/types.ts by scripts/sync-sdk-contract.mjs. Do not edit; edit the source and run `npm run sync:sdk-contract`.
/**
 * Shared domain types for hood-oracle. Every module builds against these; the
 * database schema in ./db/schema.ts mirrors them column for column.
 *
 * Vocabulary (inherited from three.ws):
 *   arm      one armed strategy: a row of knobs that decides what to buy, how
 *            much, and when to exit. "Arming" flips it enabled.
 *   oracle   the conviction model that scores every launch 0..100 and tiers it.
 *   tier     prime / strong / lean / watch / avoid, from the score.
 *   autonomy probation / standard / trusted / autonomous: how much rope an arm
 *            has earned from its realized record.
 */
/** A 0x-prefixed 20-byte hex address (viem `Address`, spelled locally so the SDK has no runtime or type dependency on viem). */
export type Address = `0x${string}`
/** A 0x-prefixed 32-byte hex hash. */
export type Hash = `0x${string}`
/** Any 0x-prefixed hex string. */
export type Hex = `0x${string}`

export type Network = 'mainnet' | 'testnet'
/**
 * Where a launch came from. 'noxa' and 'odyssey' are the launchpads the SDK
 * knows; the rest were identified from the Uniswap v3 / v4 pool-creation
 * intake (see src/chain/launchpads.ts for addresses and evidence). 'direct'
 * is a token whose pool was created straight through a position manager or
 * an unregistered contract.
 */
export type Launchpad =
  | 'noxa' | 'odyssey' | 'direct'
  | 'pons' | 'rialto' | 'dontblink' | 'lunch' | 'tokenselect' | 'ramenpad'
  | 'launcher-4a3e797b' | 'launcher-4fba72a7' | 'launcher-6e4910ea'
  | 'rwa-launchpad' | 'longlauncher' | 'cashcat' | 'forge' | 'pair-v4'
/** Where a token trades right now. Odyssey tokens start on the curve and graduate to a pool. 'v4' is a Uniswap v4 pool (observed and scored, not routable by the executor). */
export type Venue = 'curve' | 'pool' | 'v4'
export type Mode = 'simulate' | 'live'
export type Side = 'buy' | 'sell'

export type Trigger = 'new_launch' | 'graduation' | 'oracle_crossing'
export type DecisionMode = 'rules' | 'llm'
export type FirewallLevel = 'block' | 'warn' | 'off'

export type OracleTier = 'prime' | 'strong' | 'lean' | 'watch' | 'avoid'
export type AutonomyTier = 'probation' | 'standard' | 'trusted' | 'autonomous'
export type Pillar = 'structure' | 'momentum' | 'pedigree' | 'narrative'
export type Head = 'win' | 'rug' | 'moon'

export type Category =
  | 'meme' | 'tech' | 'ai' | 'culture' | 'community' | 'political' | 'news'
  | 'animal' | 'celebrity' | 'utility' | 'stock' | 'unknown'

// ── launches ──────────────────────────────────────────────────────────────────

export interface LaunchRecord {
  token: Address
  network: Network
  launchpad: Launchpad
  creator: Address
  /** Uniswap v3 pool. Immediate for NOXA; null for Odyssey until graduation. */
  pool: Address | null
  venue: Venue
  blockNumber: bigint
  txHash: Hash
  firstSeenAt: Date
  /** ms between the sequencer feed showing the tx and the log being queryable; null when only seen via logs. */
  feedLeadMs: number | null
  name: string | null
  symbol: string | null
  decimals: number
  metadata: LaunchMetadata
  graduatedAt: Date | null
}

export interface LaunchMetadata {
  description?: string | null
  image?: string | null
  website?: string | null
  twitter?: string | null
  telegram?: string | null
  [key: string]: unknown
}

// ── oracle ────────────────────────────────────────────────────────────────────

/**
 * The 26 oracle features, EVM-native. Volumes are in ETH (float) inside the
 * 90-second observation window after first sight. Ratios are 0..1.
 */
export interface LaunchFeatures {
  // structure
  organic_score: number | null
  bundle_score: number | null
  snipe_ratio: number | null
  coordination_score: number | null
  timing_entropy: number | null
  concentration_top1: number | null
  concentration_top5: number | null
  concentration_top10: number | null
  fresh_wallet_ratio: number | null
  bubblemap_connectivity: number | null
  // momentum (first 90s of tape)
  unique_buyers: number | null
  unique_sellers: number | null
  buy_sell_ratio: number | null
  buy_volume_eth: number | null
  sell_volume_eth: number | null
  net_volume_eth: number | null
  trade_count: number | null
  largest_buy_eth: number | null
  avg_buy_eth: number | null
  median_buy_eth: number | null
  mc_eth_first_seen: number | null
  // pedigree
  dev_buy_eth: number | null
  dev_sell_eth: number | null
  dev_sold: boolean | null
  smart_money_count: number | null
  creator_launches: number | null
  creator_wins: number | null
  /** Fraction of supply the deployer still holds at the end of the window. */
  deployer_holding_pct: number | null
  // narrative
  category: Category
  narrative_confidence: number | null
}

export interface FeatureSnapshot {
  token: Address
  network: Network
  observedAt: Date
  windowSeconds: number
  features: LaunchFeatures
  /** Feature keys whose source was unavailable (RPC gap, no pool yet). Never fabricated. */
  missing: string[]
}

export interface OracleHit {
  key: string
  pillar: Pillar
  bucket: string
  w: number
  present: boolean
  n: number | null
}

export interface OracleVerdict {
  token: Address
  score: number
  tier: OracleTier
  probabilities: Record<Head, number>
  /** Probability a first-sight holder ends up down more than half. Published on its own, never blended into the score. */
  rugRisk: number
  pillars: Record<Pillar, number>
  hits: OracleHit[]
  reasons: string[]
  /** 0..1: share of features that were actually observed. */
  confidence: number
  modelVersion: string
  scoredAt: Date
}

export interface OracleModelDocument {
  version: number
  fitted_at: string
  training_rows: number
  score_head: Head
  heads: Record<Head, { intercept: number; base_rate: number }>
  tier_probability_anchors: Record<OracleTier, number>
  features: OracleModelFeature[]
  holdout?: Record<Head, HoldoutMetrics> | null
  provenance: string
}

export interface OracleModelFeature {
  key: string
  pillar: Pillar
  categorical: boolean
  edges: number[]
  buckets: Record<string, { n: number; w: Record<Head, number> }>
}

export interface HoldoutMetrics {
  auc: number
  brier: number
  precision_at_5: number
  reliability: { lo: number; hi: number; n: number; observed: number; predicted: number }[]
}

/** Price-independent labels for one launch once its outcome is known. */
export interface OracleOutcome {
  token: Address
  network: Network
  labelVersion: number
  win: boolean
  rug: boolean
  moon: boolean
  athMultiple: number | null
  /** Realized entry-to-exit result from our own closed positions, when we traded it. Preferred over chart labels. */
  realizedWin: boolean | null
  realizedPnlPct: number | null
  realizedSamples: number
  resolvedAt: Date
}

// ── arms ──────────────────────────────────────────────────────────────────────

export interface Arm {
  id: string
  label: string
  network: Network
  enabled: boolean
  killSwitch: boolean
  mode: Mode
  trigger: Trigger
  launchpads: Launchpad[]
  // sizing
  perTradeWei: bigint
  dailyBudgetWei: bigint
  maxConcurrentPositions: number
  cooldownSeconds: number
  slippageBps: number
  maxPriceImpactPct: number
  firewallLevel: FirewallLevel
  buyDelayMs: number
  // entry filters (null = not applied)
  minOracleScore: number | null
  maxRugRisk: number | null
  minUniqueBuyers: number | null
  maxCreatorLaunches: number | null
  maxDeployerPct: number | null
  maxBundleScore: number | null
  maxConcentrationTop1: number | null
  minMarketCapEth: number | null
  maxMarketCapEth: number | null
  requireSocials: boolean
  avoidDevDump: boolean
  allowedCategories: Category[] | null
  // exits
  stopLossPct: number
  takeProfitPct: number | null
  trailingStopPct: number | null
  maxHoldSeconds: number
  liquidityDecaySeconds: number | null
  initialsOutMultiple: number | null
  moonbagMinPct: number
  moonbagAlways: boolean
  // intelligence
  decisionMode: DecisionMode
  llmMinConfidence: number | null
  autoOptimize: boolean
  autonomyTier: AutonomyTier
  // notifications / grouping
  telegramChatId: string | null
  experimentGroup: string | null
  /**
   * The on-chain HoodArmAccount this arm trades from, or null for the legacy
   * arm that trades the operator's own hot wallet. When set, the executor
   * routes every buy and sell through the account contract and the chain
   * enforces the caps in {@link ArmAccount.policy} on top of these knobs.
   */
  accountId: string | null
  createdAt: Date
  updatedAt: Date
}

// ── on-chain arm accounts (multi-tenant, non-custodial) ──────────────────────

/**
 * Where an account stands from the engine's point of view.
 *   pending  the create transaction is recorded but the chain has not been
 *            read back yet (no policy, no balances).
 *   active   the account exists, our engine key is its `operator`, and the
 *            cached policy and balances are from a real chain read.
 *   revoked  the owner rotated the operator away from us (or killed the
 *            account). Arms bound to it are disabled and never trade.
 */
export type AccountStatus = 'pending' | 'active' | 'revoked'

/**
 * The owner's on-chain bounds, mirroring `Policy` in
 * `contracts/src/libraries/PolicyLib.sol` field for field. Every number here
 * is enforced by the account contract itself, so it is a ceiling no server
 * bug and no leaked hot key can raise.
 */
export interface AccountPolicy {
  perTradeCapWei: bigint
  dailyBudgetWei: bigint
  maxOpenPositions: number
  maxSlippageBps: number
  cooldownSeconds: number
  maxHoldSecondsHint: number
  /** 0 disables the on-chain oracle gate; 1..100 requires a fresh attestation at least this high. */
  minOracleScore: number
  allowedRouter: Address
  quoteToken: Address
}

/** One user's HoodArmAccount clone as the server caches it. */
export interface ArmAccount {
  id: string
  /** The wallet that signed the create transaction and holds withdrawal rights. */
  ownerAddress: Address
  /** The clone's address: where the funds actually sit. */
  accountAddress: Address
  chainId: number
  factoryAddress: Address
  deployedTx: Hash | null
  /** Whoever the account currently calls `operator`. Ours, until the owner rotates it. */
  operatorAddress: Address | null
  status: AccountStatus
  label: string | null
  /** Last policy read from the chain; null while the account is still pending. */
  policy: AccountPolicy | null
  /** Why the account was marked revoked, in one sentence. */
  revokedReason: string | null
  ethBalanceWei: bigint
  wethBalanceWei: bigint
  createdAt: Date
  lastSyncedAt: Date | null
}

/** Live chain facts an account exposes beyond its policy. */
export interface AccountChainState {
  owner: Address
  operator: Address
  killed: boolean
  policy: AccountPolicy
  spentTodayWei: bigint
  remainingDailyBudgetWei: bigint
  cooldownRemainingSeconds: number
  openPositionCount: number
  feesAccruedWei: bigint
  ethBalanceWei: bigint
  wethBalanceWei: bigint
  readAt: Date
}

/** A wallet sign-in, stored server-side; the browser only ever holds an opaque cookie. */
export interface WalletSession {
  id: string
  address: Address
  chainId: number
  issuedAt: Date
  expiresAt: Date
  lastSeenAt: Date
}

// ── positions, trades, decisions ──────────────────────────────────────────────

export type PositionStatus = 'open' | 'closed' | 'reconcile_pending'
export type ExitReason =
  | 'stop_loss' | 'take_profit' | 'trailing_stop' | 'take_initials' | 'timeout'
  | 'liquidity_decay' | 'kill_switch' | 'manual' | 'graduated' | 'error' | 'rug_detected'

export interface Position {
  id: string
  armId: string
  token: Address
  network: Network
  launchpad: Launchpad
  venue: Venue
  mode: Mode
  status: PositionStatus
  /** ETH spent to open, wei. */
  entryWei: bigint
  /** Token units held, smallest unit. */
  tokenAmount: bigint
  tokenDecimals: number
  buyTx: Hash | 'SIMULATED'
  sellTx: Hash | 'SIMULATED' | null
  openedAt: Date
  closedAt: Date | null
  peakValueWei: bigint
  lastValueWei: bigint | null
  staleSince: Date | null
  initialsRecovered: boolean
  realizedPnlWei: bigint | null
  realizedPnlPct: number | null
  exitReason: ExitReason | null
  oracleScoreAtEntry: number | null
  meta: Record<string, unknown>
}

export interface Trade {
  id: string
  armId: string
  positionId: string | null
  token: Address
  network: Network
  side: Side
  mode: Mode
  venue: Venue
  amountIn: bigint
  amountOut: bigint
  txHash: Hash | 'SIMULATED'
  gasWei: bigint | null
  priceImpactPct: number | null
  slippageBps: number
  at: Date
  meta: Record<string, unknown>
}

export type DecisionKind = 'buy' | 'sell' | 'skip' | 'refused' | 'observe' | 'alert' | 'error'

/** One hash-chained journal row. `entryHash = sha256(prevHash + canonical json)`. */
export interface Decision {
  id: string
  armId: string | null
  token: Address | null
  kind: DecisionKind
  reason: string
  detail: Record<string, unknown>
  prevHash: string | null
  entryHash: string
  at: Date
}

// ── guards ────────────────────────────────────────────────────────────────────

export type RefusalReason =
  | 'kill_switch' | 'disarmed' | 'per_trade_cap' | 'daily_budget' | 'daily_loss'
  | 'concurrency' | 'cooldown' | 'slippage_bound' | 'price_impact' | 'wallet_floor'
  | 'firewall' | 'oracle_gate' | 'entry_filter' | 'no_route' | 'zero_amount'
  | 'autonomy_bounds' | 'llm_declined'
  // on-chain arm accounts (src/engine/account-executor.ts)
  | 'operator_revoked' | 'account_unavailable'

export interface GuardVerdict {
  ok: boolean
  reason?: RefusalReason
  detail: string
}

export type FirewallVerdict = 'allow' | 'warn' | 'block'

export interface FirewallCheck {
  check: string
  status: 'pass' | 'warn' | 'fail' | 'unavailable'
  reason: string
  weight: number
}

export interface FirewallAssessment {
  token: Address
  venue: Venue
  verdict: FirewallVerdict
  /** 0..100, 100 = perfectly clean. */
  score: number
  checks: FirewallCheck[]
  /** Fraction lost on an immediate buy then sell round trip, 0..1, null when it could not be simulated. */
  roundTripLossPct: number | null
  assessedAt: Date
  latencyMs: number
}

// ── engine events (SSE + dashboard) ───────────────────────────────────────────

export type EngineEvent =
  | { kind: 'launch'; at: number; launch: LaunchRecord }
  | { kind: 'features'; at: number; snapshot: FeatureSnapshot }
  | { kind: 'score'; at: number; verdict: OracleVerdict }
  | { kind: 'decision'; at: number; decision: Decision }
  | { kind: 'trade'; at: number; trade: Trade }
  | { kind: 'position'; at: number; position: Position }
  | { kind: 'graduation'; at: number; token: Address; pool: Address }
  | { kind: 'status'; at: number; level: 'info' | 'warn' | 'error'; source: string; message: string }
  | { kind: 'kill'; at: number; reason: string }

export interface EngineHealth {
  network: Network
  chainId: number
  headBlock: number | null
  feed: { connected: boolean; lastSequence: number | null; secondsSinceFrame: number | null }
  wallet: { address: Address | null; ethWei: bigint | null; live: boolean }
  killed: boolean
  killReason: string | null
  arms: { total: number; enabled: number; live: number }
  positions: { open: number }
  model: { version: string; provenance: string; trainingRows: number; fittedAt: string | null }
  /** Launches taken in during the last hour, keyed by launchpad name ('direct' for unregistered creators). */
  launchpads: Record<string, number>
  startedAt: string
}


// ── cross-module interfaces ───────────────────────────────────────────────────

/** The active oracle model, hot-swappable. Implemented in src/oracle/model-store.ts. */
export interface ModelStoreApi {
  /** The model every score is computed under right now. */
  active(): OracleModelDocument
  provenance(): { version: string; provenance: string; trainingRows: number; fittedAt: string | null }
  /** Reload the active row from the database (called after a promotion). */
  reload(): Promise<void>
  /** Score a feature snapshot under the active model. Pure apart from the model read. */
  convict(snapshot: FeatureSnapshot, pedigree?: { creatorLaunches: number | null; creatorWins: number | null }): OracleVerdict
}

/** Typed pub/sub for engine events. Implemented in src/engine/bus.ts. */
export interface EventBusApi {
  emit(event: EngineEvent): void
  subscribe(fn: (event: EngineEvent) => void): () => void
  /** Last N events, newest last, for SSE replay on connect. */
  recent(limit?: number): EngineEvent[]
}

/** The trading loop. Implemented in src/engine/index.ts. */
export interface EngineApi {
  start(): Promise<void>
  stop(): Promise<void>
  health(): EngineHealth
  /** Trip the kill switch: halts new buys, keeps managing exits. */
  kill(reason: string): void
  /** Clear a kill that came from the API (signal and file kills are not clearable at runtime). */
  unkill(): boolean
  /** Close an open position now at market. Returns the trade or throws. */
  closePosition(positionId: string, reason: ExitReason): Promise<Trade>
  /** Re-read arms from the database (the API calls this after any arm write). */
  refreshArms(): Promise<void>
  /** Latest score for a token, or null if never scored. */
  lastVerdict(token: Address): OracleVerdict | null
}

// ── oracle: learning loop contracts (src/oracle/*) ───────────────────────────

/** One named test the promotion gate ran on a candidate model. */
export interface OracleGateCheck {
  check: string
  pass: boolean
  detail: string
}

/** The promotion gate's decision on one candidate, with the sentence explaining it. */
export interface OracleGateVerdict {
  promote: boolean
  reason: string
  checks: OracleGateCheck[]
}

/** Observed hit rate for one 10-point conviction band. */
export interface OracleCalibrationBand {
  lo: number
  hi: number
  n: number
  wins: number
  /** Share of resolved launches in the band that won; null when the band is empty. */
  observed: number | null
  /** What the band claims, via the tier anchors, at its mean score; null when empty. */
  predicted: number | null
  lift: number | null
}

/** Stored in `settings` under 'oracle:calibration'. */
export interface OracleCalibration {
  version: number
  network: Network
  computedAt: string
  modelVersion: string
  resolvedN: number
  winsN: number
  baseRate: number | null
  bands: OracleCalibrationBand[]
}

/** What the narrative classifier says a launch is. */
export interface NarrativeRead {
  category: Category
  /** 0..1 */
  confidence: number
  narrative: string
  tags: string[]
  source: 'llm' | 'heuristic'
}

/** Handle on the oracle's scheduled jobs. Implemented in src/oracle/jobs.ts. */
export interface OracleJobsApi {
  /** Run one job now, outside its schedule. Resolves when it finishes; a job already running is awaited, not duplicated. */
  runNow(job: 'labels' | 'calibrate' | 'refit'): Promise<void>
  stop(): void
}
