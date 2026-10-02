// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {EpochManager} from "../../src/core/EpochManager.sol";
import {RiskLens} from "../../src/core/RiskLens.sol";
import {IRiskEngine} from "../../src/interfaces/IRiskEngine.sol";
import {SafeStockFeed} from "../../src/libraries/SafeStockFeed.sol";
import {BlackScholesRef} from "../../src/pricing/BlackScholesRef.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";
import {AdversarialBase} from "./AdversarialBase.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @dev The Stylus program prices (quote, strikeForDelta) but its risk part reverts.
contract RiskDownEngine is IRiskEngine {
    BlackScholesRef internal immutable ref;

    error RiskEngineDown();

    constructor(BlackScholesRef ref_) {
        ref = ref_;
    }

    function quote(uint256 spot, uint256 strike, uint256 t, uint256 sigma, bool isCall)
        external
        view
        returns (uint256, int256)
    {
        return ref.quote(spot, strike, t, sigma, isCall);
    }

    function strikeForDelta(uint256 spot, uint256 delta, uint256 t, uint256 sigma, bool isCall)
        external
        view
        returns (uint256)
    {
        return ref.strikeForDelta(spot, delta, t, sigma, isCall);
    }

    function greeks(uint256, uint256, uint256, uint256, bool) external pure returns (int256, uint256, uint256, int256) {
        revert RiskEngineDown();
    }

    function impliedVol(uint256, uint256, uint256, uint256, bool) external pure returns (uint256) {
        revert RiskEngineDown();
    }

    function scenarioLoss(bool, uint256, uint256, uint256, int256[] calldata)
        external
        pure
        returns (uint256, uint256[] memory)
    {
        revert RiskEngineDown();
    }
}

/// @notice OFFLINE, v3 only: the risk engine and `RiskLens`. The v2 pricer outage is in `Offline.t.sol` on main;
///         the I-01 regression is `test_AUDIT3_info_pricerWithoutRiskEngineBlocksAcceptedProposals`.
///         Map: docs/security/adversarial.md#offline (on main).
contract AdversarialOfflineV3Test is AdversarialBase {
    /// The risk part of the Stylus engine starts reverting mid-week (I-01). Sales go on (a buy needs only the quote);
    /// the live risk view reverts rather than show a number; an accepted proposal reverts on the `SeriesRisk` call
    /// while a rejected one is still slashed (the verdict comes first). Nobody is stuck: the open epoch is aborted,
    /// the series sold before settles and pays, and with a full engine back the next proposal is accepted.
    function test_ADV_OFFLINE_riskEngineReverts() public {
        RiskLens lens = new RiskLens(manager);
        _depositCall(alice, 100 * WAD);
        _depositPut(alice, 30_000 * USDG_UNIT);
        uint256 id = _openAndPropose(callVault, 275 * WAD, 100 * WAD);
        _buy(id, 40 * WAD);
        RiskDownEngine broken = new RiskDownEngine(pricer);
        vm.prank(admin);
        manager.setPricer(broken);
        bytes memory down = abi.encodeWithSelector(RiskDownEngine.RiskEngineDown.selector);

        _buy(id, 10 * WAD);
        vm.expectRevert(down);
        lens.seriesRisk(id);

        vm.prank(agent);
        manager.openEpoch(address(putVault));
        vm.prank(agent);
        vm.expectRevert(down);
        manager.proposeSeries(address(putVault), 235 * WAD, FRIDAY_CLOSE, 50 * WAD, 10_000);
        assertEq(_strikes(), 0);
        vm.prank(agent);
        (bool ok,) = manager.proposeSeries(address(putVault), 248 * WAD, FRIDAY_CLOSE, 50 * WAD, 10_000);
        assertFalse(ok, "out of the delta band");
        assertEq(_strikes(), 1, "a rejection does not need the risk engine");

        vm.warp(MONDAY + 1 days);
        vm.prank(bob);
        manager.abortEpoch(address(putVault));
        assertFalse(putVault.locked());
        manager.settle(address(callVault), _expireAt(300e8));
        uint256 perOption = Math.mulDiv(25 * WAD, WAD, 300 * WAD);
        vm.prank(buyer);
        assertEq(manager.redeem(id, 50 * WAD, buyer), Math.mulDiv(50 * WAD, perOption, WAD));

        vm.prank(admin);
        manager.setPricer(pricer);
        vm.warp(NEXT_MONDAY);
        feed.set(250e8);
        vm.prank(agent);
        manager.openEpoch(address(putVault));
        vm.prank(agent);
        (ok,) = manager.proposeSeries(address(putVault), 235 * WAD, NEXT_FRIDAY_CLOSE, 50 * WAD, 10_000);
        assertTrue(ok);
    }

    /// The risk panel's live view reads the protocol's own SafeStockFeed spot. With the token or its oracle paused, a
    /// zero answer, a stale print or the sequencer down, it reverts with the protocol's error instead of showing a
    /// risk computed at a price the protocol would not trade at. When the feed recovers it prices at the fresh print;
    /// once settled, the series shows no exposure (L-04).
    function test_ADV_OFFLINE_riskLensRefusesUnsafeFeed() public {
        RiskLens lens = new RiskLens(manager);
        _depositCall(alice, 100 * WAD);
        uint256 id = _openAndPropose(callVault, 275 * WAD, 100 * WAD);
        _buy(id, 60 * WAD);
        assertGt(lens.seriesRisk(id).worstLoss, 0);

        tsla.setTokenPaused(true);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.TokenPaused.selector, address(tsla)));
        lens.seriesRisk(id);
        tsla.setTokenPaused(false);
        tsla.setOraclePaused(true);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.FeedPaused.selector, address(tsla)));
        lens.seriesRisk(id);
        tsla.setOraclePaused(false);
        feed.set(0);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.InvalidPrice.selector, int256(0)));
        lens.seriesRisk(id);
        uint256 printedAt = block.timestamp;
        feed.set(250e8);
        vm.warp(block.timestamp + 25 hours);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.StalePrice.selector, printedAt, 1 days));
        lens.seriesRisk(id);

        feed.set(255e8);
        MockAggregator sequencer = new MockAggregator(0);
        sequencer.push(1, block.timestamp);
        vm.prank(admin);
        oracle.setSequencerFeed(sequencer, 1 hours);
        vm.expectRevert(SafeStockFeed.SequencerDown.selector);
        lens.seriesRisk(id);
        sequencer.push(0, block.timestamp - 2 hours);

        feed.set(260e8);
        RiskLens.SeriesRisk memory r = lens.seriesRisk(id);
        assertEq(r.spot, 260 * WAD, "the fresh print");
        assertEq(r.sold, 60 * WAD);
        assertGt(r.worstLoss, 0);

        manager.settle(address(callVault), _expireAt(300e8));
        r = lens.seriesRisk(id);
        assertEq(r.worstLoss, 0, "settled: nothing more to lose");
        assertEq(r.delta, 0);
    }
}
