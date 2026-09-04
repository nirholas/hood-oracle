/**
 * Sequencer feed: every raw transaction the Nitro sequencer publishes, decoded
 * before it is queryable over RPC. We match `to` against the launchpad
 * factories and emit a pre-launch signal with the calldata selector; the
 * observation window later stamps the confirming log with the measured lead.
 *
 * Reconnection: the SDK subscription retries with backoff and gives up after
 * its budget; this wrapper re-subscribes from scratch after that, and a
 * silence watchdog tears down a socket that stopped delivering frames.
 */
import { type Address, type Hash, type Hex, getAddress, recoverTransactionAddress, toFunctionSelector } from 'viem'
import { subscribeFeed, type FeedMessage, type FeedSubscription } from 'hoodchain'
import type { Launchpad } from '../types.js'
import type { Logger } from '../log.js'
import type { ChainAddresses } from './client.js'
import { matchesLaunchSignal, type LaunchpadEntry } from './launchpads.js'

export interface PreLaunchSignal {
  launchpad: Launchpad
  factory: Address
  txHash: Hash
  /** Recovered sender (the creator for a launch call). */
  from: Address | null
  selector: Hex
  /** Verified function name for the selector, or null when the contract is unverified. */
  functionName: string | null
  /** Registry label of the matched contract. */
  label: string
  /** 'launchpad' for a launch factory; 'position-manager' for a direct pool creation through a position manager. */
  kind: LaunchpadEntry['kind']
  value: bigint
  sequenceNumber: number
  /** ms when the frame was decoded. */
  seenAt: number
}

export interface FeedHealth {
  connected: boolean
  lastSequence: number | null
  secondsSinceFrame: number | null
  framesPerSecond: number
  reconnects: number
}

/**
 * Launch entrypoints from the verified Odyssey implementations. Only these
 * selectors count as a launch signal on their factory; anything else sent to
 * a factory (buys, admin) is not.
 */
const ODYSSEY_LAUNCH_SIGNATURES = [
  'function createToken(string,string,uint256,uint256)',
  'function createTokenMeme(string,string,uint256,uint256)',
  'function createTokenMemeWithDexSeed(string,string,uint256,uint256,uint256)',
  'function createTokenMarginBacked(string,string,uint256,address,bytes32,uint256)',
  'function createTokenMarginBackedWithDexSeed(string,string,uint256,address,bytes32,uint256,uint256)',
  'function createTokenRwaBacked(string,string,uint256,address,bytes32,uint256)',
  'function createTokenRwaBackedWithDexSeed(string,string,uint256,address,bytes32,uint256,uint256)',
  'function createTokenRwaBackedSigned(string,string,uint256,address,bytes32,uint256,uint256,bytes)',
  'function createTokenRwaBackedSignedWithDexSeed(string,string,uint256,address,bytes32,uint256,uint256,uint256,bytes)',
  'function createTokenReflection(string,string,uint256,address,uint256,uint16)',
  'function createTokenReflectionInstant(string,string,address,uint16)',
  'function createTokenReflectionWithDexSeed(string,string,uint256,address,uint256,uint16,uint256)',
  'function createTokenMemeInstant(string,string,uint256,uint8)',
  'function createTokenMarginBackedInstant(string,string,address,bytes32,uint256)',
  'function createTokenRwaBackedInstant(string,string,address,bytes32,uint256,uint8)',
  'function createTokenRwaBackedSignedInstant(string,string,address,bytes32,uint256,uint256,bytes,uint8)',
] as const

export const ODYSSEY_LAUNCH_SELECTORS: ReadonlyMap<Hex, string> = new Map(
  ODYSSEY_LAUNCH_SIGNATURES.map((sig) => [toFunctionSelector(sig), sig.slice('function '.length, sig.indexOf('('))]),
)

export interface FeedOptions {
  url: string
  addresses: Pick<ChainAddresses, 'noxaFactory' | 'odysseyBonding' | 'odysseyReflection' | 'odysseyInstant' | 'odysseyLegacy'>
  log: Logger
  onSignal: (signal: PreLaunchSignal) => void
  onStatus?: (level: 'info' | 'warn' | 'error', message: string) => void
  /** Silence after which the socket is recycled. */
  silenceMs?: number
}

export class SequencerFeed {
  private sub: FeedSubscription | null = null
  private stopped = true
  private lastSequence: number | null = null
  private lastFrameAt = 0
  private connected = false
  private reconnects = 0
  private frameTimes: number[] = []
  private watchdog: NodeJS.Timeout | null = null
  private readonly odysseyFactories: Set<string>
  private readonly seen = new Map<string, number>()

