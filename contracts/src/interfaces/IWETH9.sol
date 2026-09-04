// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title IWETH9
/// @notice Wrapped ETH. Robinhood Chain mainnet: 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73.
interface IWETH9 is IERC20 {
    /// @notice Wrap `msg.value` of native ETH into WETH for the caller.
    function deposit() external payable;

    /// @notice Unwrap `wad` WETH back into native ETH for the caller.
    function withdraw(uint256 wad) external;
}
