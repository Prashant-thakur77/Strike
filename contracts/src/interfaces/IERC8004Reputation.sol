// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title IERC8004Reputation
/// @notice ERC-8004 (Trustless Agents) Reputation Registry, as deployed at 0x8004BAa1…9b63 (mainnets) and
///         0x8004B663…8713 (testnets). The submitter must not be the agent's owner or operator.
interface IERC8004Reputation {
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external;
}
