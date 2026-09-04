/**
 * Registry of the contracts that create token pools on Robinhood Chain
 * mainnet (4663), built from a scan of every Uniswap v3 `PoolCreated`
 * (238 over 400,000 blocks, 32 distinct creating `tx.to`) and every Uniswap
 * v4 `Initialize` (9,550 over the same span) on 2026-09-03, with each address
 * identified through Blockscout (verified source where it exists), its
 * calldata, and its emitted events. Counts below are pools created in that
 * scan. Unverified launchers are named by address prefix; their `kind` is
 * still 'launchpad' because every one of them deploys the token and seeds
 * the pool in one transaction from many distinct senders.
 *
 * Uniswap v4 on 4663: the PoolManager singleton
 * 0x8366a39CC670B4001A1121B8F6A443A643e40951 is live (found through the
 * Odyssey reflection factory's `v4Graduator().poolManager()`), with a
 * PositionManager and the UniversalRouter. Most v4 initializations pair
 * existing tokens with USDG behind fee-on-swap hooks; the launch-shaped ones
 * come from hook launchpads (Lunch tax hooks, RWA LaunchHook, PairV4,
 * CashCat, Forge). v4 launches are observed and scored (venue 'v4') but the
 * executor does not route them: the swap path is SwapRouter02 only.
 */
import { type AbiEvent, type Address, type Hex, getAddress, toFunctionSelector } from 'viem'
import { NOXA_ADDRESSES, ODYSSEY_ADDRESSES, MAINNET_ADDRESSES, noxaTokenLaunchedEvent } from 'hoodchain'
import { dontblinkLaunchedEvent, lunchV3PairLaunchedEvent, lunchV3TokenLaunchedEvent, odysseyCurveAbi, odysseyInstantAbi, odysseyReflectionPoolAbi, tokenSelectCreatedEvent } from './abis.js'
import type { Launchpad } from '../types.js'

export type LaunchpadKind = 'launchpad' | 'position-manager' | 'router' | 'unknown'

export interface LaunchpadEntry {
  address: Address
  /** The Launchpad literal a launch through this contract is recorded under. */
  name: Launchpad
  kind: LaunchpadKind
  /** Human label (contract name from verified source, or how it was identified). */
  label: string
  dex: 'v3' | 'v4' | 'curve'
  verified: boolean
  launchEventAbi?: AbiEvent
  /** Calldata selectors that mean "launch" on this contract; empty means any call is treated as a launch signal. */
  launchSelectors?: readonly Hex[]
  /** Function name per selector where the source is verified. */
  selectorNames?: Record<Hex, string>
  /** Pools created in the 400k-block scan (2026-09-03), for the record. */
  poolsInScan: number
  notes: string
}

export const UNISWAP_V4 = {
  poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951' as Address,
  positionManager: '0x58daec3116aae6d93017baaea7749052e8a04fa7' as Address,
  universalRouter: '0x8876789976dEcBfCbBbe364623C63652db8C0904' as Address,
} as const

