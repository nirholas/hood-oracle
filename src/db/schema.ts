/**
 * Drizzle schema. Mirrors src/types.ts. Money is never a float: wei and token
 * units are numeric(40,0) read back as bigint (see ./client.ts helpers).
 */
import { sql } from 'drizzle-orm'
import {
  pgTable, text, boolean, integer, numeric, timestamp, jsonb, uuid, real, index, uniqueIndex, primaryKey,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'

const wei = (name: string) => numeric(name, { precision: 40, scale: 0 })

export const arms = pgTable('arms', {
  id: uuid('id').primaryKey().defaultRandom(),
  label: text('label').notNull(),
  network: text('network').notNull().default('mainnet'),
  enabled: boolean('enabled').notNull().default(false),
  killSwitch: boolean('kill_switch').notNull().default(false),
  mode: text('mode').notNull().default('simulate'),
  trigger: text('trigger').notNull().default('new_launch'),
  launchpads: jsonb('launchpads').$type<string[]>().notNull().default(['noxa', 'odyssey', 'direct', 'pons', 'rialto', 'dontblink', 'lunch', 'tokenselect', 'ramenpad', 'launcher-4a3e797b', 'launcher-4fba72a7', 'launcher-6e4910ea', 'rwa-launchpad', 'longlauncher', 'cashcat', 'forge', 'pair-v4']),
  perTradeWei: wei('per_trade_wei').notNull().default('0'),
  dailyBudgetWei: wei('daily_budget_wei').notNull().default('0'),
  maxConcurrentPositions: integer('max_concurrent_positions').notNull().default(1),
  cooldownSeconds: integer('cooldown_seconds').notNull().default(0),
  slippageBps: integer('slippage_bps').notNull().default(500),
  maxPriceImpactPct: real('max_price_impact_pct').notNull().default(10),
  firewallLevel: text('firewall_level').notNull().default('block'),
  buyDelayMs: integer('buy_delay_ms').notNull().default(0),
  minOracleScore: real('min_oracle_score'),
  maxRugRisk: real('max_rug_risk'),
  minUniqueBuyers: integer('min_unique_buyers'),
  maxCreatorLaunches: integer('max_creator_launches'),
  maxDeployerPct: real('max_deployer_pct'),
  maxBundleScore: real('max_bundle_score'),
  maxConcentrationTop1: real('max_concentration_top1'),
  minMarketCapEth: real('min_market_cap_eth'),
  maxMarketCapEth: real('max_market_cap_eth'),
  requireSocials: boolean('require_socials').notNull().default(false),
  avoidDevDump: boolean('avoid_dev_dump').notNull().default(true),
  allowedCategories: jsonb('allowed_categories').$type<string[] | null>(),
  stopLossPct: real('stop_loss_pct').notNull().default(30),
  takeProfitPct: real('take_profit_pct'),
  trailingStopPct: real('trailing_stop_pct'),
  maxHoldSeconds: integer('max_hold_seconds').notNull().default(1800),
  liquidityDecaySeconds: integer('liquidity_decay_seconds'),
  initialsOutMultiple: real('initials_out_multiple'),
  moonbagMinPct: real('moonbag_min_pct').notNull().default(15),
  moonbagAlways: boolean('moonbag_always').notNull().default(false),
  decisionMode: text('decision_mode').notNull().default('rules'),
  llmMinConfidence: real('llm_min_confidence'),
  autoOptimize: boolean('auto_optimize').notNull().default(false),
  autonomyTier: text('autonomy_tier').notNull().default('standard'),
  telegramChatId: text('telegram_chat_id'),
  experimentGroup: text('experiment_group'),
  /**
   * The on-chain HoodArmAccount this arm trades from. NULL is the legacy
   * operator-key arm: it keeps working exactly as it always has, funded by
   * TRADER_PRIVATE_KEY and gated by the operator token alone.
   */
  accountId: uuid('account_id').references((): AnyPgColumn => accounts.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('arms_account_idx').on(t.accountId)])

export const launches = pgTable('launches', {
  token: text('token').notNull(),
  network: text('network').notNull().default('mainnet'),
  launchpad: text('launchpad').notNull(),
  creator: text('creator').notNull(),
  pool: text('pool'),
  venue: text('venue').notNull(),
  blockNumber: numeric('block_number', { precision: 20, scale: 0 }).notNull(),
  txHash: text('tx_hash').notNull(),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  feedLeadMs: integer('feed_lead_ms'),
  name: text('name'),
  symbol: text('symbol'),
  decimals: integer('decimals').notNull().default(18),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  graduatedAt: timestamp('graduated_at', { withTimezone: true }),
}, (t) => [
  primaryKey({ columns: [t.token, t.network] }),
  index('launches_first_seen_idx').on(t.network, t.firstSeenAt),
  index('launches_creator_idx').on(t.network, t.creator),
])

export const launchFeatures = pgTable('launch_features', {
  token: text('token').notNull(),
  network: text('network').notNull().default('mainnet'),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
  windowSeconds: integer('window_seconds').notNull().default(90),
  features: jsonb('features').$type<Record<string, unknown>>().notNull(),
  missing: jsonb('missing').$type<string[]>().notNull().default([]),
}, (t) => [primaryKey({ columns: [t.token, t.network] })])

export const oracleScores = pgTable('oracle_scores', {
  id: uuid('id').primaryKey().defaultRandom(),
  token: text('token').notNull(),
  network: text('network').notNull().default('mainnet'),
  scoredAt: timestamp('scored_at', { withTimezone: true }).notNull().defaultNow(),
  modelVersion: text('model_version').notNull(),
  score: real('score').notNull(),
  tier: text('tier').notNull(),
  rugRisk: real('rug_risk').notNull(),
  probabilities: jsonb('probabilities').$type<Record<string, number>>().notNull(),
  pillars: jsonb('pillars').$type<Record<string, number>>().notNull(),
  hits: jsonb('hits').$type<unknown[]>().notNull(),
  reasons: jsonb('reasons').$type<string[]>().notNull(),
  confidence: real('confidence').notNull(),
}, (t) => [
  index('oracle_scores_token_idx').on(t.network, t.token, t.scoredAt),
  index('oracle_scores_at_idx').on(t.network, t.scoredAt),
])

export const oracleOutcomes = pgTable('oracle_outcomes', {
  token: text('token').notNull(),
  network: text('network').notNull().default('mainnet'),
  labelVersion: integer('label_version').notNull().default(1),
  win: boolean('win').notNull(),
  rug: boolean('rug').notNull(),
  moon: boolean('moon').notNull(),
  athMultiple: real('ath_multiple'),
  realizedWin: boolean('realized_win'),
  realizedPnlPct: real('realized_pnl_pct'),
  realizedSamples: integer('realized_samples').notNull().default(0),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.token, t.network] })])

