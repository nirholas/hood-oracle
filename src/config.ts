/**
 * Environment configuration, parsed once and validated. Every knob the engine
 * reads from the environment lives here so a misconfiguration fails at boot
 * with a readable message instead of mid-trade.
 */
import { z } from 'zod'
import type { Network } from './types.js'

const bool = z
  .string()
  .optional()
  .transform((v) => v === '1' || v === 'true')

const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  HOOD_NETWORK: z.enum(['mainnet', 'testnet']).default('mainnet'),
  RPC_URLS: z.string().optional().default(''),
  FEED_URL: z.string().optional(),
  TRADER_PRIVATE_KEY: z.string().optional(),
  MIN_WALLET_ETH: z.coerce.number().min(0).default(0.005),
  OPERATOR_TOKEN: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.string().default('info'),
  LLM_PROVIDER: z.enum(['anthropic', 'openai', 'groq', 'openrouter']).optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  KILL_FILE: z.string().default('KILL'),
  /** Engine-wide halt on new buys; exits keep managing. */
  GLOBAL_KILL: bool,
  /** Disable the sequencer websocket (log polling only). */
  DISABLE_FEED: bool,
  WEB_DIST: z.string().default('web/dist'),
})

export type Config = {
  databaseUrl: string
  network: Network
  chainId: number
  rpcUrls: string[]
  feedUrl: string
  traderPrivateKey: `0x${string}` | null
  minWalletEth: number
  operatorToken: string | null
  port: number
  logLevel: string
  llm: { provider: 'anthropic' | 'openai' | 'groq' | 'openrouter'; apiKey: string; model: string | null } | null
  telegram: { botToken: string; chatId: string } | null
  killFile: string
  globalKill: boolean
  disableFeed: boolean
  webDist: string
}

export const PUBLIC_RPC: Record<Network, string> = {
  mainnet: 'https://rpc.mainnet.chain.robinhood.com',
  testnet: 'https://rpc.testnet.chain.robinhood.com',
}

export const CHAIN_ID: Record<Network, number> = { mainnet: 4663, testnet: 46630 }

export const FEED_URL: Record<Network, string> = {
  mainnet: 'wss://feed.mainnet.chain.robinhood.com',
  testnet: 'wss://feed.testnet.chain.robinhood.com',
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`invalid environment: ${issues}`)
  }
  const e = parsed.data
  const extra = e.RPC_URLS.split(',').map((s) => s.trim()).filter(Boolean)
  const key = e.TRADER_PRIVATE_KEY?.trim()
  if (key && !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('TRADER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key')
  return {
    databaseUrl: e.DATABASE_URL,
    network: e.HOOD_NETWORK,
    chainId: CHAIN_ID[e.HOOD_NETWORK],
    rpcUrls: [...extra, PUBLIC_RPC[e.HOOD_NETWORK]],
    feedUrl: e.FEED_URL || FEED_URL[e.HOOD_NETWORK],
    traderPrivateKey: key ? (key as `0x${string}`) : null,
    minWalletEth: e.MIN_WALLET_ETH,
    operatorToken: e.OPERATOR_TOKEN?.trim() || null,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    llm: e.LLM_PROVIDER && e.LLM_API_KEY ? { provider: e.LLM_PROVIDER, apiKey: e.LLM_API_KEY, model: e.LLM_MODEL?.trim() || null } : null,
    telegram: e.TELEGRAM_BOT_TOKEN && e.TELEGRAM_CHAT_ID ? { botToken: e.TELEGRAM_BOT_TOKEN, chatId: e.TELEGRAM_CHAT_ID } : null,
    killFile: e.KILL_FILE,
    globalKill: e.GLOBAL_KILL,
    disableFeed: e.DISABLE_FEED,
    webDist: e.WEB_DIST,
  }
}
