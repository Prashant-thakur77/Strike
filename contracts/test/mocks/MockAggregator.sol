// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IAggregatorV3} from "../../src/interfaces/IAggregatorV3.sol";

/// @notice Chainlink-style feed with real round history. Round ids follow the proxy format
///         (phaseId << 64) | aggregatorRoundId.
contract MockAggregator is IAggregatorV3 {
    struct Round {
        int256 answer;
        uint256 updatedAt;
    }

    uint8 public immutable decimals;
    uint16 public phaseId = 1;
    uint64 public aggregatorRound;
    mapping(uint80 roundId => Round) internal _rounds;

    error NoDataPresent();

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }

    function description() external pure returns (string memory) {
        return "MOCK / USD";
    }

    function currentRoundId() public view returns (uint80) {
        return uint80((uint256(phaseId) << 64) | aggregatorRound);
    }

    /// @notice Record a new round.
    function push(int256 answer, uint256 updatedAt) public returns (uint80 roundId) {
        ++aggregatorRound;
        roundId = currentRoundId();
        _rounds[roundId] = Round(answer, updatedAt);
    }

    /// @notice Record a round at the current time.
    function set(int256 answer) external returns (uint80) {
        return push(answer, block.timestamp);
    }

    /// @notice Simulate an aggregator upgrade: round numbering restarts in a new phase.
    function newPhase() external {
        ++phaseId;
        aggregatorRound = 0;
    }

    function getRoundData(uint80 roundId) public view returns (uint80, int256, uint256, uint256, uint80) {
        Round memory r = _rounds[roundId];
        if (r.updatedAt == 0) revert NoDataPresent();
        return (roundId, r.answer, r.updatedAt, r.updatedAt, roundId);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return getRoundData(currentRoundId());
    }
}
