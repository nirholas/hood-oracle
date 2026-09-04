/**
 * Contract ABIs the chain layer needs. Everything here is either the canonical
 * Uniswap v3 periphery, WETH9, ERC-20, or a fragment copied verbatim from a
 * Blockscout-verified source on Robinhood Chain mainnet (chain 4663):
 *
 *   The Odyssey bonding-curve factory 0xEb3FeeD2716cF0eEAda05B22e67424794e1f5a80
 *   is a TransparentUpgradeableProxy whose verified implementation is
 *   0xC82fFF61B3293D236Af14F16f4d045c8E5a95393 ("BondingCurveFactoryProxyInit",
 *   solc 0.8.26). The reflection factory 0x6Ce85c4b7cE12903E5867652C265bCcce57f935F
 *   proxies 0xeB30ad18839aB6b0D81620EFdED52186fd7af605
 *   ("ReflectionBondingCurveFactoryProxyInit"); the instant factory
 *   0xD7601cEe401306fdea5833c6898181D9c770F800 proxies
 *   0x82A29eEa748C8882D31aB37e9DB65E600155A7cc ("InstantLaunchFactoryProxyInit").
 *   The legacy factory 0xAf9f3ce1d34909F59E88c23027f89d5807B0F915 is verified
 *   directly and shares the bonding-curve trading surface.
 *
 * Venue support, stated precisely:
 *   - NOXA launches trade on a Uniswap v3 pool (1% tier) from block one. The
 *     NOXA factory itself is unverified on Blockscout, which is fine: we never
 *     call it, we only decode its TokenLaunched log and trade the pool.
 *   - Odyssey bonding-curve tokens (bonding + legacy factories) trade on the
 *     curve through buy/sell/quoteBuy/quoteSell below (verified source), and
 *     graduate to a Uniswap v3 pool announced by PoolMigrated.
 *   - Odyssey reflection tokens trade on the same curve interface but graduate
 *     to a Uniswap v4 pool (PoolMigratedV4, bytes32 poolId) that SwapRouter02
 *     cannot route, so the executor refuses to open positions in them.
 *   - Odyssey instant launches (InstantTokenCreated) list straight into a
 *     Uniswap v3 pool carried in the event and trade like NOXA pools.
 */
import { parseAbi } from 'viem'
import { erc20Abi, quoterV2Abi, swapRouter02Abi, weth9Abi, uniswapV3FactoryAbi } from 'hoodchain'

export { erc20Abi, quoterV2Abi, swapRouter02Abi, weth9Abi, uniswapV3FactoryAbi }

/** Uniswap v3 pool: immutables, state, and the Swap event. */
export const uniswapV3PoolAbi = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
])

export const uniswapV3SwapEvent = uniswapV3PoolAbi[5]

/**
 * SwapRouter02 payment helpers the SDK's fragment omits. `unwrapWETH9` turns
 * router-held WETH (a swap whose recipient was ADDRESS_THIS) into native ETH
 * for `recipient`; `refundETH` returns unspent msg.value after a native-in
 * swap. Both are part of the canonical SwapRouter02 (PeripheryPayments).
 */
export const swapRouter02PaymentsAbi = parseAbi([
  'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
  'function refundETH() payable',
])

/** SwapRouter02 recipient sentinel: route output to the router itself. */
export const ROUTER_ADDRESS_THIS = '0x0000000000000000000000000000000000000002' as const

export const erc20TransferEvent = erc20Abi.find((x) => x.type === 'event' && x.name === 'Transfer')!

/**
 * Odyssey bonding-curve factory trading surface. Verbatim from the verified
 * implementation (see the module comment). Semantics from the source:
 *   buy(token, tokensOut) payable: exact-OUT with a budget. `msg.value` is the
 *     budget; totalIn = costToBuy(vq, vt, out) + 1 plus a ceil(feeBps) fee on
 *     top; the unspent budget is refunded in the same call. Sending the full
 *     per-trade amount as value with tokensOut = quoted out * (1 - slippage)
 *     is therefore a native slippage bound.
 *   sell(token, tokensIn, minQuoteOut): exact-IN, fee taken from the gross
 *     ETH out; the launch token must be approved to the factory.
 *   quoteBuy / quoteSell are the exact view mirrors of the two above.
 *   getPool(token) returns the curve state (creator, completed, reserves).
 */
