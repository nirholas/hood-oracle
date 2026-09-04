/**
 * /app/connect: wallet sign-in and the on-chain arm accounts a wallet owns.
 *
 * The server never holds an owner key, so every state change here is a
 * transaction this page asks the user's wallet to sign: the factory call that
 * clones an account, and the `setPolicy` call that changes its bounds. The
 * API only ever hands back unsigned calldata and reads the chain back.
 */
import type {
  AccountDetailResponse, AccountPolicyWire, AccountWire, AccountsResponse, MeResponse,
  NonceResponse, PrepareCreateResponse, PreparePolicyResponse, StatusResponse, UnsignedTx, VerifyResponse,
} from '../../src/api/contract'
import { buildSiweMessage } from '../../src/accounts/siwe'
import { ethToWei, weiToEthString } from '../../src/api/wei'
import { api, errorMessage } from './api'
import { $, copyText, h, maybe, setHtml, skeletonRows, stateBlock, toast } from './dom'
import { ago, fmtDuration, fmtEth, fmtNum, shortAddr, shortHash } from './format'
import { mountShell } from './shell'

// ── the wallet ───────────────────────────────────────────────────────────────

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>
  on?(event: string, handler: (...args: unknown[]) => void): void
  removeListener?(event: string, handler: (...args: unknown[]) => void): void
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider
  }
}

/** An EIP-1193 rejection carries a numeric code; 4001 is "the user said no". */
function walletError(err: unknown): { code: number | null; message: string } {
  const e = err as { code?: unknown; message?: unknown; data?: { message?: unknown } } | null
  const code = typeof e?.code === 'number' ? e.code : null
  const raw = typeof e?.data?.message === 'string' ? e.data.message : typeof e?.message === 'string' ? e.message : String(err)
  return { code, message: raw.split('\n')[0]!.slice(0, 240) }
}

const REJECTED = 4001
const CHAIN_NOT_ADDED = 4902

const provider = (): Eip1193Provider | null => (typeof window !== 'undefined' && window.ethereum) || null

async function requestAccounts(): Promise<string[]> {
  const p = provider()
  if (!p) throw new Error('no wallet')
  return (await p.request({ method: 'eth_requestAccounts' })) as string[]
}

async function currentChainId(): Promise<number | null> {
  const p = provider()
  if (!p) return null
  const hex = (await p.request({ method: 'eth_chainId' })) as string
  return Number.parseInt(hex, 16)
}

/** Move the wallet to the chain this server trades on, adding the network if the wallet has never seen it. */
async function ensureChain(status: StatusResponse): Promise<void> {
  const p = provider()
  if (!p) throw new Error('no wallet')
  if ((await currentChainId()) === status.chainId) return
  const hexId = `0x${status.chainId.toString(16)}`
  try {
    await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexId }] })
  } catch (err) {
    const { code } = walletError(err)
    if (code !== CHAIN_NOT_ADDED) throw err
    await p.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: hexId,
        chainName: status.network === 'mainnet' ? 'Robinhood Chain' : 'Robinhood Chain Testnet',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: [status.publicRpcUrl],
        blockExplorerUrls: [status.explorerUrl],
      }],
    })
  }
  if ((await currentChainId()) !== status.chainId) {
    throw new Error(`the wallet is still on another network; switch it to chain ${status.chainId} and try again`)
  }
}

/** Sends a prepared transaction and waits for it to be mined, polling the wallet's own RPC. */
async function sendAndWait(from: string, tx: UnsignedTx, onStatus: (s: string) => void): Promise<string> {
  const p = provider()
  if (!p) throw new Error('no wallet')
  onStatus('Waiting for the wallet…')
  const hash = (await p.request({
    method: 'eth_sendTransaction',
    params: [{ from, to: tx.to, data: tx.data, value: `0x${BigInt(tx.value).toString(16)}` }],
  })) as string
  onStatus(`Sent ${shortHash(hash)}. Waiting for the receipt…`)
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const receipt = (await p.request({ method: 'eth_getTransactionReceipt', params: [hash] })) as { status?: string } | null
    if (receipt) {
      if (receipt.status === '0x0') throw new Error(`transaction ${shortHash(hash)} reverted on chain`)
      return hash
    }
    await sleep(1_200)
  }
  throw new Error(`transaction ${shortHash(hash)} has not been mined after two minutes; it may still land, reload to pick it up`)
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// ── page state ───────────────────────────────────────────────────────────────

