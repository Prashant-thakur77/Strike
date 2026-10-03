// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {GasDrip} from "../../src/testnet/GasDrip.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Test} from "forge-std/Test.sol";

/// @dev A recipient that refuses ETH.
contract Refuser {
    receive() external payable {
        revert("no");
    }
}

/// @dev A recipient that tries to drip itself again while receiving.
contract Reenterer {
    GasDrip internal drip;

    function set(GasDrip d) external {
        drip = d;
    }

    receive() external payable {
        drip.drip(address(this));
    }
}

contract GasDripTest is Test {
    address internal owner = makeAddr("owner");
    address internal relayer = makeAddr("relayer");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    GasDrip internal drip;

    uint256 internal constant AMOUNT = 0.0001 ether;
    uint256 internal constant CAP = 3;

    event Dripped(address indexed to, address indexed relayer, uint256 amount);
    event RelayerSet(address indexed relayer, bool allowed);
    event Refilled(address indexed from, uint256 amount);
    event Swept(address indexed to, uint256 amount);

    function setUp() public {
        vm.warp(1_791_208_800); // 2026-10-05 12:00 UTC
        drip = new GasDrip(owner, relayer, AMOUNT, CAP);
        vm.deal(owner, 1 ether);
        vm.prank(owner);
        (bool ok,) = address(drip).call{value: 0.01 ether}(""); // a plain transfer funds it
        assertTrue(ok);
    }

    function _drip(address to) internal {
        vm.prank(relayer);
        drip.drip(to);
    }

    function test_constructor() public view {
        assertEq(drip.owner(), owner);
        assertEq(drip.amount(), AMOUNT);
        assertEq(drip.dailyCap(), CAP);
        assertTrue(drip.isRelayer(relayer));
        assertEq(drip.remaining(), 0.01 ether);
        assertEq(drip.dripsLeftToday(), CAP);
        assertEq(drip.MAX_AMOUNT(), 0.01 ether);
        assertEq(drip.MAX_DAILY_CAP(), 1000);
    }

    function test_constructor_noRelayer() public {
        GasDrip d = new GasDrip(owner, address(0), AMOUNT, CAP);
        assertFalse(d.isRelayer(address(0)));
    }

    function test_constructor_emitsRelayerSet() public {
        vm.expectEmit();
        emit RelayerSet(relayer, true);
        new GasDrip(owner, relayer, AMOUNT, CAP);
    }

    function test_constructor_badParams() public {
        vm.expectRevert(GasDrip.BadParams.selector);
        new GasDrip(owner, relayer, 0, CAP);
        vm.expectRevert(GasDrip.BadParams.selector);
        new GasDrip(owner, relayer, 0.01 ether + 1, CAP);
        vm.expectRevert(GasDrip.BadParams.selector);
        new GasDrip(owner, relayer, AMOUNT, 0);
        vm.expectRevert(GasDrip.BadParams.selector);
        new GasDrip(owner, relayer, AMOUNT, 1001);
        // The bounds themselves are accepted.
        new GasDrip(owner, relayer, 0.01 ether, 1000);
    }

    function test_receive_emitsRefilled() public {
        vm.deal(bob, 1 ether);
        vm.expectEmit(address(drip));
        emit Refilled(bob, 0.002 ether);
        vm.prank(bob);
        (bool ok,) = address(drip).call{value: 0.002 ether}("");
        assertTrue(ok);
        assertEq(drip.remaining(), 0.012 ether);
    }

    function test_drip_sendsAmountOnce() public {
        assertFalse(drip.dripped(alice));
        vm.expectEmit(address(drip));
        emit Dripped(alice, relayer, AMOUNT);
        _drip(alice);
        assertEq(alice.balance, AMOUNT);
        assertTrue(drip.dripped(alice));
        assertEq(drip.remaining(), 0.01 ether - AMOUNT);
        assertEq(drip.dripsToday(), 1);
        assertEq(drip.dripsLeftToday(), CAP - 1);
    }

    function test_drip_notRelayer() public {
        vm.expectRevert(GasDrip.NotRelayer.selector);
        vm.prank(alice);
        drip.drip(alice);
        // The owner is not a relayer unless it names itself.
        vm.expectRevert(GasDrip.NotRelayer.selector);
        vm.prank(owner);
        drip.drip(alice);
    }

    function test_drip_zeroRecipient() public {
        vm.expectRevert(GasDrip.ZeroRecipient.selector);
        _drip(address(0));
    }

    function test_drip_alreadyDripped_evenAfterSpending() public {
        _drip(alice);
        // Alice spends her gas; she still cannot drip again: one per address, ever.
        vm.prank(alice);
        payable(bob).transfer(AMOUNT);
        assertEq(alice.balance, 0);
        vm.warp(block.timestamp + 30 days);
        vm.expectRevert(abi.encodeWithSelector(GasDrip.AlreadyDripped.selector, alice));
        _drip(alice);
    }

    function test_drip_hasGas() public {
        vm.deal(alice, AMOUNT);
        vm.expectRevert(abi.encodeWithSelector(GasDrip.HasGas.selector, AMOUNT));
        _drip(alice);
        // Just under the amount still qualifies.
        vm.deal(alice, AMOUNT - 1);
        _drip(alice);
        assertEq(alice.balance, 2 * AMOUNT - 1);
    }

    function test_drip_dailyCap_resetsAtUtcMidnight() public {
        for (uint256 i; i < CAP; ++i) {
            _drip(address(uint160(0x1000 + i)));
        }
        assertEq(drip.dripsLeftToday(), 0);
        uint256 resetsAt = (block.timestamp / 1 days + 1) * 1 days;
        vm.expectRevert(abi.encodeWithSelector(GasDrip.DailyCapReached.selector, resetsAt));
        _drip(alice);
        // A failed drip does not mark the address.
        assertFalse(drip.dripped(alice));
        vm.warp(resetsAt - 1);
        vm.expectRevert(abi.encodeWithSelector(GasDrip.DailyCapReached.selector, resetsAt));
        _drip(alice);
        vm.warp(resetsAt);
        assertEq(drip.dripsLeftToday(), CAP); // a view of the new day, before any write
        _drip(alice);
        assertEq(drip.day(), resetsAt / 1 days);
        assertEq(drip.dripsToday(), 1);
    }

    function test_drip_empty() public {
        vm.prank(owner);
        drip.sweep(payable(owner), 0.01 ether - AMOUNT + 1); // one wei short of a drip
        vm.expectRevert(GasDrip.Empty.selector);
        _drip(alice);
        assertFalse(drip.dripped(alice));
        assertEq(drip.dripsToday(), 0);
    }

    function test_drip_sendFailed() public {
        Refuser r = new Refuser();
        vm.expectRevert(GasDrip.SendFailed.selector);
        _drip(address(r));
        assertFalse(drip.dripped(address(r))); // the whole call reverted
    }

    function test_drip_reentryIsRefused() public {
        Reenterer r = new Reenterer();
        r.set(drip);
        // The re-entrant call is not from a relayer, so it reverts and takes the outer drip with it.
        vm.expectRevert(GasDrip.SendFailed.selector);
        _drip(address(r));
        assertEq(address(r).balance, 0);
    }

    function test_setRelayer() public {
        vm.expectEmit(address(drip));
        emit RelayerSet(bob, true);
        vm.prank(owner);
        drip.setRelayer(bob, true);
        vm.prank(bob);
        drip.drip(alice);
        vm.prank(owner);
        drip.setRelayer(bob, false);
        vm.expectRevert(GasDrip.NotRelayer.selector);
        vm.prank(bob);
        drip.drip(makeAddr("carol"));
    }

    function test_setRelayer_onlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, relayer));
        vm.prank(relayer);
        drip.setRelayer(relayer, true);
    }

    function test_sweep() public {
        vm.expectEmit(address(drip));
        emit Swept(bob, 0.004 ether);
        vm.prank(owner);
        drip.sweep(payable(bob), 0.004 ether);
        assertEq(bob.balance, 0.004 ether);
        assertEq(drip.remaining(), 0.006 ether);
    }

    function test_sweep_onlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, relayer));
        vm.prank(relayer);
        drip.sweep(payable(relayer), 1);
    }

    function test_sweep_sendFailed() public {
        Refuser r = new Refuser();
        vm.expectRevert(GasDrip.SendFailed.selector);
        vm.prank(owner);
        drip.sweep(payable(address(r)), 1);
    }

    function test_check_mirrorsDrip() public {
        (bool ok, bytes4 reason) = drip.check(alice);
        assertTrue(ok);
        assertEq(reason, bytes4(0));
        (ok, reason) = drip.check(address(0));
        assertEq(reason, GasDrip.ZeroRecipient.selector);
        assertFalse(ok);
        _drip(alice);
        (ok, reason) = drip.check(alice);
        assertEq(reason, GasDrip.AlreadyDripped.selector);
        vm.deal(bob, 1 ether);
        (ok, reason) = drip.check(bob);
        assertEq(reason, GasDrip.HasGas.selector);
        _drip(makeAddr("x"));
        _drip(makeAddr("y"));
        (ok, reason) = drip.check(makeAddr("z"));
        assertEq(reason, GasDrip.DailyCapReached.selector);
        vm.warp(block.timestamp + 1 days);
        uint256 all = drip.remaining();
        vm.prank(owner);
        drip.sweep(payable(owner), all);
        (ok, reason) = drip.check(makeAddr("z"));
        assertEq(reason, GasDrip.Empty.selector);
        assertFalse(ok);
    }

    /// @dev Whatever the relayer sends, the total paid out in a day never exceeds dailyCap * amount, and no address
    ///      is paid twice.
    function testFuzz_dailySpendIsBounded(uint8 n, uint32 seed) public {
        uint256 paid;
        for (uint256 i; i < n; ++i) {
            address to = address(uint160(uint256(keccak256(abi.encode(seed, i % 7)))));
            uint256 before = address(drip).balance;
            vm.prank(relayer);
            try drip.drip(to) {} catch {}
            paid += before - address(drip).balance;
        }
        assertLe(paid, CAP * AMOUNT);
        assertLe(paid, 7 * AMOUNT);
    }
}
