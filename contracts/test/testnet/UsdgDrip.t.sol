// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {TestUSDG} from "../../src/testnet/TestUSDG.sol";
import {UsdgDrip} from "../../src/testnet/UsdgDrip.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Test} from "forge-std/Test.sol";

contract UsdgDripTest is Test {
    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    TestUSDG internal usdg;
    UsdgDrip internal drip;

    event Dripped(address indexed to, uint256 amount);
    event Refilled(address indexed from, uint256 amount);
    event Swept(address indexed to, uint256 amount);

    function setUp() public {
        vm.warp(1_791_208_800);
        usdg = new TestUSDG();
        drip = new UsdgDrip(usdg, owner);
        vm.prank(owner);
        usdg.faucet(1000e6);
        vm.prank(owner);
        usdg.transfer(address(drip), 100e6); // a plain transfer funds it
    }

    function test_constants() public view {
        assertEq(drip.AMOUNT(), 10e6);
        assertEq(drip.COOLDOWN(), 1 days);
        assertEq(address(drip.usdg()), address(usdg));
        assertEq(drip.owner(), owner);
    }

    function test_drip_sendsTenAndStartsCooldown() public {
        assertEq(drip.nextDripAt(alice), 0);
        vm.expectEmit(address(drip));
        emit Dripped(alice, 10e6);
        vm.prank(alice);
        drip.drip();
        assertEq(usdg.balanceOf(alice), 10e6);
        assertEq(drip.remaining(), 90e6);
        assertEq(drip.nextDripAt(alice), block.timestamp + 1 days);
        // Another address is not affected.
        assertEq(drip.nextDripAt(bob), 0);
        vm.prank(bob);
        drip.drip();
        assertEq(usdg.balanceOf(bob), 10e6);
    }

    function test_drip_tooSoon_thenAgainAfterCooldown() public {
        vm.prank(alice);
        drip.drip();
        uint256 next = block.timestamp + 1 days;
        vm.warp(next - 1);
        vm.expectRevert(abi.encodeWithSelector(UsdgDrip.TooSoon.selector, next));
        vm.prank(alice);
        drip.drip();
        vm.warp(next);
        vm.prank(alice);
        drip.drip();
        assertEq(usdg.balanceOf(alice), 20e6);
        assertEq(drip.nextDripAt(alice), next + 1 days);
    }

    function test_drip_empty() public {
        vm.prank(owner);
        drip.sweep(owner, 95e6); // 5 USDG left: less than one drip
        vm.expectRevert(UsdgDrip.Empty.selector);
        vm.prank(alice);
        drip.drip();
        assertEq(drip.nextDripAt(alice), 0); // a failed drip does not start the cooldown
    }

    function test_drip_drainsExactly() public {
        for (uint256 i; i < 10; ++i) {
            vm.prank(address(uint160(0x1000 + i)));
            drip.drip();
        }
        assertEq(drip.remaining(), 0);
        vm.expectRevert(UsdgDrip.Empty.selector);
        vm.prank(alice);
        drip.drip();
    }

    function test_refill_onlyOwner() public {
        vm.prank(owner);
        usdg.approve(address(drip), 50e6);
        vm.expectEmit(address(drip));
        emit Refilled(owner, 50e6);
        vm.prank(owner);
        drip.refill(50e6);
        assertEq(drip.remaining(), 150e6);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        drip.refill(1);
    }

    function test_sweep_onlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        drip.sweep(alice, 1);

        vm.expectEmit(address(drip));
        emit Swept(bob, 100e6);
        vm.prank(owner);
        drip.sweep(bob, 100e6);
        assertEq(usdg.balanceOf(bob), 100e6);
        assertEq(drip.remaining(), 0);
    }

    /// Whatever the gap, a second drip succeeds exactly when COOLDOWN has passed, and TooSoon names that time.
    function testFuzz_cooldown(uint256 start, uint256 gap) public {
        start = bound(start, 1, type(uint64).max);
        gap = bound(gap, 0, 3 days);
        vm.warp(start);
        vm.prank(alice);
        drip.drip();
        vm.warp(start + gap);
        if (gap < 1 days) {
            vm.expectRevert(abi.encodeWithSelector(UsdgDrip.TooSoon.selector, start + 1 days));
            vm.prank(alice);
            drip.drip();
            assertEq(usdg.balanceOf(alice), 10e6);
        } else {
            vm.prank(alice);
            drip.drip();
            assertEq(usdg.balanceOf(alice), 20e6);
            assertEq(drip.nextDripAt(alice), start + gap + 1 days);
        }
    }
}
