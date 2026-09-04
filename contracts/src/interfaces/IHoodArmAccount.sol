// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Policy} from "../libraries/PolicyLib.sol";

/// @title IHoodArmAccount
/// @notice One owner's on-chain arm: the trading wallet the engine's hot key
///         (the operator) can only drive inside the owner's policy. Every
///         guard the off-chain risk engine applies to new risk (kill switch,
///         per-trade cap, rolling daily budget, concurrency, cooldown,
///         slippage bound, oracle gate) is enforced here by the chain, so a
///         leaked operator key cannot exceed them.
interface IHoodArmAccount {
    /// @notice Cost-basis accounting for one held token. `costBasisWei` is the
    ///         quote spent on the units still held (weighted average);
    ///         `realizedNetWei` is the cumulative realized P&L of this position;
    ///         `feeHighWaterWei` is the highest `realizedNetWei` a fee has been
    ///         charged up to, so fees are only ever charged on new profit.
    struct Position {
        uint128 tokenAmount;
        uint128 costBasisWei;
        int128 realizedNetWei;
        int128 feeHighWaterWei;
        uint64 openedAt;
    }

    event Initialized(address indexed owner, address indexed operator, uint16 performanceFeeBps);
    event OperatorSet(address indexed previous, address indexed operator);
    event OwnershipTransferStarted(address indexed owner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previous, address indexed owner);
    event PolicyApplied(Policy policy);
    event PolicyProposed(Policy policy, uint256 effectiveAt);
    event PolicyCancelled();
    event Killed(address indexed by);
    event Unkilled(address indexed by);
    event Buy(
        address indexed token,
        uint256 amountInWei,
        uint256 amountOut,
        uint24 fee,
        uint256 positionTokenAmount,
        uint256 positionCostBasisWei
    );
    event Sell(
        address indexed token,
        uint256 amountIn,
        uint256 proceedsWei,
        uint24 fee,
        int256 realizedWei,
        uint256 feeWei,
        address indexed by
    );
    event PositionClosed(address indexed token, int256 realizedNetWei);
    event Withdrawn(address indexed token, uint256 amount, address indexed to);
    event DustSwept(address indexed token, uint256 amount, address indexed to);
    event FeesClaimed(address indexed recipient, uint256 amount);
    event Wrapped(uint256 amountWei);
    event Received(address indexed from, uint256 amountWei);

    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
    function operator() external view returns (address);
    function factory() external view returns (address);
    function attestations() external view returns (address);
    function weth() external view returns (address);
    function performanceFeeBps() external view returns (uint16);
    function killed() external view returns (bool);
    function feesAccruedWei() external view returns (uint256);
    function openPositionCount() external view returns (uint256);
    function lastTradeAt() external view returns (uint64);

    function policy() external view returns (Policy memory);
    function pendingPolicy() external view returns (Policy memory proposed, uint256 effectiveAt);
    function position(address token) external view returns (Position memory);
    /// @notice Quote spent on buys so far in the current UTC day (rolls over at 00:00 UTC).
    function spentTodayWei() external view returns (uint256);
    function remainingDailyBudgetWei() external view returns (uint256);
    /// @notice Seconds until the operator may buy again; 0 when the cooldown has elapsed.
    function cooldownRemaining() external view returns (uint256);
    /// @notice The account's quote balance minus accrued protocol fees.
    function withdrawableQuoteWei() external view returns (uint256);

    function initialize(address owner_, address operator_, Policy calldata policy_, uint16 performanceFeeBps_) external;

    function buy(address token, uint256 amountInWei, uint256 amountOutMinimum, uint24 fee, uint256 deadline)
        external
        returns (uint256 amountOut);
    function sell(address token, uint256 amountIn, uint256 amountOutMinimum, uint24 fee, uint256 deadline)
        external
        returns (uint256 proceedsWei);

    function setPolicy(Policy calldata proposed) external;
    function applyPolicy() external;
    function cancelPolicy() external;
    function setOperator(address operator_) external;
    function transferOwnership(address newOwner) external;
    function acceptOwnership() external;
    function kill() external;
    function unkill() external;
    function ownerWithdraw(address token, uint256 amount, address to) external;
    function sweepDust(address token, address to) external;
    function claimFees() external returns (uint256 amount);
}
