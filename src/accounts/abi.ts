/**
 * The contract surface the multi-tenant layer talks to, as viem ABIs.
 *
 * These are written out by hand rather than imported from
 * `contracts/out/**.json` on purpose: that directory is a build artifact and
 * is gitignored, so a server that never ran `forge build` would lose the
 * ability to read an account. Everything here is checked against the Solidity
 * sources by `tests/accounts-abi.test.ts`, which compiles the contracts and
 * compares selectors, so a drifted signature fails a test instead of a trade.
 */
import type { Abi } from 'viem'

/** `Policy` in contracts/src/libraries/PolicyLib.sol, field for field and in order. */
export const POLICY_COMPONENTS = [
  { name: 'perTradeCapWei', type: 'uint128' },
  { name: 'dailyBudgetWei', type: 'uint128' },
  { name: 'maxOpenPositions', type: 'uint16' },
  { name: 'maxSlippageBps', type: 'uint16' },
  { name: 'cooldownSeconds', type: 'uint32' },
  { name: 'maxHoldSecondsHint', type: 'uint32' },
  { name: 'minOracleScore', type: 'uint8' },
  { name: 'allowedRouter', type: 'address' },
  { name: 'quoteToken', type: 'address' },
] as const

const policyOut = { name: '', type: 'tuple', components: POLICY_COMPONENTS } as const
const policyIn = (name: string) => ({ name, type: 'tuple', components: POLICY_COMPONENTS }) as const

export const hoodArmFactoryAbi = [
  {
    type: 'event',
    name: 'AccountCreated',
    inputs: [
      { name: 'owner', type: 'address', indexed: true },
      { name: 'account', type: 'address', indexed: true },
      { name: 'operator', type: 'address', indexed: true },
      { ...policyIn('policy'), indexed: false },
    ],
  },
  { type: 'function', name: 'createAccount', stateMutability: 'nonpayable', inputs: [{ name: 'operator', type: 'address' }], outputs: [{ name: 'account', type: 'address' }] },
  { type: 'function', name: 'createAccount', stateMutability: 'nonpayable', inputs: [{ name: 'operator', type: 'address' }, policyIn('policy')], outputs: [{ name: 'account', type: 'address' }] },
  { type: 'function', name: 'accountsOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'address[]' }] },
  { type: 'function', name: 'isAccount', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'defaultPolicy', stateMutability: 'view', inputs: [], outputs: [policyOut] },
  { type: 'function', name: 'implementation', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'attestations', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'weth', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'feeRecipient', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'performanceFeeBps', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint16' }] },
  { type: 'function', name: 'accountCount', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
] as const satisfies Abi

const positionOut = {
  name: '',
  type: 'tuple',
  components: [
    { name: 'tokenAmount', type: 'uint128' },
    { name: 'costBasisWei', type: 'uint128' },
    { name: 'realizedNetWei', type: 'int128' },
    { name: 'feeHighWaterWei', type: 'int128' },
    { name: 'openedAt', type: 'uint64' },
  ],
} as const

/** Every custom error `buy` and `sell` can revert with, so a revert decodes into a RefusalReason. */
export const hoodArmErrorsAbi = [
  { type: 'error', name: 'KillSwitch', inputs: [] },
  { type: 'error', name: 'PerTradeCap', inputs: [{ name: 'amountWei', type: 'uint256' }, { name: 'capWei', type: 'uint256' }] },
  { type: 'error', name: 'DailyBudget', inputs: [{ name: 'wouldSpendWei', type: 'uint256' }, { name: 'budgetWei', type: 'uint256' }] },
  { type: 'error', name: 'Concurrency', inputs: [{ name: 'openPositions', type: 'uint256' }, { name: 'maxOpenPositions', type: 'uint256' }] },
  { type: 'error', name: 'Cooldown', inputs: [{ name: 'remainingSeconds', type: 'uint256' }] },
  { type: 'error', name: 'SlippageBound', inputs: [{ name: 'amountOutMinimum', type: 'uint256' }, { name: 'requiredMinimum', type: 'uint256' }] },
  { type: 'error', name: 'OracleGate', inputs: [{ name: 'score', type: 'uint8' }, { name: 'minScore', type: 'uint8' }, { name: 'fresh', type: 'bool' }] },
  { type: 'error', name: 'NotOperator', inputs: [{ name: 'caller', type: 'address' }] },
  { type: 'error', name: 'NotOwner', inputs: [{ name: 'caller', type: 'address' }] },
  { type: 'error', name: 'NotOwnerOrOperator', inputs: [{ name: 'caller', type: 'address' }] },
  { type: 'error', name: 'ZeroAmount', inputs: [] },
  { type: 'error', name: 'ZeroAddress', inputs: [] },
  { type: 'error', name: 'QuoteTokenNotTradable', inputs: [] },
  { type: 'error', name: 'NoPosition', inputs: [{ name: 'token', type: 'address' }] },
  { type: 'error', name: 'InsufficientPosition', inputs: [{ name: 'token', type: 'address' }, { name: 'requested', type: 'uint256' }, { name: 'held', type: 'uint256' }] },
  { type: 'error', name: 'DeadlineExpired', inputs: [{ name: 'deadline', type: 'uint256' }, { name: 'blockTimestamp', type: 'uint256' }] },
  { type: 'error', name: 'InsufficientBalance', inputs: [{ name: 'requested', type: 'uint256' }, { name: 'available', type: 'uint256' }] },
  { type: 'error', name: 'NothingReceived', inputs: [{ name: 'token', type: 'address' }] },
  { type: 'error', name: 'NoPool', inputs: [{ name: 'tokenA', type: 'address' }, { name: 'tokenB', type: 'address' }, { name: 'fee', type: 'uint24' }] },
  { type: 'error', name: 'PoolNotInitialized', inputs: [{ name: 'pool', type: 'address' }] },
  { type: 'error', name: 'InvalidPolicy', inputs: [{ name: 'field', type: 'string' }] },
  { type: 'error', name: 'PositionsOpen', inputs: [{ name: 'openPositions', type: 'uint256' }] },
  { type: 'error', name: 'Timelocked', inputs: [{ name: 'effectiveAt', type: 'uint256' }] },
  { type: 'error', name: 'NothingPending', inputs: [] },
] as const satisfies Abi

export const hoodArmAccountAbi = [
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'operator', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'factory', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'attestations', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'weth', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'performanceFeeBps', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint16' }] },
  { type: 'function', name: 'killed', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'policy', stateMutability: 'view', inputs: [], outputs: [policyOut] },
  { type: 'function', name: 'pendingPolicy', stateMutability: 'view', inputs: [], outputs: [{ ...policyOut, name: 'proposed' }, { name: 'effectiveAt', type: 'uint256' }] },
  { type: 'function', name: 'position', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }], outputs: [positionOut] },
  { type: 'function', name: 'spentTodayWei', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'remainingDailyBudgetWei', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'cooldownRemaining', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'openPositionCount', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'feesAccruedWei', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'withdrawableQuoteWei', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'lastTradeAt', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint64' }] },
  {
    type: 'function',
    name: 'buy',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'amountInWei', type: 'uint256' },
      { name: 'amountOutMinimum', type: 'uint256' },
      { name: 'fee', type: 'uint24' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'sell',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMinimum', type: 'uint256' },
      { name: 'fee', type: 'uint24' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'proceedsWei', type: 'uint256' }],
  },
  { type: 'function', name: 'setPolicy', stateMutability: 'nonpayable', inputs: [policyIn('proposed')], outputs: [] },
  { type: 'function', name: 'applyPolicy', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'cancelPolicy', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'setOperator', stateMutability: 'nonpayable', inputs: [{ name: 'operator_', type: 'address' }], outputs: [] },
  { type: 'function', name: 'kill', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'unkill', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  {
    type: 'function',
    name: 'ownerWithdraw',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'to', type: 'address' }],
    outputs: [],
  },
  { type: 'function', name: 'claimFees', stateMutability: 'nonpayable', inputs: [], outputs: [{ name: 'amount', type: 'uint256' }] },
  {
    type: 'event',
    name: 'Buy',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'amountInWei', type: 'uint256', indexed: false },
      { name: 'amountOut', type: 'uint256', indexed: false },
      { name: 'fee', type: 'uint24', indexed: false },
      { name: 'positionTokenAmount', type: 'uint256', indexed: false },
      { name: 'positionCostBasisWei', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Sell',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'amountIn', type: 'uint256', indexed: false },
      { name: 'proceedsWei', type: 'uint256', indexed: false },
      { name: 'fee', type: 'uint24', indexed: false },
      { name: 'realizedWei', type: 'int256', indexed: false },
      { name: 'feeWei', type: 'uint256', indexed: false },
      { name: 'by', type: 'address', indexed: true },
    ],
  },
  ...hoodArmErrorsAbi,
] as const satisfies Abi

