// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {EpochManager} from "../../src/core/EpochManager.sol";
import {RiskLens} from "../../src/core/RiskLens.sol";
import {RiskLib} from "../../src/pricing/RiskLib.sol";
import {StrikeVault} from "../../src/vaults/StrikeVault.sol";
import {StrikeBase} from "../utils/StrikeBase.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Vm} from "forge-std/Vm.sol";

/// @notice The risk engine inside the protocol: greeks recorded at proposal (`SeriesRisk`) and the `RiskLens` view.
contract RiskLensTest is StrikeBase {
    RiskLens internal lens;

    function setUp() public override {
        super.setUp();
        lens = new RiskLens(manager);
        _depositCall(alice, 100 * WAD);
        _depositPut(alice, 100_000 * USDG_UNIT);
    }

    function _wideGrid() internal pure returns (int256[] memory shocks) {
        shocks = new int256[](7);
        (shocks[0], shocks[1], shocks[2], shocks[3]) = (-0.9999e18, -0.5e18, -0.3e18, 0);
        (shocks[4], shocks[5], shocks[6]) = (0.3e18, 1e18, 10e18);
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

    // ---------------------------------------------------------------- SeriesRisk at proposal

    function test_proposal_emitsSeriesRiskWithPricerGreeks() public {
        vm.prank(agent);
        manager.openEpoch(address(callVault));
        uint256 tenor = FRIDAY_CLOSE - block.timestamp;
        (int256 d, uint256 g, uint256 v, int256 t) = pricer.greeks(250 * WAD, 275 * WAD, tenor, 0.6e18, true);
        uint256 id = manager.seriesIdOf(address(callVault), address(tsla), 275 * WAD, FRIDAY_CLOSE, true);
        vm.expectEmit(address(manager));
        emit EpochManager.SeriesRisk(id, d, g, v, t);
        vm.prank(agent);
        manager.proposeSeries(address(callVault), 275 * WAD, FRIDAY_CLOSE, 50 * WAD, 10_000);
        // Its delta is the one SeriesProposed reports.
        (,, int256 proposedDelta,) = manager.previewProposal(address(callVault), 275 * WAD, FRIDAY_CLOSE, 1, 10_000);
        assertEq(d, proposedDelta);
        assertGt(g, 0);
        assertGt(v, 0);
        assertLt(t, 0);
    }

    /// Greeks use the epoch's opening snapshot: a sigma update and a new print after `openEpoch` do not move them.
    function test_proposal_greeksUseOpeningSnapshot() public {
        vm.prank(agent);
        manager.openEpoch(address(putVault));
        vm.warp(block.timestamp + 1 hours);
        vm.prank(keeper);
        manager.setSigma(address(tsla), 0.7e18);
        feed.set(252e8);
        uint256 tenor = FRIDAY_CLOSE - block.timestamp;
        (int256 d, uint256 g, uint256 v, int256 t) = pricer.greeks(250 * WAD, 235 * WAD, tenor, 0.6e18, false);
        vm.recordLogs();
        vm.prank(agent);
        (bool ok, uint256 id) = manager.proposeSeries(address(putVault), 235 * WAD, FRIDAY_CLOSE, 50 * WAD, 10_000);
        assertTrue(ok);
        (int256 ld, uint256 lg, uint256 lv, int256 lt) = _seriesRiskLog(id);
        assertEq(ld, d);
        assertEq(lg, g);
        assertEq(lv, v);
        assertEq(lt, t);
        assertLt(ld, 0); // a put
    }

    function test_proposeByDelta_emitsSeriesRisk() public {
        vm.prank(agent);
        manager.openEpoch(address(callVault));
        vm.recordLogs();
        vm.prank(agent);
        (bool ok, uint256 id, uint256 strike) =
            manager.proposeByDelta(address(callVault), 2000, FRIDAY_CLOSE, 50 * WAD, 10_000);
        assertTrue(ok);
        (int256 d,,,) = _seriesRiskLog(id);
        // The strike was solved for 0.20 delta and rounded to a cent.
        assertApproxEqAbs(d, 0.2e18, 0.001e18);
        (int256 expected,,,) = pricer.greeks(250 * WAD, strike, FRIDAY_CLOSE - block.timestamp, 0.6e18, true);
        assertEq(d, expected);
    }

    /// A rejected proposal creates no series and records no greeks.
    function test_rejectedProposal_emitsNoSeriesRisk() public {
        vm.prank(agent);
        manager.openEpoch(address(callVault));
        vm.recordLogs();
        vm.prank(agent);
        (bool ok,) = manager.proposeSeries(address(callVault), 251 * WAD, FRIDAY_CLOSE, 50 * WAD, 10_000);
        assertFalse(ok);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != EpochManager.SeriesRisk.selector);
        }
    }

    // ---------------------------------------------------------------- RiskLens.seriesRisk

    function test_defaultShocks() public view {
        int256[] memory s = lens.defaultShocks();
        assertEq(s.length, 13);
        assertEq(s[0], -0.3e18);
        assertEq(s[6], 0);
        assertEq(s[12], 0.3e18);
    }

    function test_seriesRisk_liveCall() public {
        uint256 id = _openAndPropose(callVault, 275 * WAD, 50 * WAD);
        _buy(id, 20 * WAD);
        vm.warp(block.timestamp + 1 days);
        feed.set(260e8);
        RiskLens.SeriesRisk memory r = lens.seriesRisk(id);

        assertEq(r.spot, 260 * WAD);
        assertEq(r.sigma, 0.6e18);
        assertEq(r.tenor, FRIDAY_CLOSE - block.timestamp);
        (int256 d, uint256 g, uint256 v, int256 t) = pricer.greeks(260 * WAD, 275 * WAD, r.tenor, 0.6e18, true);
        assertEq(r.delta, d);
        assertEq(r.gamma, g);
        assertEq(r.vega, v);
        assertEq(r.theta, t);
        assertEq(r.sold, 20 * WAD);
        assertEq(r.collateral, 20 * WAD);

        // Worst case for a covered call: spot +30% (338), paying 20 × (338 − 275) = $1,260.
        assertEq(r.losses.length, 13);
        assertEq(r.worstShock, 0.3e18);
        assertEq(r.worstLoss, r.losses[12]);
        assertApproxEqAbs(r.worstLoss, 1260 * WAD, 1e6);
        (uint256 worst, uint256[] memory losses) = pricer.scenarioLoss(true, 275 * WAD, 20 * WAD, 260 * WAD, r.shocks);
        assertEq(r.worstLoss, worst);
        assertEq(r.losses, losses);
        // In tokens: 20 × (338 − 275) / 338.
        assertEq(r.worstPayout, Math.mulDiv(20 * WAD, Math.mulDiv((338 - 275) * WAD, WAD, 338 * WAD), WAD));
        assertLe(r.worstPayout, r.collateral);
    }

    function test_seriesRisk_livePut() public {
        uint256 id = _openAndPropose(putVault, 235 * WAD, 50 * WAD);
        _buy(id, 10 * WAD);
        RiskLens.SeriesRisk memory r = lens.seriesRisk(id);
        // Worst case for a cash-secured put: spot −30% (175), paying 10 × (235 − 175) = $600 = 600 USDG.
        assertEq(r.worstShock, -0.3e18);
        assertEq(r.worstLoss, 600 * WAD);
        assertEq(r.worstPayout, 600 * USDG_UNIT);
        assertEq(r.collateral, 2350 * USDG_UNIT);
        assertLt(r.delta, 0);
    }

    function test_seriesRisk_nothingSold() public {
        uint256 id = _openAndPropose(callVault, 275 * WAD, 50 * WAD);
        RiskLens.SeriesRisk memory r = lens.seriesRisk(id);
        assertEq(r.worstLoss, 0);
        assertEq(r.worstPayout, 0);
        assertEq(r.worstShock, -0.3e18); // the first shock with the largest (zero) payout
        assertGt(r.gamma, 0); // greeks are per option, whatever was sold
    }

    /// After expiry the greeks are zero (no time left) and the scenario is still computed.
    function test_seriesRisk_afterExpiry() public {
        uint256 id = _openAndPropose(callVault, 275 * WAD, 50 * WAD);
        _buy(id, 10 * WAD);
        _expireAt(300e8);
        RiskLens.SeriesRisk memory r = lens.seriesRisk(id);
        assertEq(r.tenor, 0);
        assertEq(r.delta, 0);
        assertEq(r.gamma, 0);
        assertEq(r.vega, 0);
        assertEq(r.theta, 0);
        assertApproxEqAbs(r.worstLoss, 10 * (390 - 275) * WAD, 1e6); // 300 × 1.3 = 390
    }

    /// `seriesRiskAt` with no shock at the settlement price gives exactly the payout `settle` locks up.
    function testFuzz_seriesRiskAt_matchesSettlement(uint256 amount, uint256 price8, bool isCall) public {
        StrikeVault vault = isCall ? callVault : putVault;
        uint256 strike = isCall ? 275 * WAD : 235 * WAD;
        uint256 id = _openAndPropose(vault, strike, 50 * WAD);
        _buy(id, bound(amount, 1, 50 * WAD));
        price8 = bound(price8, 1e8, 1000e8);
        uint80 round = _expireAt(int256(price8));
        int256[] memory none = new int256[](1);
        RiskLens.SeriesRisk memory r = lens.seriesRiskAt(id, price8 * 1e10, 0.6e18, none);
        manager.settle(address(vault), round);
        assertEq(r.worstPayout, manager.getSeries(id).escrow);
    }

    /// Invariant-style: whatever was sold and wherever spot goes, the worst-case payout fits in the locked
    /// collateral (in collateral units), and its USD value fits in the collateral's value at the shocked spot.
    function testFuzz_worstCaseWithinCollateral(uint256 amount, uint256 price8, uint256 sigma, bool isCall) public {
        StrikeVault vault = isCall ? callVault : putVault;
        uint256 id = _openAndPropose(vault, isCall ? 275 * WAD : 235 * WAD, 50 * WAD);
        _buy(id, bound(amount, 1, 50 * WAD));
        uint256 spot = bound(price8, 1e8, 10_000e8) * 1e10;
        sigma = bound(sigma, 0.05e18, 5e18);
        RiskLens.SeriesRisk memory r = lens.seriesRiskAt(id, spot, sigma, _wideGrid());
        _assertCovered(r, isCall);
    }

    function _assertCovered(RiskLens.SeriesRisk memory r, bool isCall) internal pure {
        assertLe(r.worstPayout, r.collateral, "payout > collateral");
        // Collateral value: call collateral is 18-decimal tokens at the shocked spot; put collateral is 6-decimal USDG.
        uint256 shocked = RiskLib.shockedSpot(r.spot, r.worstShock);
        uint256 collateralValue = isCall ? r.collateral * shocked / WAD : r.collateral * 1e12;
        assertLe(r.worstLoss, collateralValue, "loss > collateral value");
    }

    function test_seriesRisk_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(RiskLens.SeriesUnknown.selector, 123));
        lens.seriesRisk(123);
        vm.expectRevert(abi.encodeWithSelector(RiskLens.ZeroAddress.selector));
        new RiskLens(EpochManager(address(0)));
        // A stale feed: the live view refuses, like every protocol price read.
        uint256 id = _openAndPropose(callVault, 275 * WAD, 50 * WAD);
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert();
        lens.seriesRisk(id);
        // The explicit-spot view still works.
        lens.seriesRiskAt(id, 250 * WAD, 0.6e18, lens.defaultShocks());
    }

    /// A shock outside (-100%, +1000%] is the engine's error 8.
    function test_seriesRiskAt_badShock() public {
        uint256 id = _openAndPropose(callVault, 275 * WAD, 50 * WAD);
        int256[] memory bad = new int256[](1);
        bad[0] = -1e18;
        vm.expectRevert(abi.encodeWithSignature("PricerInputOutOfRange(uint8)", uint8(8)));
        lens.seriesRiskAt(id, 250 * WAD, 0.6e18, bad);
    }
}