  constructor(private readonly opts: FeedOptions) {
    const a = opts.addresses
    this.odysseyFactories = new Set([a.odysseyBonding, a.odysseyReflection, a.odysseyInstant, a.odysseyLegacy].map((x) => x.toLowerCase()))
  }

  /** When the feed first showed a transaction, for measuring lead time against the confirming log. */
  seenAt(txHash: Hash): number | null {
    return this.seen.get(txHash.toLowerCase()) ?? null
  }

  async start(): Promise<void> {
    this.stopped = false
    await this.connect()
    this.watchdog = setInterval(() => this.checkSilence(), 5_000)
    this.watchdog.unref?.()
  }

  stop(): void {
    this.stopped = true
    if (this.watchdog) clearInterval(this.watchdog)
    this.watchdog = null
    this.teardown()
  }

  health(): FeedHealth {
    const now = Date.now()
    this.frameTimes = this.frameTimes.filter((t) => now - t < 10_000)
    return {
      connected: this.connected,
      lastSequence: this.lastSequence,
      secondsSinceFrame: this.lastFrameAt ? Math.round((now - this.lastFrameAt) / 1000) : null,
      framesPerSecond: this.frameTimes.length / 10,
      reconnects: this.reconnects,
    }
  }

  private teardown(): void {
    try { this.sub?.close() } catch { /* socket already gone */ }
    this.sub = null
    this.connected = false
  }

  private async connect(): Promise<void> {
    if (this.stopped) return
    try {
      this.sub = await subscribeFeed((m) => this.onMessage(m), {
        url: this.opts.url,
        maxReconnects: 20,
        reconnectDelayMs: 500,
        onConnect: () => {
          this.connected = true
          this.opts.onStatus?.('info', `sequencer feed connected (${this.opts.url})`)
        },
        onError: (err) => {
          this.connected = false
          this.opts.onStatus?.('warn', `sequencer feed: ${err.message}`)
          if (err.name === 'FeedConnectionError') this.scheduleReconnect(30_000)
        },
      })
    } catch (err) {
      this.opts.onStatus?.('error', `sequencer feed failed to open: ${(err as Error).message}`)
      this.scheduleReconnect(10_000)
    }
  }

  private scheduleReconnect(delayMs: number): void {
    if (this.stopped) return
    this.teardown()
    this.reconnects++
    const t = setTimeout(() => { void this.connect() }, delayMs)
    t.unref?.()
  }

  private checkSilence(): void {
    if (this.stopped || !this.lastFrameAt) return
    const silence = this.opts.silenceMs ?? 20_000
    if (Date.now() - this.lastFrameAt > silence) {
      this.opts.onStatus?.('warn', `sequencer feed silent for ${Math.round((Date.now() - this.lastFrameAt) / 1000)}s, recycling socket`)
      this.lastFrameAt = Date.now()
      this.scheduleReconnect(250)
    }
  }

  private onMessage(m: FeedMessage): void {
    const now = Date.now()
    this.lastFrameAt = now
    this.lastSequence = m.sequenceNumber
    this.connected = true
    this.frameTimes.push(now)
    if (this.frameTimes.length > 4000) this.frameTimes.splice(0, this.frameTimes.length - 4000)
    for (const tx of m.transactions) {
      const to = tx.transaction.to
      if (!to) continue
      const data = (tx.transaction.data ?? '0x') as Hex
      const selector = data.slice(0, 10) as Hex
      // Odyssey factories: only the verified createToken* entrypoints are launches (buys and admin calls also target them).
      const isOdyssey = this.odysseyFactories.has(to.toLowerCase())
      const odysseyName = isOdyssey ? ODYSSEY_LAUNCH_SELECTORS.get(selector) ?? null : null
      if (isOdyssey && !odysseyName) continue
      const entry = matchesLaunchSignal(to, data)
      if (!entry) continue
      const launchpad: Launchpad = entry.name
      const functionName = odysseyName ?? entry.selectorNames?.[selector.toLowerCase() as Hex] ?? null
      const key = tx.hash.toLowerCase()
      if (this.seen.has(key)) continue
      this.seen.set(key, now)
      if (this.seen.size > 2000) this.seen.delete(this.seen.keys().next().value!)
      void recoverTransactionAddress({ serializedTransaction: tx.raw as Parameters<typeof recoverTransactionAddress>[0]['serializedTransaction'] })
        .then((from) => from, () => null)
        .then((from) => {
          this.opts.onSignal({
            launchpad,
            factory: getAddress(to),
            txHash: tx.hash,
            from,
            selector,
            functionName,
            label: entry.label,
            kind: entry.kind,
            value: tx.transaction.value ?? 0n,
            sequenceNumber: m.sequenceNumber,
            seenAt: now,
          })
        })
    }
  }
}
