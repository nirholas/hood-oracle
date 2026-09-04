/**
 * Exact ETH <-> wei conversion on decimal strings. Shared by the API (input
 * parsing) and the dashboard (form fields), so both sides agree to the wei.
 * Never goes through a float: 0.1 ETH is exactly 100000000000000000 wei here.
 */

export const WEI_PER_ETH = 10n ** 18n

const DECIMAL = /^\d+(\.\d+)?$/

/** "0.05" | 0.05 -> 50000000000000000n. Throws on a negative, NaN, or more than 18 decimals. */
export function ethToWei(input: string | number): bigint {
  const s = typeof input === 'number' ? numberToDecimalString(input) : input.trim()
  if (!DECIMAL.test(s)) throw new Error(`not a non-negative decimal ETH amount: ${JSON.stringify(input)}`)
  const [whole, frac = ''] = s.split('.')
  if (frac.length > 18) throw new Error('ETH amounts carry at most 18 decimals')
  return BigInt(whole) * WEI_PER_ETH + BigInt(frac.padEnd(18, '0') || '0')
}

/** wei (bigint or decimal string) -> ETH as a JS number, for display only. */
export function weiToEth(wei: bigint | string | number | null | undefined): number {
  if (wei == null) return 0
  const b = typeof wei === 'bigint' ? wei : BigInt(String(wei).split('.')[0] || '0')
  const neg = b < 0n
  const abs = neg ? -b : b
  const whole = abs / WEI_PER_ETH
  const frac = abs % WEI_PER_ETH
  const n = Number(whole) + Number(frac) / 1e18
  return neg ? -n : n
}

/** wei -> exact decimal ETH string with trailing zeros trimmed ("0.05"). */
export function weiToEthString(wei: bigint | string): string {
  const b = typeof wei === 'bigint' ? wei : BigInt(String(wei).split('.')[0] || '0')
  const neg = b < 0n
  const abs = neg ? -b : b
  const whole = (abs / WEI_PER_ETH).toString()
  const frac = (abs % WEI_PER_ETH).toString().padStart(18, '0').replace(/0+$/, '')
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`
}

/**
 * The shortest round-trip decimal for the number (what the user typed), with
 * exponent notation expanded. toFixed(18) would surface binary noise
 * (0.1 -> 0.100000000000000006) and store 6 wei the user never asked for.
 */
function numberToDecimalString(n: number): string {
  if (!Number.isFinite(n) || n < 0) throw new Error(`not a non-negative finite ETH amount: ${n}`)
  const s = String(n)
  const m = /^(\d+)(?:\.(\d+))?e([+-]\d+)$/i.exec(s)
  if (!m) return s
  const digits = m[1] + (m[2] ?? '')
  const exp = Number(m[3]) - (m[2]?.length ?? 0)
  if (exp >= 0) return digits + '0'.repeat(exp)
  const pad = -exp - digits.length
  return pad >= 0 ? '0.' + '0'.repeat(pad) + digits : digits.slice(0, digits.length + exp) + '.' + digits.slice(digits.length + exp)
}