const sel = (...sigs: string[]): Hex[] => sigs.map((s) => toFunctionSelector(s))
const names = (...sigs: string[]): Record<Hex, string> => Object.fromEntries(sigs.map((s) => [toFunctionSelector(s), s.slice('function '.length, s.indexOf('('))]))
const PONS_SIGS = ['function launchToken((string,string,string,string,(string,string,string,string,string),address),uint256,uint256,bytes32)']
const DONTBLINK_SIGS = ['function launch((uint16,string,string,address,uint24,uint24,uint32,uint8,uint128,uint16,uint8,uint16,bool,address,string,string,string,string,string,uint16,uint16),bytes32)']
const LUNCH_PAIR_SIGS = [
  'function launchPair(string,string,uint256,uint24,address,uint256,uint256)', 'function launchPairRef(string,string,uint256,uint24,address,uint256,uint256,address)',
  'function launchPairWithMeta(string,string,uint256,uint24,address,uint256,uint256,(string,string,string,string,string,string))', 'function launchPairWithMetaRef(string,string,uint256,uint24,address,uint256,uint256,(string,string,string,string,string,string),address)',
  'function launchPairEthWithMetaRef(string,string,uint256,uint24,address,bytes,uint256,(string,string,string,string,string,string),address)',
  'function launchPairWithMetaSalt(string,string,uint256,uint24,address,uint256,uint256,(string,string,string,string,string,string),bytes32)', 'function launchPairWithMetaSaltRef(string,string,uint256,uint24,address,uint256,uint256,(string,string,string,string,string,string),bytes32,address)',
  'function launchPairWithSalt(string,string,uint256,uint24,address,uint256,uint256,bytes32)', 'function launchPairWithSaltRef(string,string,uint256,uint24,address,uint256,uint256,bytes32,address)',
  'function launchDual(string,string,uint256,address,uint256,address)',
]
const LUNCH_SINGLE_SIGS = [
  'function launch(string,string,uint256,uint24,uint256)', 'function launchRef(string,string,uint256,uint24,uint256,address)', 'function launchWithMeta(string,string,uint256,uint24,uint256,(string,string,string,string,string,string))',
  'function launchWithMetaRef(string,string,uint256,uint24,uint256,(string,string,string,string,string,string),address)', 'function launchWithMetaSalt(string,string,uint256,uint24,uint256,(string,string,string,string,string,string),bytes32)',
  'function launchWithMetaSaltRef(string,string,uint256,uint24,uint256,(string,string,string,string,string,string),bytes32,address)', 'function launchWithSalt(string,string,uint256,uint24,uint256,bytes32)', 'function launchWithSaltRef(string,string,uint256,uint24,uint256,bytes32,address)',
]
const TOKENSELECT_SIGS = ['function createTokenSelectToken((string,string,string,string,string,string,string,uint256,uint256),address)']
const V3_NPM_SIGS = ['function multicall(bytes[])', 'function createAndInitializePoolIfNecessary(address,address,uint24,uint160)']
const V4_NPM_SIGS = ['function multicall(bytes[])', 'function initializePool((address,address,uint24,int24,address),uint160)']
const ev = (abi: readonly unknown[], name: string): AbiEvent => abi.find((x) => (x as AbiEvent).type === 'event' && (x as AbiEvent).name === name) as AbiEvent

