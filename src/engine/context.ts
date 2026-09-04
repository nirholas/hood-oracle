/**
 * What every engine module receives. Built once in createEngine and shared so
 * the executor, observer and sweeper see the same clients, journal and arms.
 */
import type { Config } from '../config.js'
import type { Db } from '../db/client.js'
import type { Logger } from '../log.js'
import type { ChainClient } from '../chain/client.js'
import type { Prices } from '../chain/prices.js'
import type { Arm, EventBusApi, ModelStoreApi, Network } from '../types.js'
import type { Journal } from './journal.js'
import type { Alerts } from './alerts.js'
import type { RiskEngine } from '../guards/risk.js'
import type { KillSwitch } from '../guards/kill.js'

export interface EngineContext {
  config: Config
  db: Db
  log: Logger
  bus: EventBusApi
  model: ModelStoreApi
  chain: ChainClient
  prices: Prices
  journal: Journal
  alerts: Alerts
  risk: RiskEngine
  kill: KillSwitch
  network: Network
  /** The cached arms (refreshed every 15s and on demand). */
  arms: () => Arm[]
}

/** The observation window every launch gets. */
export const WINDOW_SECONDS = 90