const shell = mountShell({ page: 'connect' })

interface PageState {
  wallet: string | null
  walletChainId: number | null
  session: MeResponse | null
  accounts: AccountWire[]
  factory: string | null
  operator: string | null
  defaultPolicy: AccountPolicyWire | null
  selected: string | null
  detail: AccountDetailResponse | null
  loading: boolean
  error: string | null
}

const state: PageState = {
  wallet: null,
  walletChainId: null,
  session: null,
  accounts: [],
  factory: null,
  operator: null,
  defaultPolicy: null,
  selected: null,
  detail: null,
  loading: true,
  error: null,
}

const signedIn = (): boolean => Boolean(state.session?.address)

// ── wallet card ──────────────────────────────────────────────────────────────

function renderWallet(): void {
  const el = $('#walletCard')
  const status = shell.status
  if (!provider()) {
    setHtml(
      el,
      h`<div class="state compact"><b>No wallet in this browser</b>Install a wallet extension (any EIP-1193 wallet works) to deploy and control an account. You can still read every arm, score and position without one.
        <div><a class="btn sm" href="/docs/multi-tenant">Read how accounts work</a></div></div>`,
    )
    return
  }
  const chainOk = state.walletChainId != null && status != null && state.walletChainId === status.chainId
  if (!signedIn()) {
    setHtml(
      el,
      h`<div class="wallet-line"><span class="dot ${state.wallet ? 'warn' : 'off'}"></span>${state.wallet ? shortAddr(state.wallet) : 'not connected'}${
        state.wallet && !chainOk ? h` <span class="badge b-revoked">wrong network</span>` : ''
      }</div>
      <p class="field-hint" style="margin:10px 0 14px">Signing in proves you control the address. The signature moves no funds and approves no transaction; it only tells this server which accounts are yours.</p>
      <button type="button" class="btn primary block" id="signInBtn">${state.wallet ? 'Sign in with this wallet' : 'Connect wallet'}</button>`,
    )
    $('#signInBtn').addEventListener('click', () => void signIn())
    return
  }
  const me = state.session!
  setHtml(
    el,
    h`<div class="wallet-line"><span class="dot ${chainOk ? 'live' : 'warn'}"></span>${shortAddr(me.address!)}<span class="badge">chain ${me.chainId}</span></div>
    <div class="kv" style="margin-top:12px">
      <div>signed in until</div><div>${me.expiresAt ? new Date(me.expiresAt).toLocaleString() : 'n/a'}</div>
      <div>engine operator</div><div>${me.operator ? shortAddr(me.operator) : 'none'}</div>
      <div>factory</div><div>${me.factory ? shortAddr(me.factory) : 'not configured'}</div>
    </div>
    <div class="btn-row" style="margin-top:14px">
      <button type="button" class="btn sm" id="newBtn"${me.factory && me.operator ? '' : ' disabled title="This server has no factory or no trading key configured, so it cannot operate an account yet."'}>New account</button>
      <button type="button" class="btn sm ghost" id="signOutBtn">Sign out</button>
    </div>`,
  )
  $('#newBtn').addEventListener('click', () => openCreate())
  $('#signOutBtn').addEventListener('click', () => void signOut())
}

async function connectWallet(): Promise<boolean> {
  try {
    const accounts = await requestAccounts()
    state.wallet = accounts[0] ?? null
    state.walletChainId = await currentChainId()
    renderWallet()
    return Boolean(state.wallet)
  } catch (err) {
    const { code, message } = walletError(err)
    toast(code === REJECTED ? 'Wallet connection refused' : `Wallet error: ${message}`, 'bad')
    return false
  }
}