export const odysseyCurveAbi = [
  { type: 'function', name: 'buy', stateMutability: 'payable', inputs: [{ name: 'token', type: 'address' }, { name: 'tokensOut', type: 'uint256' }], outputs: [{ name: 'actualOut', type: 'uint256' }, { name: 'totalIn', type: 'uint256' }] },
  { type: 'function', name: 'sell', stateMutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }, { name: 'tokensIn', type: 'uint256' }, { name: 'minQuoteOut', type: 'uint256' }], outputs: [{ name: 'userGets', type: 'uint256' }] },
  { type: 'function', name: 'quoteBuy', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }, { name: 'tokensOut', type: 'uint256' }], outputs: [{ name: 'cost', type: 'uint256' }, { name: 'fee', type: 'uint256' }, { name: 'totalIn', type: 'uint256' }, { name: 'actualOut', type: 'uint256' }, { name: 'willGraduate', type: 'bool' }] },
  { type: 'function', name: 'quoteSell', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }, { name: 'tokensIn', type: 'uint256' }], outputs: [{ name: 'grossOut', type: 'uint256' }, { name: 'fee', type: 'uint256' }, { name: 'userGets', type: 'uint256' }] },
  { type: 'function', name: 'feeBps', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'antiSnipeBlocks', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint64' }] },
  { type: 'function', name: 'maxWalletBps', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint16' }] },
  { type: 'function', name: 'TOTAL_SUPPLY', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'FOR_SALE', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'VIRTUAL_REMAIN', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'VIRTUAL_TOKEN_INIT', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'event', name: 'Traded', inputs: [{ name: 'token', type: 'address', indexed: true }, { name: 'trader', type: 'address', indexed: true }, { name: 'isBuy', type: 'bool', indexed: false }, { name: 'tokenAmount', type: 'uint256', indexed: false }, { name: 'quoteAmount', type: 'uint256', indexed: false }, { name: 'fee', type: 'uint256', indexed: false }, { name: 'virtualQuote', type: 'uint256', indexed: false }, { name: 'virtualToken', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'TokenCreated', inputs: [{ name: 'token', type: 'address', indexed: true }, { name: 'creator', type: 'address', indexed: true }, { name: 'backingWallet', type: 'address', indexed: false }, { name: 'isMarginBacked', type: 'bool', indexed: false }, { name: 'threshold', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'PoolCompleted', inputs: [{ name: 'token', type: 'address', indexed: true }, { name: 'realQuoteRaised', type: 'uint256', indexed: false }, { name: 'lpTokenReserve', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'PoolMigrated', inputs: [{ name: 'token', type: 'address', indexed: true }, { name: 'pool', type: 'address', indexed: false }, { name: 'tokenId', type: 'uint256', indexed: false }, { name: 'liquidity', type: 'uint128', indexed: false }, { name: 'tokenUsed', type: 'uint256', indexed: false }, { name: 'quoteUsed', type: 'uint256', indexed: false }] },
] as const

/** Bonding-curve factory `getPool(token)` (the 16-field Pool struct of the current implementation). */
export const odysseyBondingPoolAbi = [
  { type: 'function', name: 'getPool', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }], outputs: [{ name: '', type: 'tuple', components: [
    { name: 'creator', type: 'address' }, { name: 'backingWallet', type: 'address' }, { name: 'isMarginBacked', type: 'bool' }, { name: 'completed', type: 'bool' },
    { name: 'virtualQuote', type: 'uint256' }, { name: 'virtualToken', type: 'uint256' }, { name: 'virtualQuoteInit', type: 'uint256' }, { name: 'realQuote', type: 'uint256' },
    { name: 'feesAccrued', type: 'uint256' }, { name: 'lastDistribute', type: 'uint64' }, { name: 'isRwaBacked', type: 'bool' }, { name: 'dexSeedEnabled', type: 'bool' },
    { name: 'dexSeedPool', type: 'address' }, { name: 'dexSeedPositionId', type: 'uint256' }, { name: 'dexSeedLiquidity', type: 'uint128' }, { name: 'dexSeedEthWei', type: 'uint256' },
  ] }] },
] as const

/**
 * The curve state every factory variant exposes through `pools(token)`: the
 * first eleven fields are identical across the bonding, legacy and reflection
 * implementations up to `realQuote`, which is all the trading path reads. The
 * reflection struct replaces `backingWallet`/`isMarginBacked` with
 * `rewardToken`/`completed`, so it gets its own decoder below.
 */
export const odysseyReflectionPoolAbi = [
  { type: 'function', name: 'getPool', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }], outputs: [{ name: '', type: 'tuple', components: [
    { name: 'creator', type: 'address' }, { name: 'rewardToken', type: 'address' }, { name: 'completed', type: 'bool' },
    { name: 'virtualQuote', type: 'uint256' }, { name: 'virtualToken', type: 'uint256' }, { name: 'virtualQuoteInit', type: 'uint256' }, { name: 'realQuote', type: 'uint256' },
    { name: 'feesAccrued', type: 'uint256' }, { name: 'lastDistribute', type: 'uint64' }, { name: 'hasCustomSplit', type: 'bool' }, { name: 'creatorBpsChosen', type: 'uint16' },
    { name: 'dexSeedEnabled', type: 'bool' }, { name: 'dexSeedGraduator', type: 'address' }, { name: 'dexSeedEthWei', type: 'uint256' }, { name: 'instantLaunch', type: 'bool' },
  ] }] },
  { type: 'event', name: 'TokenCreated', inputs: [{ name: 'token', type: 'address', indexed: true }, { name: 'creator', type: 'address', indexed: true }, { name: 'rewardToken', type: 'address', indexed: false }, { name: 'threshold', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'PoolMigratedV4', inputs: [{ name: 'token', type: 'address', indexed: true }, { name: 'poolId', type: 'bytes32', indexed: true }, { name: 'liquidity', type: 'uint128', indexed: false }, { name: 'tokenAmt', type: 'uint256', indexed: false }, { name: 'quoteAmt', type: 'uint256', indexed: false }] },
] as const

/** Instant-launch factory: tokens list straight into the Uniswap v3 pool in the event. */
export const odysseyInstantAbi = [
  { type: 'function', name: 'getPool', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }], outputs: [{ name: '', type: 'tuple', components: [
    { name: 'creator', type: 'address' }, { name: 'backingWallet', type: 'address' }, { name: 'isMarginBacked', type: 'bool' }, { name: 'isRwaBacked', type: 'bool' }, { name: 'isMeme', type: 'bool' },
    { name: 'uniPool', type: 'address' }, { name: 'positionId', type: 'uint256' }, { name: 'liquidity', type: 'uint128' }, { name: 'tickLower', type: 'int24' }, { name: 'tickUpper', type: 'int24' }, { name: 'dexId', type: 'uint8' },
  ] }] },
  { type: 'event', name: 'InstantTokenCreated', inputs: [{ name: 'token', type: 'address', indexed: true }, { name: 'creator', type: 'address', indexed: true }, { name: 'backingWallet', type: 'address', indexed: false }, { name: 'isMeme', type: 'bool', indexed: false }, { name: 'isMargin', type: 'bool', indexed: false }, { name: 'isRwa', type: 'bool', indexed: false }, { name: 'pool', type: 'address', indexed: false }, { name: 'positionId', type: 'uint256', indexed: false }, { name: 'dexId', type: 'uint8', indexed: false }] },
  { type: 'event', name: 'InstantFirstBuy', inputs: [{ name: 'token', type: 'address', indexed: true }, { name: 'buyer', type: 'address', indexed: true }, { name: 'ethIn', type: 'uint256', indexed: false }, { name: 'tokensOut', type: 'uint256', indexed: false }] },
] as const

/**
 * Odyssey LaunchToken / ReflectionLaunchToken anti-snipe surface (verified
 * source: `_update` reverts a transfer that would push the recipient above
 * `maxWallet()` while `limitsActive()`). The firewall reads these to size a
 * buy under the cap instead of learning about it from a revert.
 */
export const odysseyLaunchTokenAbi = parseAbi([
  'function limitsActive() view returns (bool)',
  'function maxWallet() view returns (uint256)',
  'function maxWalletBps() view returns (uint16)',
  'function antiSnipeBlocks() view returns (uint64)',
  'function launchBlock() view returns (uint64)',
  'function limitExempt(address) view returns (bool)',
  'function factory() view returns (address)',
])

/**
 * Common ERC-20 control surfaces probed by the firewall. None of these are part
 * of the standard; a token that implements one is telling on itself. Every
 * probe is a view call that either decodes or reverts, never a guess about a
 * selector's meaning: the names below are exactly what the selectors hash to.
 */
export const erc20ControlProbeAbi = parseAbi([
  'function owner() view returns (address)',
  'function paused() view returns (bool)',
  'function tradingEnabled() view returns (bool)',
  'function tradingActive() view returns (bool)',
  'function tradingOpen() view returns (bool)',
  'function isBlacklisted(address) view returns (bool)',
  'function blacklist(address) view returns (bool)',
  'function blacklisted(address) view returns (bool)',
  'function isBot(address) view returns (bool)',
  'function maxTxAmount() view returns (uint256)',
  'function maxTransactionAmount() view returns (uint256)',
  'function maxWalletAmount() view returns (uint256)',
  'function sellTax() view returns (uint256)',
  'function buyTax() view returns (uint256)',
])

/** Multicall3 `aggregate3` for batched reads outside viem's own batching. */
export const multicall3Abi = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calldata calls) payable returns (Result[] memory returnData)',
])

