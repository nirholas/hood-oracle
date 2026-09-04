// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/// @title ISwapRouter02
/// @notice The subset of Uniswap's SwapRouter02 the arm uses. SwapRouter02's
///         `exactInputSingle` takes no deadline (deadlines ride on `multicall`),
///         so the account enforces the caller's deadline itself before calling.
///         Robinhood Chain mainnet: 0xCaf681a66D020601342297493863E78C959E5cb2.
interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    /// @notice Swaps `amountIn` of one token for as much as possible of another token.
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);

    /// @notice The Uniswap v3 factory this router swaps through (PeripheryImmutableState).
    function factory() external view returns (address);

    /// @notice The WETH9 this router wraps into (PeripheryImmutableState).
    function WETH9() external view returns (address);
}
