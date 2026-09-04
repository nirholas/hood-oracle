import type { PublicClient } from 'viem'
import type { Config } from '../config.js'
import type { Db } from '../db/client.js'
import type { Logger } from '../log.js'
import type { EngineApi, EventBusApi, ModelStoreApi } from '../types.js'
import type { Metrics } from './metrics.js'
import type { AccountRegistryApi } from '../accounts/registry.js'
import type { SessionStore } from '../accounts/session.js'

/** Where the engine is in its startup life cycle. `src/index.ts` owns the transitions; `/api/ready` reads them. */
export type EngineStartupPhase = 'starting' | 'running' | 'failed'

export interface EngineStartupState {
  phase: EngineStartupPhase
  /** Which start attempt is in flight (or was the last one). */
  attempt: number
  /** How many attempts run before the phase is called `failed`; retries continue after that. */
  attempts: number
  /** The last start failure, or null once the engine is running. */
  error: string | null
  /** When the engine reached this phase. */
  since: string
}

/** The state an API built without an `engineStartup` reports: the engine was started before the app (tests, embedded use). */
export const ENGINE_RUNNING: EngineStartupState = { phase: 'running', attempt: 1, attempts: 1, error: null, since: new Date(0).toISOString() }

export interface AppLimits {
  /** Writes (POST/PUT/PATCH/DELETE) per client address per minute. Default 30. */
  writesPerMinute?: number
  /** Reads per client address per minute. Default 600. */
  readsPerMinute?: number
  /** Largest accepted request body on JSON routes, bytes. Default 65536. */
  bodyLimitBytes?: number
  /** Nonce requests per client per minute on /api/auth. Default 20. */
  authReadsPerMinute?: number
  /** Sign-in attempts per client per minute on /api/auth. Default 10. */
  authWritesPerMinute?: number
}

/**
 * The multi-tenant surface: the on-chain account registry and the client it
 * reads with. Absent (no HOOD_ARM_FACTORY, or no chain client) means the
 * account routes answer 503 and every operator-token flow is untouched.
 */
export interface AccountsDeps {
  registry: AccountRegistryApi
  /** Used for EIP-1271 signature verification and receipt reads. */
  publicClient: PublicClient
}

export interface AppDeps {
  config: Config
  db: Db
  log: Logger
  engine: EngineApi
  model: ModelStoreApi
  bus: EventBusApi
  /** The process-wide metrics collector. createApp builds one when absent (tests). */
  metrics?: Metrics
  /** Rate-limit and body-size overrides (tests). Production uses the defaults. */
  limits?: AppLimits
  /**
   * The engine's startup phase. The HTTP listener comes up before the engine
   * so a throttled RPC cannot fail a deploy's startup probe, which means
   * `/api/ready` has to be able to say "the engine is not running yet".
   * Absent means the engine was already started by the caller.
   */
  engineStartup?: () => EngineStartupState
  /** The on-chain account registry. Absent disables /api/accounts (503). */
  accounts?: AccountsDeps
  /** Wallet sign-in store. createApp builds one from the config when absent. */
  sessions?: SessionStore
}

export const EXPLORER_URL: Record<string, string> = {
  mainnet: 'https://robinhoodchain.blockscout.com',
  testnet: 'https://explorer.testnet.chain.robinhood.com',
}
