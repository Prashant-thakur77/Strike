// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {DecisionLog} from "../../src/agents/DecisionLog.sol";
import {EpochManager} from "../../src/core/EpochManager.sol";
import {MandateGuard} from "../../src/libraries/MandateGuard.sol";
import {AdversarialBase} from "./AdversarialBase.sol";
import {IERC1155Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Vm} from "forge-std/Vm.sol";

/// @notice REPLAY: a call that already took effect is sent again (settle, abort, cancel, a decision record, a
///         proposal). Each test asserts that the second call reverts or is a no-op, and that no balance moved twice.
///         The v3 signer-consent replays are in the v3-contracts branch. Map: docs/security/adversarial.md#replay.
contract AdversarialReplayTest is AdversarialBase {
    struct Books {
        uint256 vaultAssets;
        uint256 managerTsla;
        uint256 managerUsdg;
        uint256 vaultUsdg;
        uint256 feesAgent;
        uint256 feesTreasury;
        uint256 alicePremium;
        uint256 escrow;
        uint64 epoch;
        uint32 settledEpochs;
    }

    function _books(uint256 seriesId) internal view returns (Books memory b) {
        b.vaultAssets = callVault.totalAssets();
        b.managerTsla = tsla.balanceOf(address(manager));
        b.managerUsdg = usdg.balanceOf(address(manager));
        b.vaultUsdg = usdg.balanceOf(address(callVault));
        b.feesAgent = fees.claimable(agent);
        b.feesTreasury = fees.claimable(treasury);
        b.alicePremium = callVault.pendingPremium(alice);
        b.escrow = manager.getSeries(seriesId).escrow;
        b.epoch = callVault.currentEpoch();
        (b.settledEpochs,) = registry.track(agentId);
    }

    /// `settle` is replayed by the keeper with the same round, by a stranger with a later round, and the oracle's
    /// record is replayed with a later, higher print. The epoch is closed, so `settle` reverts; the oracle returns the
    /// price it recorded the first time and emits nothing. No payout, premium, fee or track record is counted twice.
    function test_ADV_REPLAY_settleTwice() public {
        _depositCall(alice, 100 * WAD);
        uint256 id = _openAndPropose(callVault, 275 * WAD, 100 * WAD);
        _buy(id, 60 * WAD);
        uint80 round = _expireAt(300e8);
        manager.settle(address(callVault), round);
        Books memory before = _books(id);
        assertEq(before.settledEpochs, 1);

        bytes memory closed = _wrongState(EpochManager.EpochState.Selling, EpochManager.EpochState.Idle);
        vm.prank(keeper);
        vm.expectRevert(closed);
        manager.settle(address(callVault), round);
        uint80 later = feed.set(400e8);
        vm.prank(bob);
        vm.expectRevert(closed);
        manager.settle(address(callVault), later);

        vm.recordLogs();
        assertEq(oracle.recordSettlementPrice(address(tsla), FRIDAY_CLOSE, later), 300e18, "first record stands");
        assertEq(vm.getRecordedLogs().length, 0, "a replayed record is a no-op");

        Books memory afterwards = _books(id);
        assertEq(keccak256(abi.encode(afterwards)), keccak256(abi.encode(before)), "nothing moved twice");
        assertEq(manager.getSeries(id).settlementPrice, 300e18);
    }

    /// An abort is replayed by the curator and, after the timeout, by a stranger; an emergency cancel is replayed by
    /// the guardian. Both close only once: the slashed bond reaches depositors once, the vault's epoch counter moves
    /// once, and the cancelled series refunds its premium once (a second redeem of the same options reverts).
    function test_ADV_REPLAY_abortAndCancelTwice() public {
        _depositCall(alice, 100 * WAD);
        vm.prank(agent);
        manager.openEpoch(address(callVault));
        vm.prank(agent);
        manager.proposeSeries(address(callVault), 252 * WAD, FRIDAY_CLOSE, 50 * WAD, 10_000); // rejected: slash
        vm.prank(curator);
        manager.abortEpoch(address(callVault));
        uint256 comp = callVault.pendingPremium(alice);
        assertApproxEqAbs(comp, SLASH, 1, "the slash reached depositors");
        uint256 vaultUsdg = usdg.balanceOf(address(callVault));

        bytes memory notOpen = _wrongState(EpochManager.EpochState.Open, EpochManager.EpochState.Idle);
        vm.prank(curator);
        vm.expectRevert(notOpen);
        manager.abortEpoch(address(callVault));
        vm.warp(MONDAY + 1 days);
        feed.set(250e8);
        vm.prank(buyer);
        vm.expectRevert(notOpen);
        manager.abortEpoch(address(callVault));
        assertEq(callVault.pendingPremium(alice), comp);
        assertEq(usdg.balanceOf(address(callVault)), vaultUsdg);
        assertEq(manager.compensation(address(callVault)), 0);
        assertEq(callVault.currentEpoch(), 1);

        // Epoch 2 (Tuesday): a series sells and is never settled; the guardian cancels it after the grace period.
        uint256 id = _openAndPropose(callVault, 270 * WAD, 50 * WAD);
        uint256 premium = _buy(id, 20 * WAD);
        vm.warp(FRIDAY_CLOSE + 7 days);
        vm.prank(guardian);
        manager.emergencyCancel(address(callVault));
        vm.prank(guardian);
        vm.expectRevert(_wrongState(EpochManager.EpochState.Selling, EpochManager.EpochState.Idle));
        manager.emergencyCancel(address(callVault));
        assertEq(callVault.currentEpoch(), 2);

        vm.prank(buyer);
        assertEq(manager.redeem(id, 20 * WAD, buyer), premium);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(IERC1155Errors.ERC1155InsufficientBalance.selector, buyer, 0, 1, id));
        manager.redeem(id, 1, buyer);
        assertEq(manager.getSeries(id).escrow, 0);
        assertEq(usdg.balanceOf(buyer), premium, "refunded once");
    }

    /// A decision record is anchored again. By design `DecisionLog` is an append-only anchor: the agent's own signer
    /// may re-send a record (the latest hash for that agent, vault and epoch is kept, every anchor stays in the event
    /// log), so a replayed record can move `latestHash` back to an older hash; a reader that needs the record the
    /// agent stood by at a given time reads the events with their block times. Nobody else can replay it: the same
    /// calldata from another address, or from the agent's previous key after a rotation, reverts NotSigner.
    function test_ADV_REPLAY_decisionLogRecordReplay() public {
        DecisionLog log = new DecisionLog(registry);
        bytes32 v1 = keccak256("record v1");
        bytes32 v2 = keccak256("record v2 (corrected)");
        vm.prank(agent);
        log.record(agentId, address(callVault), 1, v1, "ipfs://v1");

        vm.recordLogs();
        vm.prank(agent);
        log.record(agentId, address(callVault), 1, v1, "ipfs://v1");
        Vm.Log[] memory entries = vm.getRecordedLogs();
        assertEq(entries.length, 1, "each anchor is an event");
        assertEq(entries[0].topics[0], DecisionLog.DecisionRecorded.selector);
        assertEq(log.latestHash(agentId, address(callVault), 1), v1, "same hash, same latest");
        assertEq(log.recordCount(agentId), 2);

        vm.prank(agent);
        log.record(agentId, address(callVault), 1, v2, "ipfs://v2");
        assertEq(log.latestHash(agentId, address(callVault), 1), v2, "a correction re-anchors");
        vm.prank(agent);
        log.record(agentId, address(callVault), 1, v1, "ipfs://v1");
        assertEq(log.latestHash(agentId, address(callVault), 1), v1, "a replay by the signer moves latestHash back");
        assertEq(log.latestHash(agentId, address(callVault), 2), bytes32(0), "other epochs untouched");

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(DecisionLog.NotSigner.selector, agentId, bob));
        log.record(agentId, address(callVault), 1, v2, "ipfs://v2");
        address fresh = makeAddr("fresh");
        vm.prank(agent);
        registry.setSigner(agentId, fresh);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(DecisionLog.NotSigner.selector, agentId, agent));
        log.record(agentId, address(callVault), 1, v2, "ipfs://v2");
        assertEq(log.latestHash(agentId, address(callVault), 1), v1);
        assertEq(log.recordCount(agentId), 4);
    }

    /// The agent re-sends its accepted proposal, a bigger one, or the same by delta while the series sells, and tries
    /// to re-open the epoch. All revert on the epoch state before any check, so nothing is slashed and the open
    /// series (size, sales, premium, collateral) is untouched. After settlement, the old proposal in a new epoch is
    /// an expired one: the dry run reports TenorOutOfRange, so it cannot recreate the series.
    function test_ADV_REPLAY_proposalForOpenSeries() public {
        _depositCall(alice, 100 * WAD);
        uint256 id = _openAndPropose(callVault, 275 * WAD, 50 * WAD);
        _buy(id, 20 * WAD);
        bytes32 before = keccak256(abi.encode(manager.getSeries(id)));

        bytes memory selling = _wrongState(EpochManager.EpochState.Open, EpochManager.EpochState.Selling);
        vm.startPrank(agent);
        vm.expectRevert(selling);
        manager.proposeSeries(address(callVault), 275 * WAD, FRIDAY_CLOSE, 50 * WAD, 10_000);
        vm.expectRevert(selling);
        manager.proposeSeries(address(callVault), 280 * WAD, FRIDAY_CLOSE, 100 * WAD, 10_000);
        vm.expectRevert(selling);
        manager.proposeByDelta(address(callVault), 2000, FRIDAY_CLOSE, 50 * WAD, 10_000);
        vm.expectRevert(_wrongState(EpochManager.EpochState.Idle, EpochManager.EpochState.Selling));
        manager.openEpoch(address(callVault));
        vm.stopPrank();

        assertEq(keccak256(abi.encode(manager.getSeries(id))), before, "the open series is untouched");
        assertEq(_bond(), 1000e6);
        assertEq(_strikes(), 0);
        assertEq(registry.getAgent(agentId).accepted, 1);

        manager.settle(address(callVault), _expireAt(260e8));
        vm.warp(NEXT_MONDAY);
        feed.set(250e8);
        vm.prank(agent);
        manager.openEpoch(address(callVault));
        (MandateGuard.Reason r,,,) =
            manager.previewProposal(address(callVault), 275 * WAD, FRIDAY_CLOSE, 50 * WAD, 10_000);
        assertEq(uint8(r), uint8(MandateGuard.Reason.TenorOutOfRange));
        assertTrue(manager.getSeries(id).settled, "the old series stays settled");
    }
}