async function signIn(): Promise<void> {
  const status = shell.status
  if (!status) {
    toast('The API is unreachable, so there is nothing to sign in to yet.', 'bad')
    return
  }
  if (!state.wallet && !(await connectWallet())) return
  const btn = maybe<HTMLButtonElement>('#signInBtn')
  if (btn) {
    btn.disabled = true
    btn.textContent = 'Check your wallet…'
  }
  try {
    await ensureChain(status)
    state.walletChainId = await currentChainId()
    const nonce = await api<NonceResponse>('/api/auth/nonce')
    if (!nonce.ok || !nonce.data) throw new Error(errorMessage(nonce, 'Could not get a sign-in nonce.'))
    const message = buildSiweMessage({
      domain: nonce.data.domain,
      address: state.wallet as `0x${string}`,
      uri: nonce.data.uri,
      chainId: nonce.data.chainId,
      nonce: nonce.data.nonce,
      statement: nonce.data.statement,
      expirationTime: new Date(nonce.data.expiresAt),
    })
    const signature = (await provider()!.request({ method: 'personal_sign', params: [message, state.wallet] })) as string
    const verified = await api<VerifyResponse>('/api/auth/verify', { method: 'POST', body: { message, signature } })
    if (!verified.ok) throw new Error(errorMessage(verified, 'The server rejected the signature.'))
    toast('Signed in', 'ok')
    await loadSession()
    await loadAccounts()
  } catch (err) {
    const { code, message } = walletError(err)
    toast(code === REJECTED ? 'Signature refused' : message, 'bad', 7_000)
  } finally {
    renderWallet()
  }
}

async function signOut(): Promise<void> {
  await api('/api/auth/logout', { method: 'POST' })
  state.session = null
  state.accounts = []
  state.selected = null
  state.detail = null
  renderWallet()
  renderAccounts()
  renderDetail()
  toast('Signed out', 'info')
}

// ── accounts ─────────────────────────────────────────────────────────────────

async function loadSession(): Promise<void> {
  const me = await api<MeResponse>('/api/auth/me')
  state.session = me.ok && me.data?.address ? me.data : me.ok ? { ...me.data!, address: null } : null
  if (state.session && !state.session.address) state.session = null
  if (me.ok && me.data) {
    state.factory = me.data.factory
    state.operator = me.data.operator
  }
}

async function loadAccounts(): Promise<void> {
  if (!signedIn()) {
    state.loading = false
    renderAccounts()
    renderDetail()
    return
  }
  state.loading = true
  renderAccounts()
  const r = await api<AccountsResponse>('/api/accounts', { timeout: 20_000 })
  state.loading = false
  if (!r.ok || !r.data) {
    state.error = errorMessage(r, 'Could not load your accounts.')
    renderAccounts()
    return
  }
  state.error = null
  state.accounts = r.data.accounts
  state.factory = r.data.factory
  state.operator = r.data.operator
  state.defaultPolicy = r.data.defaultPolicy
  if (state.selected && !state.accounts.some((a) => a.address === state.selected)) state.selected = null
  if (!state.selected && state.accounts.length) state.selected = state.accounts[0]!.address
  renderAccounts()
  if (state.selected) await loadDetail(state.selected)
  else renderDetail()
}

function statusBadge(a: AccountWire): ReturnType<typeof h> {
  const cls = a.status === 'active' ? 'b-active' : a.status === 'pending' ? 'b-pending' : 'b-revoked'
  return h`<span class="badge ${cls}" title="${a.revokedReason ?? ''}">${a.status}</span>`
}

