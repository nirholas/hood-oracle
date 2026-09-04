// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {HoodArmAccount} from "../../src/HoodArmAccount.sol";
import {HoodArmFactory} from "../../src/HoodArmFactory.sol";
import {HoodOracleAttestations} from "../../src/HoodOracleAttestations.sol";
import {IHoodOracleAttestations} from "../../src/interfaces/IHoodOracleAttestations.sol";
import {Policy} from "../../src/libraries/PolicyLib.sol";
import {SpotPriceLib} from "../../src/libraries/SpotPriceLib.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockWETH9} from "../mocks/MockWETH9.sol";
import {MockPool, MockRouter, MockUniswapV3Factory} from "../mocks/MockUniswap.sol";

/// @dev Shared world for the unit tests: a mock WETH, a launch token, a
///      constant-price pool between them, a router that fills at that price,
///      the attestations contract with a known signer key, and one arm
///      account funded with 10 ETH.
abstract contract HoodFixture is Test {
    uint24 internal constant FEE = 10_000;
    uint16 internal constant PROTOCOL_FEE_BPS = 1_000;
    uint256 internal constant START = 1_760_000_000;

    address internal protocolOwner = makeAddr("protocolOwner");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal owner = makeAddr("owner");
    address internal operator = makeAddr("operator");
    address internal stranger = makeAddr("stranger");
    uint256 internal signerKey = 0xA11CE;
    address internal signer = vm.addr(signerKey);

    MockWETH9 internal weth;
    MockERC20 internal token;
    MockUniswapV3Factory internal uniFactory;
    MockPool internal pool;
    MockRouter internal router;
    HoodOracleAttestations internal attestations;
    HoodArmAccount internal implementation;
    HoodArmFactory internal factory;
    HoodArmAccount internal account;
    Policy internal basePolicy;

    function setUp() public virtual {
        vm.warp(START);
        weth = new MockWETH9();
        token = new MockERC20("Launch", "LNCH", 18);
        uniFactory = new MockUniswapV3Factory();
        pool = MockPool(uniFactory.createPool(address(weth), address(token), FEE, sqrtPriceFor(1_000e18, 1e18)));
        router = new MockRouter(address(uniFactory), address(weth));
        attestations = new HoodOracleAttestations(protocolOwner, signer);
        implementation = new HoodArmAccount();
        basePolicy = Policy({
            perTradeCapWei: 0.1 ether,
            dailyBudgetWei: 0.25 ether,
            maxOpenPositions: 2,
            maxSlippageBps: 500,
            cooldownSeconds: 30,
            maxHoldSecondsHint: 3_600,
            minOracleScore: 0,
            allowedRouter: address(router),
            quoteToken: address(weth)
        });
        factory = new HoodArmFactory(
            protocolOwner,
            address(implementation),
            address(attestations),
            address(weth),
            feeRecipient,
            PROTOCOL_FEE_BPS,
            basePolicy
        );
        vm.prank(owner);
        account = HoodArmAccount(payable(factory.createAccount(operator)));
        vm.deal(address(account), 10 ether);
        // The router pays sells out of its own WETH, so give it a float.
        vm.deal(address(router), 1_000 ether);
        vm.prank(address(router));
        weth.deposit{value: 1_000 ether}();
    }

    // ── price helpers ────────────────────────────────────────────────────────

    /// @dev sqrtPriceX96 for `tokenUnits` of the launch token per `wethUnits` of WETH,
    ///      honoring the pool's token ordering.
    function sqrtPriceFor(uint256 tokenUnits, uint256 wethUnits) internal view returns (uint160) {
        (uint256 amount1, uint256 amount0) =
            address(weth) < address(token) ? (tokenUnits, wethUnits) : (wethUnits, tokenUnits);
        return uint160(Math.sqrt(Math.mulDiv(amount1, 2 ** 192, amount0)));
    }

    function setTokensPerWeth(uint256 tokenUnits) internal {
        pool.setSqrtPriceX96(sqrtPriceFor(tokenUnits, 1e18));
    }

    /// @dev The exact `amountOutMinimum` floor the account will require.
    function requiredMin(address tokenIn, uint256 amountIn) internal view returns (uint256) {
        uint256 expected = SpotPriceLib.expectedOut(address(pool), tokenIn, amountIn, FEE);
        return SpotPriceLib.minimumOut(expected, account.policy().maxSlippageBps);
    }

    // ── trade helpers ────────────────────────────────────────────────────────
    // Every helper computes its minimum before pranking: `requiredMin` makes
    // external calls, and a prank or expectRevert binds to the next call.

    function buyAs(address who, uint256 amountIn) internal returns (uint256) {
        uint256 min = requiredMin(address(weth), amountIn);
        vm.prank(who);
        return account.buy(address(token), amountIn, min, FEE, block.timestamp);
    }

    function buy(uint256 amountIn) internal returns (uint256) {
        return buyAs(operator, amountIn);
    }

    /// @dev A buy by `who` that must revert with exactly `revertData`.
    function buyExpecting(bytes memory revertData, address who, uint256 amountIn) internal {
        uint256 min = requiredMin(address(weth), amountIn);
        vm.prank(who);
        vm.expectRevert(revertData);
        account.buy(address(token), amountIn, min, FEE, block.timestamp);
    }

    function buyExpecting(bytes memory revertData, uint256 amountIn) internal {
        buyExpecting(revertData, operator, amountIn);
    }

    function sellAs(address who, uint256 amountIn) internal returns (uint256) {
        uint256 min = requiredMin(address(token), amountIn);
        vm.prank(who);
        return account.sell(address(token), amountIn, min, FEE, block.timestamp);
    }

    function sell(uint256 amountIn) internal returns (uint256) {
        return sellAs(operator, amountIn);
    }

    function sellExpecting(bytes memory revertData, address who, uint256 amountIn) internal {
        uint256 min = requiredMin(address(token), amountIn);
        vm.prank(who);
        vm.expectRevert(revertData);
        account.sell(address(token), amountIn, min, FEE, block.timestamp);
    }

    /// @dev The account's minimum for a buy of `tokenOut` through an arbitrary mock pool.
    function requiredMinFor(address pool_, address tokenIn, uint256 amountIn) internal view returns (uint256) {
        uint256 expected = SpotPriceLib.expectedOut(pool_, tokenIn, amountIn, FEE);
        return SpotPriceLib.minimumOut(expected, account.policy().maxSlippageBps);
    }

    function skipCooldown() internal {
        vm.warp(block.timestamp + basePolicy.cooldownSeconds);
    }

    // ── attestation helpers ──────────────────────────────────────────────────

    function attestation(address token_, uint8 score, uint64 ttl)
        internal
        view
        returns (IHoodOracleAttestations.Attestation memory)
    {
        return IHoodOracleAttestations.Attestation({
            token: token_,
            score: score,
            tier: IHoodOracleAttestations.Tier.Strong,
            rugRiskBps: 1_200,
            modelVersion: 7,
            observedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp) + ttl
        });
    }

    function sign(uint256 key, IHoodOracleAttestations.Attestation memory a) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, attestations.digest(a));
        return abi.encodePacked(r, s, v);
    }

    function post(IHoodOracleAttestations.Attestation memory a) internal {
        attestations.post(a, sign(signerKey, a));
    }
}
