// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {HoodArmAccount} from "../src/HoodArmAccount.sol";
import {HoodArmFactory} from "../src/HoodArmFactory.sol";
import {IHoodArmFactory} from "../src/interfaces/IHoodArmFactory.sol";
import {Policy} from "../src/libraries/PolicyLib.sol";
import {
    FeeTooHigh,
    InvalidPolicy,
    KillSwitch,
    NothingPending,
    Timelocked,
    ZeroAddress
} from "../src/libraries/HoodErrors.sol";
import {HoodFixture} from "./utils/Fixture.sol";

contract HoodArmFactoryTest is HoodFixture {
    function test_constructorValidates() public {
        vm.expectRevert(ZeroAddress.selector);
        new HoodArmFactory(
            protocolOwner, address(0), address(attestations), address(weth), feeRecipient, 100, basePolicy
        );
        vm.expectRevert(ZeroAddress.selector);
        new HoodArmFactory(
            protocolOwner, address(implementation), address(attestations), address(0), feeRecipient, 100, basePolicy
        );
        vm.expectRevert(ZeroAddress.selector);
        new HoodArmFactory(
            protocolOwner, address(implementation), address(attestations), address(weth), address(0), 100, basePolicy
        );
        vm.expectRevert(abi.encodeWithSelector(FeeTooHigh.selector, 2_001, 2_000));
        new HoodArmFactory(
            protocolOwner,
            address(implementation),
            address(attestations),
            address(weth),
            feeRecipient,
            2_001,
            basePolicy
        );
        Policy memory bad = basePolicy;
        bad.quoteToken = address(0);
        vm.expectRevert(abi.encodeWithSelector(InvalidPolicy.selector, "quoteToken"));
        new HoodArmFactory(
            protocolOwner, address(implementation), address(attestations), address(weth), feeRecipient, 100, bad
        );
    }

    function test_constructorState() public view {
        assertEq(factory.owner(), protocolOwner);
        assertEq(factory.implementation(), address(implementation));
        assertEq(factory.attestations(), address(attestations));
        assertEq(factory.weth(), address(weth));
        assertEq(factory.feeRecipient(), feeRecipient);
        assertEq(factory.performanceFeeBps(), PROTOCOL_FEE_BPS);
        assertEq(factory.defaultPolicy().dailyBudgetWei, basePolicy.dailyBudgetWei);
        assertEq(factory.MAX_PERFORMANCE_FEE_BPS(), 2_000);
        assertEq(factory.FEE_TIMELOCK(), 24 hours);
    }

    function test_registryTracksAccounts() public {
        assertTrue(factory.isAccount(address(account)));
        assertFalse(factory.isAccount(stranger));
        assertEq(factory.accountCount(), 1);
        assertEq(factory.accountAt(0), address(account));
        address[] memory mine = factory.accountsOf(owner);
        assertEq(mine.length, 1);
        assertEq(mine[0], address(account));

        Policy memory custom = basePolicy;
        custom.maxOpenPositions = 5;
        vm.prank(owner);
        vm.expectEmit(true, false, true, true, address(factory));
        emit IHoodArmFactory.AccountCreated(owner, address(0), operator, custom);
        address second = factory.createAccount(operator, custom);
        assertEq(HoodArmAccount(payable(second)).policy().maxOpenPositions, 5);
        assertEq(factory.accountsOf(owner).length, 2);
        assertEq(factory.accountCount(), 2);
        assertEq(factory.accountsOf(stranger).length, 0);
    }

    function test_clonesAreIsolated() public {
        vm.prank(stranger);
        HoodArmAccount other = HoodArmAccount(payable(factory.createAccount(operator)));
        vm.deal(address(other), 1 ether);
        vm.prank(owner);
        account.kill();
        assertFalse(other.killed());
        uint256 min = requiredMin(address(weth), 0.05 ether);
        vm.prank(operator);
        other.buy(address(token), 0.05 ether, min, FEE, block.timestamp);
        assertEq(other.openPositionCount(), 1);
        assertEq(account.openPositionCount(), 0);
        buyExpecting(abi.encodeWithSelector(KillSwitch.selector), 0.05 ether);
        assertEq(other.owner(), stranger);
        assertEq(account.owner(), owner);
    }

    function test_setImplementationOnlyAffectsNewAccounts() public {
        HoodArmAccount next = new HoodArmAccount();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        factory.setImplementation(address(next));
        vm.prank(protocolOwner);
        vm.expectRevert(ZeroAddress.selector);
        factory.setImplementation(address(0));
        vm.prank(protocolOwner);
        vm.expectEmit(address(factory));
        emit IHoodArmFactory.ImplementationSet(address(implementation), address(next));
        factory.setImplementation(address(next));

        vm.prank(owner);
        address fresh = factory.createAccount(operator);
        assertEq(_cloneTarget(fresh), address(next));
        assertEq(_cloneTarget(address(account)), address(implementation));
        buy(0.05 ether);
    }

    function test_setDefaultPolicy() public {
        Policy memory p = basePolicy;
        p.cooldownSeconds = 120;
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        factory.setDefaultPolicy(p);
        vm.prank(protocolOwner);
        vm.expectEmit(address(factory));
        emit IHoodArmFactory.DefaultPolicySet(p);
        factory.setDefaultPolicy(p);
        vm.prank(owner);
        HoodArmAccount fresh = HoodArmAccount(payable(factory.createAccount(operator)));
        assertEq(fresh.policy().cooldownSeconds, 120);
        p.allowedRouter = address(0);
        vm.prank(protocolOwner);
        vm.expectRevert(abi.encodeWithSelector(InvalidPolicy.selector, "allowedRouter"));
        factory.setDefaultPolicy(p);
    }

    function test_feeChangeIsTimelockedAndSnapshotted() public {
        address treasury = makeAddr("treasury");
        vm.startPrank(protocolOwner);
        vm.expectRevert(abi.encodeWithSelector(FeeTooHigh.selector, 2_001, 2_000));
        factory.proposeFee(treasury, 2_001);
        vm.expectRevert(ZeroAddress.selector);
        factory.proposeFee(address(0), 100);
        vm.expectRevert(NothingPending.selector);
        factory.applyFee();
        vm.expectRevert(NothingPending.selector);
        factory.cancelFee();

        vm.expectEmit(address(factory));
        emit IHoodArmFactory.FeeProposed(treasury, 2_000, block.timestamp + 24 hours);
        factory.proposeFee(treasury, 2_000);
        (address pr, uint16 pb, uint256 at) = factory.pendingFee();
        assertEq(pr, treasury);
        assertEq(pb, 2_000);
        assertEq(at, block.timestamp + 24 hours);
        vm.expectRevert(abi.encodeWithSelector(Timelocked.selector, at));
        factory.applyFee();
        vm.warp(at);
        vm.expectEmit(address(factory));
        emit IHoodArmFactory.FeeApplied(treasury, 2_000);
        factory.applyFee();
        vm.stopPrank();

        assertEq(factory.feeRecipient(), treasury);
        assertEq(factory.performanceFeeBps(), 2_000);
        (pr, pb, at) = factory.pendingFee();
        assertEq(at, 0);
        assertEq(account.performanceFeeBps(), PROTOCOL_FEE_BPS);
        vm.prank(owner);
        HoodArmAccount fresh = HoodArmAccount(payable(factory.createAccount(operator)));
        assertEq(fresh.performanceFeeBps(), 2_000);

        uint256 got = buy(0.05 ether);
        setTokensPerWeth(500e18);
        sell(got);
        uint256 due = account.feesAccruedWei();
        account.claimFees();
        assertEq(weth.balanceOf(treasury), due);
    }

    function test_cancelFee() public {
        vm.startPrank(protocolOwner);
        factory.proposeFee(feeRecipient, 500);
        vm.expectEmit(address(factory));
        emit IHoodArmFactory.FeeCancelled();
        factory.cancelFee();
        (,, uint256 at) = factory.pendingFee();
        assertEq(at, 0);
        assertEq(factory.performanceFeeBps(), PROTOCOL_FEE_BPS);
        vm.stopPrank();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        factory.proposeFee(feeRecipient, 500);
    }

    function test_protocolOwnershipIsTwoStep() public {
        address next = makeAddr("nextProtocolOwner");
        vm.prank(protocolOwner);
        factory.transferOwnership(next);
        assertEq(factory.owner(), protocolOwner);
        vm.prank(next);
        factory.acceptOwnership();
        assertEq(factory.owner(), next);
    }

    /// @dev The implementation address an EIP-1167 clone delegates to sits at
    ///      bytes 10..30 of its runtime code.
    function _cloneTarget(address clone) private view returns (address target) {
        bytes memory code = clone.code;
        assertEq(code.length, 45);
        assembly {
            target := shr(96, mload(add(code, 0x2a)))
        }
    }
}
