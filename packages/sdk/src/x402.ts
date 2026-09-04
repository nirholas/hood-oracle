/**
 * Pay for GET /api/x402/score/:token with USDG on Robinhood Chain (4663).
 * hood402's client signs an EIP-3009 TransferWithAuthorization for the
 * amount the 402 asks for and retries with the X-PAYMENT header; the
 * engine's facilitator settles it and the verdict comes back with an
 * X-PAYMENT-RESPONSE receipt. The payer needs USDG, never ETH: settlement gas
 * is the facilitator's.
 *
 * `hood402` and `viem` are optional peer dependencies loaded on first use.
 */
import type { HoodOracleClient } from './client.js'
import { HoodOracleError } from './errors.js'

type Hex = `0x${string}`

/** A viem `LocalAccount` (from `privateKeyToAccount`) or anything with the same two members. */
export interface SignerAccount {
  address: Hex
  signTypedData(args: unknown): Promise<Hex>
}

/** A viem `WalletClient` (an injected wallet in the browser) plus the address to sign with. */
export interface WalletSigner {
  walletClient: { signTypedData(args: unknown): Promise<Hex> }
  address: Hex
}

export type X402PayOptions = ({ account: SignerAccount } | WalletSigner) & {
  /** Hard cap on what this client will sign per origin, in USDG (default `"1.00"`). */
  maxSpendUsdg?: string
  /** Validity window of the signed authorization, seconds (default 300). */
  validitySeconds?: number
}

export interface X402Settlement {
  success: boolean
  transaction?: Hex
  network?: string
  payer?: Hex
}

export interface X402PayResult<T> {
  data: T
  /** True when a payment was made (false when the route answered without a 402). */
  paid: boolean
  /** Decoded X-PAYMENT-RESPONSE settlement receipt, when a payment was made. */
  settlement?: X402Settlement
  /** USDG spent against this origin so far by this client. */
  spentUsdg: string
}

interface Hood402ClientModule {
  Hood402Client: new (opts: {
    signer: unknown
    maxSpendPerOrigin?: string
    validitySeconds?: number
    fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  }) => {
    fetchWithReceipt(url: string, init?: RequestInit): Promise<{ response: Response; paid: boolean; settlement?: X402Settlement }>
    spent(origin: string): string
  }
  fromAccount(account: unknown): unknown
  fromWalletClient(client: unknown, address: Hex): unknown
}

async function loadHood402(): Promise<Hood402ClientModule> {
  try {
    return (await import('hood402/client')) as unknown as Hood402ClientModule
  } catch (err) {
    throw new HoodOracleError(0, 'hood402_missing', `Paying for a score needs the hood402 package: npm install hood402 viem (${err instanceof Error ? err.message : String(err)})`)
  }
}

export async function payForScore<T = unknown>(client: HoodOracleClient, token: string, opts: X402PayOptions): Promise<X402PayResult<T>> {
  const hood402 = await loadHood402()
  const signer = 'account' in opts ? hood402.fromAccount(opts.account) : hood402.fromWalletClient(opts.walletClient, opts.address)
  const payer = new hood402.Hood402Client({
    signer,
    maxSpendPerOrigin: opts.maxSpendUsdg,
    validitySeconds: opts.validitySeconds,
    fetch: (input, init) => client.raw('GET', new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url).pathname, undefined, init ?? {}),
  })
  const url = client.url(`/api/x402/score/${encodeURIComponent(token)}`)
  const { response, paid, settlement } = await payer.fetchWithReceipt(url)
  if (!response.ok) throw await HoodOracleError.fromResponse(response)
  return { data: (await response.json()) as T, paid, settlement, spentUsdg: payer.spent(url) }
}
