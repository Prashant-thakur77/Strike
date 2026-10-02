// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {EpochManager} from "../../src/core/EpochManager.sol";
import {IPricer} from "../../src/interfaces/IPricer.sol";
import {SafeStockFeed} from "../../src/libraries/SafeStockFeed.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";
import {AdversarialBase} from "./AdversarialBase.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @dev The pricer program is unreachable or reverts (for a Stylus program: evicted from the cache, out of ink).
contract DeadPricer is IPricer {
    error PricerDown();

    function quote(uint256, uint256, uint256, uint256, bool) external pure returns (uint256, int256) {
        revert PricerDown();
    }

    function strikeForDelta(uint256, uint256, uint256, uint256, bool) external pure returns (uint256) {
        revert PricerDown();
    }
}

/// @notice OFFLINE: a party the protocol depends on stops (the keeper and its feed, the agent, the token's oracle,
///         the pricer, the L2 sequencer). Each test asserts that nothing is sold or paid at a price that is not safe,
///         that settlement waits for the first print after expiry however late, and that depositors get out.
///         Map: docs/security/adversarial.md#offline.
contract AdversarialOfflineTest is AdversarialBase {
    /// The keeper stops after Monday's print. From Tuesday the feed is stale: no buy, no quote, no new epoch. After
    /// expiry the last print predates it, so settlement refuses it and waits; the guardian cannot cancel either.
    /// When the keeper comes back and copies the missed rounds, a depositor settles at the first print after expiry,
    /// not at the stale one and not at a later one.
    function test_ADV_OFFLINE_keeperStopsFeedGoesStale() public {
        _depositCall(alice, 100 * WAD);
        _depositPut(alice, 30_000 * USDG_UNIT);
        uint256 id = _openAndPropose(callVault, 275 * WAD, 100 * WAD);
        _buy(id, 50 * WAD);

        vm.warp(MONDAY + 25 hours);
        bytes memory stale = abi.encodeWithSelector(SafeStockFeed.StalePrice.selector, MONDAY, 1 days);
        vm.prank(buyer);
        vm.expectRevert(stale);
        manager.buy(id, WAD, type(uint256).max, buyer);
        vm.expectRevert(stale);
        manager.quoteBuy(id, WAD);
        vm.prank(agent);
        vm.expectRevert(stale);
        manager.openEpoch(address(putVault));

        vm.warp(FRIDAY_CLOSE + 2 days);
        uint80 last = feed.currentRoundId();
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.InvalidSettlementRound.selector, last));
        manager.settle(address(callVault), last);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(EpochManager.TooEarly.selector, uint256(FRIDAY_CLOSE) + 7 days));
        manager.emergencyCancel(address(callVault));
        assertTrue(callVault.locked(), "settlement waits");

        uint80 first = feed.push(280e8, FRIDAY_CLOSE + 30); // the missed mainnet round, with its own timestamp
        uint80 later = feed.push(320e8, FRIDAY_CLOSE + 1 hours);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.InvalidSettlementRound.selector, later));
        manager.settle(address(callVault), later);
        vm.prank(alice);
        manager.settle(address(callVault), first);
        EpochManager.Series memory s = manager.getSeries(id);
        assertEq(s.settlementPrice, 280 * WAD);
        assertEq(s.payoutPerOption, Math.mulDiv(5 * WAD, WAD, 280 * WAD));
        assertEq(manager.getSeries(id).sold, 50 * WAD, "nothing sold while stale");
    }

    /// The agent opens the epoch and goes silent. While it waits, deposits and redemptions queue. A stranger cannot
    /// abort before `proposalTimeout`, and can from the second it passes; the queue is processed at an unchanged share
    /// price, so everyone gets out whole. Silence costs the agent nothing, and the depositors nothing either.
    function test_ADV_OFFLINE_agentNeverProposes() public {
        _depositCall(alice, 100 * WAD);
        vm.prank(agent);
        manager.openEpoch(address(callVault));
        _requestDepositCall(bob, 40 * WAD);
        vm.prank(alice);
        callVault.requestRedeem(50 * WAD);

        vm.warp(MONDAY + 1 days - 1);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(EpochManager.TooEarly.selector, MONDAY + 1 days));
        manager.abortEpoch(address(callVault));
        vm.warp(MONDAY + 1 days);
        vm.prank(buyer);
        manager.abortEpoch(address(callVault));

        assertFalse(callVault.locked());
        assertEq(uint8(_state(callVault)), uint8(EpochManager.EpochState.Idle));
        assertEq(callVault.claimRedeem(alice), 50 * WAD);
        uint256 bobShares = callVault.claimDeposit(bob);
        assertEq(callVault.convertToAssets(bobShares), 40 * WAD);
        vm.prank(alice);
        callVault.redeem(50 * WAD, alice, alice);
        assertEq(tsla.balanceOf(alice), 100 * WAD, "Alice is whole");
        assertEq(_bond(), 1000e6);
        assertEq(_strikes(), 0);
    }

    /// Friday afternoon the issuer pauses the token's oracle, and over the weekend the token too. Sales stop at once;
    /// after expiry settlement reverts TokenPaused or FeedPaused and waits, and the guardian cannot turn the payout
    /// into a refund. On Monday the oracle resumes and prints: that print, the first after expiry, settles the series
    /// three days late; the pre-expiry print and any later print are refused.
    function test_ADV_OFFLINE_tokenOrOraclePausedAtExpiry() public {
        _depositCall(alice, 100 * WAD);
        uint256 id = _openAndPropose(callVault, 275 * WAD, 100 * WAD);
        _buy(id, 60 * WAD);
        vm.warp(FRIDAY_CLOSE - 2 hours);
        uint80 last = feed.set(270e8);
        tsla.setOraclePaused(true);
        bytes memory feedPaused = abi.encodeWithSelector(SafeStockFeed.FeedPaused.selector, address(tsla));
        vm.prank(buyer);
        vm.expectRevert(feedPaused);
        manager.buy(id, WAD, type(uint256).max, buyer);

        vm.warp(FRIDAY_CLOSE + 1 days);
        tsla.setTokenPaused(true);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.TokenPaused.selector, address(tsla)));
        manager.settle(address(callVault), last);
        tsla.setTokenPaused(false);
        vm.expectRevert(feedPaused);
        manager.settle(address(callVault), last);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(EpochManager.TooEarly.selector, uint256(FRIDAY_CLOSE) + 7 days));
        manager.emergencyCancel(address(callVault));
        assertTrue(callVault.locked(), "settlement waits");
        assertEq(oracle.settlementPrice(address(tsla), FRIDAY_CLOSE), 0);

        vm.warp(FRIDAY_CLOSE + 3 days - 6 hours); // Monday 14:00 UTC
        tsla.setOraclePaused(false);
        uint80 first = feed.set(290e8);
        vm.warp(block.timestamp + 1 hours);
        uint80 later = feed.set(310e8);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.InvalidSettlementRound.selector, last));
        manager.settle(address(callVault), last);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.InvalidSettlementRound.selector, later));
        manager.settle(address(callVault), later);
        manager.settle(address(callVault), first);

        uint256 perOption = Math.mulDiv(15 * WAD, WAD, 290 * WAD);
        assertEq(manager.getSeries(id).settlementPrice, 290 * WAD);
        vm.prank(buyer);
        assertEq(manager.redeem(id, 60 * WAD, buyer), Math.mulDiv(60 * WAD, perOption, WAD));
    }

    /// The pricer starts reverting mid-week. Sales stop and no proposal can be judged: it reverts whole, inside or
    /// outside the mandate, so no agent is slashed on a missing price (only an already-expired expiry, a rule that
    /// needs no price, is still rejected and slashed). The open epoch is aborted by anyone after the timeout, and the
    /// series sold before the outage settles and pays without the pricer. (The v3 risk-engine variant, I-01, is in
    /// the v3-contracts branch.)
    function test_ADV_OFFLINE_pricerReverts() public {
        _depositCall(alice, 100 * WAD);
        _depositPut(alice, 30_000 * USDG_UNIT);
        uint256 id = _openAndPropose(callVault, 275 * WAD, 100 * WAD);
        _buy(id, 40 * WAD);
        DeadPricer dead = new DeadPricer();
        vm.prank(admin);
        manager.setPricer(dead);
        bytes memory down = abi.encodeWithSelector(DeadPricer.PricerDown.selector);

        vm.prank(buyer);
        vm.expectRevert(down);
        manager.buy(id, WAD, type(uint256).max, buyer);
        vm.prank(agent);
        manager.openEpoch(address(putVault)); // reads only the feed
        vm.startPrank(agent);
        vm.expectRevert(down);
        manager.proposeSeries(address(putVault), 235 * WAD, FRIDAY_CLOSE, 50 * WAD, 10_000);
        vm.expectRevert(down);
        manager.proposeSeries(address(putVault), 248 * WAD, FRIDAY_CLOSE, 50 * WAD, 10_000);
        vm.expectRevert(down);
        manager.proposeByDelta(address(putVault), 2000, FRIDAY_CLOSE, 50 * WAD, 10_000);
        assertEq(_strikes(), 0, "no slash on a missing price");
        (bool ok,) = manager.proposeSeries(address(putVault), 235 * WAD, uint64(block.timestamp - 1), 50 * WAD, 10_000);
        vm.stopPrank();
        assertFalse(ok);
        assertEq(_strikes(), 1, "an expired expiry needs no price to be wrong");

        vm.warp(MONDAY + 1 days);
        vm.prank(bob);
        manager.abortEpoch(address(putVault));
        assertFalse(putVault.locked());
        assertApproxEqAbs(putVault.pendingPremium(alice), SLASH, 1);

        manager.settle(address(callVault), _expireAt(300e8));
        uint256 perOption = Math.mulDiv(25 * WAD, WAD, 300 * WAD);
        vm.prank(buyer);
        assertEq(manager.redeem(id, 40 * WAD, buyer), Math.mulDiv(40 * WAD, perOption, WAD));
    }

    /// The L2 sequencer goes down on Wednesday: sales stop and no epoch opens; when it is back, prices are refused
    /// for the grace hour (the feed may lag), then sales resume. On Friday it goes down again just after the first
    /// post-expiry print: settlement waits through the downtime and the grace hour, then settles on that print; the
    /// print made after the restart is refused, and the guardian cannot cancel in between.
    function test_ADV_OFFLINE_sequencerDown() public {
        MockAggregator sequencer = new MockAggregator(0);
        sequencer.push(0, MONDAY - 1 days);
        vm.prank(admin);
        oracle.setSequencerFeed(sequencer, 1 hours);
        _depositCall(alice, 100 * WAD);
        _depositPut(alice, 30_000 * USDG_UNIT);
        uint256 id = _openAndPropose(callVault, 275 * WAD, 100 * WAD);
        _buy(id, 60 * WAD);

        vm.warp(MONDAY + 2 days);
        feed.set(255e8);
        sequencer.push(1, block.timestamp);
        vm.prank(buyer);
        vm.expectRevert(SafeStockFeed.SequencerDown.selector);
        manager.buy(id, WAD, type(uint256).max, buyer);
        vm.prank(agent);
        vm.expectRevert(SafeStockFeed.SequencerDown.selector);
        manager.openEpoch(address(putVault));

        vm.warp(block.timestamp + 2 hours);
        uint256 upSince = block.timestamp;
        sequencer.push(0, upSince);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.SequencerGracePeriod.selector, upSince));
        manager.buy(id, WAD, type(uint256).max, buyer);
        vm.warp(upSince + 1 hours);
        feed.set(255e8);
        _buy(id, 10 * WAD);

        vm.warp(FRIDAY_CLOSE + 1 minutes);
        uint80 first = feed.set(290e8);
        vm.warp(FRIDAY_CLOSE + 5 minutes);
        sequencer.push(1, block.timestamp);
        vm.expectRevert(SafeStockFeed.SequencerDown.selector);
        manager.settle(address(callVault), first);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(EpochManager.TooEarly.selector, uint256(FRIDAY_CLOSE) + 7 days));
        manager.emergencyCancel(address(callVault));

        vm.warp(FRIDAY_CLOSE + 2 hours);
        upSince = block.timestamp;
        sequencer.push(0, upSince);
        uint80 later = feed.set(300e8);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.SequencerGracePeriod.selector, upSince));
        manager.settle(address(callVault), first);
        vm.warp(upSince + 1 hours);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.InvalidSettlementRound.selector, later));
        manager.settle(address(callVault), later);
        manager.settle(address(callVault), first);
        assertEq(manager.getSeries(id).settlementPrice, 290 * WAD);
        assertEq(manager.getSeries(id).sold, 70 * WAD, "sold only while the sequencer was up and past its grace");
    }
}