/** `Attestation` in contracts/src/interfaces/IHoodOracleAttestations.sol. */
export const ATTESTATION_COMPONENTS = [
  { name: 'token', type: 'address' },
  { name: 'score', type: 'uint8' },
  { name: 'tier', type: 'uint8' },
  { name: 'rugRiskBps', type: 'uint16' },
  { name: 'modelVersion', type: 'uint32' },
  { name: 'observedAt', type: 'uint64' },
  { name: 'expiresAt', type: 'uint64' },
] as const

export const hoodOracleAttestationsAbi = [
  {
    type: 'function',
    name: 'post',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'attestation', type: 'tuple', components: ATTESTATION_COMPONENTS }, { name: 'signature', type: 'bytes' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'latest',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ name: 'attestation', type: 'tuple', components: ATTESTATION_COMPONENTS }, { name: 'fresh', type: 'bool' }],
  },
  { type: 'function', name: 'meets', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }, { name: 'minScore', type: 'uint8' }], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'signer', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'signerEpoch', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint64' }] },
  {
    type: 'function',
    name: 'digest',
    stateMutability: 'view',
    inputs: [{ name: 'attestation', type: 'tuple', components: ATTESTATION_COMPONENTS }],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  { type: 'error', name: 'InvalidSignature', inputs: [] },
  { type: 'error', name: 'AttestationExpired', inputs: [{ name: 'expiresAt', type: 'uint64' }, { name: 'blockTimestamp', type: 'uint256' }] },
  { type: 'error', name: 'StaleAttestation', inputs: [{ name: 'observedAt', type: 'uint64' }, { name: 'storedObservedAt', type: 'uint64' }] },
  { type: 'error', name: 'InvalidAttestation', inputs: [{ name: 'field', type: 'string' }] },
] as const satisfies Abi

/** The EIP-712 types the attestations contract hashes, matching ATTESTATION_TYPEHASH. */
export const ATTESTATION_EIP712_TYPES = {
  Attestation: [
    { name: 'token', type: 'address' },
    { name: 'score', type: 'uint8' },
    { name: 'tier', type: 'uint8' },
    { name: 'rugRiskBps', type: 'uint16' },
    { name: 'modelVersion', type: 'uint32' },
    { name: 'observedAt', type: 'uint64' },
    { name: 'expiresAt', type: 'uint64' },
  ],
} as const

export const ATTESTATION_DOMAIN_NAME = 'HoodOracleAttestations'
export const ATTESTATION_DOMAIN_VERSION = '1'

export const erc20BalanceAbi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
] as const satisfies Abi
