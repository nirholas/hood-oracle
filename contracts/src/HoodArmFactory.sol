// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IHoodArmAccount} from "./interfaces/IHoodArmAccount.sol";
import {IHoodArmFactory} from "./interfaces/IHoodArmFactory.sol";
import {Policy, PolicyLib} from "./libraries/PolicyLib.sol";
import {FeeTooHigh, NothingPending, Timelocked, ZeroAddress} from "./libraries/HoodErrors.sol";

/// @title HoodArmFactory
/// @notice Deploys HoodArmAccount clones, keeps the owner => accounts registry,
///         and holds the protocol-level settings: the fee recipient and
///         performance fee (24h timelock, 20% ceiling), the default policy
///         template, and the implementation new accounts clone.
///
///         Existing accounts are immutable. An EIP-1167 clone delegates to the
///         implementation address baked into its bytecode at creation, so
///         `setImplementation` changes what the NEXT account runs and nothing
///         about accounts already holding funds. That is the point: an owner
///         who audited the code their money sits behind never has that code
///         swapped out from under them by a protocol key. Each account also
///         snapshots its performance fee and attestations address at creation
///         for the same reason; only the fee recipient is read live, because
///         that is the protocol's own treasury.
contract HoodArmFactory is IHoodArmFactory, Ownable2Step {
    using PolicyLib for Policy;

    uint16 public constant MAX_PERFORMANCE_FEE_BPS = 2_000;
    uint256 public constant FEE_TIMELOCK = 24 hours;

    address public implementation;
    address public immutable attestations;
    address public immutable weth;
    address public feeRecipient;
    uint16 public performanceFeeBps;

    Policy private _defaultPolicy;
    address private _pendingFeeRecipient;
    uint16 private _pendingFeeBps;
    uint256 private _pendingFeeEffectiveAt;

    mapping(address account => bool) public isAccount;
    mapping(address owner => address[]) private _accountsOf;
    address[] private _accounts;

    constructor(
        address owner_,
        address implementation_,
        address attestations_,
        address weth_,
        address feeRecipient_,
        uint16 performanceFeeBps_,
        Policy memory defaultPolicy_
    ) Ownable(owner_) {
        if (implementation_ == address(0) || weth_ == address(0) || feeRecipient_ == address(0)) {
            revert ZeroAddress();
        }
        if (performanceFeeBps_ > MAX_PERFORMANCE_FEE_BPS) {
            revert FeeTooHigh(performanceFeeBps_, MAX_PERFORMANCE_FEE_BPS);
        }
        defaultPolicy_.validate();
        implementation = implementation_;
        attestations = attestations_;
        weth = weth_;
        feeRecipient = feeRecipient_;
        performanceFeeBps = performanceFeeBps_;
        _defaultPolicy = defaultPolicy_;
        emit ImplementationSet(address(0), implementation_);
        emit FeeApplied(feeRecipient_, performanceFeeBps_);
        emit DefaultPolicySet(defaultPolicy_);
    }

    // ── accounts ─────────────────────────────────────────────────────────────

    /// @inheritdoc IHoodArmFactory
    function createAccount(address operator) external returns (address account) {
        return _create(operator, _defaultPolicy);
    }

    /// @inheritdoc IHoodArmFactory
    function createAccount(address operator, Policy calldata policy) external returns (address account) {
        return _create(operator, policy);
    }

    function _create(address operator, Policy memory policy) private returns (address account) {
        account = Clones.clone(implementation);
        IHoodArmAccount(account).initialize(msg.sender, operator, policy, performanceFeeBps);
        isAccount[account] = true;
        _accountsOf[msg.sender].push(account);
        _accounts.push(account);
        emit AccountCreated(msg.sender, account, operator, policy);
    }

    // ── protocol settings ────────────────────────────────────────────────────

    /// @inheritdoc IHoodArmFactory
    function setImplementation(address implementation_) external onlyOwner {
        if (implementation_ == address(0)) revert ZeroAddress();
        emit ImplementationSet(implementation, implementation_);
        implementation = implementation_;
    }

    /// @inheritdoc IHoodArmFactory
    function setDefaultPolicy(Policy calldata policy) external onlyOwner {
        Policy memory p = policy;
        p.validate();
        _defaultPolicy = p;
        emit DefaultPolicySet(p);
    }

    /// @inheritdoc IHoodArmFactory
    function proposeFee(address feeRecipient_, uint16 performanceFeeBps_) external onlyOwner {
        if (feeRecipient_ == address(0)) revert ZeroAddress();
        if (performanceFeeBps_ > MAX_PERFORMANCE_FEE_BPS) {
            revert FeeTooHigh(performanceFeeBps_, MAX_PERFORMANCE_FEE_BPS);
        }
        _pendingFeeRecipient = feeRecipient_;
        _pendingFeeBps = performanceFeeBps_;
        _pendingFeeEffectiveAt = block.timestamp + FEE_TIMELOCK;
        emit FeeProposed(feeRecipient_, performanceFeeBps_, _pendingFeeEffectiveAt);
    }

    /// @inheritdoc IHoodArmFactory
    function applyFee() external onlyOwner {
        uint256 effectiveAt = _pendingFeeEffectiveAt;
        if (effectiveAt == 0) revert NothingPending();
        if (block.timestamp < effectiveAt) revert Timelocked(effectiveAt);
        feeRecipient = _pendingFeeRecipient;
        performanceFeeBps = _pendingFeeBps;
        emit FeeApplied(feeRecipient, performanceFeeBps);
        _clearPendingFee();
    }

    /// @inheritdoc IHoodArmFactory
    function cancelFee() external onlyOwner {
        if (_pendingFeeEffectiveAt == 0) revert NothingPending();
        _clearPendingFee();
        emit FeeCancelled();
    }

    function _clearPendingFee() private {
        _pendingFeeRecipient = address(0);
        _pendingFeeBps = 0;
        _pendingFeeEffectiveAt = 0;
    }

    // ── views ────────────────────────────────────────────────────────────────

    /// @inheritdoc IHoodArmFactory
    function defaultPolicy() external view returns (Policy memory) {
        return _defaultPolicy;
    }

    /// @inheritdoc IHoodArmFactory
    function pendingFee() external view returns (address, uint16, uint256) {
        return (_pendingFeeRecipient, _pendingFeeBps, _pendingFeeEffectiveAt);
    }

    /// @inheritdoc IHoodArmFactory
    function accountsOf(address owner_) external view returns (address[] memory) {
        return _accountsOf[owner_];
    }

    /// @inheritdoc IHoodArmFactory
    function accountCount() external view returns (uint256) {
        return _accounts.length;
    }

    /// @inheritdoc IHoodArmFactory
    function accountAt(uint256 index) external view returns (address) {
        return _accounts[index];
    }
}
