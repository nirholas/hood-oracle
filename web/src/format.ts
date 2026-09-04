import { weiToEth, weiToEthString } from '../../src/api/wei'

export { weiToEth, weiToEthString }

/** wei -> "0.0500 ETH", precision adapting to size so tiny sims stay legible. */
export function fmtEth(wei: string | bigint | null | undefined, unit = ' ETH'): string {
  if (wei == null) return 'n/a'
  const v = weiToEth(wei)
  const abs = Math.abs(v)
  const digits = abs === 0 ? 2 : abs >= 100 ? 1 : abs >= 1 ? 3 : abs >= 0.01 ? 4 : abs >= 0.0001 ? 6 : 8
  return `${v.toFixed(digits)}${unit}`
}

export function fmtSignedEth(wei: string | bigint | null | undefined): string {
  if (wei == null) return 'n/a'
  const v = weiToEth(wei)
  return `${v > 0 ? '+' : ''}${fmtEth(wei)}`
}

export function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return 'n/a'
  return `${n.toFixed(digits)}%`
}

export function fmtSignedPct(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return 'n/a'
  return `${n > 0 ? '+' : ''}${n.toFixed(digits)}%`
}

/** 0..1 ratio -> "42%". */
export function fmtRatio(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return 'n/a'
  return `${(n * 100).toFixed(digits)}%`
}

export function fmtNum(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return 'n/a'
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (Math.abs(n) >= 1e4) return `${(n / 1e3).toFixed(1)}k`
  return n.toFixed(digits)
}

export function ago(ts: string | number | Date | null | undefined): string {
  if (!ts) return 'n/a'
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000)
  if (s < 60) return `${Math.floor(s)}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return 'n/a'
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`
}

export function fmtDate(ts: string | number | Date | null | undefined): string {
  if (!ts) return 'n/a'
  const d = new Date(ts)
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function shortAddr(a: string | null | undefined, head = 6, tail = 4): string {
  if (!a) return 'n/a'
  return a.length > head + tail + 2 ? `${a.slice(0, head)}…${a.slice(-tail)}` : a
}

export function shortHash(h: string | null | undefined): string {
  if (!h) return 'n/a'
  if (h === 'SIMULATED') return 'simulated'
  return shortAddr(h, 8, 6)
}

/** Unrealized move of a position, in percent of entry. */
export function pnlPct(entryWei: string, valueWei: string | null): number | null {
  if (valueWei == null) return null
  const entry = BigInt(entryWei)
  if (entry === 0n) return null
  return Number(((BigInt(valueWei) - entry) * 10_000n) / entry) / 100
}

export function symbolOf(item: { symbol?: string | null; name?: string | null; token: string }): string {
  return item.symbol || item.name || shortAddr(item.token)
}

export function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}