function renderAccounts(): void {
  const el = $('#acctList')
  $('#acctCount').textContent = state.accounts.length ? String(state.accounts.length) : ''
  el.setAttribute('aria-busy', String(state.loading))
  if (!signedIn()) {
    stateBlock(el, { title: 'Sign in to see your accounts', body: 'Accounts are keyed to the wallet that created them. Nothing is shown until a wallet proves itself.', compact: true })
    return
  }
  if (state.loading) {
    setHtml(el, skeletonRows(3, [55, 20, 20]))
    return
  }
  if (state.error) {
    stateBlock(el, { title: 'Could not load accounts', body: state.error, kind: 'error', compact: true, action: { label: 'Try again', onClick: () => void loadAccounts() } })
    return
  }
  if (!state.accounts.length) {
    stateBlock(el, {
      title: 'No accounts yet',
      body: 'Deploy one from your wallet, fund it with ETH, then point an arm at it. It costs one transaction and the engine can never withdraw from it.',
      compact: true,
      action: { label: 'Create an account', onClick: () => openCreate() },
    })
    return
  }
  setHtml(
    el,
    h`${state.accounts.map((a) => h`<button type="button" class="acct ${a.address === state.selected ? 'on' : ''}" data-addr="${a.address}">
      <div class="a-top"><span class="a-addr">${a.label || shortAddr(a.address, 8, 6)}</span>${statusBadge(a)}</div>
      <div class="a-bal">${fmtEth(a.ethBalanceWei)}</div>
      <div class="a-sub"><span>${shortAddr(a.address, 6, 4)}</span><span>${a.policy ? `cap ${weiToEthString(a.policy.perTradeCapWei)} ETH` : 'policy unread'}</span><span>${a.lastSyncedAt ? `synced ${ago(a.lastSyncedAt)} ago` : 'never synced'}</span></div>
    </button>`)}`,
  )
  for (const btn of el.querySelectorAll<HTMLButtonElement>('.acct')) {
    btn.addEventListener('click', () => {
      state.selected = btn.dataset.addr!
      renderAccounts()
      void loadDetail(state.selected)
    })
  }
}

async function loadDetail(address: string): Promise<void> {
  setHtml($('#detailCard'), h`<div class="card-head"><div><h3>Account</h3><p class="sub">Reading the chain…</p></div></div>${skeletonRows(6, [40, 30])}`)
  const r = await api<AccountDetailResponse>(`/api/accounts/${address}`, { timeout: 20_000 })
  if (!r.ok || !r.data) {
    state.detail = null
    stateBlock($('#detailCard'), { title: 'Could not read this account', body: errorMessage(r), kind: 'error', action: { label: 'Retry', onClick: () => void loadDetail(address) } })
    return
  }
  state.detail = r.data
  renderDetail()
}

const POLICY_FIELDS: { key: keyof AccountPolicyWire; label: string; kind: 'eth' | 'int'; hint: string; max?: number }[] = [
  { key: 'perTradeCapWei', label: 'Per-trade cap', kind: 'eth', hint: 'The most the operator can spend on any single buy.' },
  { key: 'dailyBudgetWei', label: 'Daily budget', kind: 'eth', hint: 'Rolling 24h spend ceiling across every arm on this account.' },
  { key: 'maxOpenPositions', label: 'Max open positions', kind: 'int', hint: 'Buys are refused on chain past this many open positions.', max: 65_535 },
  { key: 'maxSlippageBps', label: 'Max slippage (bps)', kind: 'int', hint: 'The widest slippage the account will accept on a swap.', max: 10_000 },
  { key: 'cooldownSeconds', label: 'Cooldown (s)', kind: 'int', hint: 'Minimum seconds between buys.', max: 86_400 },
  { key: 'minOracleScore', label: 'Min oracle score', kind: 'int', hint: '0 disables the on-chain gate. Above 0, a buy needs a fresh signed attestation at least this high.', max: 100 },
]

function policyRows(p: AccountPolicyWire): ReturnType<typeof h> {
  return h`<div class="kv">
    <div>per-trade cap</div><div>${weiToEthString(p.perTradeCapWei)} ETH</div>
    <div>daily budget</div><div>${weiToEthString(p.dailyBudgetWei)} ETH</div>
    <div>max open positions</div><div>${p.maxOpenPositions}</div>
    <div>max slippage</div><div>${(p.maxSlippageBps / 100).toFixed(2)}%</div>
    <div>cooldown</div><div>${fmtDuration(p.cooldownSeconds)}</div>
    <div>hold hint</div><div>${fmtDuration(p.maxHoldSecondsHint)}</div>
    <div>min oracle score</div><div>${p.minOracleScore === 0 ? 'gate off' : p.minOracleScore}</div>
    <div>allowed router</div><div>${shortAddr(p.allowedRouter)}</div>
    <div>quote token</div><div>${shortAddr(p.quoteToken)}</div>
  </div>`
}

