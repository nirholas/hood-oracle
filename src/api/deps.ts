import type { Config } from '../config.js'
import type { Db } from '../db/client.js'
import type { Logger } from '../log.js'
import type { EngineApi, EventBusApi, ModelStoreApi } from '../types.js'
import type { Metrics } from './metrics.js'

export interface AppLimits {
  /** Writes (POST/PUT/PATCH/DELETE) per client address per minute. Default 30. */
  writesPerMinute?: number
  /** Reads per client address per minute. Default 600. */
  readsPerMinute?: number
  /** Largest accepted request body on JSON routes, bytes. Default 65536. */
  bodyLimitBytes?: number
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
}

export const EXPLORER_URL: Record<string, string> = {
  mainnet: 'https://robinhoodchain.blockscout.com',
  testnet: 'https://explorer.testnet.chain.robinhood.com',
}