export const LAUNCHPAD_REGISTRY: readonly LaunchpadEntry[] = [
  // ── launchpads the SDK already knew ───────────────────────────────────────
  { address: NOXA_ADDRESSES.launchFactory, name: 'noxa', kind: 'launchpad', label: 'NOXA launch factory', dex: 'v3', verified: false, launchEventAbi: noxaTokenLaunchedEvent as AbiEvent, poolsInScan: 0, notes: '14,574 launches historically, none since block ~5.25M.' },
  { address: ODYSSEY_ADDRESSES.bondingCurveFactory, name: 'odyssey', kind: 'launchpad', label: 'The Odyssey bonding-curve factory', dex: 'curve', verified: true, launchEventAbi: ev(odysseyCurveAbi, 'TokenCreated'), poolsInScan: 0, notes: 'Curve trades via buy/sell; graduates to a v3 pool (PoolMigrated).' },
  { address: ODYSSEY_ADDRESSES.reflectionFactory, name: 'odyssey', kind: 'launchpad', label: 'The Odyssey reflection factory', dex: 'curve', verified: true, launchEventAbi: ev(odysseyReflectionPoolAbi, 'TokenCreated'), poolsInScan: 0, notes: 'Graduates to a v4 pool (PoolMigratedV4); curve buys refused by the executor.' },
  { address: ODYSSEY_ADDRESSES.instantFactory, name: 'odyssey', kind: 'launchpad', label: 'The Odyssey instant factory', dex: 'v3', verified: true, launchEventAbi: ev(odysseyInstantAbi, 'InstantTokenCreated'), poolsInScan: 0, notes: 'Lists straight into a v3 pool carried by InstantTokenCreated.' },
  { address: ODYSSEY_ADDRESSES.legacyFactory, name: 'odyssey', kind: 'launchpad', label: 'The Odyssey legacy factory', dex: 'curve', verified: true, launchEventAbi: ev(odysseyCurveAbi, 'TokenCreated'), poolsInScan: 0, notes: 'First-generation factory; historical launches only.' },
  // ── v3 pool creators found in the scan ────────────────────────────────────
  { address: '0x4a3e797b2e4dd1cf96b352513ea91b2f6449e74a', name: 'launcher-4a3e797b', kind: 'launchpad', label: 'Unverified launcher 0x4a3e797b (selector 0xbdc35cd0)', dex: 'v3', verified: false, launchSelectors: ['0xbdc35cd0'], poolsInScan: 70, notes: 'Deploys the token and its WETH pool in one call; calldata carries name, symbol and an ipfs:// metadata URI; 70 launches from 46 distinct senders, so a public launchpad. Deployed by EOA 0xdf769057eb42b27bd7dd4c8643779f0dfe49a6a2. Emits topics 0x50aaba7c and 0x48b011bb (unverified).' },
  { address: '0xf4fc0cd27fc8ecf17e55ee4c3f7201897df3eb75', name: 'pons', kind: 'launchpad', label: 'PonsLaunchFactory (ERC1967 proxy to 0x02081d3Dec43f816b145672cFc65029948D396AE)', dex: 'v3', verified: true, launchEventAbi: noxaTokenLaunchedEvent as AbiEvent, launchSelectors: sel(...PONS_SIGS), selectorNames: names(...PONS_SIGS), poolsInScan: 17, notes: 'NOXA codebase: TokenLaunched has the identical signature; tokens are PonsLauncherToken with launch-window restrictions.' },
  { address: '0x1fae6f162355cf77bf7f23cb919130962dad4ecb', name: 'rialto', kind: 'launchpad', label: 'Rialto launchpad (unverified, selector 0x026f2bf0)', dex: 'v3', verified: false, launchSelectors: ['0x026f2bf0'], poolsInScan: 10, notes: 'Calldata carries name, symbol and an image at varo-assets.rialto.xyz/launchpad/<sender>/...; 10 launches from 10 senders.' },
  { address: '0x7a4eb7f99833178c6463184bd0d8d17b6fc2d59c', name: 'dontblink', kind: 'launchpad', label: 'DontblinkPortal (proxy to 0x2cda8ad7fab20614c60b5365a5801a190bea27bd)', dex: 'v3', verified: true, launchEventAbi: dontblinkLaunchedEvent as AbiEvent, launchSelectors: sel(...DONTBLINK_SIGS), selectorNames: names(...DONTBLINK_SIGS), poolsInScan: 8, notes: 'Launched(nonce, token, creator, ...) carries the pool and quote; all 8 scan launches came from one sender.' },
  { address: '0x568e12b312751992dcfe387cfc8ec7d63e941103', name: 'lunch', kind: 'launchpad', label: 'LunchV3PairLauncherFrozen (proxy to 0x94FABf797ae357f6ab8B561Cb54D6DFD693461C7)', dex: 'v3', verified: true, launchEventAbi: lunchV3PairLaunchedEvent as AbiEvent, launchSelectors: sel(...LUNCH_PAIR_SIGS), selectorNames: names(...LUNCH_PAIR_SIGS), poolsInScan: 7, notes: 'V3PairLaunched(token, tokenId, creator, pool, fee, pairToken, launchTick); V3TokenMeta carries socials.' },
  { address: '0x4fba72a7b98eed8a57f37274f9a82fe0a8d4d5c7', name: 'launcher-4fba72a7', kind: 'launchpad', label: 'Unverified launcher 0x4fba72a7 (selector 0x894e4855)', dex: 'v3', verified: false, launchSelectors: ['0x894e4855'], poolsInScan: 7, notes: 'Deploys a "TOKEN" contract and a WETH pool per call; 7 launches from 4 senders; emits topic 0x0cdbb16c.' },
  { address: '0xf5ac14e7691ef44b15b59fcc6a756e41a3e5efd6', name: 'lunch', kind: 'launchpad', label: 'LunchV3LauncherSingle (proxy to 0xc419ba7b9c32103ab8b1a04de4ea2ed518e03749)', dex: 'v3', verified: true, launchEventAbi: lunchV3TokenLaunchedEvent as AbiEvent, launchSelectors: sel(...LUNCH_SINGLE_SIGS), selectorNames: names(...LUNCH_SINGLE_SIGS), poolsInScan: 3, notes: 'Single-band variant of the Lunch launcher; V3TokenLaunched(token, tokenId, creator, pool, fee).' },
  { address: '0x6e4910ea5a04376032f6564da9a9e4e88b7a87c1', name: 'launcher-6e4910ea', kind: 'launchpad', label: 'Unverified launcher 0x6e4910ea (selector 0x13d39311)', dex: 'v3', verified: false, launchSelectors: ['0x13d39311'], poolsInScan: 3, notes: 'Deploys a "Token" contract and a WETH pool with a dev buy in msg.value; emits topic 0xb378e89b.' },
  { address: '0xc89f3837895b3e02c54f254ed73d580016bbd3e7', name: 'ramenpad', kind: 'launchpad', label: 'Ramenpad (unverified, selector 0xc0672f0c)', dex: 'v3', verified: false, launchSelectors: ['0xc0672f0c'], poolsInScan: 2, notes: 'Calldata carries an image at api.yougotcoined.com/ramenpad/...; emits topic 0x7b2c61d7.' },
  { address: '0xa94aa60e9c7f193bf678608d5837f0fd51794635', name: 'tokenselect', kind: 'launchpad', label: 'TokenSelectFactory (proxy to 0x6353c5a486e7818ca509009d20404e81c99bf700)', dex: 'v3', verified: true, launchEventAbi: tokenSelectCreatedEvent as AbiEvent, launchSelectors: sel(...TOKENSELECT_SIGS), selectorNames: names(...TOKENSELECT_SIGS), poolsInScan: 2, notes: 'NewTokenSelectToken(tokenAddress, creator, name, symbol, targetETHRaise, ...).' },
  // ── v4 hook launchpads (identified by tx.to on the PoolManager Initialize) ──
  { address: '0xce9c48cfa068947f77738c81be406b53338e5b0d', name: 'rwa-launchpad', kind: 'launchpad', label: 'RWAERC20LaunchpadFactory', dex: 'v4', verified: true, poolsInScan: 0, notes: 'Initializes v4 pools behind LaunchHook 0x0310cFEbE1D7A69f2414f6595bBe9d17c5342aCc (fee 0).' },
  { address: '0x22e99278308b393ea1260859b181ad7e78f5eeed', name: 'longlauncher', kind: 'launchpad', label: 'LongLauncher', dex: 'v4', verified: true, poolsInScan: 0, notes: 'v4 launcher seen on Initialize.' },
  // ── position managers and routers ─────────────────────────────────────────
  { address: MAINNET_ADDRESSES.nonfungiblePositionManager, name: 'direct', kind: 'position-manager', label: 'Uniswap v3 NonfungiblePositionManager', dex: 'v3', verified: true, launchSelectors: sel(...V3_NPM_SIGS), selectorNames: names(...V3_NPM_SIGS), poolsInScan: 81, notes: 'Direct pool creation (createAndInitializePoolIfNecessary, usually inside multicall); the token was deployed in an earlier transaction.' },
  { address: UNISWAP_V4.positionManager, name: 'direct', kind: 'position-manager', label: 'Uniswap v4 PositionManager', dex: 'v4', verified: true, launchSelectors: sel(...V4_NPM_SIGS), selectorNames: names(...V4_NPM_SIGS), poolsInScan: 0, notes: 'Most v4 Initialize calls route through here.' },
  { address: '0x4e1ae23de6f44571203477c96014e159420f2c44', name: 'direct', kind: 'router', label: 'ERC20PoolFactory', dex: 'v3', verified: true, poolsInScan: 1, notes: 'Pool + position helper for an already-deployed token (createMintAndBuy); not a token deployer.' },
  { address: '0x8a892580571e9b3e8e896aba6aa9278bcc3e2358', name: 'direct', kind: 'router', label: 'LpDesk', dex: 'v3', verified: true, poolsInScan: 1, notes: 'Liquidity range desk; creates the pool for a token it is handed.' },
  { address: MAINNET_ADDRESSES.swapRouter02, name: 'direct', kind: 'router', label: 'Uniswap SwapRouter02', dex: 'v3', verified: true, poolsInScan: 0, notes: 'Swap router; never a launch.' },
  { address: MAINNET_ADDRESSES.universalRouter, name: 'direct', kind: 'router', label: 'Uniswap UniversalRouter', dex: 'v4', verified: true, poolsInScan: 0, notes: 'Swap router; never a launch.' },
  { address: '0xba9b5ac91650a66773a69b6018f62ab0c71f97de', name: 'direct', kind: 'router', label: 'V4AtomicPipeline', dex: 'v4', verified: true, poolsInScan: 0, notes: 'Batches v4 initialize + liquidity for a caller-supplied token.' },
]

