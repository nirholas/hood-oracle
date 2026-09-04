import type { Config } from '../config.js'
import type { Db } from '../db/client.js'
import type { Logger } from '../log.js'
import type { EngineApi, EventBusApi, ModelStoreApi } from '../types.js'

export interface AppDeps {
  config: Config
  db: Db
  log: Logger
  engine: EngineApi
  model: ModelStoreApi
  bus: EventBusApi
}

export const EXPLORER_URL: Record<string, string> = {
  mainnet: 'https://robinhoodchain.blockscout.com',
  testnet: 'https://explorer.testnet.chain.robinhood.com',
}
