/**
 * The multi-tenant, non-custodial layer: wallet sign-in, the on-chain account
 * registry, and the policy maths that bounds an arm by its account.
 *
 * Read docs/multi-tenant.md for the model. In one paragraph: a user connects a
 * wallet, signs an EIP-4361 message to get a session, deploys a
 * HoodArmAccount clone from their own wallet, and names this engine's hot key
 * as its `operator`. From then on the engine can `buy` and `sell` inside the
 * owner's on-chain policy and can do nothing else: it cannot withdraw, cannot
 * change the policy, and cannot exceed the per-trade cap, the daily budget,
 * the cooldown, the position count, the slippage bound or the oracle floor,
 * because the account contract checks all of them itself.
 */
export { parseSiweMessage, checkSiweMessage, buildSiweMessage, SiweParseError } from './siwe.js'
export type { SiweMessage, SiweCheckOptions, SiweCheckResult, BuildSiweOptions } from './siwe.js'
export {
  SessionStore, NONCE_COOKIE, SESSION_COOKIE, NONCE_TTL_MS, SESSION_TTL_MS, ROTATE_AFTER_MS,
  serializeCookie, clearCookie, readCookie, signCookie, parseCookieValue,
} from './session.js'
export type { IssuedNonce, IssuedSession, SessionStoreOptions, CookieOptions } from './session.js'
export {
  AccountRegistry, REFRESH_INTERVAL_MS, STALE_AFTER_MS, rowToAccount, decodeAccountCreated,
} from './registry.js'
export type { AccountRegistryApi, AccountRegistryOptions } from './registry.js'
export {
  tupleToPolicy, policyToTuple, policyToJson, policyFromJson, policyProblems, isTighterOrEqual,
  clampToPolicy, armAgainstPolicyProblems, MAX_UINT128,
} from './policy.js'
export type { PolicyTuple, PolicyClamp, PolicyClampChange } from './policy.js'
export {
  hoodArmAccountAbi, hoodArmFactoryAbi, hoodArmErrorsAbi, hoodOracleAttestationsAbi, erc20BalanceAbi,
  POLICY_COMPONENTS, ATTESTATION_COMPONENTS, ATTESTATION_EIP712_TYPES,
  ATTESTATION_DOMAIN_NAME, ATTESTATION_DOMAIN_VERSION,
} from './abi.js'
