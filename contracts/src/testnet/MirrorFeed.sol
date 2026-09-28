// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IAggregatorV3} from "../interfaces/IAggregatorV3.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title MirrorFeed (TESTNET ONLY)
/// @notice Chainlink-compatible feed for testnets that have no stock-token feeds. A keeper copies each new round of
///         the matching Robinhood Chain mainnet Chainlink feed. Keeps full round history so settlement round
///         selection works exactly as on mainnet.
contract MirrorFeed is IAggregatorV3, AccessControl {
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    struct Round {
        int256 answer;
        uint64 updatedAt;
    }

    uint8 public immutable decimals;
    string public description;
    uint80 public latestRound;
    mapping(uint80 roundId => Round) internal _rounds;

    event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt);

    error NoDataPresent();
    error InvalidAnswer();
    error StaleUpdate();

    constructor(address admin, uint8 decimals_, string memory description_) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(KEEPER_ROLE, admin);
        decimals = decimals_;
        description = description_;
    }

    /// @notice Publish a new round. Timestamps must increase and may not be in the future.
    function push(int256 answer, uint64 updatedAt) external onlyRole(KEEPER_ROLE) returns (uint80 roundId) {
        if (answer <= 0) revert InvalidAnswer();
        if (updatedAt > block.timestamp || updatedAt <= _rounds[latestRound].updatedAt) revert StaleUpdate();
        roundId = ++latestRound;
        _rounds[roundId] = Round(answer, updatedAt);
        emit AnswerUpdated(answer, roundId, updatedAt);
    }

    function getRoundData(uint80 roundId) public view returns (uint80, int256, uint256, uint256, uint80) {
        Round memory r = _rounds[roundId];
        if (r.updatedAt == 0) revert NoDataPresent();
        return (roundId, r.answer, r.updatedAt, r.updatedAt, roundId);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return getRoundData(latestRound);
    }
}
