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
    uint256 internal signerKey;

    bytes32 internal constant REGISTER_TYPEHASH =
        keccak256("Register(address owner,address payout,uint256 erc8004Id,uint256 nonce,uint256 deadline)");
    bytes32 internal constant SET_SIGNER_TYPEHASH =
        keccak256("SetSigner(address owner,uint256 agentId,uint256 nonce,uint256 deadline)");

    MockERC20 internal usdg;
    MockIdentityRegistry internal identity;
    AgentRegistry internal registry;

    function setUp() public {
        usdg = new MockERC20("Global Dollar", "USDG", 6);
        identity = new MockIdentityRegistry();
        registry = new AgentRegistry(admin, usdg, IERC721(address(identity)), 100e6, 25e6, 3, 8 days);
        (signer, signerKey) = makeAddrAndKey("signer");
        bytes32 role = registry.SLASHER_ROLE();
        vm.prank(admin);
        registry.grantRole(role, slasher);
        usdg.mint(owner, 1000e6);
        vm.prank(owner);
        usdg.approve(address(registry), type(uint256).max);
    }

    function _register() internal returns (uint256 id) {
        bytes memory consent = _registerConsent(signerKey, owner, payout, 0, 0, block.timestamp);
        vm.prank(owner);
        id = registry.register(signer, payout, 0, block.timestamp, consent);
    }

    // ------------------------------------------------------------------ EIP-712, restated independently

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Strike AgentRegistry"),
                keccak256("1"),
                block.chainid,
                address(registry)
            )
        );
    }

    function _sign(uint256 key, bytes32 structHash) internal view returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _registerConsent(
        uint256 key,
        address owner_,
        address payout_,
        uint256 erc8004Id,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes memory) {
        return _sign(key, keccak256(abi.encode(REGISTER_TYPEHASH, owner_, payout_, erc8004Id, nonce, deadline)));
    }

    function _setSignerConsent(uint256 key, address owner_, uint256 agentId, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        return _sign(key, keccak256(abi.encode(SET_SIGNER_TYPEHASH, owner_, agentId, nonce, deadline)));
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
        bytes memory consent = _registerConsent(signerKey, owner, payout, identityId, 0, block.timestamp);
        vm.prank(owner);
        uint256 id = registry.register(signer, payout, identityId, block.timestamp, consent);
        assertEq(registry.getAgent(id).erc8004Id, identityId);
    }

    function test_revert_register_notIdentityOwner() public {
        uint256 identityId = identity.register(); // owned by this test contract
        bytes memory consent = _registerConsent(signerKey, owner, payout, identityId, 0, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.NotIdentityOwner.selector, identityId));
        vm.prank(owner);
        registry.register(signer, payout, identityId, block.timestamp, consent);
    }

    function test_revert_register_zeroAddressOrTakenSigner() public {
        vm.expectRevert(AgentRegistry.ZeroAddress.selector);
        registry.register(address(0), payout, 0, 0, "");
        vm.expectRevert(AgentRegistry.ZeroAddress.selector);
        registry.register(signer, address(0), 0, 0, "");
        _register();
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.SignerTaken.selector, signer));
        registry.register(signer, payout, 0, 0, "");
    }

    function test_setSignerPayoutIdentity() public {
        uint256 id = _register();
        (address newSigner, uint256 newKey) = makeAddrAndKey("newSigner");
        bytes memory consent = _setSignerConsent(newKey, owner, id, 0, block.timestamp);
        vm.startPrank(owner);
        registry.setSigner(id, newSigner, block.timestamp, consent);
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
        registry.setSigner(id, makeAddr("x"), 0, "");
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.NotOwner.selector, id));
        registry.setPayout(id, makeAddr("x"));
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.NotOwner.selector, id));
        registry.retire(id);
        vm.startPrank(owner);
        vm.expectRevert(AgentRegistry.ZeroAddress.selector);
        registry.setSigner(id, address(0), 0, "");
        vm.expectRevert(AgentRegistry.ZeroAddress.selector);
        registry.setPayout(id, address(0));
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.SignerTaken.selector, signer));
        registry.setSigner(id, signer, 0, "");
        vm.stopPrank();
    }

    function test_revert_unknownAgent() public {
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.UnknownAgent.selector, 7));
        registry.postBond(7, 1);
    }

    // ------------------------------------------------------------------ signer consent (D33)

    function test_register_withSignerConsent_usesNonce() public {
        assertEq(registry.nonces(signer), 0);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory consent = _registerConsent(signerKey, owner, payout, 0, 0, deadline);
        // The contract's digest helper matches the independently restated EIP-712 hash.
        bytes32 structHash = keccak256(abi.encode(REGISTER_TYPEHASH, owner, payout, uint256(0), uint256(0), deadline));
        assertEq(
            registry.registerDigest(signer, owner, payout, 0, deadline),
            keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash))
        );
        assertEq(registry.DOMAIN_SEPARATOR(), _domainSeparator());
        assertEq(registry.REGISTER_TYPEHASH(), REGISTER_TYPEHASH);
        assertEq(registry.SET_SIGNER_TYPEHASH(), SET_SIGNER_TYPEHASH);

        vm.prank(owner);
        uint256 id = registry.register(signer, payout, 0, deadline, consent);
        assertEq(registry.signerOf(id), signer);
        assertEq(registry.getAgent(id).owner, owner);
        assertEq(registry.nonces(signer), 1);
    }

    /// The griefing attack D33 describes: registering someone else's address without their signature.
    function test_revert_register_otherSignerWithoutConsent() public {
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.InvalidConsent.selector, signer));
        vm.prank(owner);
        registry.register(signer, payout, 0, block.timestamp, "");
        assertEq(registry.agentOfSigner(signer), 0);
    }

    function test_revert_register_wrongSigner() public {
        (, uint256 otherKey) = makeAddrAndKey("other");
        bytes memory consent = _registerConsent(otherKey, owner, payout, 0, 0, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.InvalidConsent.selector, signer));
        vm.prank(owner);
        registry.register(signer, payout, 0, block.timestamp, consent);
    }

    /// A consent is bound to the owner, payout and identity it names: a front-runner cannot reuse it.
    function test_revert_register_consentBoundToOwnerPayoutAndIdentity() public {
        bytes memory consent = _registerConsent(signerKey, owner, payout, 0, 0, block.timestamp);
        address attacker = makeAddr("attacker");
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.InvalidConsent.selector, signer));
        vm.prank(attacker);
        registry.register(signer, payout, 0, block.timestamp, consent);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.InvalidConsent.selector, signer));
        vm.prank(owner);
        registry.register(signer, attacker, 0, block.timestamp, consent);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.InvalidConsent.selector, signer));
        vm.prank(owner);
        registry.register(signer, payout, 7, block.timestamp, consent);
        // Nothing consumed: the consent still works for its owner.
        vm.prank(owner);
        registry.register(signer, payout, 0, block.timestamp, consent);
    }

    function test_revert_register_replay() public {
        bytes memory consent = _registerConsent(signerKey, owner, payout, 0, 0, block.timestamp + 1 days);
        vm.prank(owner);
        uint256 id = registry.register(signer, payout, 0, block.timestamp + 1 days, consent);
        // The owner moves the agent to its own key, which frees `signer` again.
        vm.prank(owner);
        registry.setSigner(id, owner, 0, "");
        assertEq(registry.agentOfSigner(signer), 0);
        // The used consent cannot bind the signer a second time.
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.InvalidConsent.selector, signer));
        vm.prank(owner);
        registry.register(signer, payout, 0, block.timestamp + 1 days, consent);
    }

    function test_revert_register_expiredDeadline() public {
        vm.warp(1000);
        bytes memory consent = _registerConsent(signerKey, owner, payout, 0, 0, 999);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.ConsentExpired.selector, 999));
        vm.prank(owner);
        registry.register(signer, payout, 0, 999, consent);
        // The deadline itself is still valid.
        consent = _registerConsent(signerKey, owner, payout, 0, 0, 1000);
        vm.prank(owner);
        registry.register(signer, payout, 0, 1000, consent);
    }

    function test_revert_register_malformedSignature() public {
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.InvalidConsent.selector, signer));
        vm.prank(owner);
        registry.register(signer, payout, 0, block.timestamp, new bytes(64));
    }

    function test_register_selfNeedsNoSignature() public {
        vm.prank(signer);
        uint256 id = registry.register(signer, payout, 0, 0, "");
        assertEq(registry.getAgent(id).owner, signer);
        assertEq(registry.signerOf(id), signer);
        assertEq(registry.nonces(signer), 0);
    }

    function test_setSigner_withConsent() public {
        uint256 id = _register();
        (address fresh, uint256 freshKey) = makeAddrAndKey("fresh");
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(abi.encode(SET_SIGNER_TYPEHASH, owner, id, uint256(0), deadline));
        assertEq(
            registry.setSignerDigest(fresh, id, deadline),
            keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash))
        );
        bytes memory consent = _setSignerConsent(freshKey, owner, id, 0, deadline);
        vm.expectEmit(address(registry));
        emit AgentRegistry.SignerSet(id, fresh);
        vm.prank(owner);
        registry.setSigner(id, fresh, deadline, consent);
        assertEq(registry.signerOf(id), fresh);
        assertEq(registry.nonces(fresh), 1);
    }

    function test_revert_setSigner_withoutConsent() public {
        uint256 id = _register();
        address victim = makeAddr("victim");
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.InvalidConsent.selector, victim));
        vm.prank(owner);
        registry.setSigner(id, victim, block.timestamp, "");
    }

    function test_revert_setSigner_wrongSigner() public {
        uint256 id = _register();
        address fresh = makeAddr("fresh");
        (, uint256 otherKey) = makeAddrAndKey("other");
        bytes memory consent = _setSignerConsent(otherKey, owner, id, 0, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.InvalidConsent.selector, fresh));
        vm.prank(owner);
        registry.setSigner(id, fresh, block.timestamp, consent);
    }

    /// A consent names its agent: it cannot move the signer onto another agent.
    function test_revert_setSigner_consentBoundToAgent() public {
        uint256 id = _register();
        vm.prank(owner);
        uint256 id2 = registry.register(owner, payout, 0, 0, "");
        (address fresh, uint256 freshKey) = makeAddrAndKey("fresh");
        bytes memory consent = _setSignerConsent(freshKey, owner, id, 0, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.InvalidConsent.selector, fresh));
        vm.prank(owner);
        registry.setSigner(id2, fresh, block.timestamp, consent);
    }

    function test_revert_setSigner_replay() public {
        uint256 id = _register();
        (address fresh, uint256 freshKey) = makeAddrAndKey("fresh");
        uint256 deadline = block.timestamp + 1 days;
        bytes memory consent = _setSignerConsent(freshKey, owner, id, 0, deadline);
        vm.startPrank(owner);
        registry.setSigner(id, fresh, deadline, consent);
        registry.setSigner(id, owner, 0, ""); // rotate away again, freeing `fresh`
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.InvalidConsent.selector, fresh));
        registry.setSigner(id, fresh, deadline, consent);
        vm.stopPrank();
    }

    function test_revert_setSigner_expiredDeadline() public {
        uint256 id = _register();
        (address fresh, uint256 freshKey) = makeAddrAndKey("fresh");
        uint256 deadline = block.timestamp;
        bytes memory consent = _setSignerConsent(freshKey, owner, id, 0, deadline);
        vm.warp(deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.ConsentExpired.selector, deadline));
        vm.prank(owner);
        registry.setSigner(id, fresh, deadline, consent);
    }

    function test_setSigner_selfNeedsNoSignature() public {
        uint256 id = _register();
        vm.prank(owner);
        registry.setSigner(id, owner, 0, "");
        assertEq(registry.signerOf(id), owner);
        assertEq(registry.agentOfSigner(owner), id);
        assertEq(registry.nonces(owner), 0);
    }

    /// Only the key a registration names can consent to it.
    function testFuzz_register_onlyNamedSignerCanConsent(uint256 key, uint256 otherKey) public {
        key = bound(key, 1, 1e70);
        otherKey = bound(otherKey, 1, 1e70);
        address named = vm.addr(key);
        vm.assume(named != owner);
        bytes memory consent = _registerConsent(otherKey, owner, payout, 0, 0, block.timestamp);
        if (otherKey != key) vm.expectRevert(abi.encodeWithSelector(AgentRegistry.InvalidConsent.selector, named));
        vm.prank(owner);
        registry.register(named, payout, 0, block.timestamp, consent);
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
