// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC8004Reputation} from "../../src/interfaces/IERC8004Reputation.sol";

/// @notice Records ERC-8004 feedback; can be switched to revert to prove feedback never blocks the protocol.
contract MockReputationRegistry is IERC8004Reputation {
    struct Feedback {
        uint256 agentId;
        int128 value;
        uint8 decimals;
        string tag;
        address client;
    }

    Feedback[] public feedback;
    bool public broken;

    function setBroken(bool b) external {
        broken = b;
    }

    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata,
        string calldata,
        string calldata,
        bytes32
    ) external {
        require(!broken, "broken");
        feedback.push(Feedback(agentId, value, valueDecimals, tag1, msg.sender));
    }

    function count() external view returns (uint256) {
        return feedback.length;
    }
}