export const oracleModels = pgTable('oracle_models', {
  id: uuid('id').primaryKey().defaultRandom(),
  network: text('network').notNull().default('mainnet'),
  version: text('version').notNull(),
  status: text('status').notNull().default('candidate'),
  reason: text('reason'),
  trainingRows: integer('training_rows').notNull(),
  fittedAt: timestamp('fitted_at', { withTimezone: true }).notNull().defaultNow(),
  model: jsonb('model').$type<Record<string, unknown>>().notNull(),
  holdout: jsonb('holdout').$type<Record<string, unknown> | null>(),
  checks: jsonb('checks').$type<unknown[]>().notNull().default([]),
}, (t) => [index('oracle_models_status_idx').on(t.network, t.status, t.fittedAt)])

export const positions = pgTable('positions', {
  id: uuid('id').primaryKey().defaultRandom(),
  armId: uuid('arm_id').notNull().references(() => arms.id, { onDelete: 'cascade' }),
  token: text('token').notNull(),
  network: text('network').notNull().default('mainnet'),
  launchpad: text('launchpad').notNull(),
  venue: text('venue').notNull(),
  mode: text('mode').notNull(),
  status: text('status').notNull().default('open'),
  entryWei: wei('entry_wei').notNull(),
  tokenAmount: wei('token_amount').notNull(),
  tokenDecimals: integer('token_decimals').notNull().default(18),
  buyTx: text('buy_tx').notNull(),
  sellTx: text('sell_tx'),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  peakValueWei: wei('peak_value_wei').notNull().default('0'),
  lastValueWei: wei('last_value_wei'),
  staleSince: timestamp('stale_since', { withTimezone: true }),
  initialsRecovered: boolean('initials_recovered').notNull().default(false),
  realizedPnlWei: wei('realized_pnl_wei'),
  realizedPnlPct: real('realized_pnl_pct'),
  exitReason: text('exit_reason'),
  oracleScoreAtEntry: real('oracle_score_at_entry'),
  meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
}, (t) => [
  index('positions_open_idx').on(t.network, t.status),
  index('positions_arm_idx').on(t.armId, t.openedAt),
  uniqueIndex('positions_arm_token_open_uidx').on(t.armId, t.token).where(sql`status = 'open'`),
])

