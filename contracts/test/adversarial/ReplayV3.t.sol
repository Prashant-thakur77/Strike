// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AgentRegistry} from "../../src/agents/AgentRegistry.sol";
import {DecisionLog} from "../../src/agents/DecisionLog.sol";
import {EpochManager} from "../../src/core/EpochManager.sol";
import {AdversarialBase} from "./AdversarialBase.sol";

/// @notice REPLAY, v3 only: the EIP-712 signer consent. A used consent is replayed after the key it bound was
///         rotated out. Cross-chain and cross-registry replays: `test_AUDIT3_safe_consentBoundToChainAndRegistry`;
///         replays of a plain register or setSigner: `test_revert_register_replay`, `test_revert_setSigner_replay`.
///         Map: docs/security/adversarial.md#replay (on main).
contract AdversarialReplayV3Test is AdversarialBase {
    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    /// The owner moved agent #1 onto key k1 with k1's SetSigner consent. k1 leaks, and the owner rotates to k2 (with
    /// k2's consent), which frees k1. Whoever holds k1's old consent (the attacker, a front end, the owner by
    /// mistake) replays it to put k1 back: as the same SetSigner (InvalidConsent: the nonce is used), from the
    /// attacker's address (NotOwner), or as a Register consent for the owner or for the attacker (InvalidConsent).
    /// Failed replays burn no nonce; k1 can no longer open, propose or anchor a decision for the agent; k2 can.
    function test_ADV_REPLAY_usedConsentCannotBringOldKeyBack() public {
        _depositCall(alice, 100 * WAD);
        (address k1, uint256 k1Key) = makeAddrAndKey("k1");
        (address k2, uint256 k2Key) = makeAddrAndKey("k2");
        uint256 deadline = block.timestamp + 30 days;
        bytes memory c1 = _sign(k1Key, registry.setSignerDigest(k1, agentId, deadline));
        vm.prank(agent); // the owner
        registry.setSigner(agentId, k1, deadline, c1);
        assertEq(registry.signerOf(agentId), k1);
        assertEq(registry.nonces(k1), 1);

        bytes memory c2 = _sign(k2Key, registry.setSignerDigest(k2, agentId, deadline));
        vm.prank(agent);
        registry.setSigner(agentId, k2, deadline, c2);
        assertEq(registry.agentOfSigner(k1), 0, "k1 is free again");

        bytes memory invalid = abi.encodeWithSelector(AgentRegistry.InvalidConsent.selector, k1);
        address attacker = makeAddr("attacker");
        vm.prank(agent);
        vm.expectRevert(invalid);
        registry.setSigner(agentId, k1, deadline, c1);
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.NotOwner.selector, agentId));
        registry.setSigner(agentId, k1, deadline, c1);
        vm.prank(agent);
        vm.expectRevert(invalid);
        registry.register(k1, agent, 0, deadline, c1);
        vm.prank(attacker);
        vm.expectRevert(invalid);
        registry.register(k1, attacker, 0, deadline, c1);
        assertEq(registry.nonces(k1), 1, "failed replays burn nothing");
        assertEq(registry.signerOf(agentId), k2);

        bytes memory notAgent = abi.encodeWithSelector(EpochManager.NotAgent.selector, k1);
        vm.prank(k1);
        vm.expectRevert(notAgent);
        manager.openEpoch(address(callVault));
        vm.prank(k2);
        manager.openEpoch(address(callVault));
        vm.prank(k1);
        vm.expectRevert(notAgent);
        manager.proposeSeries(address(callVault), 275 * WAD, FRIDAY_CLOSE, 50 * WAD, 10_000);
        DecisionLog log = new DecisionLog(registry);
        vm.prank(k1);
        vm.expectRevert(abi.encodeWithSelector(DecisionLog.NotSigner.selector, agentId, k1));
        log.record(agentId, address(callVault), 1, keccak256("forged record"), "");
        vm.prank(k2);
        (bool ok,) = manager.proposeSeries(address(callVault), 275 * WAD, FRIDAY_CLOSE, 50 * WAD, 10_000);
        assertTrue(ok);
        assertEq(_strikes(), 0);
    }
}
