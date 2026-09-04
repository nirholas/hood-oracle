// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ISwapRouter02} from "../../src/interfaces/ISwapRouter02.sol";
import {IUniswapV3Factory, IUniswapV3Pool} from "../../src/interfaces/IUniswapV3.sol";
import {MockERC20} from "./MockERC20.sol";

/// @dev A constant-price "pool" that only answers the reads the slippage bound
///      needs. `sqrtPriceX96` is set by the test; there is no liquidity maths.
contract MockPool is IUniswapV3Pool {
    address public immutable token0;
    address public immutable token1;
    uint160 public sqrtPriceX96;

    constructor(address a, address b, uint160 sqrtPriceX96_) {
        (token0, token1) = a < b ? (a, b) : (b, a);
        sqrtPriceX96 = sqrtPriceX96_;
    }

    function setSqrtPriceX96(uint160 v) external {
        sqrtPriceX96 = v;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (sqrtPriceX96, 0, 0, 1, 1, 0, true);
    }
}

/// @dev Registry of MockPools keyed like the real factory.
contract MockUniswapV3Factory is IUniswapV3Factory {
    mapping(address => mapping(address => mapping(uint24 => address))) private _pools;

    function createPool(address a, address b, uint24 fee, uint160 sqrtPriceX96) external returns (address pool) {
        pool = address(new MockPool(a, b, sqrtPriceX96));
        _pools[a][b][fee] = pool;
        _pools[b][a][fee] = pool;
    }

    function getPool(address a, address b, uint24 fee) external view returns (address) {
        return _pools[a][b][fee];
    }
}

/// @dev Executes swaps at the pool's spot price minus the fee tier, with an
///      optional extra `impactBps` the test can dial in to simulate price
///      impact or an adversarial fill. Mints the output token to the recipient
///      when it is a MockERC20 it can mint, else pays from its own balance.
contract MockRouter is ISwapRouter02 {
    using SafeERC20 for IERC20;

    uint256 private constant Q96 = 2 ** 96;

    address public immutable override factory;
    address public immutable override WETH9;
    uint256 public impactBps;
    bool public consumeAllowance = true;
    uint256 public lastAmountIn;

    constructor(address factory_, address weth_) {
        factory = factory_;
        WETH9 = weth_;
    }

    function setImpactBps(uint256 bps) external {
        impactBps = bps;
    }

    /// @dev When false the router leaves the arm's approval in place after the
    ///      swap, so the test can prove the arm clears any standing allowance.
    function setConsumeAllowance(bool v) external {
        consumeAllowance = v;
    }

    function quote(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn) public view returns (uint256 out) {
        MockPool pool = MockPool(IUniswapV3Factory(factory).getPool(tokenIn, tokenOut, fee));
        uint160 sqrtP = pool.sqrtPriceX96();
        if (pool.token0() == tokenIn) {
            out = Math.mulDiv(Math.mulDiv(amountIn, sqrtP, Q96), sqrtP, Q96);
        } else {
            out = Math.mulDiv(Math.mulDiv(amountIn, Q96, sqrtP), Q96, sqrtP);
        }
        out = Math.mulDiv(out, 1_000_000 - fee, 1_000_000);
        out = Math.mulDiv(out, 10_000 - impactBps, 10_000);
    }

    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256 amountOut) {
        amountOut = quote(p.tokenIn, p.tokenOut, p.fee, p.amountIn);
        require(amountOut >= p.amountOutMinimum, "Too little received");
        lastAmountIn = p.amountIn;
        if (consumeAllowance) {
            IERC20(p.tokenIn).safeTransferFrom(msg.sender, address(this), p.amountIn);
        }
        _pay(p.tokenOut, p.recipient, amountOut);
    }

    function _pay(address token, address to, uint256 amount) private {
        if (IERC20(token).balanceOf(address(this)) >= amount) {
            IERC20(token).safeTransfer(to, amount);
        } else {
            MockERC20(token).mint(to, amount);
        }
    }
}
