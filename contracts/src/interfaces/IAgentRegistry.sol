// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title IAgentRegistry
/// @notice What the EpochManager needs from the agent registry.
interface IAgentRegistry {
    function isActive(uint256 agentId) external view returns (bool);

    function signerOf(uint256 agentId) external view returns (address);

    function payoutOf(uint256 agentId) external view returns (address);

    /// @notice Move up to the slash amount of the agent's bond to `recipient`; returns the amount moved.
    function slash(uint256 agentId, address recipient) external returns (uint256);

    function recordAccepted(uint256 agentId) external;
}
