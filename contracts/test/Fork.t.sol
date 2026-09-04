// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {HoodArmAccount} from "../src/HoodArmAccount.sol";
import {HoodArmFactory} from "../src/HoodArmFactory.sol";
import {HoodOracleAttestations} from "../src/HoodOracleAttestations.sol";
import {IHoodArmAccount} from "../src/interfaces/IHoodArmAccount.sol";
import {ISwapRouter02} from "../src/interfaces/ISwapRouter02.sol";
import {IUniswapV3Factory, IUniswapV3Pool} from "../src/interfaces/IUniswapV3.sol";
import {IWETH9} from "../src/interfaces/IWETH9.sol";
import {Policy} from "../src/libraries/PolicyLib.sol";
import {SpotPriceLib} from "../src/libraries/SpotPriceLib.sol";
import {KillSwitch, SlippageBound} from "../src/libraries/HoodErrors.sol";

/// @dev Uniswap QuoterV2. Not a view: it simulates the swap and reverts inside
///      the pool callback to read the result, which is fine from a test.
interface IQuoterV2 {
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams memory params)
        external
        returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate);
}

/// @title HoodArmForkTest
/// @notice Runs against a fork of Robinhood Chain mainnet (4663): the real
///         SwapRouter02, QuoterV2, WETH and USDG, and the live WETH/USDG 0.05%
///         pool. `forge test --fork-url robinhood --match-contract Fork`, or
///         plain `forge test`, which forks on its own when it is not already
///         on 4663. The `ci` profile excludes it.
contract HoodArmForkTest is Test {
    uint256 internal constant CHAIN_ID = 4663;
    address internal constant ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address internal constant QUOTER = 0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7;
    address internal constant UNI_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    uint24 internal constant FEE = 500;
    uint16 internal constant PROTOCOL_FEE_BPS = 1_000;

    address internal protocolOwner = makeAddr("protocolOwner");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal owner = makeAddr("owner");
    address internal operator = makeAddr("operator");
    address internal whale = makeAddr("whale");

    HoodArmFactory internal factory;
    HoodArmAccount internal account;
    Policy internal policy;

    function setUp() public {
        if (block.chainid != CHAIN_ID) vm.createSelectFork("robinhood");
        assertEq(block.chainid, CHAIN_ID);
        assertEq(ISwapRouter02(ROUTER).WETH9(), WETH);
        assertEq(ISwapRouter02(ROUTER).factory(), UNI_FACTORY);
        assertTrue(IUniswapV3Factory(UNI_FACTORY).getPool(WETH, USDG, FEE) != address(0));

        HoodOracleAttestations attestations = new HoodOracleAttestations(protocolOwner, vm.addr(0xA11CE));
        HoodArmAccount implementation = new HoodArmAccount();
        policy = Policy({
            perTradeCapWei: 0.05 ether,
            dailyBudgetWei: 0.1 ether,
            maxOpenPositions: 2,
            maxSlippageBps: 300,
            cooldownSeconds: 0,
            maxHoldSecondsHint: 3_600,
            minOracleScore: 0,
            allowedRouter: ROUTER,
            quoteToken: WETH
        });
        factory = new HoodArmFactory(
            protocolOwner, address(implementation), address(attestations), WETH, feeRecipient, PROTOCOL_FEE_BPS, policy
        );
        vm.prank(owner);
        account = HoodArmAccount(payable(factory.createAccount(operator)));
        vm.deal(address(account), 1 ether);
    }

    function _quote(address tokenIn, address tokenOut, uint256 amountIn) internal returns (uint256 out) {
        (out,,,) = IQuoterV2(QUOTER).quoteExactInputSingle(
            IQuoterV2.QuoteExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                amountIn: amountIn,
                fee: FEE,
                sqrtPriceLimitX96: 0
            })
        );
    }

    /// @dev 1% under the live quote: inside the 3% policy bound and above real impact for this size.
    function _minOut(address tokenIn, address tokenOut, uint256 amountIn) internal returns (uint256) {
        return (_quote(tokenIn, tokenOut, amountIn) * 99) / 100;
    }

    function test_buyUsdgWithWethThroughRealRouterThenSellBack() public {
        uint256 amountIn = 0.01 ether;
        uint256 minOut = _minOut(WETH, USDG, amountIn);
        assertGt(minOut, 0);

        vm.expectEmit(true, false, false, false, address(account));
        emit IHoodArmAccount.Buy(USDG, amountIn, 0, FEE, 0, 0);
        vm.prank(operator);
        uint256 got = account.buy(USDG, amountIn, minOut, FEE, block.timestamp + 120);

        assertGe(got, minOut);
        assertEq(IERC20(USDG).balanceOf(address(account)), got);
        assertEq(IERC20(WETH).balanceOf(address(account)), 0);
        assertEq(address(account).balance, 1 ether - amountIn);
        assertEq(IERC20(WETH).allowance(address(account), ROUTER), 0);
        IHoodArmAccount.Position memory pos = account.position(USDG);
        assertEq(pos.tokenAmount, got);
        assertEq(pos.costBasisWei, amountIn);
        assertEq(account.openPositionCount(), 1);
        assertEq(account.spentTodayWei(), amountIn);

        uint256 sellMin = _minOut(USDG, WETH, got);
        vm.expectEmit(true, false, false, false, address(account));
        emit IHoodArmAccount.Sell(USDG, got, 0, FEE, 0, 0, operator);
        vm.expectEmit(true, false, false, false, address(account));
        emit IHoodArmAccount.PositionClosed(USDG, 0);
        vm.prank(operator);
        uint256 proceeds = account.sell(USDG, got, sellMin, FEE, block.timestamp + 120);

        assertGe(proceeds, sellMin);
        assertLt(proceeds, amountIn);
        assertEq(IERC20(WETH).balanceOf(address(account)), proceeds);
        assertEq(IERC20(USDG).balanceOf(address(account)), 0);
        assertEq(IERC20(USDG).allowance(address(account), ROUTER), 0);
        assertEq(account.openPositionCount(), 0);
        assertEq(account.feesAccruedWei(), 0);
    }

    function test_sellAtProfitAccruesFeeAgainstLivePool() public {
        uint256 amountIn = 0.05 ether;
        uint256 minOut = _minOut(WETH, USDG, amountIn);
        vm.prank(operator);
        uint256 got = account.buy(USDG, amountIn, minOut, FEE, block.timestamp + 120);

        vm.deal(whale, 400 ether);
        vm.startPrank(whale);
        IWETH9(WETH).deposit{value: 400 ether}();
        IERC20(WETH).approve(ROUTER, 400 ether);
        ISwapRouter02(ROUTER).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: WETH,
                tokenOut: USDG,
                fee: FEE,
                recipient: whale,
                amountIn: 400 ether,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
        vm.stopPrank();

        uint256 sellMin = _minOut(USDG, WETH, got);
        assertGt(sellMin, amountIn);
        vm.prank(operator);
        uint256 proceeds = account.sell(USDG, got, sellMin, FEE, block.timestamp + 120);
        uint256 profit = proceeds - amountIn;
        uint256 expectedFee = (profit * PROTOCOL_FEE_BPS) / 10_000;
        assertEq(account.feesAccruedWei(), expectedFee);
        assertEq(account.withdrawableQuoteWei(), proceeds - expectedFee);

        uint256 paid = account.claimFees();
        assertEq(paid, expectedFee);
        assertEq(IERC20(WETH).balanceOf(feeRecipient), expectedFee);
        assertEq(account.feesAccruedWei(), 0);
    }

    function test_slippageBoundHoldsAgainstLivePool() public {
        uint256 amountIn = 0.01 ether;
        address pool = IUniswapV3Factory(UNI_FACTORY).getPool(WETH, USDG, FEE);
        uint256 expected = SpotPriceLib.expectedOut(pool, WETH, amountIn, FEE);
        uint256 required = SpotPriceLib.minimumOut(expected, policy.maxSlippageBps);
        uint256 quoted = _quote(WETH, USDG, amountIn);
        assertLe(required, quoted);
        assertGt(required, (quoted * 96) / 100);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(SlippageBound.selector, 0, required));
        account.buy(USDG, amountIn, 0, FEE, block.timestamp + 120);
    }

    function test_killBlocksBuysButOwnerStillWithdraws() public {
        vm.prank(owner);
        account.kill();
        vm.prank(operator);
        vm.expectRevert(KillSwitch.selector);
        account.buy(USDG, 0.01 ether, 0, FEE, block.timestamp + 120);
        vm.prank(owner);
        account.ownerWithdraw(address(0), 1 ether, owner);
        assertEq(owner.balance, 1 ether);
    }

    function test_livePoolReadsMatchSpotMaths() public view {
        address pool = IUniswapV3Factory(UNI_FACTORY).getPool(WETH, USDG, FEE);
        (uint160 sqrtP,,,,,,) = IUniswapV3Pool(pool).slot0();
        assertGt(sqrtP, 0);
        uint256 usdgPerEth = SpotPriceLib.spotOut(sqrtP, IUniswapV3Pool(pool).token0() == WETH, 1 ether);
        assertGt(usdgPerEth, 100e6);
        assertLt(usdgPerEth, 100_000e6);
    }
}
