// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AgentRegistry} from "../../src/agents/AgentRegistry.sol";
import {DecisionLog} from "../../src/agents/DecisionLog.sol";
import {IAgentRegistry} from "../../src/interfaces/IAgentRegistry.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Test} from "forge-std/Test.sol";

contract DecisionLogTest is Test {
    event DecisionRecorded(
        uint256 indexed agentId,
        address indexed vault,
        uint64 indexed epoch,
        bytes32 recordHash,
        string uri,
        uint256 timestamp
    );

    address internal admin = makeAddr("admin");
    address internal owner = makeAddr("owner");
    address internal signer = makeAddr("signer");
    address internal vault = makeAddr("vault");
    string internal constant URI = "https://github.com/Prashant-thakur77/Strike/blob/main/docs/agent-log/a.json";
    bytes32 internal constant HASH = keccak256("decision record");

    AgentRegistry internal registry;
    DecisionLog internal decisions;
    uint256 internal agentId;

    function setUp() public {
        vm.warp(1_791_208_800);
        registry = new AgentRegistry(
            admin, new MockERC20("Global Dollar", "USDG", 6), IERC721(address(0)), 100e6, 25e6, 3, 8 days
        );
        decisions = new DecisionLog(registry);
        vm.prank(owner);
        agentId = registry.register(signer, owner, 0);
    }

    function test_constructor() public view {
        assertEq(address(decisions.registry()), address(registry));
    }

    function test_revert_constructorZeroRegistry() public {
        vm.expectRevert(DecisionLog.ZeroAddress.selector);
        new DecisionLog(IAgentRegistry(address(0)));
    }

    function test_record_emitsAndStores() public {
        vm.expectEmit(address(decisions));
        emit DecisionRecorded(agentId, vault, 1, HASH, URI, block.timestamp);
        vm.prank(signer);
        decisions.record(agentId, vault, 1, HASH, URI);
        assertEq(decisions.latestHash(agentId, vault, 1), HASH);
        assertEq(decisions.recordCount(agentId), 1);
    }

    /// Every record emits its own event; the latest hash per (agent, vault, epoch) wins, other keys are untouched.
    function test_record_eventPerRecordLatestHashWins() public {
        bytes32 second = keccak256("corrected record");
        vm.recordLogs();
        vm.startPrank(signer);
        decisions.record(agentId, vault, 1, HASH, URI);
        decisions.record(agentId, vault, 1, second, URI);
        decisions.record(agentId, vault, 2, HASH, URI);
        vm.stopPrank();
        assertEq(vm.getRecordedLogs().length, 3);
        assertEq(decisions.latestHash(agentId, vault, 1), second);
        assertEq(decisions.latestHash(agentId, vault, 2), HASH);
        assertEq(decisions.latestHash(agentId, makeAddr("other vault"), 1), bytes32(0));
        assertEq(decisions.recordCount(agentId), 3);
    }

    function testFuzz_revert_onlySigner(address caller) public {
        vm.assume(caller != signer);
        vm.expectRevert(abi.encodeWithSelector(DecisionLog.NotSigner.selector, agentId, caller));
        vm.prank(caller);
        decisions.record(agentId, vault, 1, HASH, URI);
    }

    /// The agent's owner is not its signer: owning an agent does not let you write its decisions.
    function test_revert_ownerIsNotSigner() public {
        vm.expectRevert(abi.encodeWithSelector(DecisionLog.NotSigner.selector, agentId, owner));
        vm.prank(owner);
        decisions.record(agentId, vault, 1, HASH, URI);
    }

    /// Unknown agents have no signer; even the zero address cannot record for them.
    function test_revert_unknownAgent() public {
        vm.expectRevert(abi.encodeWithSelector(DecisionLog.NotSigner.selector, 99, address(0)));
        vm.prank(address(0));
        decisions.record(99, vault, 1, HASH, URI);
    }

    function test_revert_zeroHash() public {
        vm.expectRevert(DecisionLog.ZeroHash.selector);
        vm.prank(signer);
        decisions.record(agentId, vault, 1, bytes32(0), URI);
    }

    /// Rotating the signer in the AgentRegistry revokes the old key here at once and hands the log to the new one.
    function test_rotatedSignerLosesAccess() public {
        vm.prank(signer);
        decisions.record(agentId, vault, 1, HASH, URI);

        address rotated = makeAddr("rotated");
        vm.prank(owner);
        registry.setSigner(agentId, rotated);

        vm.expectRevert(abi.encodeWithSelector(DecisionLog.NotSigner.selector, agentId, signer));
        vm.prank(signer);
        decisions.record(agentId, vault, 2, HASH, URI);

        vm.prank(rotated);
        decisions.record(agentId, vault, 2, HASH, URI);
        assertEq(decisions.latestHash(agentId, vault, 2), HASH);
    }

    /// A signer can only write under its own agent id.
    function test_revert_signerOfAnotherAgent() public {
        address other = makeAddr("other signer");
        vm.prank(owner);
        uint256 otherId = registry.register(other, owner, 0);
        vm.expectRevert(abi.encodeWithSelector(DecisionLog.NotSigner.selector, agentId, other));
        vm.prank(other);
        decisions.record(agentId, vault, 1, HASH, URI);
        vm.prank(other);
        decisions.record(otherId, vault, 1, HASH, URI);
        assertEq(decisions.recordCount(otherId), 1);
        assertEq(decisions.recordCount(agentId), 0);
    }
}
