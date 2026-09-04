// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {HoodArmAccount} from "../src/HoodArmAccount.sol";
import {IHoodArmAccount} from "../src/interfaces/IHoodArmAccount.sol";
import {IHoodOracleAttestations} from "../src/interfaces/IHoodOracleAttestations.sol";
import {Policy} from "../src/libraries/PolicyLib.sol";
import {SpotPriceLib} from "../src/libraries/SpotPriceLib.sol";
import {
    AlreadyInitialized,
    Concurrency,
    Cooldown,
    DailyBudget,
    DeadlineExpired,
    EthTransferFailed,
    InsufficientBalance,
    InsufficientPosition,
    InvalidPolicy,
    KillSwitch,
    NoPool,
    NoPosition,
    NotOperator,
    NotOwner,
    NotOwnerOrOperator,
    NothingPending,
    NothingReceived,
    NothingToClaim,
    OracleGate,
    PerTradeCap,
    PoolNotInitialized,
    PositionsOpen,
    QuoteTokenNotTradable,
    SlippageBound,
    Timelocked,
    ZeroAddress,
    ZeroAmount
} from "../src/libraries/HoodErrors.sol";
import {FeeOnTransferToken, MockERC20, ReentrantToken} from "./mocks/MockERC20.sol";
import {HoodFixture} from "./utils/Fixture.sol";

contract RejectsEth {
    receive() external payable {
        revert("no");
    }
}