function renderDetail(): void {
  const el = $('#detailCard')
  if (!signedIn()) {
    setHtml(
      el,
      h`<div class="card-head"><div><h3>How an account works</h3><p class="sub">Four steps, one signature each, and the engine never holds your keys.</p></div></div>
      <ol class="steps">
        <li><b>Sign in with your wallet</b>One EIP-4361 signature. It proves the address and moves nothing.</li>
        <li><b>Deploy an account</b>A factory call clones a HoodArmAccount owned by your wallet, with this engine as its operator and your caps written into the contract.</li>
        <li><b>Fund it</b>Send ETH to the account address. The operator can swap it inside your policy; only your wallet can withdraw it.</li>
        <li><b>Point an arm at it</b>Pick the account on the arm page. Every buy that arm makes is a call the contract checks against your caps before it executes.</li>
      </ol>
      <div class="btn-row" style="margin-top:16px"><a class="btn sm ghost" href="/docs/multi-tenant">The full write-up</a><a class="btn sm ghost" href="/docs/contracts">The contracts</a></div>`,
    )
    return
  }
  const d = state.detail
  if (!d) {
    stateBlock(el, { title: 'No account selected', body: 'Create one, or pick one from the list to see its live policy, balances and arms.', compact: true })
    return
  }
  const a = d.account
  const chain = d.chain
  const operatorOk = chain ? chain.operator.toLowerCase() === (state.operator ?? '').toLowerCase() : null
  setHtml(
    el,
    h`<div class="card-head">
      <div><h3>${a.label || 'Arm account'} ${statusBadge(a)}</h3><p class="sub"><a href="${shell.explorerUrl('address', a.address)}" target="_blank" rel="noopener">${a.address}</a></p></div>
      <div class="btn-row">
        <button type="button" class="btn xs ghost" id="copyAddr">Copy address</button>
        <button type="button" class="btn xs ghost" id="refreshAcct">Refresh</button>
      </div>
    </div>
    ${chain?.killed ? h`<div class="state error compact" style="padding:12px"><b>This account is killed</b>Its owner called <code>kill()</code>. The operator cannot open new positions; exits still work.</div>` : ''}
    ${operatorOk === false ? h`<div class="state error compact" style="padding:12px"><b>This engine is no longer the operator</b>The account now answers to ${shortAddr(chain!.operator)}. Arms bound to it are disabled and will not trade.</div>` : ''}
    ${d.chainError ? h`<div class="state error compact" style="padding:12px"><b>Chain read failed</b>${d.chainError}</div>` : ''}
    <div class="stats" style="grid-template-columns:repeat(3,1fr)">
      <div class="stat"><span>Balance</span><div class="stat-val">${fmtEth(chain?.ethBalanceWei ?? a.ethBalanceWei, '')}</div><small>ETH in the account</small></div>
      <div class="stat"><span>Budget left</span><div class="stat-val">${chain ? fmtEth(chain.remainingDailyBudgetWei, '') : 'n/a'}</div><small>${chain ? `${fmtEth(chain.spentTodayWei)} spent today` : 'chain not read'}</small></div>
      <div class="stat"><span>Open</span><div class="stat-val">${chain ? chain.openPositionCount : d.positions.filter((p) => p.status === 'open').length}</div><small>${chain && chain.cooldownRemainingSeconds > 0 ? `cooldown ${fmtDuration(chain.cooldownRemainingSeconds)}` : 'no cooldown'}</small></div>
    </div>
    <h4 style="margin:6px 0 8px;font-size:13px">Policy <span class="badge">on chain</span></h4>
    ${chain ? policyRows(chain.policy) : a.policy ? policyRows(a.policy) : h`<p class="sub">This account has never been read from the chain.</p>`}
    <div class="btn-row" style="margin-top:14px">
      <button type="button" class="btn sm" id="editPolicy"${chain || a.policy ? '' : ' disabled'}>Change policy</button>
      <a class="btn sm ghost" href="/app/arm?account=${a.id}">Bind an arm</a>
    </div>
    <h4 style="margin:20px 0 8px;font-size:13px">Arms on this account <span class="badge">${d.arms.length}</span></h4>
    ${d.arms.length
      ? h`<div class="kv">${d.arms.map((arm) => h`<div><a href="/app/arm?id=${arm.id}">${arm.label}</a></div><div>${arm.enabled ? arm.mode : 'off'} · ${weiToEthString(arm.perTradeWei)} ETH</div>`)}</div>`
      : h`<p class="sub">No arm trades this account yet. Bind one from the arm page and every buy it makes will be checked against the policy above.</p>`}
    <h4 style="margin:20px 0 8px;font-size:13px">Realized</h4>
    <div class="kv">
      <div>closed positions</div><div>${fmtNum(d.realized.closed)}</div>
      <div>wins</div><div>${fmtNum(d.realized.wins)}${d.realized.closed ? ` (${Math.round((d.realized.wins / d.realized.closed) * 100)}%)` : ''}</div>
      <div>realized pnl</div><div>${fmtEth(d.realized.realizedPnlWei)}</div>
      <div>fees accrued</div><div>${chain ? fmtEth(chain.feesAccruedWei) : 'n/a'}</div>
    </div>`,
  )
  $('#copyAddr').addEventListener('click', () => void copyText(a.address))
  $('#refreshAcct').addEventListener('click', () => void refreshAccount(a.address))
  maybe<HTMLButtonElement>('#editPolicy')?.addEventListener('click', () => openPolicyEditor(a, (chain?.policy ?? a.policy)!))
}

