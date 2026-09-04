// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title IHoodFeeSplitter
/// @notice Pull-payment splitter for protocol fees: fixed payees with fixed
///         shares, each pulls its own share of ETH and any ERC-20.
interface IHoodFeeSplitter {
    event PayeeAdded(address indexed payee, uint256 shares);
    event PaymentReceived(address indexed from, uint256 amount);
    event PaymentReleased(address indexed to, uint256 amount);
    event ERC20PaymentReleased(IERC20 indexed token, address indexed to, uint256 amount);

    function totalShares() external view returns (uint256);
    function totalReleased() external view returns (uint256);
    function totalReleased(IERC20 token) external view returns (uint256);
    function shares(address payee) external view returns (uint256);
    function released(address payee) external view returns (uint256);
    function released(IERC20 token, address payee) external view returns (uint256);
    function payee(uint256 index) external view returns (address);
    function payeeCount() external view returns (uint256);
    function releasable(address payee) external view returns (uint256);
    function releasable(IERC20 token, address payee) external view returns (uint256);

    function release(address payable payee) external;
    function release(IERC20 token, address payee) external;
}
