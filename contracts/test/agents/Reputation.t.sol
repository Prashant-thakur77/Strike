// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AgentRegistry} from "../../src/agents/AgentRegistry.sol";
import {IERC8004Reputation} from "../../src/interfaces/IERC8004Reputation.sol";
import {MockIdentityRegistry} from "../mocks/MockIdentityRegistry.sol";
import {MockReputationRegistry} from "../mocks/MockReputationRegistry.sol";
import {StrikeBase} from "../utils/StrikeBase.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/// @notice Settled epochs and mandate rejections are posted to the agent's ERC-8004 identity as feedback.
contract ReputationTest is StrikeBase {
    MockIdentityRegistry internal identity;
    MockReputationRegistry internal reputation;
    uint256 internal identityId;

    function setUp() public override {
        super.setUp();
        identity = new MockIdentityRegistry();
        reputation = new MockReputationRegistry();
        vm.startPrank(admin);
        registry.setIdentityRegistry(IERC721(address(identity)));
        registry.setReputationRegistry(reputation);
        vm.stopPrank();
        vm.startPrank(agent);
        identityId = identity.register();
        registry.setIdentity(agentId, identityId);
        vm.stopPrank();
        _depositCall(alice, 100 * WAD);
    }

    function test_settledEpochPostsPnlFeedback() public {
        uint256 seriesId = _openAndPropose(callVault, 275 * WAD, 50 * WAD);
        uint256 premium = _buy(seriesId, 50 * WAD);
        manager.settle(address(callVault), _expireAt(260e8)); // out of the money: PnL = premium

        (uint32 epochs, int256 cumulative) = registry.track(agentId);
        assertEq(epochs, 1);
        assertEq(cumulative, int256(premium));
        assertEq(reputation.count(), 1);
        (uint256 id, int128 value, uint8 dec, string memory tag, address client) = reputation.feedback(0);
        assertEq(id, identityId);
        assertEq(int256(value), int256(premium));
        assertEq(dec, 6);
        assertEq(tag, "strike.epoch.pnl");
        assertEq(client, address(registry)); // the protocol, never the agent's owner
    }

    function test_losingEpochPostsNegativePnl() public {
        uint256 seriesId = _openAndPropose(callVault, 275 * WAD, 50 * WAD);
        _buy(seriesId, 50 * WAD);
        manager.settle(address(callVault), _expireAt(330e8));
        (, int256 cumulative) = registry.track(agentId);
        assertLt(cumulative, 0);
        (, int128 value,,,) = reputation.feedback(0);
        assertLt(value, 0);
    }

    function test_rejectionPostsNegativeFeedback() public {
        vm.prank(agent);
        manager.openEpoch(address(callVault));
        vm.prank(agent);
        manager.proposeSeries(address(callVault), 252 * WAD, FRIDAY_CLOSE, 1, 10_000);
        (, int128 value,, string memory tag,) = reputation.feedback(0);
        assertEq(int256(value), -int256(SLASH));
        assertEq(tag, "strike.mandate.rejection");
    }

    function test_brokenRegistryNeverBlocksSettlement() public {
        reputation.setBroken(true);
        uint256 seriesId = _openAndPropose(callVault, 275 * WAD, 10 * WAD);
        _buy(seriesId, 10 * WAD);
        vm.warp(FRIDAY_CLOSE + 60);
        uint80 r = feed.set(250e8);
        vm.expectEmit(true, true, false, false, address(registry));
        emit AgentRegistry.ReputationFeedback(agentId, identityId, int128(0), "strike.epoch.pnl", false);
        manager.settle(address(callVault), r);
        assertFalse(callVault.locked());
        assertEq(reputation.count(), 0);
    }

    function test_noIdentityNoFeedback() public {
        vm.prank(agent);
        registry.setIdentity(agentId, 0);
        uint256 seriesId = _openAndPropose(callVault, 275 * WAD, 10 * WAD);
        _buy(seriesId, 10 * WAD);
        manager.settle(address(callVault), _expireAt(250e8));
        assertEq(reputation.count(), 0);
        (uint32 epochs,) = registry.track(agentId);
        assertEq(epochs, 1);
    }

    function test_recordEpochResult_onlySlasher() public {
        vm.expectRevert();
        registry.recordEpochResult(agentId, 1);
    }

    function test_setReputationRegistry_onlyAdmin() public {
        vm.expectRevert();
        registry.setReputationRegistry(IERC8004Reputation(address(0)));
    }
}
