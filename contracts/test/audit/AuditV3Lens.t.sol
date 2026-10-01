// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {EpochManager} from "../../src/core/EpochManager.sol";
import {RiskLens} from "../../src/core/RiskLens.sol";
import {StrikeBase} from "../utils/StrikeBase.sol";
import {Vm} from "forge-std/Vm.sol";

/// @notice Audit 2026-10-01 (v3): the `RiskLens` view the app's risk panel reads.
contract AuditV3LensTest is StrikeBase {
    RiskLens internal lens;

    function setUp() public override {
        super.setUp();
        lens = new RiskLens(manager);
        _depositCall(alice, 100 * WAD);
        _depositPut(alice, 100_000 * USDG_UNIT);
    }

    function _assertNoExposure(RiskLens.SeriesRisk memory r) internal pure {
        assertEq(r.worstLoss, 0, "worst loss");
        assertEq(r.worstPayout, 0, "worst payout");
        assertEq(r.worstShock, 0, "worst shock");
        assertEq(r.tenor, 0);
        assertEq(r.delta, 0);
        assertEq(r.gamma, 0);
        assertEq(r.vega, 0);
        assertEq(r.theta, 0);
        for (uint256 i; i < r.losses.length; ++i) {
            assertEq(r.losses[i], 0, "loss at a shock");
        }
    }

    /// The single SeriesRisk log among the recorded ones, for series `id`.
    function _seriesRiskLog(uint256 id) internal returns (int256 d, uint256 g, uint256 v, int256 t) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 seen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != EpochManager.SeriesRisk.selector) continue;
            ++seen;
            assertEq(logs[i].topics[1], bytes32(id));
            (d, g, v, t) = abi.decode(logs[i].data, (int256, uint256, uint256, int256));
        }
        assertEq(seen, 1, "SeriesRisk logs");
    }

    // ================================================================== L-04
    /// FIXED (L-04): a settled series has no exposure left, and the lens says so.
    /// Before the fix `seriesRisk` and `seriesRiskAt` ignored `settled` and `cancelled`: a series whose payout was
    /// fixed at settlement (10 calls at 300, 0.83 TSLA owed) was reported with a worst case of 1,150 USD at +30% of
    /// the live spot, as if it were still open. An integrator or a history view pricing closed series with the lens
    /// would show depositors a loss that cannot happen.
    function test_AUDIT3_lensReportsSettledSeriesAsLive() public {
        uint256 id = _openAndPropose(callVault, 275 * WAD, 50 * WAD);
        _buy(id, 10 * WAD);
        manager.settle(address(callVault), _expireAt(300e8));
        EpochManager.Series memory s = manager.getSeries(id);
        assertTrue(s.settled);
        assertGt(s.escrow, 0);

        RiskLens.SeriesRisk memory r = lens.seriesRisk(id);
        assertEq(r.sold, 10 * WAD);
        assertEq(r.collateral, 10 * WAD);
        assertEq(r.losses.length, 13);
        _assertNoExposure(r);
        r = lens.seriesRiskAt(id, 1000 * WAD, 0.6e18, lens.defaultShocks());
        _assertNoExposure(r);
    }

    /// L-04 for a cancelled series: the premium is refunded and the collateral released, so nothing can be lost.
    function test_AUDIT3_lensReportsCancelledSeriesAsLive() public {
        uint256 id = _openAndPropose(putVault, 235 * WAD, 50 * WAD);
        _buy(id, 10 * WAD);
        // No settlement price is ever recorded; after the grace period the guardian cancels.
        vm.warp(FRIDAY_CLOSE + 7 days + 1);
        vm.prank(guardian);
        manager.emergencyCancel(address(putVault));
        assertTrue(manager.getSeries(id).cancelled);
        RiskLens.SeriesRisk memory r = lens.seriesRiskAt(id, 150 * WAD, 0.6e18, lens.defaultShocks());
        assertEq(r.sold, 10 * WAD);
        _assertNoExposure(r);
    }

    // ================================================================== held
    /// The live view prices with the underlying's current sigma (what buys are priced with), so a keeper update
    /// moves it; `seriesRiskAt` at the opening spot and sigma reproduces the greeks the proposal recorded.
    function test_AUDIT3_safe_lensFollowsKeeperSigmaAndMatchesProposalGreeks() public {
        vm.recordLogs();
        uint256 id = _openAndPropose(callVault, 275 * WAD, 50 * WAD);
        (int256 d, uint256 g, uint256 v, int256 t) = _seriesRiskLog(id);
        RiskLens.SeriesRisk memory r = lens.seriesRiskAt(id, 250 * WAD, 0.6e18, lens.defaultShocks());
        assertEq(r.delta, d);
        assertEq(r.gamma, g);
        assertEq(r.vega, v);
        assertEq(r.theta, t);
        assertEq(lens.seriesRisk(id).sigma, 0.6e18);

        vm.warp(block.timestamp + 1 hours);
        vm.prank(keeper);
        manager.setSigma(address(tsla), 0.7e18);
        r = lens.seriesRisk(id);
        assertEq(r.sigma, 0.7e18);
        assertGt(r.delta, d, "a higher sigma raises an out-of-the-money call's delta");
    }
}