async function refreshAccount(address: string): Promise<void> {
  const btn = maybe<HTMLButtonElement>('#refreshAcct')
  if (btn) btn.disabled = true
  const r = await api(`/api/accounts/${address}/refresh`, { method: 'POST', timeout: 20_000 })
  if (!r.ok) toast(errorMessage(r, 'Refresh failed.'), 'bad')
  await loadDetail(address)
  await loadAccountsQuiet()
}

/** Re-read the list without tearing the panel down (used after a write). */
async function loadAccountsQuiet(): Promise<void> {
  const r = await api<AccountsResponse>('/api/accounts', { timeout: 20_000 })
  if (r.ok && r.data) {
    state.accounts = r.data.accounts
    state.defaultPolicy = r.data.defaultPolicy
    renderAccounts()
  }
}

// ── create and edit, both through the wallet ─────────────────────────────────

function policyForm(base: AccountPolicyWire, idPrefix: string): ReturnType<typeof h> {
  return h`<div class="row2">${POLICY_FIELDS.map((f) => {
    const value = f.kind === 'eth' ? weiToEthString(base[f.key] as string) : String(base[f.key])
    return h`<div class="field">
      <label for="${idPrefix}-${String(f.key)}">${f.label}</label>
      <input id="${idPrefix}-${String(f.key)}" type="text" inputmode="decimal" value="${value}" data-key="${String(f.key)}" data-kind="${f.kind}" ${f.max ? h`data-max="${f.max}"` : ''} title="${f.hint}">
    </div>`
  })}</div>`
}

/** Reads a policy form back, or throws the first message a human can act on. */
function readPolicyForm(root: ParentNode, base: AccountPolicyWire): AccountPolicyWire {
  const next: AccountPolicyWire = { ...base }
  for (const input of root.querySelectorAll<HTMLInputElement>('input[data-key]')) {
    const key = input.dataset.key as keyof AccountPolicyWire
    const value = input.value.trim()
    input.classList.remove('invalid')
    const fail = (why: string): never => {
      input.classList.add('invalid')
      input.focus()
      throw new Error(why)
    }
    if (!value) fail(`${key} cannot be empty`)
    if (input.dataset.kind === 'eth') {
      let wei: bigint
      try {
        wei = ethToWei(value)
      } catch {
        return fail(`${value} is not a valid ETH amount`)
      }
      if (wei <= 0n) fail(`${key} must be more than zero`)
      ;(next[key] as string) = wei.toString()
    } else {
      const n = Number(value)
      const max = Number(input.dataset.max ?? Number.MAX_SAFE_INTEGER)
      if (!Number.isInteger(n) || n < 0 || n > max) fail(`${key} must be a whole number between 0 and ${max}`)
      ;(next[key] as number) = n
    }
  }
  if (BigInt(next.perTradeCapWei) > BigInt(next.dailyBudgetWei)) {
    throw new Error('the per-trade cap cannot be larger than the daily budget')
  }
  return next
}

