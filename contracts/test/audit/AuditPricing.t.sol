// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Decimals} from "../../src/libraries/Decimals.sol";
import {MandateGuard} from "../../src/libraries/MandateGuard.sol";
import {StrikeVault} from "../../src/vaults/StrikeVault.sol";
import {VaultFactory} from "../../src/vaults/VaultFactory.sol";
import {StrikeBase} from "../utils/StrikeBase.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {console2} from "forge-std/console2.sol";

/// @notice Audit 2026-09-29: option pricing at sale time, proposals and mandates.
///         Each finding's test reproduces the original attack and now asserts the fixed behaviour (regression test).
contract AuditPricingTest is StrikeBase {
    function _usd(uint256 amount, uint256 priceWad) internal pure returns (uint256) {
        return Decimals.valueInUsd(amount, priceWad, 18, 6, Math.Rounding.Floor);
    }

    // ================================================================== M-02
    /// FIXED (M-02): the premium per option is at least intrinsic value.
    /// `buy` keeps selling after the option has moved in the money, at `fairValue × premiumBps`. With a
    /// mandate-compliant premiumBps below 10,000 (the reference mandate allows 9,500 and the example agent clamps to
    /// it), a deep in-the-money call close to expiry is sold for less than its intrinsic value: anyone buys it and
    /// hedges the (≈1) delta for a riskless profit paid by depositors.
    function test_AUDIT_itmSalesBelowIntrinsic() public {
        _depositCall(alice, 100 * WAD);
        vm.prank(agent);
        manager.openEpoch(address(callVault));
        vm.prank(agent);
        (bool ok, uint256 seriesId) =
            manager.proposeSeries(address(callVault), 275 * WAD, FRIDAY_CLOSE, 100 * WAD, 9500);
        assertTrue(ok);

        // Friday 14:00 New York: the stock trades at 300, the 275 call is 25 in the money, sales are still open.
        vm.warp(FRIDAY_CLOSE - 2 hours);
        feed.set(300e8);
        uint256 amount = 60 * WAD;
        uint256 paid = _buy(seriesId, amount);
        uint256 intrinsic = _usd(amount, 25 * WAD);

        // Nothing moves until the close: the buyer collects the intrinsic value.
        manager.settle(address(callVault), _expireAt(300e8));
        vm.prank(buyer);
        uint256 tokens = manager.redeem(seriesId, amount, buyer);
        uint256 received = _usd(tokens, 300 * WAD);
        console2.log("premium paid (USDG units)     ", paid);
        console2.log("intrinsic at purchase (USDG)  ", intrinsic);
        console2.log("payout value at 300 (USDG)    ", received);
        assertGe(paid, intrinsic, "AUDIT M-02: in-the-money options sold below intrinsic value");
    }

    // ================================================================== M-03
    /// FIXED (M-03): buys are priced at spot moved against the buyer by the feed's deviation threshold
    /// (`setSpotBuffer`, 50 bps for the 0.5% Chainlink stock feeds, as the deploy script sets it).
    /// The mainnet feeds update on a 0.5% deviation threshold (24 h heartbeat), so the on-chain spot can lag the
    /// market by up to ~0.5% with no new round. `buy` prices off that lagging spot. For the short-dated, low-delta
    /// options the mandate encourages, a 0.49% move is worth far more than the 5% premium margin (or even a 0%
    /// margin at premiumBps = 10,000): a buyer who watches the real market buys calls after up-moves (puts after
    /// down-moves) below fair value. The premium factor does not protect depositors from this latency arbitrage.
    function test_AUDIT_oracleDeviationBandArbitrage() public {
        _depositCall(alice, 100 * WAD);
        vm.prank(admin);
        manager.setSpotBuffer(address(tsla), 50);
        uint256 seriesId = _openAndPropose(callVault, 275 * WAD, 100 * WAD); // premiumBps = 10,000
        vm.warp(block.timestamp + 1 days);
        feed.set(250e8); // last print; the real market then moves +0.49% (below the 0.5% deviation trigger)
        uint256 realSpot = 250 * WAD * 10_049 / 10_000;

        uint256 amount = 50 * WAD;
        uint256 paid = _buy(seriesId, amount);
        (uint256 fairAtReal,) = pricer.quote(realSpot, 275 * WAD, FRIDAY_CLOSE - block.timestamp, 0.6e18, true);
        uint256 worth = _usd(amount, fairAtReal);
        console2.log("premium paid (USDG units)          ", paid);
        console2.log("fair value at the real spot (USDG) ", worth);
        console2.log("depositor margin, bps of premium   ", (paid - worth) * 10_000 / paid);
        assertGe(paid, worth, "AUDIT M-03: buyer paid below fair value using a spot inside the feed's deviation band");
    }

    // ================================================================== L-01
    /// FIXED (L-01): the cent rounding moves the strike toward the middle of the delta band.
    /// proposeByDelta promises "the series gets exactly the delta the agent intended", then rounds the strike DOWN to
    /// a cent. For a call that raises |delta| (for a put it lowers it) by up to a few bps, so a target at the band
    /// edge (e.g. maxDeltaBps) lands outside the band: the proposal is rejected and the agent's bond slashed for a
    /// strike the contract itself chose. An off-chain dry run cannot rule it out, since spot moves before inclusion.
    function test_AUDIT_proposeByDeltaRoundingSlashesAgent() public {
        _depositCall(alice, 100 * WAD);
        vm.prank(agent);
        manager.openEpoch(address(callVault));
        uint256 tenor = FRIDAY_CLOSE - block.timestamp;
        uint16 target = _mandate().maxDeltaBps; // 4000 = 0.40

        bool found;
        int256 price8;
        for (uint256 i; i < 50 && !found; ++i) {
            price8 = 250e8 + int256(i) * 1e6; // one-cent steps
            feed.set(price8);
            uint256 k = pricer.strikeForDelta(uint256(price8) * 1e10, uint256(target) * 1e14, tenor, 0.6e18, true);
            k -= k % 1e16;
            (MandateGuard.Reason r,,,) = manager.previewProposal(address(callVault), k, FRIDAY_CLOSE, 10 * WAD, 10_000);
            found = r == MandateGuard.Reason.DeltaOutOfBand;
        }
        if (!found) return; // property held on every tried spot

        uint256 bondBefore = registry.getAgent(agentId).bond;
        vm.prank(agent);
        (bool ok,, uint256 strike) = manager.proposeByDelta(address(callVault), target, FRIDAY_CLOSE, 10 * WAD, 10_000);
        console2.log("spot (feed units)", uint256(price8));
        console2.log("solved strike    ", strike);
        console2.log("bond slashed     ", bondBefore - registry.getAgent(agentId).bond);
        assertTrue(
            ok, "AUDIT L-01: proposeByDelta at the band edge rejected (agent slashed) by the contract's rounding"
        );
    }

    // ================================================================== L-02
    /// FIXED (L-02): proposals are judged against the market snapshot taken when the epoch opened, so a keeper
    /// update in between cannot change the verdict. (Keeper updates are also capped at 25% an hour.)
    /// A rejected proposal slashes instead of reverting, and the agent cannot bound the market inputs (spot, sigma)
    /// its proposal is judged against. A routine keeper sigma update (inside the admin bounds) that lands just
    /// before an honest, dry-run-checked proposal turns it into a slash and a strike. The same holds for a feed
    /// update. A keeper (semi-trusted) can do this on purpose.
    function test_AUDIT_sigmaUpdateRaceSlashesHonestAgent() public {
        _depositCall(alice, 100 * WAD);
        vm.prank(agent);
        manager.openEpoch(address(callVault));
        uint256 tenor = FRIDAY_CLOSE - block.timestamp;
        uint256 k = pricer.strikeForDelta(250 * WAD, 0.37e18, tenor, 0.6e18, true);
        k -= k % 1e16;
        (MandateGuard.Reason r,,,) = manager.previewProposal(address(callVault), k, FRIDAY_CLOSE, 10 * WAD, 10_000);
        assertEq(uint8(r), uint8(MandateGuard.Reason.None), "dry run passes");

        vm.prank(keeper);
        manager.setSigma(address(tsla), 0.75e18); // the largest allowed step

        uint256 bondBefore = registry.getAgent(agentId).bond;
        vm.prank(agent);
        (bool ok,) = manager.proposeSeries(address(callVault), k, FRIDAY_CLOSE, 10 * WAD, 10_000);
        console2.log("bond slashed", bondBefore - registry.getAgent(agentId).bond);
        assertTrue(ok, "AUDIT L-02: honest proposal slashed because sigma moved between dry run and inclusion");
    }

    // ================================================================== L-04
    /// FIXED (L-04): MandateGuard.validate enforces a protocol floor (minPremiumBps >= 9,000, maxTenor <= 35 days),
    /// so such a vault cannot be created.
    /// MandateGuard.validate accepts minPremiumBps = 1 and minYieldBps = 0 (and an unbounded maxTenor). Anyone can
    /// create a vault; with agent = curator = buyer, a vault with such a mandate sells options at 0.01% of fair
    /// value to the agent, entirely "within the mandate". threat-model T6 lists the premium floor as a mitigation,
    /// but the protocol enforces no floor of its own.
    function test_AUDIT_permissiveMandateLetsAgentBuyerDrain() public {
        MandateGuard.Mandate memory m = _mandate();
        m.minPremiumBps = 1;
        m.minYieldBps = 0;
        VaultFactory.CreateParams memory p = _params(true, 1_000_000 * WAD);
        p.mandate = m;
        vm.prank(agent); // the agent is its own curator
        vm.expectRevert(
            abi.encodeWithSelector(
                MandateGuard.InvalidMandate.selector, uint8(MandateGuard.MandateError.PremiumBelowFloor)
            )
        );
        factory.createVault(p);

        // At the floor, the agent-buyer still pays at least 90% of fair value.
        p.mandate.minPremiumBps = 9000;
        vm.prank(agent);
        StrikeVault vault = StrikeVault(factory.createVault(p));
        tsla.mint(alice, 100 * WAD);
        vm.startPrank(alice);
        tsla.approve(address(vault), 100 * WAD);
        vault.deposit(100 * WAD, alice);
        vm.stopPrank();
        vm.startPrank(agent);
        manager.openEpoch(address(vault));
        (bool ok, uint256 seriesId) = manager.proposeSeries(address(vault), 275 * WAD, FRIDAY_CLOSE, 100 * WAD, 9000);
        vm.stopPrank();
        assertTrue(ok, "accepted within the mandate");

        (uint256 paid,) = manager.quoteBuy(seriesId, 100 * WAD);
        (uint256 fair,) = pricer.quote(250 * WAD, 275 * WAD, FRIDAY_CLOSE - block.timestamp, 0.6e18, true);
        uint256 fairUsdg = _usd(100 * WAD, fair);
        console2.log("premium the agent-buyer pays (USDG units)", paid);
        console2.log("fair value (USDG units)                  ", fairUsdg);
        assertGe(paid * 10_000, fairUsdg * 9000, "AUDIT L-04: a mandate let the vault sell below 90% of fair value");
    }

    // ================================================================== I-03
    /// FIXED (I-03): a keeper update moves sigma at most 25% and at most once an hour, so a single keeper key
    /// cannot reprice a live series by orders of magnitude within a week of sales.
    function test_AUDIT_info_keeperSigmaRepricesLiveSeries() public {
        _depositCall(alice, 100 * WAD);
        uint256 seriesId = _openAndPropose(callVault, 275 * WAD, 100 * WAD);
        (uint256 before,) = manager.quoteBuy(seriesId, 50 * WAD);
        vm.prank(keeper);
        vm.expectRevert();
        manager.setSigma(address(tsla), 0.2e18);
        vm.prank(keeper);
        manager.setSigma(address(tsla), 0.45e18); // -25%
        (uint256 afterDrop,) = manager.quoteBuy(seriesId, 50 * WAD);
        console2.log("quote at sigma 0.60", before);
        console2.log("quote at sigma 0.45", afterDrop);
        assertGt(afterDrop * 10, before, "one keeper update moves a live quote by less than 10x");
    }
}
