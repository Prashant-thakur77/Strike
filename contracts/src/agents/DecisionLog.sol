// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IAgentRegistry} from "../interfaces/IAgentRegistry.sol";

/// @title DecisionLog
/// @notice On-chain anchors for agents' decision records. An agent writes a record of each decision (what it saw,
///         what it chose and why, what it sent) off-chain, for example as JSON in a public repository, and commits its
///         keccak256 hash here together with where the record lives. Anyone can then check that the published
///         record is the one the agent anchored, and when.
/// @dev Additive: it reads the live AgentRegistry and changes nothing in the protocol. Only an agent's current signer
///      key (`AgentRegistry.signerOf`) may record for it, so rotating the signer revokes the old key here too. A
///      record can be re-anchored (a corrected record for the same epoch); the latest hash per (agent, vault, epoch)
///      is kept and every anchor stays in the event log.
contract DecisionLog {
    /// @notice The agent registry whose signers may record.
    IAgentRegistry public immutable registry;

    /// @notice Latest anchored record hash per (agent, vault, epoch); zero if none.
    mapping(uint256 agentId => mapping(address vault => mapping(uint64 epoch => bytes32 recordHash))) public latestHash;

    /// @notice Number of records anchored per agent.
    mapping(uint256 agentId => uint256 count) public recordCount;

    event DecisionRecorded(
        uint256 indexed agentId,
        address indexed vault,
        uint64 indexed epoch,
        bytes32 recordHash,
        string uri,
        uint256 timestamp
    );

    error ZeroAddress();
    error NotSigner(uint256 agentId, address caller);
    error ZeroHash();

    constructor(IAgentRegistry registry_) {
        if (address(registry_) == address(0)) revert ZeroAddress();
        registry = registry_;
    }

    /// @notice Anchor a decision record. Callable only by the agent's current signer.
    /// @param agentId The agent (AgentRegistry id).
    /// @param vault The vault the decision was about.
    /// @param epoch The vault's epoch (`StrikeVault.currentEpoch`) the decision was for.
    /// @param recordHash keccak256 of the record's exact bytes.
    /// @param uri Where the record is published (for example its GitHub URL).
    function record(uint256 agentId, address vault, uint64 epoch, bytes32 recordHash, string calldata uri) external {
        address signer = registry.signerOf(agentId);
        if (signer == address(0) || msg.sender != signer) revert NotSigner(agentId, msg.sender);
        if (recordHash == bytes32(0)) revert ZeroHash();
        latestHash[agentId][vault][epoch] = recordHash;
        ++recordCount[agentId];
        emit DecisionRecorded(agentId, vault, epoch, recordHash, uri, block.timestamp);
    }
}
