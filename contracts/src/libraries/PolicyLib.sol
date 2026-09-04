// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {InvalidPolicy} from "./HoodErrors.sol";

/// @notice The owner's bounds on what the operator may do. Mirrors the sizing
///         knobs of `Arm` in `src/types.ts`: `perTradeWei`, `dailyBudgetWei`,
///         `maxConcurrentPositions`, `slippageBps`, `cooldownSeconds`,
///         `maxHoldSeconds` and `minOracleScore`.
/// @param perTradeCapWei Most quote one buy may spend. Zero disarms buying.
/// @param dailyBudgetWei Most quote all buys may spend in one UTC day. Zero disarms buying.
/// @param maxOpenPositions Most distinct tokens held at once.
/// @param maxSlippageBps Widest slippage a buy or sell may accept, measured
///        against the pool's spot price at execution (0..10000).
/// @param cooldownSeconds Seconds that must pass after any trade before the next buy.
/// @param maxHoldSecondsHint Informational: how long the engine intends to hold.
///        Not enforced (an enforced hold cap would force a sale into a thin pool).
/// @param minOracleScore When non-zero, a buy needs a fresh attestation with at
///        least this score from the attestations contract.
/// @param allowedRouter The only router the account will approve and call.
/// @param quoteToken The token every buy spends and every sell receives (WETH).
struct Policy {
    uint128 perTradeCapWei;
    uint128 dailyBudgetWei;
    uint16 maxOpenPositions;
    uint16 maxSlippageBps;
    uint32 cooldownSeconds;
    uint32 maxHoldSecondsHint;
    uint8 minOracleScore;
    address allowedRouter;
    address quoteToken;
}

/// @title PolicyLib
/// @notice Pure policy maths: validation, the tighter-or-equal comparison that
///         decides whether a change applies now or behind the timelock, and the
///         UTC-day index the daily budget rolls on.
library PolicyLib {
    uint16 internal constant BPS = 10_000;
    uint8 internal constant MAX_SCORE = 100;

    /// @notice Revert with the offending field when a policy is out of range.
    function validate(Policy memory p) internal pure {
        if (p.allowedRouter == address(0)) revert InvalidPolicy("allowedRouter");
        if (p.quoteToken == address(0)) revert InvalidPolicy("quoteToken");
        if (p.maxSlippageBps > BPS) revert InvalidPolicy("maxSlippageBps");
        if (p.minOracleScore > MAX_SCORE) revert InvalidPolicy("minOracleScore");
        if (p.perTradeCapWei > p.dailyBudgetWei) revert InvalidPolicy("perTradeCapWei");
    }

    /// @notice True when `next` takes on no more risk than `current` on every
    ///         axis, so it may take effect immediately. Anything else is a
    ///         loosening and waits for the timelock. The router and quote token
    ///         are identity fields: changing either is a loosening.
    function isTighterOrEqual(Policy memory current, Policy memory next) internal pure returns (bool) {
        return next.perTradeCapWei <= current.perTradeCapWei && next.dailyBudgetWei <= current.dailyBudgetWei
            && next.maxOpenPositions <= current.maxOpenPositions && next.maxSlippageBps <= current.maxSlippageBps
            && next.cooldownSeconds >= current.cooldownSeconds && next.minOracleScore >= current.minOracleScore
            && next.allowedRouter == current.allowedRouter && next.quoteToken == current.quoteToken;
    }

    /// @notice The UTC day `timestamp` falls in. The daily budget resets when this changes.
    function dayIndex(uint256 timestamp) internal pure returns (uint64) {
        // casting to 'uint64' is safe because a day count only leaves uint64 after 5e16 years
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint64(timestamp / 1 days);
    }
}
