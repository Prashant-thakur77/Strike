// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {EpochManager} from "../../src/core/EpochManager.sol";
import {StrikeBase} from "../utils/StrikeBase.sol";
import {console2} from "forge-std/console2.sol";

/// @notice Audit 2026-09-29: settlement-price selection and settlement liveness.
///         Each finding's test reproduces the original attack and now asserts the fixed behaviour (regression test).
///         Tests named `safe_` check a property that held.
contract AuditSettlementTest is StrikeBase {
    /// Tries every round id in [from, to] (same phase) as the settlement hint; true on the first that settles.
    function _trySettleRange(address vault, uint80 from, uint80 to) internal returns (bool) {
        for (uint80 r = from; r <= to; ++r) {
            try manager.settle(vault, r) {
                return true;
            } catch {}
        }
        return false;
    }

    function _hints(uint80 a, uint80 b) internal pure returns (uint80[] memory h) {
        h = new uint80[](2);
        (h[0], h[1]) = (a, b);
    }

    // ================================================================== H-01
    /// FIXED (H-01): the print inside the window is skipped and settlement uses the first print after
    /// effectiveAt + grace, proved with a second hint. Single-hint settle calls still cannot pick a later print.
    /// design.md §10: "Split or dividend mid-epoch ... sales and settlement pause until effectiveAt + grace".
    /// SafeStockFeed.settlementPrice instead refuses the *fixed* first round after expiry whenever it lies within
    /// `corporateActionGrace` of `effectiveAt`. Every later round fails the "previous round predates expiry" check,
    /// so the series can never settle: after `settlementGrace` the guardian must cancel it and in-the-money buyers
    /// get their premium back instead of the payout (or out-of-the-money depositors lose the premium).
    /// A quarterly ERC-8056 dividend adjustment effective on an expiry Friday is enough to trigger it.
    function test_AUDIT_corporateActionBricksSettlement() public {
        _depositCall(alice, 100 * WAD);
        uint256 seriesId = _openAndPropose(callVault, 275 * WAD, 100 * WAD);
        uint256 premium = _buy(seriesId, 50 * WAD);

        // Wednesday: the issuer schedules a dividend multiplier change effective at Friday's open (13:30 UTC).
        vm.warp(FRIDAY_CLOSE - 2 days);
        uint256 effective = FRIDAY_CLOSE - 6.5 hours;
        tsla.scheduleMultiplier(1.004e18, effective);
        vm.warp(effective);
        tsla.applyMultiplier();

        // The first print after the close is in the money.
        uint80 first = _expireAt(300e8);
        // Long after effectiveAt + grace, the feed keeps printing.
        vm.warp(FRIDAY_CLOSE + 2 days);
        feed.set(300e8);
        vm.warp(FRIDAY_CLOSE + 5 days);
        uint80 last = feed.set(300e8);

        assertFalse(_trySettleRange(address(callVault), first, last), "no single round can be picked");
        vm.expectRevert(); // a later print is not the first one after the window
        oracle.recordSettlementPriceWithHints(address(tsla), FRIDAY_CLOSE, _hints(first, last));
        oracle.recordSettlementPriceWithHints(address(tsla), FRIDAY_CLOSE, _hints(first, first + 1));
        bool settled = _trySettleRange(address(callVault), first, first);
        if (!settled) {
            // Consequence: the guardian's only way out refunds premium instead of paying the in-the-money payout.
            vm.warp(FRIDAY_CLOSE + manager.settlementGrace());
            vm.prank(guardian);
            manager.emergencyCancel(address(callVault));
            vm.prank(buyer);
            uint256 refund = manager.redeem(seriesId, 50 * WAD, buyer);
            uint256 owedTokens = 50 * WAD / 12; // (300 - 275) / 300 per option
            console2.log("premium paid (USDG units)  ", premium);
            console2.log("refund received (USDG units)", refund);
            console2.log("payout owed at 300 (tokens) ", owedTokens);
        }
        assertTrue(settled, "AUDIT H-01: settlement never possible after a corporate action near expiry");
    }

    // ================================================================== M-01
    /// FIXED (M-01a): round 1 of a new phase needs a hint for the old phase's last round, which must predate
    /// expiry and have no successor, so only the true first print is accepted.
    /// threat-model T1: "settlement uses the first round at or after expiry ... nobody can pick a favourable later
    /// print". At the first round of a Chainlink phase there is no predecessor check, only
    /// `updatedAt - expiry <= maxPriceAge` (25 h on mainnet). If the aggregator is upgraded within that window, the
    /// true first round (old phase) and the new phase's round 1 are BOTH accepted; the first caller chooses.
    function test_AUDIT_phaseChangeLetsCallerPickSettlementPrice() public {
        uint80 trueFirst = feed.push(260e8, FRIDAY_CLOSE + 5);
        feed.newPhase();
        uint80 laterPrint = feed.push(300e8, FRIDAY_CLOSE + 2 hours);
        vm.warp(FRIDAY_CLOSE + 3 hours);

        uint256 snap = vm.snapshotState();
        uint256 honest = oracle.recordSettlementPrice(address(tsla), FRIDAY_CLOSE, trueFirst);
        vm.revertToState(snap);

        bool laterAccepted;
        uint256 chosen;
        try oracle.recordSettlementPrice(address(tsla), FRIDAY_CLOSE, laterPrint) returns (uint256 p) {
            laterAccepted = true;
            chosen = p;
        } catch {}
        (bool withHint,) = address(oracle)
            .call(
                abi.encodeCall(
                    oracle.recordSettlementPriceWithHints, (address(tsla), FRIDAY_CLOSE, _hints(laterPrint, trueFirst))
                )
            );
        assertFalse(withHint, "old phase printed after expiry: the new phase's round 1 is refused");
        console2.log("true first print  ", honest);
        console2.log("caller-chosen print", chosen);
        assertFalse(laterAccepted, "AUDIT M-01a: a later print from a new phase was accepted as the settlement price");
    }

    /// FIXED (M-01b): with the old phase's last round as proof, the new phase's round 1 settles however late.
    /// Same fallback, liveness side: the aggregator is upgraded over the weekend, the old phase has no round after
    /// the Friday close and the new phase's round 1 arrives more than `maxPriceAge` later. No round can ever be
    /// accepted (round 1 fails the age window, round 2+ fail the predecessor check): only emergencyCancel remains.
    function test_AUDIT_weekendPhaseChangeBricksSettlement() public {
        _depositCall(alice, 100 * WAD);
        uint256 seriesId = _openAndPropose(callVault, 275 * WAD, 100 * WAD);
        _buy(seriesId, 50 * WAD);

        vm.warp(FRIDAY_CLOSE + 52 hours); // Sunday 20:00 New York: the 24/5 feed resumes on a new aggregator
        uint80 lastOld = feed.currentRoundId();
        feed.newPhase();
        uint80 first = feed.set(300e8);
        vm.warp(FRIDAY_CLOSE + 60 hours);
        uint80 last = feed.set(301e8);

        assertFalse(_trySettleRange(address(callVault), first, last), "one hint is not enough across phases");
        oracle.recordSettlementPriceWithHints(address(tsla), FRIDAY_CLOSE, _hints(first, lastOld));
        manager.settle(address(callVault), first);
        assertEq(manager.getSeries(seriesId).settlementPrice, 300e18, "AUDIT M-01b: settled on the new phase");
    }

    /// Inside one phase the first round after expiry is the only one accepted, whoever calls.
    function test_AUDIT_safe_settlementRoundUniqueWithinPhase() public {
        _depositCall(alice, 100 * WAD);
        uint256 seriesId = _openAndPropose(callVault, 275 * WAD, 100 * WAD);
        _buy(seriesId, 50 * WAD);
        feed.push(251e8, FRIDAY_CLOSE - 1);
        uint80 first = feed.push(280e8, FRIDAY_CLOSE + 1);
        uint80 second = feed.push(320e8, FRIDAY_CLOSE + 30);
        vm.warp(FRIDAY_CLOSE + 1 hours);
        vm.expectRevert();
        manager.settle(address(callVault), second);
        vm.expectRevert();
        manager.settle(address(callVault), first - 1);
        manager.settle(address(callVault), first);
        assertEq(manager.getSeries(seriesId).settlementPrice, 280e18);
    }

    // ================================================================== L-03
    /// FIXED (L-03): emergencyCancel reverts with SettlementAvailable once a price is recorded.
    /// audit-readiness.md: the guardian can "cancel a series only after expiry + settlementGrace with no
    /// settlement". emergencyCancel checks only the time: a series whose settlement price is already recorded (here:
    /// shared by another vault on the same token and expiry) can still be cancelled, converting an in-the-money
    /// payout into a premium refund.
    function test_AUDIT_emergencyCancelDespiteRecordedPrice() public {
        _depositCall(alice, 100 * WAD);
        uint256 seriesId = _openAndPropose(callVault, 275 * WAD, 100 * WAD);
        _buy(seriesId, 50 * WAD);
        uint80 round = _expireAt(300e8);
        // The price is recorded (anyone can call the oracle, or another vault settled first).
        oracle.recordSettlementPrice(address(tsla), FRIDAY_CLOSE, round);
        assertEq(oracle.settlementPrice(address(tsla), FRIDAY_CLOSE), 300e18);

        vm.warp(FRIDAY_CLOSE + manager.settlementGrace());
        vm.prank(guardian);
        (bool cancelled,) = address(manager).call(abi.encodeCall(EpochManager.emergencyCancel, (address(callVault))));
        assertFalse(cancelled, "AUDIT L-03: guardian cancelled a series that has a valid settlement price");
    }
}
