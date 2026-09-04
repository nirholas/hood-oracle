// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IUniswapV3Factory, IUniswapV3Pool} from "../interfaces/IUniswapV3.sol";
import {NoPool, PoolNotInitialized} from "./HoodErrors.sol";

/// @title SpotPriceLib
/// @notice The slippage bound's reference price. The off-chain engine compares
///         its order's slippage against the arm's `slippageBps`; the chain has
///         no quote to compare against, so it reads the pool's spot price and
///         requires the caller's `amountOutMinimum` to sit within
///         `maxSlippageBps` of the fee-adjusted spot output. This is what stops
///         a leaked operator key from passing `amountOutMinimum = 0` and
///         handing the position to a sandwich.
library SpotPriceLib {
    uint256 internal constant Q96 = 2 ** 96;
    uint256 internal constant FEE_DENOMINATOR = 1_000_000;
    uint256 internal constant BPS = 10_000;

    /// @notice Resolve the pool for `tokenIn`/`tokenOut` at `fee` through the router's factory.
    function poolFor(address uniswapFactory, address tokenIn, address tokenOut, uint24 fee)
        internal
        view
        returns (address pool)
    {
        pool = IUniswapV3Factory(uniswapFactory).getPool(tokenIn, tokenOut, fee);
        if (pool == address(0)) revert NoPool(tokenIn, tokenOut, fee);
    }

    /// @notice Output the pool would give for `amountIn` at its current spot
    ///         price with the fee tier taken off and zero price impact.
    function expectedOut(address pool, address tokenIn, uint256 amountIn, uint24 fee)
        internal
        view
        returns (uint256 out)
    {
        (uint160 sqrtPriceX96,,,,,,) = IUniswapV3Pool(pool).slot0();
        if (sqrtPriceX96 == 0) revert PoolNotInitialized(pool);
        out = spotOut(sqrtPriceX96, IUniswapV3Pool(pool).token0() == tokenIn, amountIn);
        out = Math.mulDiv(out, FEE_DENOMINATOR - fee, FEE_DENOMINATOR);
    }

    /// @notice Pure spot conversion. token0 in: out = in * P; token1 in: out = in / P,
    ///         where P = (sqrtPriceX96 / 2^96)^2 is the token1-per-token0 price.
    function spotOut(uint160 sqrtPriceX96, bool zeroForOne, uint256 amountIn) internal pure returns (uint256) {
        if (zeroForOne) {
            return Math.mulDiv(Math.mulDiv(amountIn, sqrtPriceX96, Q96), sqrtPriceX96, Q96);
        }
        return Math.mulDiv(Math.mulDiv(amountIn, Q96, sqrtPriceX96), Q96, sqrtPriceX96);
    }

    /// @notice The smallest `amountOutMinimum` the policy accepts for `expected` output.
    function minimumOut(uint256 expected, uint16 maxSlippageBps) internal pure returns (uint256) {
        return Math.mulDiv(expected, BPS - maxSlippageBps, BPS);
    }
}