/** Shows exactly what the wallet will be asked to sign, and resolves only on an explicit yes. */
function confirmTx(tx: UnsignedTx, note: string): Promise<boolean> {
  const dialog = $<HTMLDialogElement>('#txDialog')
  $('#txNote').textContent = note
  setHtml(
    $('#txBox'),
    h`<div>to <b>${tx.to}</b></div><div>value <b>${weiToEthString(tx.value)} ETH</b></div><div>chain <b>${tx.chainId}</b></div><div style="margin-top:8px">${tx.summary}</div>`,
  )
  const confirm = $<HTMLButtonElement>('#txConfirm')
  confirm.disabled = false
  confirm.textContent = 'Sign in wallet'
  return new Promise((resolve) => {
    const done = () => {
      dialog.removeEventListener('close', done)
      resolve(dialog.returnValue === 'go')
    }
    dialog.addEventListener('close', done)
    dialog.returnValue = ''
    dialog.showModal()
  })
}

function txStatus(text: string): void {
  const confirm = maybe<HTMLButtonElement>('#txConfirm')
  if (confirm) {
    confirm.disabled = true
    confirm.textContent = text
  }
}

function openCreate(): void {
  const base = state.defaultPolicy
  if (!base) {
    toast('The factory default policy could not be read, so there is nothing to prefill. Reload and try again.', 'bad', 6_000)
    return
  }
  const el = $('#detailCard')
  setHtml(
    el,
    h`<div class="card-head"><div><h3>New arm account</h3><p class="sub">These caps are written into the contract. The engine cannot exceed them, and only your wallet can change them later.</p></div></div>
    <div class="field"><label for="newLabel">Label</label><input id="newLabel" type="text" maxlength="80" placeholder="e.g. main" value=""></div>
    ${policyForm(base, 'new')}
    <p class="field-hint">Operator: ${state.operator ? shortAddr(state.operator) : 'none'} · Router and quote token come from the factory default and are not editable here, because an account that allows an unknown router is an account the engine cannot trade.</p>
    <div class="btn-row" style="margin-top:14px">
      <button type="button" class="btn sm primary" id="createBtn">Review transaction</button>
      <button type="button" class="btn sm ghost" id="cancelCreate">Cancel</button>
    </div>`,
  )
  $('#cancelCreate').addEventListener('click', () => renderDetail())
  $('#createBtn').addEventListener('click', () => void submitCreate(base))
}

async function submitCreate(base: AccountPolicyWire): Promise<void> {
  const btn = $<HTMLButtonElement>('#createBtn')
  let policy: AccountPolicyWire
  try {
    policy = readPolicyForm($('#detailCard'), base)
  } catch (err) {
    toast((err as Error).message, 'bad', 6_000)
    return
  }
  const label = $<HTMLInputElement>('#newLabel').value.trim()
  btn.disabled = true
  btn.textContent = 'Building…'
  const prepared = await api<PrepareCreateResponse>('/api/accounts/prepare', { method: 'POST', body: { policy }, timeout: 20_000 })
  btn.disabled = false
  btn.textContent = 'Review transaction'
  if (!prepared.ok || !prepared.data) {
    toast(errorMessage(prepared, 'Could not build the create transaction.'), 'bad', 7_000)
    return
  }
  if (!(await confirmTx(prepared.data.tx, prepared.data.note))) return
  try {
    if (!state.wallet && !(await connectWallet())) return
    await ensureChain(shell.status!)
    const hash = await sendAndWait(state.wallet!, prepared.data.tx, txStatus)
    txStatus('Registering…')
    const registered = await api<{ account: AccountWire }>('/api/accounts/register', { method: 'POST', body: { txHash: hash, label: label || null }, timeout: 30_000 })
    if (!registered.ok || !registered.data) throw new Error(errorMessage(registered, 'The account was created on chain but the server could not read it back. Reload to pick it up.'))
    state.selected = registered.data.account.address
    toast('Account deployed', 'ok')
    await loadAccounts()
  } catch (err) {
    const { code, message } = walletError(err)
    toast(code === REJECTED ? 'Transaction refused' : message, 'bad', 9_000)
  } finally {
    $<HTMLDialogElement>('#txDialog').close('done')
  }
}