// ── pool-creation intake ──────────────────────────────────────────────────────

/** Uniswap v3 factory `PoolCreated`. */
export const uniswapV3PoolCreatedEvent = parseAbi([
  'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)',
])[0]

/**
 * Uniswap v4 PoolManager (verified on Blockscout at
 * 0x8366a39CC670B4001A1121B8F6A443A643e40951). `Swap` deltas are from the
 * swapper's perspective (positive = the swapper receives that currency), the
 * opposite sign convention to v3's pool-perspective amounts.
 */
export const uniswapV4PoolManagerAbi = parseAbi([
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
  'event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)',
])
export const uniswapV4InitializeEvent = uniswapV4PoolManagerAbi[0]
export const uniswapV4SwapEvent = uniswapV4PoolManagerAbi[1]

/**
 * Launch events of the registry launchpads that publish verified source
 * (src/chain/launchpads.ts). Pons reuses NOXA's TokenLaunched shape verbatim.
 */
export const lunchV3PairLaunchedEvent = parseAbi([
  'event V3PairLaunched(address indexed token, uint256 indexed tokenId, address indexed creator, address pool, uint24 fee, address pairToken, int24 launchTick)',
])[0]
export const lunchV3TokenLaunchedEvent = parseAbi([
  'event V3TokenLaunched(address indexed token, uint256 indexed tokenId, address indexed creator, address pool, uint24 fee)',
])[0]
export const dontblinkLaunchedEvent = parseAbi([
  'event Launched(uint256 indexed nonce, address indexed token, address indexed creator, uint16 version, uint8 mode, address quote, address pool, uint256 tokenId, uint256 saleId, uint64 windowEnd)',
])[0]
export const tokenSelectCreatedEvent = parseAbi([
  'event NewTokenSelectToken(address indexed tokenAddress, address indexed creator, string name, string symbol, uint256 targetETHRaise, uint256 migrationFee, uint256 deploymentFee)',
])[0]
