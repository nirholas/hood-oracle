// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Policy} from "../libraries/PolicyLib.sol";

/// @title IHoodArmFactory
/// @notice Creates arm accounts as EIP-1167 clones, keeps the owner => accounts
///         registry, and holds the protocol fee settings and the default policy
///         template new accounts start from.
interface IHoodArmFactory {
    event AccountCreated(address indexed owner, address indexed account, address indexed operator, Policy policy);
    event ImplementationSet(address indexed previous, address indexed implementation);
    event DefaultPolicySet(Policy policy);
    event FeeProposed(address indexed feeRecipient, uint16 performanceFeeBps, uint256 effectiveAt);
    event FeeApplied(address indexed feeRecipient, uint16 performanceFeeBps);
    event FeeCancelled();

    function implementation() external view returns (address);
    function attestations() external view returns (address);
    function weth() external view returns (address);
    function feeRecipient() external view returns (address);
    function performanceFeeBps() external view returns (uint16);
    function defaultPolicy() external view returns (Policy memory);
    function pendingFee() external view returns (address feeRecipient, uint16 performanceFeeBps, uint256 effectiveAt);
    function isAccount(address account) external view returns (bool);
    function accountsOf(address owner) external view returns (address[] memory);
    function accountCount() external view returns (uint256);
    function accountAt(uint256 index) external view returns (address);

    /// @notice Create an account for `msg.sender` with the factory's default policy.
    function createAccount(address operator) external returns (address account);
    /// @notice Create an account for `msg.sender` with an explicit policy.
    function createAccount(address operator, Policy calldata policy) external returns (address account);

    function setImplementation(address implementation_) external;
    function setDefaultPolicy(Policy calldata policy) external;
    function proposeFee(address feeRecipient_, uint16 performanceFeeBps_) external;
    function applyFee() external;
    function cancelFee() external;
}
