// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IHoodArmAccount} from "../src/interfaces/IHoodArmAccount.sol";
import {Policy, PolicyLib} from "../src/libraries/PolicyLib.sol";
import {PositionLib} from "../src/libraries/PositionLib.sol";
import {SpotPriceLib} from "../src/libraries/SpotPriceLib.sol";
import {DailyBudget, PerTradeCap, SlippageBound} from "../src/libraries/HoodErrors.sol";
import {HoodFixture} from "./utils/Fixture.sol";

/// @dev Exposes PositionLib on a storage struct so the fuzzer can drive it.
contract PositionHarness {
    IHoodArmAccount.Position public pos;

    function buy(uint256 received, uint256 spent) external {
        PositionLib.recordBuy(pos, received, spent, uint64(block.timestamp));
    }

    function sell(uint256 amountIn, uint256 proceeds, uint16 feeBps) external returns (int256, uint256) {
        uint256 basis = PositionLib.releaseBasis(pos, amountIn);
        return PositionLib.recordSell(pos, proceeds, basis, feeBps);
    }
}

contract PolicyMathFuzzTest is HoodFixture {
    uint256 private constant Q96 = 2 ** 96;

    // ── PolicyLib ────────────────────────────────────────────────────────────

    function testFuzz_tighterOrEqualIsReflexive(Policy memory p) public pure {
        assertTrue(PolicyLib.isTighterOrEqual(p, p));
    }

    function testFuzz_tighterOrEqualIsAntisymmetric(Policy memory a, Policy memory b) public pure {
        if (PolicyLib.isTighterOrEqual(a, b) && PolicyLib.isTighterOrEqual(b, a)) {
            assertEq(a.perTradeCapWei, b.perTradeCapWei);
            assertEq(a.dailyBudgetWei, b.dailyBudgetWei);
            assertEq(a.maxOpenPositions, b.maxOpenPositions);
            assertEq(a.maxSlippageBps, b.maxSlippageBps);
            assertEq(a.cooldownSeconds, b.cooldownSeconds);
            assertEq(a.minOracleScore, b.minOracleScore);
            assertEq(a.allowedRouter, b.allowedRouter);
            assertEq(a.quoteToken, b.quoteToken);
        }
    }

    function testFuzz_anyLooserAxisIsNotTighter(Policy memory a, uint8 axis, uint32 delta) public pure {
        vm.assume(delta != 0);
        Policy memory b = _copy(a);
        axis = axis % 6;
        if (axis == 0) {
            vm.assume(a.perTradeCapWei <= type(uint128).max - delta);
            b.perTradeCapWei = a.perTradeCapWei + delta;
        } else if (axis == 1) {
            vm.assume(a.dailyBudgetWei <= type(uint128).max - delta);
            b.dailyBudgetWei = a.dailyBudgetWei + delta;
        } else if (axis == 2) {
            vm.assume(a.maxOpenPositions < type(uint16).max);
            b.maxOpenPositions = a.maxOpenPositions + 1;
        } else if (axis == 3) {
            vm.assume(a.maxSlippageBps < type(uint16).max);
            b.maxSlippageBps = a.maxSlippageBps + 1;
        } else if (axis == 4) {
            vm.assume(a.cooldownSeconds != 0);
            b.cooldownSeconds = a.cooldownSeconds - 1;
        } else {
            vm.assume(a.minOracleScore != 0);
            b.minOracleScore = a.minOracleScore - 1;
        }
        assertFalse(PolicyLib.isTighterOrEqual(a, b));
        assertTrue(PolicyLib.isTighterOrEqual(b, a));
    }

    function _copy(Policy memory a) private pure returns (Policy memory b) {
        b.perTradeCapWei = a.perTradeCapWei;
        b.dailyBudgetWei = a.dailyBudgetWei;
        b.maxOpenPositions = a.maxOpenPositions;
        b.maxSlippageBps = a.maxSlippageBps;
        b.cooldownSeconds = a.cooldownSeconds;
        b.maxHoldSecondsHint = a.maxHoldSecondsHint;
        b.minOracleScore = a.minOracleScore;
        b.allowedRouter = a.allowedRouter;
        b.quoteToken = a.quoteToken;
    }

    function testFuzz_dayIndexChangesOnlyAtMidnight(uint64 ts, uint32 offset) public pure {
        vm.assume(offset < 1 days);
        uint256 dayStart = (uint256(ts) / 1 days) * 1 days;
        assertEq(PolicyLib.dayIndex(dayStart + offset), PolicyLib.dayIndex(dayStart));
        assertEq(PolicyLib.dayIndex(dayStart + 1 days), PolicyLib.dayIndex(dayStart) + 1);
    }

    // ── SpotPriceLib ─────────────────────────────────────────────────────────

    function testFuzz_spotOutRoundTripsWithinRounding(uint160 sqrtP, uint96 amountIn) public pure {
        sqrtP = uint160(bound(sqrtP, 2 ** 64, 2 ** 128));
        vm.assume(amountIn > 1e6);
        uint256 out = SpotPriceLib.spotOut(sqrtP, true, amountIn);
        vm.assume(out > 1e6);
        uint256 back = SpotPriceLib.spotOut(sqrtP, false, out);
        // Two floor divisions each way: with `out` above 1e6 the round trip is within 1e-5.
        assertApproxEqRel(back, amountIn, 1e13);
    }

    function testFuzz_minimumOutNeverExceedsExpected(uint256 expected, uint16 bps) public pure {
        bps = uint16(bound(bps, 0, 10_000));
        uint256 min = SpotPriceLib.minimumOut(expected, bps);
        assertLe(min, expected);
        if (bps == 0) assertEq(min, expected);
        if (bps == 10_000) assertEq(min, 0);
    }

    // ── PositionLib ──────────────────────────────────────────────────────────

    function testFuzz_feeAboveIsFeeOfNewProfitOnly(int128 net, int128 highWater, uint16 feeBps) public pure {
        feeBps = uint16(bound(feeBps, 0, 2_000));
        uint256 fee = PositionLib.feeAbove(net, highWater, feeBps);
        if (net <= highWater || feeBps == 0) {
            assertEq(fee, 0);
        } else {
            assertEq(fee, (uint256(int256(net) - int256(highWater)) * feeBps) / 10_000);
        }
    }

    /// @dev Over any sequence of sells, the total fee equals feeBps of the
    ///      position's running-maximum realized profit (never of gross gains).
    function testFuzz_highWaterMarkTotalsFeeOnPeakProfit(uint64[8] memory proceeds, uint16 feeBps) public {
        feeBps = uint16(bound(feeBps, 0, 2_000));
        PositionHarness h = new PositionHarness();
        uint256 units = 8e18;
        uint256 spent = 8e18;
        h.buy(units, spent);
        uint256 totalFee;
        int256 net;
        int256 peak;
        for (uint256 i = 0; i < 8; i++) {
            uint256 p = uint256(proceeds[i]) % 3e18;
            (int256 realized, uint256 fee) = h.sell(1e18, p, feeBps);
            net += realized;
            assertEq(realized, int256(p) - 1e18);
            if (net > peak) {
                assertEq(fee, (uint256(net - peak) * feeBps) / 10_000);
                peak = net;
            } else {
                assertEq(fee, 0);
            }
            totalFee += fee;
        }
        (,, int128 realizedNet, int128 hwm,) = h.pos();
        assertEq(realizedNet, net);
        if (totalFee != 0) assertEq(hwm, peak);
        assertLe(totalFee, (uint256(peak) * feeBps) / 10_000 + 8);
    }

    // ── the account's caps under random sizing ───────────────────────────────

    /// @dev Whatever sizes the operator tries, the account never spends more
    ///      than the per-trade cap on one buy or the daily budget in one day.
    function testFuzz_capsBoundEverySpend(uint128[6] memory sizes) public {
        uint256 spent;
        for (uint256 i = 0; i < 6; i++) {
            uint256 size = uint256(sizes[i]) % (basePolicy.perTradeCapWei * 2) + 1;
            uint256 minOut = requiredMin(address(weth), size);
            vm.prank(operator);
            if (size > basePolicy.perTradeCapWei) {
                vm.expectRevert(abi.encodeWithSelector(PerTradeCap.selector, size, basePolicy.perTradeCapWei));
                account.buy(address(token), size, minOut, FEE, block.timestamp);
            } else if (spent + size > basePolicy.dailyBudgetWei) {
                vm.expectRevert(abi.encodeWithSelector(DailyBudget.selector, spent + size, basePolicy.dailyBudgetWei));
                account.buy(address(token), size, minOut, FEE, block.timestamp);
            } else {
                account.buy(address(token), size, minOut, FEE, block.timestamp);
                spent += size;
            }
            assertEq(account.spentTodayWei(), spent);
            assertLe(spent, basePolicy.dailyBudgetWei);
            skipCooldown();
        }
    }

    /// @dev The slippage bound accepts exactly the minimums at or above the
    ///      fee-adjusted spot output shaded by maxSlippageBps, and nothing lower.
    function testFuzz_slippageBoundIsExact(uint96 amountIn, uint16 maxSlippageBps, uint256 shade) public {
        amountIn = uint96(bound(amountIn, 1e12, basePolicy.perTradeCapWei));
        maxSlippageBps = uint16(bound(maxSlippageBps, 0, basePolicy.maxSlippageBps));
        Policy memory p = basePolicy;
        p.maxSlippageBps = maxSlippageBps;
        vm.prank(owner);
        account.setPolicy(p);
        uint256 required = requiredMin(address(weth), amountIn);
        vm.assume(required != 0);
        shade = bound(shade, 1, required);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(SlippageBound.selector, required - shade, required));
        account.buy(address(token), amountIn, required - shade, FEE, block.timestamp);
        vm.prank(operator);
        account.buy(address(token), amountIn, required, FEE, block.timestamp);
    }
}
