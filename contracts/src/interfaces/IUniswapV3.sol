// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/// @title IUniswapV3Factory
/// @notice Pool lookup. Robinhood Chain mainnet: 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA.
interface IUniswapV3Factory {
    /// @notice The pool for a pair at a fee tier, or the zero address if none exists.
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

/// @title IUniswapV3Pool
/// @notice The pool reads the slippage bound needs: the current price and token ordering.
interface IUniswapV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );
}
