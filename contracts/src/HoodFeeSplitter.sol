// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IHoodFeeSplitter} from "./interfaces/IHoodFeeSplitter.sol";
import {DuplicatePayee, NoShares, NothingDue, PayeesMismatch, ZeroAddress, ZeroAmount} from "./libraries/HoodErrors.sol";

/// @title HoodFeeSplitter
/// @notice Pull-payment splitter for protocol fees. The payee set and shares
///         are fixed at construction; each payee pulls its own share of the
///         ETH and any ERC-20 the splitter has ever received, in proportion to
///         `shares[payee] / totalShares`. Follows the audited PaymentSplitter
///         pattern OpenZeppelin shipped through v4 (removed in v5), with custom
///         errors and a reentrancy guard on release.
contract HoodFeeSplitter is IHoodFeeSplitter, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 private _totalShares;
    uint256 private _totalReleased;
    mapping(address payee => uint256) private _shares;
    mapping(address payee => uint256) private _released;
    address[] private _payees;

    mapping(IERC20 token => uint256) private _erc20TotalReleased;
    mapping(IERC20 token => mapping(address payee => uint256)) private _erc20Released;

    constructor(address[] memory payees_, uint256[] memory shares_) {
        if (payees_.length == 0 || payees_.length != shares_.length) revert PayeesMismatch();
        for (uint256 i = 0; i < payees_.length; i++) {
            _addPayee(payees_[i], shares_[i]);
        }
    }

    /// @notice Accept ETH fees.
    receive() external payable {
        emit PaymentReceived(msg.sender, msg.value);
    }

    // ── views ────────────────────────────────────────────────────────────────

    /// @inheritdoc IHoodFeeSplitter
    function totalShares() external view returns (uint256) {
        return _totalShares;
    }

    /// @inheritdoc IHoodFeeSplitter
    function totalReleased() external view returns (uint256) {
        return _totalReleased;
    }

    /// @inheritdoc IHoodFeeSplitter
    function totalReleased(IERC20 token) external view returns (uint256) {
        return _erc20TotalReleased[token];
    }

    /// @inheritdoc IHoodFeeSplitter
    function shares(address payee_) external view returns (uint256) {
        return _shares[payee_];
    }

    /// @inheritdoc IHoodFeeSplitter
    function released(address payee_) external view returns (uint256) {
        return _released[payee_];
    }

    /// @inheritdoc IHoodFeeSplitter
    function released(IERC20 token, address payee_) external view returns (uint256) {
        return _erc20Released[token][payee_];
    }

    /// @inheritdoc IHoodFeeSplitter
    function payee(uint256 index) external view returns (address) {
        return _payees[index];
    }

    /// @inheritdoc IHoodFeeSplitter
    function payeeCount() external view returns (uint256) {
        return _payees.length;
    }

    /// @inheritdoc IHoodFeeSplitter
    function releasable(address payee_) public view returns (uint256) {
        uint256 totalReceived = address(this).balance + _totalReleased;
        return _pendingPayment(payee_, totalReceived, _released[payee_]);
    }

    /// @inheritdoc IHoodFeeSplitter
    function releasable(IERC20 token, address payee_) public view returns (uint256) {
        uint256 totalReceived = token.balanceOf(address(this)) + _erc20TotalReleased[token];
        return _pendingPayment(payee_, totalReceived, _erc20Released[token][payee_]);
    }

    // ── release ──────────────────────────────────────────────────────────────

    /// @inheritdoc IHoodFeeSplitter
    function release(address payable payee_) external nonReentrant {
        if (_shares[payee_] == 0) revert NoShares(payee_);
        uint256 payment = releasable(payee_);
        if (payment == 0) revert NothingDue(payee_);
        _totalReleased += payment;
        unchecked {
            _released[payee_] += payment;
        }
        Address.sendValue(payee_, payment);
        emit PaymentReleased(payee_, payment);
    }

    /// @inheritdoc IHoodFeeSplitter
    function release(IERC20 token, address payee_) external nonReentrant {
        if (_shares[payee_] == 0) revert NoShares(payee_);
        uint256 payment = releasable(token, payee_);
        if (payment == 0) revert NothingDue(payee_);
        _erc20TotalReleased[token] += payment;
        unchecked {
            _erc20Released[token][payee_] += payment;
        }
        token.safeTransfer(payee_, payment);
        emit ERC20PaymentReleased(token, payee_, payment);
    }

    // ── internals ────────────────────────────────────────────────────────────

    function _pendingPayment(address payee_, uint256 totalReceived, uint256 alreadyReleased)
        private
        view
        returns (uint256)
    {
        return (totalReceived * _shares[payee_]) / _totalShares - alreadyReleased;
    }

    function _addPayee(address payee_, uint256 shares_) private {
        if (payee_ == address(0)) revert ZeroAddress();
        if (shares_ == 0) revert ZeroAmount();
        if (_shares[payee_] != 0) revert DuplicatePayee(payee_);
        _payees.push(payee_);
        _shares[payee_] = shares_;
        _totalShares += shares_;
        emit PayeeAdded(payee_, shares_);
    }
}
