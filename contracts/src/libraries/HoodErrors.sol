// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/// @title HoodErrors
/// @notice Every refusal the on-chain arm can raise. The names mirror the
///         `RefusalReason` union in `src/types.ts` (kill_switch, per_trade_cap,
///         daily_budget, concurrency, cooldown, slippage_bound, oracle_gate,
///         zero_amount) so a dashboard can map a revert selector straight onto
///         the vocabulary the off-chain risk engine already journals. Each error
///         carries the numbers a human needs to understand the refusal.

/// @notice The owner tripped the kill switch: no new risk until it is cleared.
error KillSwitch();
/// @notice A buy is over the per-trade cap, or the cap is zero.
error PerTradeCap(uint256 amountWei, uint256 capWei);
/// @notice The rolling UTC-day budget would be exceeded, or the budget is zero.
error DailyBudget(uint256 wouldSpendWei, uint256 budgetWei);
/// @notice Every allowed position slot is taken; wait for an exit.
error Concurrency(uint256 openPositions, uint256 maxOpenPositions);
/// @notice The cooldown since the last trade has not elapsed.
error Cooldown(uint256 remainingSeconds);
/// @notice The caller's `amountOutMinimum` accepts more slippage than the policy allows.
error SlippageBound(uint256 amountOutMinimum, uint256 requiredMinimum);
/// @notice The policy requires an oracle score and the token has no fresh attestation above it.
error OracleGate(uint8 score, uint8 minScore, bool fresh);
/// @notice Only the operator (the engine's hot key) may call this.
error NotOperator(address caller);
/// @notice Only the owner may call this.
error NotOwner(address caller);
/// @notice Only the owner or the operator may call this.
error NotOwnerOrOperator(address caller);
/// @notice A loosening change is queued behind the timelock and cannot apply yet.
error Timelocked(uint256 effectiveAt);
/// @notice Nothing is queued.
error NothingPending();
/// @notice The amount is zero.
error ZeroAmount();
/// @notice A zero address where one is required.
error ZeroAddress();
/// @notice The quote token cannot be bought with itself.
error QuoteTokenNotTradable();
/// @notice The account holds no tracked position in this token.
error NoPosition(address token);
/// @notice The sell asks for more than the tracked position holds.
error InsufficientPosition(address token, uint256 requested, uint256 held);
/// @notice `block.timestamp` is past the caller's deadline.
error DeadlineExpired(uint256 deadline, uint256 blockTimestamp);
/// @notice A policy field is out of range; `field` names it.
error InvalidPolicy(string field);
/// @notice The quote token cannot change while positions are open.
error PositionsOpen(uint256 openPositions);
/// @notice The quote token cannot change while fees are accrued in the old one. Call `claimFees()` first.
error FeesPending(uint256 feesAccruedWei);
/// @notice No Uniswap v3 pool exists for the pair at that fee tier.
error NoPool(address tokenA, address tokenB, uint24 fee);
/// @notice The pool is not initialized (zero price).
error PoolNotInitialized(address pool);
/// @notice Nothing accrued to claim.
error NothingToClaim();
/// @notice The account holds less than the withdrawal asks for, after reserving accrued fees.
error InsufficientBalance(uint256 requested, uint256 available);
/// @notice A native ETH transfer failed.
error EthTransferFailed(address to, uint256 amount);
/// @notice The clone was already initialized.
error AlreadyInitialized();
/// @notice The performance fee is above the protocol maximum (20%).
error FeeTooHigh(uint16 bps, uint16 maxBps);
/// @notice The attestation signature does not recover to the active signer.
error InvalidSignature();
/// @notice The attestation's `expiresAt` is in the past.
error AttestationExpired(uint64 expiresAt, uint256 blockTimestamp);
/// @notice The attestation is older than the one already stored for the token.
error StaleAttestation(uint64 observedAt, uint64 storedObservedAt);
/// @notice A field of the attestation is out of range; `field` names it.
error InvalidAttestation(string field);
/// @notice The payee has no shares in the splitter.
error NoShares(address payee);
/// @notice The payee already has shares.
error DuplicatePayee(address payee);
/// @notice Payee and share arrays differ in length, or are empty.
error PayeesMismatch();
/// @notice The payee has nothing releasable right now.
error NothingDue(address payee);
/// @notice The swap delivered zero units of the token bought.
error NothingReceived(address token);
