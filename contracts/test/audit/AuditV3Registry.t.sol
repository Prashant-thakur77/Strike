// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AgentRegistry} from "../../src/agents/AgentRegistry.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Test} from "forge-std/Test.sol";

/// @notice Audit 2026-10-01 (v3): the EIP-712 signer consent of `AgentRegistry.register` and `setSigner`.
///         Each finding's test reproduces the original attack and now asserts the fixed behaviour (regression test).
///         The consent's binding to the owner, payout and identity, replay after use, the deadline, malformed
///         signatures and the self-signer shortcut are covered by `test/agents/AgentRegistry.t.sol`.
contract AuditV3RegistryTest is Test {
    /// secp256k1 group order: the second valid signature for a digest has s' = n - s.
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    address internal admin = makeAddr("admin");
    address internal owner = makeAddr("owner");
    address internal signer;
    uint256 internal signerKey;

    MockERC20 internal usdg;
    AgentRegistry internal registry;

    function setUp() public {
        vm.warp(1_791_208_800);
        usdg = new MockERC20("Global Dollar", "USDG", 6);
        registry = _newRegistry();
        (signer, signerKey) = makeAddrAndKey("signer");
    }

    function _newRegistry() internal returns (AgentRegistry) {
        return new AgentRegistry(admin, usdg, IERC721(address(0)), 100e6, 25e6, 3, 8 days);
    }

    function _sign(bytes32 digest) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _invalidConsent() internal view returns (bytes memory) {
        return abi.encodeWithSelector(AgentRegistry.InvalidConsent.selector, signer);
    }

    // ================================================================== L-01
    /// FIXED (L-01): a signer withdraws the consents it has signed with `revokeConsents` (a nonce bump).
    /// Before the fix a consent could not be withdrawn before its deadline. A signer that stopped trusting the owner
    /// it signed for could only register itself, so that the owner's `register` fails with `SignerTaken`. That binds
    /// the key to a throwaway agent for good: `retire` keeps `agentOfSigner`, and the agent cannot be rotated onto
    /// its own owner either (`SignerTaken` again).
    function test_AUDIT3_consentCannotBeWithdrawn() public {
        uint256 deadline = block.timestamp + 30 days;
        bytes memory consent = _sign(registry.registerDigest(signer, owner, owner, 0, deadline));

        // The signer changes its mind: the consent is dead and the key stays free.
        vm.expectEmit(address(registry));
        emit AgentRegistry.ConsentsRevoked(signer, 0);
        vm.prank(signer);
        registry.revokeConsents();
        assertEq(registry.nonces(signer), 1);
        vm.expectRevert(_invalidConsent());
        vm.prank(owner);
        registry.register(signer, owner, 0, deadline, consent);
        assertEq(registry.agentOfSigner(signer), 0, "AUDIT L-01: the key must stay free");

        // A consent signed at the new nonce works as before.
        consent = _sign(registry.registerDigest(signer, owner, owner, 0, deadline));
        vm.prank(owner);
        registry.register(signer, owner, 0, deadline, consent);
        assertEq(registry.agentOfSigner(signer), 1);

        // The only remedy before the fix, for the record: self-registration takes the key for good.
        address other = makeAddr("other");
        vm.startPrank(other);
        uint256 id = registry.register(other, other, 0, 0, "");
        registry.retire(id);
        assertEq(registry.agentOfSigner(other), id);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.SignerTaken.selector, other));
        registry.setSigner(id, other, 0, "");
        vm.stopPrank();
    }

    // ================================================================== held
    /// A consent is bound to the chain id and the registry address through the EIP-712 domain: another registry
    /// with the same name and version refuses it, and so does the same registry on a fork or another chain.
    function test_AUDIT3_safe_consentBoundToChainAndRegistry() public {
        uint256 deadline = block.timestamp + 1 days;
        bytes memory consent = _sign(registry.registerDigest(signer, owner, owner, 0, deadline));

        AgentRegistry other = _newRegistry();
        vm.expectRevert(_invalidConsent());
        vm.prank(owner);
        other.register(signer, owner, 0, deadline, consent);

        uint256 chain = block.chainid;
        vm.chainId(chain + 1);
        assertNotEq(registry.DOMAIN_SEPARATOR(), other.DOMAIN_SEPARATOR());
        vm.expectRevert(_invalidConsent());
        vm.prank(owner);
        registry.register(signer, owner, 0, deadline, consent);
        vm.chainId(chain);

        // Nothing was consumed: the consent works where it was signed for.
        assertEq(registry.nonces(signer), 0);
        vm.prank(owner);
        registry.register(signer, owner, 0, deadline, consent);
        assertEq(registry.agentOfSigner(signer), 1);
    }

    /// The second valid ECDSA signature for the same digest (s' = n - s, v flipped) recovers the signer with
    /// `ecrecover` but is refused (OpenZeppelin rejects high-s values), so a consent has one canonical form.
    function test_AUDIT3_safe_malleatedConsentRejected() public {
        uint256 deadline = block.timestamp + 1 days;
        bytes32 digest = registry.registerDigest(signer, owner, owner, 0, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        bytes32 s2 = bytes32(SECP256K1_N - uint256(s));
        uint8 v2 = v == 27 ? 28 : 27;
        assertEq(ecrecover(digest, v2, r, s2), signer, "the malleated signature is a valid ECDSA signature");

        vm.expectRevert(_invalidConsent());
        vm.prank(owner);
        registry.register(signer, owner, 0, deadline, abi.encodePacked(r, s2, v2));
        assertEq(registry.nonces(signer), 0);

        vm.prank(owner);
        registry.register(signer, owner, 0, deadline, abi.encodePacked(r, s, v));
        assertEq(registry.agentOfSigner(signer), 1);
    }

    /// `Register` and `SetSigner` have distinct type hashes: a consent to one cannot be used for the other, even
    /// though both consume the same per-signer nonce.
    function test_AUDIT3_safe_registerAndSetSignerConsentsAreDistinct() public {
        vm.prank(owner);
        uint256 id = registry.register(owner, owner, 0, 0, "");
        uint256 deadline = block.timestamp + 1 days;
        bytes memory setSignerConsent = _sign(registry.setSignerDigest(signer, id, deadline));
        bytes memory registerConsent = _sign(registry.registerDigest(signer, owner, owner, 0, deadline));

        vm.expectRevert(_invalidConsent());
        vm.prank(owner);
        registry.register(signer, owner, 0, deadline, setSignerConsent);
        vm.expectRevert(_invalidConsent());
        vm.prank(owner);
        registry.setSigner(id, signer, deadline, registerConsent);
        assertEq(registry.nonces(signer), 0);

        vm.prank(owner);
        registry.setSigner(id, signer, deadline, setSignerConsent);
        assertEq(registry.signerOf(id), signer);
        assertEq(registry.nonces(signer), 1);
    }

    /// A consent is checked after `SignerTaken`, so a key that already signs for an agent cannot be bound twice
    /// even with a fresh consent, and the failed attempt burns no nonce.
    function test_AUDIT3_safe_takenSignerConsentBurnsNoNonce() public {
        uint256 deadline = block.timestamp + 1 days;
        bytes memory first = _sign(registry.registerDigest(signer, owner, owner, 0, deadline));
        vm.prank(owner);
        registry.register(signer, owner, 0, deadline, first);
        address second = makeAddr("second");
        bytes memory consent = _sign(registry.registerDigest(signer, second, second, 0, deadline));
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.SignerTaken.selector, signer));
        vm.prank(second);
        registry.register(signer, second, 0, deadline, consent);
        assertEq(registry.nonces(signer), 1);
    }
}
