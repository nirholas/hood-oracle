/**
 * Sign once, broadcast everywhere. A raw transaction is sent to every RPC URL
 * in parallel; the first accepted hash wins and every other acceptance (or an
 * "already known" from a node that saw it via gossip) is the same success.
 * Then the receipt is awaited against the fallback client with a deadline.
 *
 * Nonce discipline: the account's viem nonce manager hands out the next nonce;
 * if no node accepts the transaction the nonce is handed back (reset) so the
 * next attempt does not skip a number and stall the wallet.
 */
import { type Address, type Hash, type Hex, type TransactionReceipt, formatGwei } from 'viem'
import type { ChainClient } from './client.js'
import { errorText } from './client.js'

export interface SubmitRequest {
  to: Address
  data: Hex
  value?: bigint
  /** Gas limit override; estimated with 25% headroom when omitted. */
  gas?: bigint
}

export interface SubmitResult {
  hash: Hash
  receipt: TransactionReceipt
  /** ms from signing to the first RPC acceptance. */
  acceptMs: number
  /** ms from signing to receipt. */
  confirmMs: number
  acceptedBy: string[]
  gasWei: bigint
}

export class SubmitError extends Error {
  constructor(message: string, readonly hash: Hash | null, readonly stage: 'prepare' | 'broadcast' | 'receipt' | 'reverted') {
    super(message)
    this.name = 'SubmitError'
  }
}

const ACCEPTED_ANYWAY = /(already known|already exists|alreadyknown|known transaction|nonce too low|replacement transaction underpriced|transaction already imported)/i

async function sendRaw(url: string, raw: Hex, timeoutMs: number): Promise<{ url: string; hash: Hash | null; error: string | null }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [raw] }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body = (await res.json()) as { result?: Hash; error?: { message?: string; code?: number } }
    if (body.result) return { url, hash: body.result, error: null }
    return { url, hash: null, error: body.error?.message ?? `http ${res.status}` }
  } catch (err) {
    return { url, hash: null, error: errorText(err) }
  }
}

/**
 * Prepare, sign, broadcast to every HTTP RPC in parallel, and wait for the
 * receipt. Throws SubmitError with the stage that failed; a reverted receipt
 * is stage 'reverted' and carries the hash.
 */
export async function submitTransaction(chain: ChainClient, req: SubmitRequest, opts: { receiptDeadlineMs?: number; broadcastTimeoutMs?: number } = {}): Promise<SubmitResult> {
  const { account, walletClient, publicClient } = chain
  if (!account || !walletClient) throw new SubmitError('no signing account configured', null, 'prepare')
  const receiptDeadlineMs = opts.receiptDeadlineMs ?? 30_000
  const broadcastTimeoutMs = opts.broadcastTimeoutMs ?? 8_000

  let raw: Hex
  let nonce: number
  try {
    const gas = req.gas ?? await publicClient.estimateGas({ account, to: req.to, data: req.data, value: req.value ?? 0n }).then((g) => (g * 125n) / 100n)
    const fees = await publicClient.estimateFeesPerGas()
    nonce = account.nonceManager
      ? await account.nonceManager.consume({ address: account.address, chainId: chain.chainId, client: publicClient })
      : await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' })
    const prepared = await walletClient.prepareTransactionRequest({
      account,
      to: req.to,
      data: req.data,
      value: req.value ?? 0n,
      gas,
      nonce,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      type: 'eip1559',
      chain: chain.chain,
    })
    raw = await walletClient.signTransaction(prepared)
  } catch (err) {
    throw new SubmitError(`prepare failed: ${errorText(err)}`, null, 'prepare')
  }

  const t0 = Date.now()
  const urls = chain.rpcUrls.filter((u) => !u.startsWith('ws'))
  const sends = urls.map((u) => sendRaw(u, raw, broadcastTimeoutMs))
  // Resolve on the first acceptance; keep the rest running for the audit trail.
  const first = await new Promise<{ url: string; hash: Hash } | null>((resolve) => {
    let pending = sends.length
    if (!pending) resolve(null)
    for (const p of sends) {
      p.then((r) => {
        if (r.hash) resolve({ url: r.url, hash: r.hash })
        else if (--pending === 0) resolve(null)
      })
    }
  })
  const acceptMs = Date.now() - t0

  let hash: Hash | null = first?.hash ?? null
  const results = await Promise.all(sends)
  if (!hash) {
    // "already known" means a node has it from gossip: the broadcast succeeded through another path.
    const knownAnyway = results.find((r) => r.error && ACCEPTED_ANYWAY.test(r.error))
    if (knownAnyway) {
      hash = await findPendingHash(chain, account.address, nonce)
    }
    if (!hash) {
      account.nonceManager?.reset({ address: account.address, chainId: chain.chainId })
      const detail = results.map((r) => `${r.url.split('/')[2]}: ${r.error}`).join('; ')
      throw new SubmitError(`no RPC accepted the transaction (${detail})`, null, 'broadcast')
    }
  }
  const acceptedBy = results.filter((r) => r.hash).map((r) => r.url)

  let receipt: TransactionReceipt
  try {
    receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: receiptDeadlineMs, pollingInterval: 150, retryCount: 4 })
  } catch (err) {
    throw new SubmitError(`receipt not seen within ${receiptDeadlineMs}ms: ${errorText(err)}`, hash, 'receipt')
  }
  const gasWei = receipt.gasUsed * receipt.effectiveGasPrice
  if (receipt.status !== 'success') {
    throw new SubmitError(`transaction reverted on-chain (gas ${formatGwei(receipt.effectiveGasPrice)} gwei)`, hash, 'reverted')
  }
  return { hash, receipt, acceptMs, confirmMs: Date.now() - t0, acceptedBy, gasWei }
}

/** Locate the hash of the wallet's transaction at `nonce` once a node reports it as already known. */
async function findPendingHash(chain: ChainClient, address: Address, nonce: number): Promise<Hash | null> {
  for (let i = 0; i < 20; i++) {
    try {
      const block = await chain.publicClient.getBlock({ blockTag: 'latest', includeTransactions: true })
      const hit = block.transactions.find((tx) => tx.from.toLowerCase() === address.toLowerCase() && tx.nonce === nonce)
      if (hit) return hit.hash
    } catch {
      // keep polling until the deadline below
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  return null
}