export const trades = pgTable('trades', {
  id: uuid('id').primaryKey().defaultRandom(),
  armId: uuid('arm_id').notNull().references(() => arms.id, { onDelete: 'cascade' }),
  positionId: uuid('position_id').references(() => positions.id, { onDelete: 'set null' }),
  token: text('token').notNull(),
  network: text('network').notNull().default('mainnet'),
  side: text('side').notNull(),
  mode: text('mode').notNull(),
  venue: text('venue').notNull(),
  amountIn: wei('amount_in').notNull(),
  amountOut: wei('amount_out').notNull(),
  txHash: text('tx_hash').notNull(),
  gasWei: wei('gas_wei'),
  priceImpactPct: real('price_impact_pct'),
  slippageBps: integer('slippage_bps').notNull(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
}, (t) => [index('trades_arm_at_idx').on(t.armId, t.at), index('trades_at_idx').on(t.network, t.at)])

export const decisions = pgTable('decisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  armId: uuid('arm_id').references(() => arms.id, { onDelete: 'set null' }),
  token: text('token'),
  kind: text('kind').notNull(),
  reason: text('reason').notNull(),
  detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
  prevHash: text('prev_hash'),
  entryHash: text('entry_hash').notNull(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('decisions_at_idx').on(t.at), index('decisions_token_idx').on(t.token, t.at)])

export const firewallDecisions = pgTable('firewall_decisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  token: text('token').notNull(),
  network: text('network').notNull().default('mainnet'),
  venue: text('venue').notNull(),
  verdict: text('verdict').notNull(),
  score: real('score').notNull(),
  roundTripLossPct: real('round_trip_loss_pct'),
  checks: jsonb('checks').$type<unknown[]>().notNull(),
  latencyMs: integer('latency_ms').notNull(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('firewall_token_idx').on(t.network, t.token, t.at)])

export const equityPoints = pgTable('equity_points', {
  id: uuid('id').primaryKey().defaultRandom(),
  armId: uuid('arm_id').notNull().references(() => arms.id, { onDelete: 'cascade' }),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  realizedWei: wei('realized_wei').notNull(),
  openValueWei: wei('open_value_wei').notNull(),
  equityWei: wei('equity_wei').notNull(),
}, (t) => [index('equity_arm_at_idx').on(t.armId, t.at)])

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const creatorStats = pgTable('creator_stats', {
  creator: text('creator').notNull(),
  network: text('network').notNull().default('mainnet'),
  launches: integer('launches').notNull().default(0),
  wins: integer('wins').notNull().default(0),
  rugs: integer('rugs').notNull().default(0),
  lastLaunchAt: timestamp('last_launch_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.creator, t.network] })])

/**
 * One user's on-chain arm account (a HoodArmAccount clone). The row is a
 * CACHE of chain state, never the source of truth: `policy`, the balances and
 * `operator_address` are refreshed from the account contract, and a mismatch
 * between `operator_address` and the engine's own key flips `status` to
 * 'revoked'. Nothing here can widen what the chain allows.
 */
export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** The wallet that created the account and can withdraw from it, lowercase. */
  ownerAddress: text('owner_address').notNull(),
  /** The clone address that holds the funds, lowercase. */
  accountAddress: text('account_address').notNull(),
  chainId: integer('chain_id').notNull(),
  factoryAddress: text('factory_address').notNull(),
  deployedTx: text('deployed_tx'),
  operatorAddress: text('operator_address'),
  /** pending | active | revoked */
  status: text('status').notNull().default('pending'),
  /** Owner-supplied name for the account picker. */
  label: text('label'),
  /** Snapshot of the on-chain Policy struct, wei fields as decimal strings. */
  policy: jsonb('policy').$type<Record<string, unknown> | null>(),
  revokedReason: text('revoked_reason'),
  ethBalanceWei: wei('eth_balance_wei').notNull().default('0'),
  wethBalanceWei: wei('weth_balance_wei').notNull().default('0'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('accounts_address_uidx').on(t.accountAddress, t.chainId),
  index('accounts_owner_idx').on(t.ownerAddress, t.chainId),
  index('accounts_status_idx').on(t.status, t.lastSyncedAt),
])

/**
 * Wallet sign-in sessions (EIP-4361). The browser holds `<id>.<secret>.<sig>`
 * in an HttpOnly cookie; only the SHA-256 of the secret is stored, so a
 * database leak cannot be replayed as a login. `user_agent_hash` is a salted
 * digest, never the raw header.
 */
export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  address: text('address').notNull(),
  tokenHash: text('token_hash').notNull(),
  chainId: integer('chain_id').notNull(),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  userAgentHash: text('user_agent_hash'),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('sessions_token_uidx').on(t.tokenHash),
  index('sessions_address_idx').on(t.address, t.expiresAt),
  index('sessions_expiry_idx').on(t.expiresAt),
])

/**
 * Single-use EIP-4361 nonces. Each one is bound to the pre-auth cookie that
 * carried it (`secret_hash`), so a nonce observed in transit cannot be
 * replayed from another browser, and consumed exactly once.
 */
export const authNonces = pgTable('auth_nonces', {
  id: uuid('id').primaryKey().defaultRandom(),
  nonce: text('nonce').notNull(),
  secretHash: text('secret_hash').notNull(),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('auth_nonces_nonce_uidx').on(t.nonce),
  index('auth_nonces_expiry_idx').on(t.expiresAt),
])