export interface V4HookEntry {
  name: Launchpad
  label: string
  /** Whether the UniversalRouter exact-in swap path (src/chain/v4.ts) is known to work on this hook, from its verified source. */
  swap: 'supported' | 'refused'
  /** What the verified before/afterSwap does, and any condition the executor must respect. */
  notes: string
}

/**
 * v4 hook contracts that identify a launchpad when the creating tx.to is only
 * the PositionManager, with the swap-path verdict read from each hook's
 * verified source (2026-09-04). None of them reads hookData, none gates the
 * swapper, and each taxes the quote side per swap; the tax shows up in the
 * quoter and in the firewall's simulated round trip rather than as a revert.
 */
export const V4_HOOK_LAUNCHPADS: ReadonlyMap<string, V4HookEntry> = new Map([
  ['0xf7521cf0bb7c11e2d2794189412614cf2e29a0cc', { name: 'lunch', label: 'LunchTaxHook (176 inits in scan)', swap: 'supported', notes: 'Native-ETH pools. beforeSwap/afterSwap skim buyBps/sellBps of the ETH leg (capped by MAX_SIDE_BPS) and may auto-distribute rewards in-swap; never reverts a trade.' }],
  ['0x4eb1976978756bd56802d8162f2271844924e0cc', { name: 'lunch', label: 'LunchTaxHookPair', swap: 'supported', notes: 'Same economics on a non-ETH quote (WETH, USDG, stocks); only WETH/USDG quotes are executed here.' }],
  ['0x16d1560630ce74af4478d9b8ad46548a092a2000', { name: 'pair-v4', label: 'PairV4Hook (49 inits in scan)', swap: 'supported', notes: 'No swap hooks at all (only initialize/liquidity authorization); swaps are plain v4 swaps.' }],
  ['0x75a54357d9c78a2db19004a5fdc76c50f9242aec', { name: 'cashcat', label: 'CashCatHookV2 (41 inits in scan)', swap: 'supported', notes: 'Fee on the ETH leg via currentFeeRate; afterSwap reverts PartialFillRejected when an exact-in swap is not fully filled, which the firewall round trip reproduces.' }],
  ['0x842fe3a7d852a901c6ed27a69e3a734949c52aec', { name: 'forge', label: 'ForgeHookV4', swap: 'supported', notes: 'buyFeeBps / sellFeeBps on the quote leg, registered pools only.' }],
  ['0x0310cfebe1d7a69f2414f6595bbe9d17c5342acc', { name: 'rwa-launchpad', label: 'LaunchHook', swap: 'supported', notes: 'Quote-leg fee with referral components; hookData is an optional (referrer, comment) envelope and an empty one is accepted. Exact-OUT swaps are refused during the anti-snipe window; the executor only sends exact-in.' }],
])

