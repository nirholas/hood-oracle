// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {HoodFeeSplitter} from "../src/HoodFeeSplitter.sol";
import {IHoodFeeSplitter} from "../src/interfaces/IHoodFeeSplitter.sol";
import {DuplicatePayee, NoShares, NothingDue, PayeesMismatch, ZeroAddress, ZeroAmount} from "../src/libraries/HoodErrors.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract HoodFeeSplitterTest is Test {
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    HoodFeeSplitter internal splitter;
    MockERC20 internal usd;

    function setUp() public {
        address[] memory payees = new address[](2);
        payees[0] = alice;
        payees[1] = bob;
        uint256[] memory shares = new uint256[](2);
        shares[0] = 3;
        shares[1] = 1;
        splitter = new HoodFeeSplitter(payees, shares);
        usd = new MockERC20("USD", "USD", 6);
    }

    function test_constructorValidates() public {
        address[] memory payees = new address[](1);
        uint256[] memory shares = new uint256[](2);
        vm.expectRevert(PayeesMismatch.selector);
        new HoodFeeSplitter(payees, shares);
        vm.expectRevert(PayeesMismatch.selector);
        new HoodFeeSplitter(new address[](0), new uint256[](0));
        shares = new uint256[](1);
        shares[0] = 1;
        vm.expectRevert(ZeroAddress.selector);
        new HoodFeeSplitter(payees, shares);
        payees[0] = alice;
        shares[0] = 0;
        vm.expectRevert(ZeroAmount.selector);
        new HoodFeeSplitter(payees, shares);
        address[] memory dup = new address[](2);
        dup[0] = alice;
        dup[1] = alice;
        uint256[] memory dupShares = new uint256[](2);
        dupShares[0] = 1;
        dupShares[1] = 1;
        vm.expectRevert(abi.encodeWithSelector(DuplicatePayee.selector, alice));
        new HoodFeeSplitter(dup, dupShares);
    }

    function test_views() public view {
        assertEq(splitter.totalShares(), 4);
        assertEq(splitter.shares(alice), 3);
        assertEq(splitter.shares(bob), 1);
        assertEq(splitter.payee(0), alice);
        assertEq(splitter.payee(1), bob);
        assertEq(splitter.payeeCount(), 2);
        assertEq(splitter.totalReleased(), 0);
        assertEq(splitter.totalReleased(IERC20(address(usd))), 0);
        assertEq(splitter.releasable(alice), 0);
    }

    function test_ethSplitsByShares() public {
        vm.deal(address(this), 8 ether);
        vm.expectEmit(address(splitter));
        emit IHoodFeeSplitter.PaymentReceived(address(this), 8 ether);
        (bool ok,) = address(splitter).call{value: 8 ether}("");
        assertTrue(ok);
        assertEq(splitter.releasable(alice), 6 ether);
        assertEq(splitter.releasable(bob), 2 ether);

        vm.expectEmit(address(splitter));
        emit IHoodFeeSplitter.PaymentReleased(alice, 6 ether);
        splitter.release(payable(alice));
        assertEq(alice.balance, 6 ether);
        assertEq(splitter.released(alice), 6 ether);
        assertEq(splitter.totalReleased(), 6 ether);
        assertEq(splitter.releasable(alice), 0);
        vm.expectRevert(abi.encodeWithSelector(NothingDue.selector, alice));
        splitter.release(payable(alice));

        vm.deal(address(this), 4 ether);
        (ok,) = address(splitter).call{value: 4 ether}("");
        assertTrue(ok);
        assertEq(splitter.releasable(alice), 3 ether);
        assertEq(splitter.releasable(bob), 3 ether);
        splitter.release(payable(bob));
        assertEq(bob.balance, 3 ether);
        splitter.release(payable(alice));
        assertEq(alice.balance, 9 ether);
        assertEq(address(splitter).balance, 0);
    }

    function test_erc20SplitsByShares() public {
        usd.mint(address(splitter), 400e6);
        assertEq(splitter.releasable(IERC20(address(usd)), alice), 300e6);
        assertEq(splitter.releasable(IERC20(address(usd)), bob), 100e6);
        vm.expectEmit(address(splitter));
        emit IHoodFeeSplitter.ERC20PaymentReleased(IERC20(address(usd)), bob, 100e6);
        splitter.release(IERC20(address(usd)), bob);
        assertEq(usd.balanceOf(bob), 100e6);
        assertEq(splitter.released(IERC20(address(usd)), bob), 100e6);
        assertEq(splitter.totalReleased(IERC20(address(usd))), 100e6);
        vm.expectRevert(abi.encodeWithSelector(NothingDue.selector, bob));
        splitter.release(IERC20(address(usd)), bob);
        usd.mint(address(splitter), 40e6);
        splitter.release(IERC20(address(usd)), alice);
        assertEq(usd.balanceOf(alice), 330e6);
        splitter.release(IERC20(address(usd)), bob);
        assertEq(usd.balanceOf(bob), 110e6);
        assertEq(usd.balanceOf(address(splitter)), 0);
    }

    function test_nonPayeeCannotRelease() public {
        vm.deal(address(splitter), 1 ether);
        vm.expectRevert(abi.encodeWithSelector(NoShares.selector, carol));
        splitter.release(payable(carol));
        vm.expectRevert(abi.encodeWithSelector(NoShares.selector, carol));
        splitter.release(IERC20(address(usd)), carol);
    }

    function testFuzz_releasesNeverExceedShare(uint96 first, uint96 second) public {
        vm.deal(address(splitter), uint256(first) + second);
        if (splitter.releasable(alice) != 0) splitter.release(payable(alice));
        if (splitter.releasable(bob) != 0) splitter.release(payable(bob));
        uint256 total = uint256(first) + second;
        assertEq(alice.balance, (total * 3) / 4);
        assertEq(bob.balance, total / 4);
        assertLe(alice.balance + bob.balance, total);
    }
}