contract HoodArmAccountTest is HoodFixture {
    // ── initialization ───────────────────────────────────────────────────────

    function test_initializeSnapshotsFactoryState() public view {
        assertEq(account.owner(), owner);
        assertEq(account.operator(), operator);
        assertEq(account.factory(), address(factory));
        assertEq(account.attestations(), address(attestations));
        assertEq(account.weth(), address(weth));
        assertEq(account.performanceFeeBps(), PROTOCOL_FEE_BPS);
        assertEq(account.policy().perTradeCapWei, basePolicy.perTradeCapWei);
        assertFalse(account.killed());
    }

    function test_initializeTwiceReverts() public {
        vm.expectRevert(AlreadyInitialized.selector);
        account.initialize(owner, operator, basePolicy, 0);
    }

    function test_implementationCannotBeInitialized() public {
        vm.expectRevert(AlreadyInitialized.selector);
        implementation.initialize(owner, operator, basePolicy, 0);
    }

    function test_createAccountRejectsInvalidPolicy() public {
        Policy memory p = basePolicy;
        p.maxSlippageBps = 10_001;
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(InvalidPolicy.selector, "maxSlippageBps"));
        factory.createAccount(operator, p);
    }

    function test_receiveEmits() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        vm.expectEmit(address(account));
        emit IHoodArmAccount.Received(stranger, 1 ether);
        (bool ok,) = address(account).call{value: 1 ether}("");
        assertTrue(ok);
    }

    // ── buy: happy path ──────────────────────────────────────────────────────

    function test_buyWrapsEthRecordsPositionAndSpend() public {
        uint256 amountIn = 0.05 ether;
        uint256 minOut = requiredMin(address(weth), amountIn);
        uint256 expectedOut = router.quote(address(weth), address(token), FEE, amountIn);

        vm.expectEmit(address(account));
        emit IHoodArmAccount.Wrapped(amountIn);
        vm.expectEmit(address(account));
        emit IHoodArmAccount.Buy(address(token), amountIn, expectedOut, FEE, expectedOut, amountIn);
        vm.prank(operator);
        uint256 out = account.buy(address(token), amountIn, minOut, FEE, block.timestamp + 60);

        assertEq(out, expectedOut);
        assertEq(token.balanceOf(address(account)), expectedOut);
        assertEq(address(account).balance, 10 ether - amountIn);
        IHoodArmAccount.Position memory pos = account.position(address(token));
        assertEq(pos.tokenAmount, expectedOut);
        assertEq(pos.costBasisWei, amountIn);
        assertEq(pos.openedAt, block.timestamp);
        assertEq(account.openPositionCount(), 1);
        assertEq(account.spentTodayWei(), amountIn);
        assertEq(account.remainingDailyBudgetWei(), basePolicy.dailyBudgetWei - amountIn);
        assertEq(account.lastTradeAt(), block.timestamp);
        assertEq(account.cooldownRemaining(), basePolicy.cooldownSeconds);
        assertEq(weth.allowance(address(account), address(router)), 0);
    }

    function test_buyUsesExistingWethBeforeWrapping() public {
        vm.prank(address(account));
        weth.deposit{value: 0.03 ether}();
        buy(0.05 ether);
        assertEq(address(account).balance, 10 ether - 0.05 ether);
        assertEq(weth.balanceOf(address(account)), 0);
    }

    function test_buyClearsStandingAllowance() public {
        router.setConsumeAllowance(false);
        buy(0.05 ether);
        assertEq(weth.allowance(address(account), address(router)), 0);
    }

    function test_buyAddsToOpenPositionWithWeightedBasis() public {
        uint256 first = buy(0.05 ether);
        skipCooldown();
        setTokensPerWeth(500e18);
        uint256 second = buy(0.05 ether);
        IHoodArmAccount.Position memory pos = account.position(address(token));
        assertEq(pos.tokenAmount, first + second);
        assertEq(pos.costBasisWei, 0.1 ether);
        assertEq(account.openPositionCount(), 1);
    }

    // ── buy: refusals in guard order ─────────────────────────────────────────

    function test_buyRefusesNonOperator() public {
        buyExpecting(abi.encodeWithSelector(NotOperator.selector, owner), owner, 0.05 ether);
    }

    function test_buyRefusesWhenKilled() public {
        vm.prank(owner);
        account.kill();
        buyExpecting(abi.encodeWithSelector(KillSwitch.selector), 0.05 ether);
    }

    function test_buyRefusesZeroAmount() public {
        vm.prank(operator);
        vm.expectRevert(ZeroAmount.selector);
        account.buy(address(token), 0, 0, FEE, block.timestamp);
    }

    function test_buyRefusesExpiredDeadline() public {
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(DeadlineExpired.selector, block.timestamp - 1, block.timestamp));
        account.buy(address(token), 0.01 ether, 0, FEE, block.timestamp - 1);
    }

    function test_buyRefusesQuoteToken() public {
        vm.prank(operator);
        vm.expectRevert(QuoteTokenNotTradable.selector);
        account.buy(address(weth), 0.01 ether, 0, FEE, block.timestamp);
        vm.prank(operator);
        vm.expectRevert(QuoteTokenNotTradable.selector);
        account.buy(address(0), 0.01 ether, 0, FEE, block.timestamp);
    }

    function test_buyRefusesDuringCooldown() public {
        buy(0.05 ether);
        vm.warp(block.timestamp + 10);
        buyExpecting(abi.encodeWithSelector(Cooldown.selector, 20), 0.05 ether);
        vm.warp(block.timestamp + 20);
        buy(0.05 ether);
    }

    function test_buyRefusesOverPerTradeCap() public {
        buyExpecting(abi.encodeWithSelector(PerTradeCap.selector, 0.1 ether + 1, 0.1 ether), 0.1 ether + 1);
    }

    function test_buyRefusesZeroPerTradeCap() public {
        Policy memory p = basePolicy;
        p.perTradeCapWei = 0;
        vm.prank(owner);
        account.setPolicy(p);
        buyExpecting(abi.encodeWithSelector(PerTradeCap.selector, 0.01 ether, 0), 0.01 ether);
    }

    function test_buyRefusesOverDailyBudget() public {
        buy(0.1 ether);
        skipCooldown();
        buy(0.1 ether);
        skipCooldown();
        buyExpecting(abi.encodeWithSelector(DailyBudget.selector, 0.3 ether, 0.25 ether), 0.1 ether);
        buy(0.05 ether);
        assertEq(account.remainingDailyBudgetWei(), 0);
    }

    function test_buyRefusesZeroDailyBudget() public {
        Policy memory p = basePolicy;
        p.perTradeCapWei = 0;
        p.dailyBudgetWei = 0;
        vm.prank(owner);
        account.setPolicy(p);
        buyExpecting(abi.encodeWithSelector(PerTradeCap.selector, 0.01 ether, 0), 0.01 ether);
    }

    function test_dailyBudgetRollsOverAtUtcMidnight() public {
        buy(0.1 ether);
        skipCooldown();
        buy(0.1 ether);
        uint256 midnight = (block.timestamp / 1 days + 1) * 1 days;
        vm.warp(midnight - 1);
        assertEq(account.spentTodayWei(), 0.2 ether);
        buyExpecting(abi.encodeWithSelector(DailyBudget.selector, 0.3 ether, 0.25 ether), 0.1 ether);
        vm.warp(midnight);
        assertEq(account.spentTodayWei(), 0);
        assertEq(account.remainingDailyBudgetWei(), 0.25 ether);
        buy(0.1 ether);
        assertEq(account.spentTodayWei(), 0.1 ether);
    }

    function test_buyRefusesConcurrency() public {
        MockERC20 second = new MockERC20("Two", "TWO", 18);
        MockERC20 third = new MockERC20("Three", "THREE", 18);
        address secondPool = uniFactory.createPool(address(weth), address(second), FEE, pool.sqrtPriceX96());
        address thirdPool = uniFactory.createPool(address(weth), address(third), FEE, pool.sqrtPriceX96());
        buy(0.05 ether);
        skipCooldown();
        uint256 min = requiredMinFor(secondPool, address(weth), 0.05 ether);
        vm.prank(operator);
        account.buy(address(second), 0.05 ether, min, FEE, block.timestamp);
        skipCooldown();
        min = requiredMinFor(thirdPool, address(weth), 0.05 ether);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(Concurrency.selector, 2, 2));
        account.buy(address(third), 0.05 ether, min, FEE, block.timestamp);
        buy(0.05 ether);
        assertEq(account.openPositionCount(), 2);
    }

    function test_buyRefusesSlippageBelowBound() public {
        uint256 amountIn = 0.05 ether;
        uint256 required = requiredMin(address(weth), amountIn);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(SlippageBound.selector, required - 1, required));
        account.buy(address(token), amountIn, required - 1, FEE, block.timestamp);
    }

    function test_buyRefusesWhenRouterFillIsWorseThanMinimum() public {
        router.setImpactBps(600);
        buyExpecting(bytes("Too little received"), 0.05 ether);
    }

    function test_buyRefusesUnknownPool() public {
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(NoPool.selector, address(weth), address(token), uint24(3_000)));
        account.buy(address(token), 0.05 ether, 0, 3_000, block.timestamp);
    }

    function test_buyRefusesUninitializedPool() public {
        pool.setSqrtPriceX96(0);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(PoolNotInitialized.selector, address(pool)));
        account.buy(address(token), 0.05 ether, 0, FEE, block.timestamp);
    }

    function test_buyRefusesWithoutFunds() public {
        vm.prank(owner);
        account.ownerWithdraw(address(0), 10 ether, owner);
        buyExpecting(abi.encodeWithSelector(InsufficientBalance.selector, 0.05 ether, 0), 0.05 ether);
    }

    function test_buyRefusesWhenNothingArrives() public {
        Policy memory p = basePolicy;
        p.maxSlippageBps = 10_000;
        vm.prank(owner);
        account.setPolicy(p);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(owner);
        account.applyPolicy();
        router.setImpactBps(10_000);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(NothingReceived.selector, address(token)));
        account.buy(address(token), 0.05 ether, 0, FEE, block.timestamp);
    }

    // ── oracle gate ──────────────────────────────────────────────────────────

    function _requireScore(uint8 minScore) internal {
        Policy memory p = basePolicy;
        p.minOracleScore = minScore;
        vm.prank(owner);
        account.setPolicy(p);
    }

    function test_oracleGateRefusesWithoutAttestation() public {
        _requireScore(60);
        buyExpecting(abi.encodeWithSelector(OracleGate.selector, 0, 60, false), 0.05 ether);
    }

    function test_oracleGateRefusesLowScore() public {
        _requireScore(60);
        post(attestation(address(token), 59, 300));
        buyExpecting(abi.encodeWithSelector(OracleGate.selector, 59, 60, true), 0.05 ether);
    }

    function test_oracleGateRefusesExpired() public {
        _requireScore(60);
        post(attestation(address(token), 80, 300));
        vm.warp(block.timestamp + 300);
        buyExpecting(abi.encodeWithSelector(OracleGate.selector, 80, 60, false), 0.05 ether);
    }

    function test_oracleGatePassesFreshScore() public {
        _requireScore(60);
        post(attestation(address(token), 60, 300));
        buy(0.05 ether);
        assertEq(account.openPositionCount(), 1);
    }

    function test_oracleGateFailsClosedWithoutAttestationsContract() public {
        Policy memory p = basePolicy;
        p.minOracleScore = 10;
        HoodArmAccount bare = HoodArmAccount(payable(new NoAttestationsFactory(address(implementation), address(weth)).create(owner, operator, p)));
        vm.deal(address(bare), 1 ether);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(OracleGate.selector, 0, 10, false));
        bare.buy(address(token), 0.01 ether, 0, FEE, block.timestamp);
    }

    // ── sell ─────────────────────────────────────────────────────────────────

    function test_sellAtLossChargesNoFee() public {
        uint256 got = buy(0.05 ether);
        uint256 expectedProceeds = router.quote(address(token), address(weth), FEE, got);
        assertLt(expectedProceeds, 0.05 ether);
        vm.expectEmit(address(account));
        emit IHoodArmAccount.Sell(
            address(token), got, expectedProceeds, FEE, int256(expectedProceeds) - int256(0.05 ether), 0, operator
        );
        vm.expectEmit(address(account));
        emit IHoodArmAccount.PositionClosed(address(token), int256(expectedProceeds) - int256(0.05 ether));
        uint256 proceeds = sell(got);
        assertEq(proceeds, expectedProceeds);
        assertEq(account.feesAccruedWei(), 0);
        assertEq(account.openPositionCount(), 0);
        assertEq(account.position(address(token)).tokenAmount, 0);
        assertEq(token.allowance(address(account), address(router)), 0);
    }

    function test_sellAtProfitAccruesPerformanceFee() public {
        uint256 got = buy(0.05 ether);
        setTokensPerWeth(500e18);
        uint256 proceeds = sell(got);
        assertGt(proceeds, 0.05 ether);
        uint256 profit = proceeds - 0.05 ether;
        assertEq(account.feesAccruedWei(), (profit * PROTOCOL_FEE_BPS) / 10_000);
        assertEq(account.withdrawableQuoteWei(), proceeds - account.feesAccruedWei());
    }

    function test_sellIgnoresCooldownAndKill() public {
        uint256 got = buy(0.05 ether);
        vm.prank(owner);
        account.kill();
        sell(got / 2);
        assertEq(account.position(address(token)).tokenAmount, got - got / 2);
    }

    function test_sellUpdatesLastTradeAtSoNextBuyWaits() public {
        uint256 got = buy(0.05 ether);
        skipCooldown();
        sell(got);
        buyExpecting(abi.encodeWithSelector(Cooldown.selector, basePolicy.cooldownSeconds), 0.05 ether);
    }

    function test_ownerCanSell() public {
        uint256 got = buy(0.05 ether);
        sellAs(owner, got);
        assertEq(account.openPositionCount(), 0);
    }

    function test_sellRefusesStranger() public {
        uint256 got = buy(0.05 ether);
        sellExpecting(abi.encodeWithSelector(NotOwnerOrOperator.selector, stranger), stranger, got);
    }

    function test_sellRefusesZeroDeadlineAndSlippage() public {
        uint256 got = buy(0.05 ether);
        vm.prank(operator);
        vm.expectRevert(ZeroAmount.selector);
        account.sell(address(token), 0, 0, FEE, block.timestamp);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(DeadlineExpired.selector, block.timestamp - 1, block.timestamp));
        account.sell(address(token), got, 0, FEE, block.timestamp - 1);
        uint256 required = requiredMin(address(token), got);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(SlippageBound.selector, 0, required));
        account.sell(address(token), got, 0, FEE, block.timestamp);
    }

    function test_sellRefusesNoPositionAndOverPosition() public {
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(NoPosition.selector, address(token)));
        account.sell(address(token), 1, 0, FEE, block.timestamp);
        uint256 got = buy(0.05 ether);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(InsufficientPosition.selector, address(token), got + 1, got));
        account.sell(address(token), got + 1, 0, FEE, block.timestamp);
    }

    function test_highWaterMarkChargesOnlyNewProfit() public {
        uint256 got = buy(0.1 ether);
        uint256 third = got / 3;

        setTokensPerWeth(500e18);
        uint256 p1 = sell(third);
        uint256 basis1 = (0.1 ether * third) / got;
        uint256 fee1 = ((p1 - basis1) * PROTOCOL_FEE_BPS) / 10_000;
        assertEq(account.feesAccruedWei(), fee1);
        IHoodArmAccount.Position memory pos = account.position(address(token));
        assertEq(pos.feeHighWaterWei, int256(p1) - int256(basis1));

        setTokensPerWeth(1_500e18);
        uint256 remainingBasis = 0.1 ether - basis1;
        uint256 remaining = got - third;
        uint256 p2 = sell(third);
        uint256 basis2 = (remainingBasis * third) / remaining;
        assertLt(p2, basis2);
        assertEq(account.feesAccruedWei(), fee1);
        pos = account.position(address(token));
        assertEq(pos.feeHighWaterWei, int256(p1) - int256(basis1));
        int256 netAfterLoss = int256(p1) - int256(basis1) + int256(p2) - int256(basis2);
        assertEq(pos.realizedNetWei, netAfterLoss);

        setTokensPerWeth(500e18);
        uint256 p3 = sell(got - 2 * third);
        uint256 basis3 = remainingBasis - basis2;
        int256 finalNet = netAfterLoss + int256(p3) - int256(basis3);
        int256 above = finalNet - (int256(p1) - int256(basis1));
        uint256 fee3 = above > 0 ? (uint256(above) * PROTOCOL_FEE_BPS) / 10_000 : 0;
        assertEq(account.feesAccruedWei(), fee1 + fee3);
        assertEq(account.openPositionCount(), 0);
    }

    function test_feeOnTransferTokenIsBookedAtDeliveredAmount() public {
        FeeOnTransferToken tax = new FeeOnTransferToken(500);
        address taxPool = uniFactory.createPool(address(weth), address(tax), FEE, sqrtPriceFor(1_000e18, 1e18));
        tax.mint(address(router), 1_000_000e18);
        uint256 quoted = router.quote(address(weth), address(tax), FEE, 0.05 ether);
        uint256 min = requiredMinFor(taxPool, address(weth), 0.05 ether);
        vm.prank(operator);
        uint256 got = account.buy(address(tax), 0.05 ether, min, FEE, block.timestamp);
        assertEq(got, quoted - (quoted * 500) / 10_000);
        assertEq(account.position(address(tax)).tokenAmount, got);
        assertEq(tax.balanceOf(address(account)), got);
    }

    function test_reentrantTokenCannotReenter() public {
        ReentrantToken re = new ReentrantToken();
        address rePool = uniFactory.createPool(address(weth), address(re), FEE, sqrtPriceFor(1_000e18, 1e18));
        re.arm(address(account), abi.encodeCall(HoodArmAccount.claimFees, ()));
        uint256 min = requiredMinFor(rePool, address(weth), 0.05 ether);
        vm.prank(operator);
        account.buy(address(re), 0.05 ether, min, FEE, block.timestamp);
        assertTrue(re.reentered());
        assertEq(bytes4(re.lastError()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(account.openPositionCount(), 1);
    }

    // ── fees ─────────────────────────────────────────────────────────────────

    function test_claimFeesPaysProtocolRecipient() public {
        uint256 got = buy(0.05 ether);
        setTokensPerWeth(500e18);
        sell(got);
        uint256 due = account.feesAccruedWei();
        assertGt(due, 0);
        vm.expectEmit(address(account));
        emit IHoodArmAccount.FeesClaimed(feeRecipient, due);
        vm.prank(stranger);
        uint256 paid = account.claimFees();
        assertEq(paid, due);
        assertEq(weth.balanceOf(feeRecipient), due);
        assertEq(account.feesAccruedWei(), 0);
        vm.expectRevert(NothingToClaim.selector);
        account.claimFees();
    }

    function test_ownerCannotWithdrawAccruedFees() public {
        uint256 got = buy(0.05 ether);
        setTokensPerWeth(500e18);
        sell(got);
        uint256 available = account.withdrawableQuoteWei();
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(InsufficientBalance.selector, available + 1, available));
        account.ownerWithdraw(address(weth), available + 1, owner);
        vm.prank(owner);
        account.ownerWithdraw(address(weth), available, owner);
        assertEq(weth.balanceOf(owner), available);
        assertEq(weth.balanceOf(address(account)), account.feesAccruedWei());
    }

    // ── owner withdraw and sweep ─────────────────────────────────────────────

    function test_ownerWithdrawEthAlwaysWorksEvenWhenKilled() public {
        vm.startPrank(owner);
        account.kill();
        vm.expectEmit(address(account));
        emit IHoodArmAccount.Withdrawn(address(0), 4 ether, owner);
        account.ownerWithdraw(address(0), 4 ether, owner);
        vm.stopPrank();
        assertEq(owner.balance, 4 ether);
        assertEq(address(account).balance, 6 ether);
    }

    function test_ownerWithdrawPositionTokenShrinksPosition() public {
        uint256 got = buy(0.05 ether);
        vm.prank(owner);
        account.ownerWithdraw(address(token), got / 2, owner);
        IHoodArmAccount.Position memory pos = account.position(address(token));
        assertEq(pos.tokenAmount, got - got / 2);
        assertEq(pos.costBasisWei, 0.05 ether - (0.05 ether * (got / 2)) / got);
        vm.prank(owner);
        vm.expectEmit(address(account));
        emit IHoodArmAccount.PositionClosed(address(token), 0);
        account.ownerWithdraw(address(token), got - got / 2, owner);
        assertEq(account.openPositionCount(), 0);
        assertEq(token.balanceOf(owner), got);
    }

    function test_ownerWithdrawUntrackedTokenLeavesBooksAlone() public {
        MockERC20 gift = new MockERC20("Gift", "GIFT", 18);
        gift.mint(address(account), 5e18);
        vm.prank(owner);
        account.ownerWithdraw(address(gift), 5e18, owner);
        assertEq(gift.balanceOf(owner), 5e18);
        assertEq(account.openPositionCount(), 0);
    }

    function test_ownerWithdrawRejectsBadInputsAndCallers() public {
        vm.expectRevert(abi.encodeWithSelector(NotOwner.selector, operator));
        vm.prank(operator);
        account.ownerWithdraw(address(0), 1, operator);
        vm.startPrank(owner);
        vm.expectRevert(ZeroAmount.selector);
        account.ownerWithdraw(address(0), 0, owner);
        vm.expectRevert(ZeroAddress.selector);
        account.ownerWithdraw(address(0), 1, address(0));
        address sink = address(new RejectsEth());
        vm.expectRevert(abi.encodeWithSelector(EthTransferFailed.selector, sink, 1));
        account.ownerWithdraw(address(0), 1, sink);
        vm.stopPrank();
    }

    function test_sweepDustSendsOnlyUntrackedUnits() public {
        uint256 got = buy(0.05 ether);
        token.mint(address(account), 7e18);
        vm.prank(owner);
        vm.expectEmit(address(account));
        emit IHoodArmAccount.DustSwept(address(token), 7e18, owner);
        account.sweepDust(address(token), owner);
        assertEq(token.balanceOf(address(account)), got);
        vm.prank(owner);
        vm.expectRevert(ZeroAmount.selector);
        account.sweepDust(address(token), owner);
    }

    function test_sweepDustQuoteKeepsFeesAndEthSweepsAll() public {
        uint256 got = buy(0.05 ether);
        setTokensPerWeth(500e18);
        sell(got);
        uint256 fees = account.feesAccruedWei();
        uint256 free = account.withdrawableQuoteWei();
        vm.startPrank(owner);
        account.sweepDust(address(weth), owner);
        assertEq(weth.balanceOf(owner), free);
        assertEq(weth.balanceOf(address(account)), fees);
        account.sweepDust(address(0), owner);
        assertEq(address(account).balance, 0);
        vm.expectRevert(ZeroAmount.selector);
        account.sweepDust(address(0), owner);
        vm.expectRevert(ZeroAddress.selector);
        account.sweepDust(address(0), address(0));
        vm.stopPrank();
    }

    // ── kill switch ──────────────────────────────────────────────────────────

    function test_killAndUnkill() public {
        vm.prank(owner);
        vm.expectEmit(address(account));
        emit IHoodArmAccount.Killed(owner);
        account.kill();
        assertTrue(account.killed());
        vm.expectRevert(abi.encodeWithSelector(NotOwner.selector, operator));
        vm.prank(operator);
        account.unkill();
        vm.prank(owner);
        vm.expectEmit(address(account));
        emit IHoodArmAccount.Unkilled(owner);
        account.unkill();
        buy(0.05 ether);
    }

    // ── policy timelock ──────────────────────────────────────────────────────

    function test_tighteningAppliesImmediately() public {
        Policy memory p = basePolicy;
        p.perTradeCapWei = 0.05 ether;
        p.dailyBudgetWei = 0.2 ether;
        p.maxOpenPositions = 1;
        p.maxSlippageBps = 300;
        p.cooldownSeconds = 60;
        p.minOracleScore = 40;
        vm.prank(owner);
        vm.expectEmit(address(account));
        emit IHoodArmAccount.PolicyApplied(p);
        account.setPolicy(p);
        assertEq(account.policy().perTradeCapWei, 0.05 ether);
        (, uint256 effectiveAt) = account.pendingPolicy();
        assertEq(effectiveAt, 0);
    }

    function test_looseningWaitsOneHour() public {
        Policy memory p = basePolicy;
        p.perTradeCapWei = 0.2 ether;
        p.dailyBudgetWei = 0.5 ether;
        vm.prank(owner);
        vm.expectEmit(address(account));
        emit IHoodArmAccount.PolicyProposed(p, block.timestamp + 1 hours);
        account.setPolicy(p);
        assertEq(account.policy().perTradeCapWei, 0.1 ether);
        (Policy memory pending, uint256 effectiveAt) = account.pendingPolicy();
        assertEq(pending.perTradeCapWei, 0.2 ether);
        assertEq(effectiveAt, block.timestamp + 1 hours);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Timelocked.selector, effectiveAt));
        account.applyPolicy();

        vm.warp(effectiveAt);
        vm.prank(owner);
        vm.expectEmit(address(account));
        emit IHoodArmAccount.PolicyApplied(p);
        account.applyPolicy();
        assertEq(account.policy().perTradeCapWei, 0.2 ether);
        (, effectiveAt) = account.pendingPolicy();
        assertEq(effectiveAt, 0);
    }

    function test_mixedChangeIsTimelocked() public {
        Policy memory p = basePolicy;
        p.perTradeCapWei = 0.01 ether;
        p.cooldownSeconds = 0;
        vm.prank(owner);
        account.setPolicy(p);
        assertEq(account.policy().cooldownSeconds, 30);
        (, uint256 effectiveAt) = account.pendingPolicy();
        assertEq(effectiveAt, block.timestamp + 1 hours);
    }

    function test_cancelPolicy() public {
        vm.startPrank(owner);
        vm.expectRevert(NothingPending.selector);
        account.cancelPolicy();
        vm.expectRevert(NothingPending.selector);
        account.applyPolicy();
        Policy memory p = basePolicy;
        p.maxSlippageBps = 1_000;
        account.setPolicy(p);
        vm.expectEmit(address(account));
        emit IHoodArmAccount.PolicyCancelled();
        account.cancelPolicy();
        (, uint256 effectiveAt) = account.pendingPolicy();
        assertEq(effectiveAt, 0);
        vm.stopPrank();
    }

    function test_quoteTokenChangeNeedsNoOpenPositions() public {
        buy(0.05 ether);
        Policy memory p = basePolicy;
        p.quoteToken = address(token);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PositionsOpen.selector, 1));
        account.setPolicy(p);

        uint256 got = account.position(address(token)).tokenAmount;
        sell(got);
        vm.prank(owner);
        account.setPolicy(p);
        vm.warp(block.timestamp + 1 hours);
        buy(0.05 ether);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PositionsOpen.selector, 1));
        account.applyPolicy();
    }

    function test_setPolicyValidatesFields() public {
        vm.startPrank(owner);
        Policy memory p = basePolicy;
        p.allowedRouter = address(0);
        vm.expectRevert(abi.encodeWithSelector(InvalidPolicy.selector, "allowedRouter"));
        account.setPolicy(p);
        p = basePolicy;
        p.quoteToken = address(0);
        vm.expectRevert(abi.encodeWithSelector(InvalidPolicy.selector, "quoteToken"));
        account.setPolicy(p);
        p = basePolicy;
        p.minOracleScore = 101;
        vm.expectRevert(abi.encodeWithSelector(InvalidPolicy.selector, "minOracleScore"));
        account.setPolicy(p);
        p = basePolicy;
        p.perTradeCapWei = p.dailyBudgetWei + 1;
        vm.expectRevert(abi.encodeWithSelector(InvalidPolicy.selector, "perTradeCapWei"));
        account.setPolicy(p);
        vm.stopPrank();
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(NotOwner.selector, operator));
        account.setPolicy(basePolicy);
    }

    // ── keys ─────────────────────────────────────────────────────────────────

    function test_setOperatorRotatesHotKey() public {
        address fresh = makeAddr("fresh");
        vm.prank(owner);
        vm.expectEmit(address(account));
        emit IHoodArmAccount.OperatorSet(operator, fresh);
        account.setOperator(fresh);
        buyExpecting(abi.encodeWithSelector(NotOperator.selector, operator), 0.05 ether);
        buyAs(fresh, 0.05 ether);
    }

    function test_twoStepOwnership() public {
        address next = makeAddr("next");
        vm.prank(owner);
        account.transferOwnership(next);
        assertEq(account.owner(), owner);
        assertEq(account.pendingOwner(), next);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(NotOwner.selector, stranger));
        account.acceptOwnership();
        vm.prank(next);
        vm.expectEmit(address(account));
        emit IHoodArmAccount.OwnershipTransferred(owner, next);
        account.acceptOwnership();
        assertEq(account.owner(), next);
        assertEq(account.pendingOwner(), address(0));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(NotOwner.selector, owner));
        account.kill();
    }

    function test_cooldownRemainingIsZeroBeforeAnyTrade() public view {
        assertEq(account.cooldownRemaining(), 0);
    }
}

/// @dev A minimal factory with no attestations contract, to prove the oracle
///      gate fails closed when a policy asks for a score nobody can supply.
contract NoAttestationsFactory {
    address public immutable implementation;
    address public immutable weth;
    address public constant attestations = address(0);
    address public constant feeRecipient = address(1);

    constructor(address implementation_, address weth_) {
        implementation = implementation_;
        weth = weth_;
    }

    function create(address owner_, address operator_, Policy memory p) external returns (address clone) {
        bytes20 target = bytes20(implementation);
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000000000000000000000)
            mstore(add(ptr, 0x14), target)
            mstore(add(ptr, 0x28), 0x5af43d82803e903d91602b57fd5bf30000000000000000000000000000000000)
            clone := create(0, ptr, 0x37)
        }
        HoodArmAccount(payable(clone)).initialize(owner_, operator_, p, 0);
    }
}
