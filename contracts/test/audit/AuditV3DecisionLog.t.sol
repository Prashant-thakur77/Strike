// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AgentRegistry} from "../../src/agents/AgentRegistry.sol";
import {DecisionLog} from "../../src/agents/DecisionLog.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Test} from "forge-std/Test.sol";

/// @notice Audit 2026-10-01 (v3): `DecisionLog` against the v3 registry (consent-based signer rotation). The
///         contract is the one deployed next to each of the three deployments (source on `main`).
contract AuditV3DecisionLogTest is Test {
    address internal admin = makeAddr("admin");
    address internal ownerA = makeAddr("ownerA");
    address internal ownerB = makeAddr("ownerB");
    address internal signerA;
    uint256 internal signerAKey;

    AgentRegistry internal registry;
    DecisionLog internal decisions;
    uint256 internal agentA;
    uint256 internal agentB;

    function setUp() public {
        vm.warp(1_791_208_800);
        registry = new AgentRegistry(
            admin, new MockERC20("Global Dollar", "USDG", 6), IERC721(address(0)), 100e6, 25e6, 3, 8 days
        );
        decisions = new DecisionLog(registry);
        (signerA, signerAKey) = makeAddrAndKey("signerA");
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(signerAKey, registry.registerDigest(signerA, ownerA, ownerA, 0, deadline));
        vm.prank(ownerA);
        agentA = registry.register(signerA, ownerA, 0, deadline, abi.encodePacked(r, s, v));
        vm.prank(ownerB);
        agentB = registry.register(ownerB, ownerB, 0, 0, "");
    }

    // ================================================================== I-03
    /// I-03 (Info, no fix): the log checks the signer and nothing else. It does not check that the vault exists,
    /// that the agent serves it, that the epoch is the vault's current one, or that the agent is still active. The
    /// keys are per agent, so no agent can touch another's records; a reader must filter by the vault's own agent.
    function test_AUDIT3_info_logAcceptsAnyVaultEpochAndInactiveAgent() public {
        address vaultOfB = makeAddr("vault served by agent B");
        bytes32 h1 = keccak256("record 1");
        vm.prank(signerA);
        decisions.record(agentA, vaultOfB, 999, h1, "ipfs://a");
        assertEq(decisions.latestHash(agentA, vaultOfB, 999), h1);
        assertEq(decisions.latestHash(agentB, vaultOfB, 999), bytes32(0), "namespaced per agent");

        vm.prank(admin);
        registry.setStatus(agentA, AgentRegistry.Status.Suspended);
        vm.prank(signerA);
        decisions.record(agentA, vaultOfB, 999, keccak256("record 2"), "ipfs://b");
        vm.prank(ownerA);
        registry.retire(agentA);
        vm.prank(signerA);
        decisions.record(agentA, vaultOfB, 999, keccak256("record 3"), "ipfs://c");
        assertEq(decisions.recordCount(agentA), 3);
    }

    // ================================================================== held
    /// A v3 signer rotation (with the new key's consent) revokes the old key in the log at once; the new key
    /// re-anchors and replaces the latest hash, and a self-rotation to the owner makes the owner the recorder.
    function test_AUDIT3_safe_logFollowsConsentBasedSignerRotation() public {
        address vault = makeAddr("vault");
        bytes32 h1 = keccak256("record 1");
        vm.prank(signerA);
        decisions.record(agentA, vault, 1, h1, "ipfs://a");

        (address fresh, uint256 freshKey) = makeAddrAndKey("fresh");
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(freshKey, registry.setSignerDigest(fresh, agentA, deadline));
        vm.prank(ownerA);
        registry.setSigner(agentA, fresh, deadline, abi.encodePacked(r, s, v));

        vm.expectRevert(abi.encodeWithSelector(DecisionLog.NotSigner.selector, agentA, signerA));
        vm.prank(signerA);
        decisions.record(agentA, vault, 1, keccak256("forged"), "ipfs://x");
        bytes32 h2 = keccak256("record 1, corrected");
        vm.prank(fresh);
        decisions.record(agentA, vault, 1, h2, "ipfs://b");
        assertEq(decisions.latestHash(agentA, vault, 1), h2);

        vm.prank(ownerA);
        registry.setSigner(agentA, ownerA, 0, "");
        vm.expectRevert(abi.encodeWithSelector(DecisionLog.NotSigner.selector, agentA, fresh));
        vm.prank(fresh);
        decisions.record(agentA, vault, 2, h1, "ipfs://y");
        vm.prank(ownerA);
        decisions.record(agentA, vault, 2, h1, "ipfs://c");
        assertEq(decisions.recordCount(agentA), 3);
    }
}