function openPolicyEditor(account: AccountWire, current: AccountPolicyWire): void {
  const el = $('#detailCard')
  setHtml(
    el,
    h`<div class="card-head"><div><h3>Change policy</h3><p class="sub">Tightening any bound lands immediately. Loosening one queues for an hour before it can be applied, so a stolen owner key cannot widen your caps and drain the account in one go.</p></div></div>
    ${policyForm(current, 'edit')}
    <div class="btn-row" style="margin-top:14px">
      <button type="button" class="btn sm primary" id="savePolicy">Review transaction</button>
      <button type="button" class="btn sm ghost" id="cancelPolicy">Cancel</button>
    </div>`,
  )
  $('#cancelPolicy').addEventListener('click', () => renderDetail())
  $('#savePolicy').addEventListener('click', () => void submitPolicy(account, current))
}

async function submitPolicy(account: AccountWire, current: AccountPolicyWire): Promise<void> {
  const btn = $<HTMLButtonElement>('#savePolicy')
  let policy: AccountPolicyWire
  try {
    policy = readPolicyForm($('#detailCard'), current)
  } catch (err) {
    toast((err as Error).message, 'bad', 6_000)
    return
  }
  btn.disabled = true
  btn.textContent = 'Building…'
  const prepared = await api<PreparePolicyResponse>(`/api/accounts/${account.address}/policy/prepare`, { method: 'POST', body: { policy }, timeout: 20_000 })
  btn.disabled = false
  btn.textContent = 'Review transaction'
  if (!prepared.ok || !prepared.data) {
    toast(errorMessage(prepared, 'Could not build the policy transaction.'), 'bad', 7_000)
    return
  }
  if (!(await confirmTx(prepared.data.tx, prepared.data.note))) return
  try {
    if (!state.wallet && !(await connectWallet())) return
    await ensureChain(shell.status!)
    await sendAndWait(state.wallet!, prepared.data.tx, txStatus)
    toast(prepared.data.immediate ? 'Policy updated' : 'Policy queued: applyPolicy() unlocks in one hour', 'ok', 7_000)
    await refreshAccount(account.address)
  } catch (err) {
    const { code, message } = walletError(err)
    toast(code === REJECTED ? 'Transaction refused' : message, 'bad', 9_000)
  } finally {
    $<HTMLDialogElement>('#txDialog').close('done')
  }
}

// ── boot ─────────────────────────────────────────────────────────────────────

$('#txCancel').addEventListener('click', () => $<HTMLDialogElement>('#txDialog').close('cancel'))
$<HTMLDialogElement>('#txDialog').addEventListener('submit', () => {
  $<HTMLDialogElement>('#txDialog').returnValue = 'go'
})
$('#reloadBtn').addEventListener('click', () => void loadAccounts())

const p = provider()
p?.on?.('accountsChanged', (...args: unknown[]) => {
  const accounts = (args[0] as string[] | undefined) ?? []
  const next = accounts[0] ?? null
  if (next?.toLowerCase() === state.wallet?.toLowerCase()) return
  state.wallet = next
  // The session belongs to the old address; drop it rather than showing another wallet's accounts.
  void signOut()
})
p?.on?.('chainChanged', (...args: unknown[]) => {
  state.walletChainId = Number.parseInt(String(args[0] ?? '0x0'), 16)
  renderWallet()
})

void (async () => {
  if (p) {
    const existing = (await p.request({ method: 'eth_accounts' }).catch(() => [])) as string[]
    state.wallet = existing[0] ?? null
    state.walletChainId = await currentChainId().catch(() => null)
  }
  await loadSession()
  renderWallet()
  await loadAccounts()
})()

shell.onStatus(() => {
  if (!signedIn()) renderWallet()
})