/**
 * Swap-path verdict for a v4 pool's hook. A hook the registry has read is
 * supported per its source; a hookless pool is plain v4; an unregistered hook
 * is allowed only because the firewall proves the sell leg in simulation
 * before any live buy, and that is stated in the reason.
 */
export function v4HookSupport(hooks: Address | null | undefined): { supported: boolean; reason: string } {
  if (!hooks || hooks === '0x0000000000000000000000000000000000000000') return { supported: true, reason: 'hookless v4 pool' }
  const entry = V4_HOOK_LAUNCHPADS.get(hooks.toLowerCase())
  if (entry) return { supported: entry.swap === 'supported', reason: `${entry.label}: ${entry.notes}` }
  return { supported: true, reason: `unregistered hook ${hooks}: no verified source was read; the firewall's simulated buy-then-sell is the only proof of a working exit` }
}

const byAddress = new Map<string, LaunchpadEntry>(LAUNCHPAD_REGISTRY.map((e) => [e.address.toLowerCase(), e]))

export function launchpadEntry(address: Address | string | null | undefined): LaunchpadEntry | null {
  if (!address) return null
  return byAddress.get(address.toLowerCase()) ?? null
}

/** The Launchpad literal for a creating contract (or hook), 'direct' when unregistered. */
export function launchpadNameFor(creatingTo: Address | null, hooks?: Address | null): Launchpad {
  const entry = launchpadEntry(creatingTo)
  if (entry && entry.kind === 'launchpad') return entry.name
  if (hooks) {
    const hook = V4_HOOK_LAUNCHPADS.get(hooks.toLowerCase())
    if (hook) return hook.name
  }
  return 'direct'
}

/** Every distinct Launchpad literal the registry can produce, for schema defaults and validation. */
export const ALL_LAUNCHPADS: readonly Launchpad[] = [...new Set<Launchpad>([
  'noxa', 'odyssey', 'direct',
  ...LAUNCHPAD_REGISTRY.filter((e) => e.kind === 'launchpad').map((e) => e.name),
  ...[...V4_HOOK_LAUNCHPADS.values()].map((h) => h.name),
])]

/** Does a sequencer-feed transaction to `to` with calldata `data` look like a launch on a registered contract? */
export function matchesLaunchSignal(to: Address | string | null | undefined, data: Hex | undefined): LaunchpadEntry | null {
  const entry = launchpadEntry(to)
  if (!entry) return null
  if (entry.kind === 'router' || entry.kind === 'unknown') return null
  if (!entry.launchSelectors || entry.launchSelectors.length === 0) return entry
  const selector = (data ?? '0x').slice(0, 10).toLowerCase()
  return entry.launchSelectors.some((s) => s.toLowerCase() === selector) ? entry : null
}

export const checksum = (a: string): Address => getAddress(a)
