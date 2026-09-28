// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AgentRegistry} from "../../src/agents/AgentRegistry.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockIdentityRegistry} from "../mocks/MockIdentityRegistry.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Test} from "forge-std/Test.sol";

contract AgentRegistryTest is Test {
    address internal admin = makeAddr("admin");
    address internal owner = makeAddr("owner");
    address internal signer = makeAddr("signer");
    address internal payout = makeAddr("payout");
    address internal slasher = makeAddr("slasher");
    address internal vault = makeAddr("vault");

    MockERC20 internal usdg;
    MockIdentityRegistry internal identity;
    AgentRegistry internal registry;

    function setUp() public {
        usdg = new MockERC20("Global Dollar", "USDG", 6);
        identity = new MockIdentityRegistry();
        registry = new AgentRegistry(admin, usdg, IERC721(address(identity)), 100e6, 25e6, 3, 8 days);
        bytes32 role = registry.SLASHER_ROLE();
        vm.prank(admin);
        registry.grantRole(role, slasher);
        usdg.mint(owner, 1000e6);
        vm.prank(owner);
        usdg.approve(address(registry), type(uint256).max);
    }

    function _register() internal returns (uint256 id) {
        vm.prank(owner);
        id = registry.register(signer, payout, 0);
    }

    function _registerBonded(uint256 bond) internal returns (uint256 id) {
        id = _register();
        vm.prank(owner);
        registry.postBond(id, bond);
    }

    // ------------------------------------------------------------------ registration

    function test_register() public {
        vm.expectEmit(true, true, false, true, address(registry));
        emit AgentRegistry.AgentRegistered(1, owner, signer, 0);
        uint256 id = _register();
        assertEq(id, 1);
        AgentRegistry.Agent memory a = registry.getAgent(id);
        assertEq(a.owner, owner);
        assertEq(a.signer, signer);
        assertEq(a.payout, payout);
        assertEq(uint8(a.status), uint8(AgentRegistry.Status.Active));
        assertEq(registry.agentOfSigner(signer), id);
        assertEq(registry.signerOf(id), signer);
        assertEq(registry.payoutOf(id), payout);
        assertFalse(registry.isActive(id)); // not bonded yet
    }

    function test_register_withErc8004Identity() public {
        vm.prank(owner);
        uint256 identityId = identity.register();
        vm.prank(owner);
        uint256 id = registry.register(signer, payout, identityId);
        assertEq(registry.getAgent(id).erc8004Id, identityId);
    }

    function test_revert_register_notIdentityOwner() public {
        uint256 identityId = identity.register(); // owned by this test contract
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.NotIdentityOwner.selector, identityId));
        vm.prank(owner);
        registry.register(signer, payout, identityId);
    }

    function test_revert_register_zeroAddressOrTakenSigner() public {
        vm.expectRevert(AgentRegistry.ZeroAddress.selector);
        registry.register(address(0), payout, 0);
        vm.expectRevert(AgentRegistry.ZeroAddress.selector);
        registry.register(signer, address(0), 0);
        _register();
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.SignerTaken.selector, signer));
        registry.register(signer, payout, 0);
    }

    function test_setSignerPayoutIdentity() public {
        uint256 id = _register();
        address newSigner = makeAddr("newSigner");
        vm.startPrank(owner);
        registry.setSigner(id, newSigner);
        registry.setPayout(id, newSigner);
        uint256 identityId = identity.register();
        registry.setIdentity(id, identityId);
        vm.stopPrank();
        assertEq(registry.signerOf(id), newSigner);
        assertEq(registry.agentOfSigner(signer), 0);
        assertEq(registry.agentOfSigner(newSigner), id);
        assertEq(registry.payoutOf(id), newSigner);
        assertEq(registry.getAgent(id).erc8004Id, identityId);
    }

    function test_revert_ownerOnlyAndZero() public {
        uint256 id = _register();
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.NotOwner.selector, id));
        registry.setSigner(id, makeAddr("x"));
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.NotOwner.selector, id));
        registry.setPayout(id, makeAddr("x"));
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.NotOwner.selector, id));
        registry.retire(id);
        vm.startPrank(owner);
        vm.expectRevert(AgentRegistry.ZeroAddress.selector);
        registry.setSigner(id, address(0));
        vm.expectRevert(AgentRegistry.ZeroAddress.selector);
        registry.setPayout(id, address(0));
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.SignerTaken.selector, signer));
        registry.setSigner(id, signer);
        vm.stopPrank();
    }

    function test_revert_unknownAgent() public {
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.UnknownAgent.selector, 7));
        registry.postBond(7, 1);
    }

    // ------------------------------------------------------------------ bond

    function test_postBondActivates() public {
        uint256 id = _registerBonded(100e6);
        assertTrue(registry.isActive(id));
        assertEq(usdg.balanceOf(address(registry)), 100e6);
        vm.expectRevert(AgentRegistry.ZeroAmount.selector);
        registry.postBond(id, 0);
    }

    function test_unbondAfterDelay() public {
        uint256 id = _registerBonded(300e6);
        vm.prank(owner);
        registry.requestUnbond(id, 200e6);
        assertEq(registry.getAgent(id).bond, 100e6);
        assertEq(registry.getAgent(id).unbonding, 200e6);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.UnbondPending.selector, uint64(block.timestamp + 8 days)));
        vm.prank(owner);
        registry.withdrawUnbonded(id, owner);
        vm.warp(block.timestamp + 8 days);
        vm.prank(owner);
        assertEq(registry.withdrawUnbonded(id, owner), 200e6);
        assertEq(usdg.balanceOf(owner), 900e6);
    }

    function test_revert_unbondErrors() public {
        uint256 id = _registerBonded(100e6);
        vm.startPrank(owner);
        vm.expectRevert(AgentRegistry.ZeroAmount.selector);
        registry.requestUnbond(id, 0);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.InsufficientBond.selector, 101e6, 100e6));
        registry.requestUnbond(id, 101e6);
        vm.expectRevert(AgentRegistry.NothingUnbonding.selector);
        registry.withdrawUnbonded(id, owner);
        vm.expectRevert(AgentRegistry.ZeroAddress.selector);
        registry.withdrawUnbonded(id, address(0));
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ slashing

    function test_slash_movesBondAndCountsStrikes() public {
        uint256 id = _registerBonded(150e6);
        vm.prank(slasher);
        assertEq(registry.slash(id, vault), 25e6);
        assertEq(usdg.balanceOf(vault), 25e6);
        AgentRegistry.Agent memory a = registry.getAgent(id);
        assertEq(a.bond, 125e6);
        assertEq(a.strikes, 1);
        assertEq(a.rejected, 1);
        assertTrue(registry.isActive(id));
    }

    function test_slash_reachesUnbondingBond() public {
        uint256 id = _registerBonded(110e6);
        vm.prank(owner);
        registry.requestUnbond(id, 100e6);
        vm.prank(slasher);
        assertEq(registry.slash(id, vault), 25e6); // 10 from bond, 15 from unbonding
        assertEq(registry.getAgent(id).bond, 0);
        assertEq(registry.getAgent(id).unbonding, 85e6);
    }

    function test_slash_maxStrikesSuspends() public {
        uint256 id = _registerBonded(1000e6);
        vm.startPrank(slasher);
        registry.slash(id, vault);
        registry.slash(id, vault);
        vm.expectEmit(true, false, false, true, address(registry));
        emit AgentRegistry.StatusSet(id, AgentRegistry.Status.Suspended);
        registry.slash(id, vault);
        vm.stopPrank();
        assertFalse(registry.isActive(id));
        vm.prank(admin);
        registry.setStatus(id, AgentRegistry.Status.Active);
        assertTrue(registry.isActive(id));
        assertEq(registry.getAgent(id).strikes, 0);
    }

    function test_slash_cappedByBalance() public {
        uint256 id = _registerBonded(10e6);
        vm.prank(slasher);
        assertEq(registry.slash(id, vault), 10e6);
        vm.prank(slasher);
        assertEq(registry.slash(id, vault), 0);
    }

    function test_revert_slash() public {
        uint256 id = _registerBonded(100e6);
        vm.expectRevert();
        registry.slash(id, vault);
        vm.prank(slasher);
        vm.expectRevert(AgentRegistry.ZeroAddress.selector);
        registry.slash(id, address(0));
    }

    function test_recordAccepted() public {
        uint256 id = _register();
        vm.prank(slasher);
        registry.recordAccepted(id);
        assertEq(registry.getAgent(id).accepted, 1);
        vm.expectRevert();
        registry.recordAccepted(id);
    }

    function testFuzz_slashNeverExceedsHoldings(uint256 bond, uint256 unbond, uint8 times) public {
        bond = bound(bond, 1, 1000e6);
        unbond = bound(unbond, 0, bond);
        uint256 id = _registerBonded(bond);
        if (unbond != 0) {
            vm.prank(owner);
            registry.requestUnbond(id, unbond);
        }
        uint256 total;
        for (uint256 i; i < bound(times, 1, 10); ++i) {
            vm.prank(slasher);
            total += registry.slash(id, vault);
        }
        AgentRegistry.Agent memory a = registry.getAgent(id);
        assertEq(total + a.bond + a.unbonding, bond);
        assertEq(usdg.balanceOf(address(registry)), a.bond + a.unbonding);
    }

    // ------------------------------------------------------------------ status & admin

    function test_retire() public {
        uint256 id = _registerBonded(100e6);
        vm.prank(owner);
        registry.retire(id);
        assertFalse(registry.isActive(id));
    }

    function test_admin() public {
        uint256 id = _register();
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.InvalidStatus.selector, AgentRegistry.Status.None));
        registry.setStatus(id, AgentRegistry.Status.None);
        registry.setStatus(id, AgentRegistry.Status.Suspended);
        registry.setParams(1, 2, 5, 2 days);
        assertEq(registry.minBond(), 1);
        assertEq(registry.slashAmount(), 2);
        vm.expectRevert(AgentRegistry.InvalidParams.selector);
        registry.setParams(1, 2, 0, 2 days);
        vm.expectRevert(AgentRegistry.InvalidParams.selector);
        registry.setParams(1, 2, 3, 1 hours);
        registry.setIdentityRegistry(IERC721(address(0)));
        vm.stopPrank();
        assertEq(address(registry.identityRegistry()), address(0));
        vm.expectRevert();
        registry.setParams(1, 2, 3, 2 days);
        vm.expectRevert(AgentRegistry.ZeroAddress.selector);
        new AgentRegistry(address(0), usdg, IERC721(address(0)), 1, 1, 1, 1 days);
    }
}
