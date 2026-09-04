/**
 * Telegram alerts over the Bot API with plain fetch. Best-effort by design:
 * an alert never throws into the trade loop, a repeated signature pages once
 * an hour, and a slow Telegram cannot hold a fill (2.5s timeout). Per-arm
 * chat ids override the engine-wide chat.
 */
import type { Logger } from '../log.js'
import type { Config } from '../config.js'

export interface AlertOptions {
  /** Per-arm chat id; falls back to the configured chat. */
  chatId?: string | null
  /** Stable dedup key; the same signature is sent at most once per hour. */
  signature?: string
  /** Do not deduplicate (trade notifications). */
  always?: boolean
}

const DEDUP_MS = 60 * 60 * 1000
const TIMEOUT_MS = 2_500

export class Alerts {
  private readonly recent = new Map<string, number>()
  private readonly telegram: Config['telegram']

  constructor(config: Pick<Config, 'telegram' | 'network'>, private readonly log: Logger) {
    this.telegram = config.telegram
    this.network = config.network
  }

  private readonly network: string

  get enabled(): boolean {
    return this.telegram !== null
  }

  /** Send a message. Resolves true when Telegram accepted it. */
  async send(text: string, opts: AlertOptions = {}): Promise<boolean> {
    if (!this.telegram) return false
    const chatId = opts.chatId || this.telegram.chatId
    if (!opts.always && opts.signature) {
      const key = `${chatId}:${opts.signature}`
      const last = this.recent.get(key) ?? 0
      if (Date.now() - last < DEDUP_MS) return false
      this.recent.set(key, Date.now())
      if (this.recent.size > 2000) this.recent.delete(this.recent.keys().next().value!)
    }
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.telegram.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: `[hood-oracle ${this.network}] ${text}`, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok) {
        this.log.warn({ status: res.status }, 'telegram rejected alert')
        return false
      }
      return true
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'telegram alert failed')
      return false
    }
  }

  boot(detail: { mode: string; arms: number; live: number }): void {
    void this.send(`engine online: ${detail.arms} arms (${detail.live} live), feed ${detail.mode}`, { signature: 'boot' })
  }

  kill(reason: string): void {
    void this.send(`KILL SWITCH: ${reason}. New buys halted; exits keep managing.`, { always: true })
  }

  buy(d: { armLabel: string; token: string; symbol: string | null; ethIn: string; mode: string; score: number | null; chatId: string | null }): void {
    void this.send(`BUY ${d.symbol ?? d.token.slice(0, 10)} (${d.mode}) by ${d.armLabel}: ${d.ethIn} ETH${d.score != null ? `, oracle ${d.score}` : ''}`, { always: true, chatId: d.chatId })
  }

  sell(d: { armLabel: string; token: string; symbol: string | null; reason: string; pnlPct: number | null; ethOut: string; mode: string; fraction: number; chatId: string | null }): void {
    const pnl = d.pnlPct == null ? 'pnl unknown' : `${d.pnlPct >= 0 ? '+' : ''}${d.pnlPct.toFixed(1)}%`
    const part = d.fraction < 1 ? ` (${Math.round(d.fraction * 100)}% of bag)` : ''
    void this.send(`SELL ${d.symbol ?? d.token.slice(0, 10)} (${d.mode}) by ${d.armLabel}: ${d.reason}${part}, ${d.ethOut} ETH, ${pnl}`, { always: true, chatId: d.chatId })
  }

  warn(signature: string, text: string, chatId?: string | null): void {
    void this.send(`WARN ${text}`, { signature, chatId })
  }

  error(signature: string, text: string): void {
    void this.send(`ERROR ${text}`, { signature })
  }
}
