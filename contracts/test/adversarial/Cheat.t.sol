// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {EpochManager} from "../../src/core/EpochManager.sol";
import {IStrikeVault} from "../../src/interfaces/IStrikeVault.sol";
import {Decimals} from "../../src/libraries/Decimals.sol";
import {MandateGuard} from "../../src/libraries/MandateGuard.sol";
import {SafeStockFeed} from "../../src/libraries/SafeStockFeed.sol";
import {OptionToken} from "../../src/tokens/OptionToken.sol";
import {StrikeVault} from "../../src/vaults/StrikeVault.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";
import {AdversarialBase} from "./AdversarialBase.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice CHEAT: a participant (agent, buyer, curator, admin, oracle, a fake vault) tries to get more than the
///         rules allow. Each test asserts the defence. Map: docs/security/adversarial.md#cheat.
contract AdversarialCheatTest is AdversarialBase {
    // ------------------------------------------------------------------ agent

    /// The agent's dry run of the 275 call passed at open. The market then falls to 240, and the agent proposes a 252
    /// call: a ~0.24-delta call against the live spot, but a ~0.46-delta call against the opening snapshot, outside
    /// the 0.05-0.40 band. The verdict uses the snapshot, so the move cannot be used to slip a near-the-money strike
    /// past the mandate: rejected, slashed, paid to this vault. The honest 275 is still accepted although its live
    /// delta (~0.02) is now below the band, and buyers pay the live fair value, not the snapshot's.
    function test_ADV_CHEAT_proposalJudgedAgainstOpenSnapshot() public {
        _depositCall(alice, 100 * WAD);
        vm.prank(agent);
        manager.openEpoch(address(callVault));
        (MandateGuard.Reason r,,,) =
            manager.previewProposal(address(callVault), 275 * WAD, FRIDAY_CLOSE, 50 * WAD, 10_000);
        assertEq(uint8(r), uint8(MandateGuard.Reason.None), "dry run at open");

        feed.set(240e8);
        uint256 tenor = FRIDAY_CLOSE - block.timestamp;
        (, int256 liveDelta) = pricer.quote(240 * WAD, 252 * WAD, tenor, 0.6e18, true);
        assertGt(liveDelta, 0.05e18, "inside the band at the live spot");
        assertLt(liveDelta, 0.4e18, "inside the band at the live spot");
        (r,,,) = manager.previewProposal(address(callVault), 252 * WAD, FRIDAY_CLOSE, 50 * WAD, 10_000);
        assertEq(uint8(r), uint8(MandateGuard.Reason.DeltaOutOfBand), "outside the band at the snapshot");

        uint256 bond = _bond();
        vm.prank(agent);
        (bool ok, uint256 id) = manager.proposeSeries(address(callVault), 252 * WAD, FRIDAY_CLOSE, 50 * WAD, 10_000);
        assertFalse(ok);
        assertEq(id, 0);
        assertEq(_bond(), bond - SLASH, "slashed");
        assertEq(_strikes(), 1);
        assertEq(manager.compensation(address(callVault)), SLASH, "owed to this vault's depositors");
        (EpochManager.EpochState state,,, uint128 openSpot,) = manager.epochs(address(callVault));
        assertEq(uint8(state), uint8(EpochManager.EpochState.Open), "no series");
        assertEq(openSpot, 250 * WAD, "the snapshot did not move");

        // The honest proposal that passed the dry run: accepted against the snapshot, priced at the live spot.
        (, liveDelta) = pricer.quote(240 * WAD, 275 * WAD, tenor, 0.6e18, true);
        assertLt(liveDelta, 0.05e18, "would be out of the band if judged live");
        vm.prank(agent);
        (ok, id) = manager.proposeSeries(address(callVault), 275 * WAD, FRIDAY_CLOSE, 50 * WAD, 10_000);
        assertTrue(ok);
        assertEq(_strikes(), 1, "no second strike");
        (uint256 premium,) = manager.quoteBuy(id, 10 * WAD);
        (uint256 fairLive,) = pricer.quote(240 * WAD, 275 * WAD, tenor, 0.6e18, true);
        assertEq(premium, Decimals.valueInUsd(10 * WAD, fairLive, 18, 6, Math.Rounding.Ceil), "live fair value");
    }

    /// A second bonded agent tries to drive a vault that names another agent: open, propose (by strike or delta,
    /// inside or outside the mandate), abort, or switch the vault to itself. Every call reverts; nobody is slashed.
    function test_ADV_CHEAT_agentProposesForVaultItDoesNotRun() public {
        _depositCall(alice, 100 * WAD);
        address rogue = makeAddr("rogue");
        usdg.mint(rogue, 1000e6);
        vm.startPrank(rogue);
        uint256 rogueId = registry.register(rogue, rogue, 0);
        usdg.approve(address(registry), 1000e6);
        registry.postBond(rogueId, 1000e6);
        vm.expectRevert(abi.encodeWithSelector(EpochManager.NotAgent.selector, rogue));
        manager.openEpoch(address(callVault));
        vm.stopPrank();

        vm.prank(agent);
        manager.openEpoch(address(callVault));
        bytes memory notAgent = abi.encodeWithSelector(EpochManager.NotAgent.selector, rogue);
        vm.startPrank(rogue);
        vm.expectRevert(notAgent);
        manager.proposeSeries(address(callVault), 275 * WAD, FRIDAY_CLOSE, 50 * WAD, 10_000);
        vm.expectRevert(notAgent);
        manager.proposeSeries(address(callVault), 252 * WAD, FRIDAY_CLOSE, 50 * WAD, 10_000);
        vm.expectRevert(notAgent);
        manager.proposeByDelta(address(callVault), 2000, FRIDAY_CLOSE, 50 * WAD, 10_000);
        vm.expectRevert(abi.encodeWithSelector(EpochManager.TooEarly.selector, MONDAY + 1 days));
        manager.abortEpoch(address(callVault));
        vm.expectRevert(abi.encodeWithSelector(EpochManager.NotCurator.selector, rogue));
        manager.setVaultAgent(address(callVault), rogueId);
        vm.stopPrank();

        assertEq(registry.getAgent(rogueId).strikes, 0);
        assertEq(registry.getAgent(rogueId).bond, 1000e6);
        assertEq(_strikes(), 0);
        assertEq(manager.compensation(address(callVault)), 0);
        assertEq(manager.vaultConfig(address(callVault)).agentId, agentId);
        assertEq(uint8(_state(callVault)), uint8(EpochManager.EpochState.Open), "still waiting for its own agent");
        vm.prank(agent);
        (bool ok,) = manager.proposeSeries(address(callVault), 275 * WAD, FRIDAY_CLOSE, 50 * WAD, 10_000);
        assertTrue(ok);
    }

    /// The agent asks less than the mandate's premium floor (95% of fair value), or nothing at all: each attempt is
    /// rejected with PremiumBelowFair and costs a slash; the third rejection suspends the agent.
    function test_ADV_CHEAT_agentSellsBelowPremiumFloor() public {
        _depositCall(alice, 100 * WAD);
        vm.prank(agent);
        manager.openEpoch(address(callVault));
        uint16[3] memory asks = [uint16(9499), uint16(5000), uint16(0)];
        for (uint256 i; i < asks.length; ++i) {
            (MandateGuard.Reason r,,,) =
                manager.previewProposal(address(callVault), 275 * WAD, FRIDAY_CLOSE, 50 * WAD, asks[i]);
            assertEq(uint8(r), uint8(MandateGuard.Reason.PremiumBelowFair));
            vm.prank(agent);
            (bool ok,) = manager.proposeSeries(address(callVault), 275 * WAD, FRIDAY_CLOSE, 50 * WAD, asks[i]);
            assertFalse(ok);
        }
        assertEq(_bond(), 1000e6 - 3 * SLASH);
        assertEq(manager.compensation(address(callVault)), 3 * SLASH);
        assertFalse(registry.isActive(agentId), "suspended at three strikes");
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(EpochManager.AgentNotActive.selector, agentId));
        manager.proposeSeries(address(callVault), 275 * WAD, FRIDAY_CLOSE, 50 * WAD, 9500);
    }

    /// The agent tries to sell in the money. A strike on the wrong side of the opening spot is rejected and slashed;
    /// a strike the live spot has crossed since the open reverts (StrikeInTheMoney): nothing is sold, nobody slashed.
    function test_ADV_CHEAT_agentSellsInTheMoney() public {
        _depositCall(alice, 100 * WAD);
        _depositPut(alice, 30_000 * USDG_UNIT);
        vm.prank(agent);
        manager.openEpoch(address(callVault));
        vm.prank(agent);
        (bool ok,) = manager.proposeSeries(address(callVault), 240 * WAD, FRIDAY_CLOSE, 50 * WAD, 10_000);
        assertFalse(ok, "a 240 call with spot at 250");
        assertEq(_strikes(), 1);

        vm.prank(agent);
        manager.openEpoch(address(putVault));
        feed.set(230e8); // the put's 235 strike is now in the money
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(EpochManager.StrikeInTheMoney.selector, 235 * WAD, 230 * WAD));
        manager.proposeSeries(address(putVault), 235 * WAD, FRIDAY_CLOSE, 50 * WAD, 10_000);
        assertEq(_strikes(), 1, "no slash for a move the agent did not make");
        assertEq(uint8(_state(putVault)), uint8(EpochManager.EpochState.Open), "nothing sold");
    }

    /// Whatever the spot does after the agent sells at its floor (95% of fair value), no buy is ever priced below the
    /// option's intrinsic value or below 95% of its fair value at the live spot: the spot buffer and the intrinsic
    /// floor in `_quoteBuy` hold for calls and puts, deep in and out of the money, up to the sale cutoff.
    function test_ADV_CHEAT_noSaleBelowIntrinsicOrPremiumFloor(uint256 spotCents, uint256 elapsed, bool isCall) public {
        vm.prank(admin);
        manager.setSpotBuffer(address(tsla), 50); // as deployed
        StrikeVault vault = isCall ? callVault : putVault;
        if (isCall) _depositCall(alice, 100 * WAD);
        else _depositPut(alice, 100_000 * USDG_UNIT);
        uint256 strike = isCall ? 275 * WAD : 235 * WAD;
        vm.prank(agent);
        manager.openEpoch(address(vault));
        vm.prank(agent);
        (bool ok, uint256 id) = manager.proposeSeries(address(vault), strike, FRIDAY_CLOSE, 100 * WAD, 9500);
        assertTrue(ok);

        elapsed = bound(elapsed, 0, FRIDAY_CLOSE - manager.saleCutoff() - 1 - block.timestamp);
        spotCents = bound(spotCents, 15_000, 40_000);
        vm.warp(block.timestamp + elapsed);
        feed.set(int256(spotCents) * 1e6);
        uint256 live = spotCents * 1e16;
        uint256 amount = 10 * WAD;
        (uint256 premium,) = manager.quoteBuy(id, amount);
        (uint256 fair,) = pricer.quote(live, strike, FRIDAY_CLOSE - block.timestamp, 0.6e18, isCall);
        uint256 intrinsic = isCall ? (live > strike ? live - strike : 0) : (strike > live ? strike - live : 0);
        assertGe(premium, Decimals.valueInUsd(amount, intrinsic, 18, 6, Math.Rounding.Floor), "below intrinsic");
        assertGe(
            premium * 10_000, Decimals.valueInUsd(amount, fair, 18, 6, Math.Rounding.Floor) * 9500, "below the floor"
        );
    }

    // ------------------------------------------------------------------ buyer

    /// A buyer tries to take more than the series' size, in one buy or by topping up after others bought: refused
    /// with ExceedsSize down to one wei; the collateral locked never exceeds the vault's assets.
    function test_ADV_CHEAT_buyerBuysAboveSize() public {
        _depositCall(alice, 100 * WAD);
        uint256 id = _openAndPropose(callVault, 275 * WAD, 40 * WAD);
        _buy(id, 25 * WAD);
        vm.expectRevert(abi.encodeWithSelector(EpochManager.ExceedsSize.selector, 15 * WAD + 1, 15 * WAD));
        manager.buy(id, 15 * WAD + 1, type(uint256).max, buyer);
        _buyAs(bob, id, 15 * WAD);
        vm.expectRevert(abi.encodeWithSelector(EpochManager.ExceedsSize.selector, 1, 0));
        manager.buy(id, 1, type(uint256).max, buyer);

        EpochManager.Series memory s = manager.getSeries(id);
        assertEq(s.sold, s.size);
        assertEq(options.balanceOf(buyer, id) + options.balanceOf(bob, id), 40 * WAD);
        assertEq(s.collateral, 40 * WAD);
        assertLe(s.collateral, callVault.totalAssets());
    }

    /// A buyer tries to buy at the sale cutoff (15:00 New York), after expiry when the outcome is known, and after
    /// settlement. Only the buy one second before the cutoff goes through; the others revert and cost nothing.
    function test_ADV_CHEAT_buyerBuysAfterSaleCutoff() public {
        _depositCall(alice, 100 * WAD);
        uint256 id = _openAndPropose(callVault, 275 * WAD, 100 * WAD);
        uint256 cutoff = FRIDAY_CLOSE - manager.saleCutoff();
        vm.warp(cutoff - 1);
        feed.set(250e8);
        _buy(id, 10 * WAD);

        usdg.mint(buyer, 1000e6);
        vm.prank(buyer);
        usdg.approve(address(manager), type(uint256).max);
        bytes memory closed = abi.encodeWithSelector(EpochManager.SaleClosed.selector, FRIDAY_CLOSE);
        vm.warp(cutoff);
        feed.set(250e8);
        vm.prank(buyer);
        vm.expectRevert(closed);
        manager.buy(id, WAD, type(uint256).max, buyer);
        uint80 round = _expireAt(300e8); // in the money: a buyer would now take a sure profit
        vm.prank(buyer);
        vm.expectRevert(closed);
        manager.buy(id, WAD, type(uint256).max, buyer);
        manager.settle(address(callVault), round);
        vm.prank(buyer);
        vm.expectRevert(_wrongState(EpochManager.EpochState.Selling, EpochManager.EpochState.Idle));
        manager.buy(id, WAD, type(uint256).max, buyer);

        assertEq(manager.getSeries(id).sold, 10 * WAD);
        assertEq(options.balanceOf(buyer, id), 10 * WAD);
        assertEq(usdg.balanceOf(buyer), 1000e6, "the refused buys took nothing");
    }

    // ------------------------------------------------------------------ curator

    /// After deposits, the curator tries to loosen the mandate (a 90% premium floor, a wider delta band). There is no
    /// setter: `registerVault` is the only writer, only the factory may call it, and it refuses a registered vault
    /// even for the admin holding the factory role; the clone cannot be re-initialised; switching the agent leaves the
    /// mandate as it was, and a proposal at the looser terms is still rejected.
    function test_ADV_CHEAT_curatorCannotChangeMandate() public {
        _depositCall(alice, 100 * WAD);
        bytes32 before = keccak256(abi.encode(manager.vaultConfig(address(callVault)).mandate));
        MandateGuard.Mandate memory loose = _mandate();
        loose.minPremiumBps = 9000;
        loose.maxDeltaBps = 9000;

        bytes32 factoryRole = manager.FACTORY_ROLE();
        vm.prank(curator);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, curator, factoryRole)
        );
        manager.registerVault(address(callVault), curator, agentId, loose);
        vm.startPrank(admin);
        manager.grantRole(factoryRole, admin);
        vm.expectRevert(abi.encodeWithSelector(EpochManager.VaultAlreadyRegistered.selector, address(callVault)));
        manager.registerVault(address(callVault), curator, agentId, loose);
        vm.stopPrank();

        IStrikeVault.InitParams memory p = IStrikeVault.InitParams({
            asset: address(tsla),
            premiumToken: address(usdg),
            underlying: address(tsla),
            isCall: true,
            manager: curator,
            depositCap: type(uint256).max,
            name: "x",
            symbol: "x"
        });
        vm.prank(curator);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        callVault.initialize(p);

        vm.prank(curator);
        manager.setVaultAgent(address(callVault), agentId);
        assertEq(keccak256(abi.encode(manager.vaultConfig(address(callVault)).mandate)), before, "mandate unchanged");
        assertEq(callVault.manager(), address(manager));

        vm.prank(agent);
        manager.openEpoch(address(callVault));
        vm.prank(agent);
        (bool ok,) = manager.proposeSeries(address(callVault), 275 * WAD, FRIDAY_CLOSE, 50 * WAD, 9000);
        assertFalse(ok, "90% of fair value is still below this vault's 95%");
    }

    // ------------------------------------------------------------------ admin

    /// The admin calls `settle` with the last print before expiry, with a later in-the-money print, and with a later
    /// print dressed up as a corporate-action hint: InvalidSettlementRound each time. Only the first print at or after
    /// expiry settles, and once recorded the price is final: swapping the token's feed afterwards changes nothing.
    function test_ADV_CHEAT_adminCannotSettleOffTheFirstRound() public {
        _depositCall(alice, 100 * WAD);
        uint256 id = _openAndPropose(callVault, 275 * WAD, 100 * WAD);
        _buy(id, 50 * WAD);
        uint80 before = feed.push(251e8, FRIDAY_CLOSE - 1);
        uint80 first = feed.push(260e8, FRIDAY_CLOSE + 1);
        uint80 later = feed.push(320e8, FRIDAY_CLOSE + 2 hours);
        vm.warp(FRIDAY_CLOSE + 3 hours);

        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.InvalidSettlementRound.selector, before));
        manager.settle(address(callVault), before);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.InvalidSettlementRound.selector, later));
        manager.settle(address(callVault), later);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.InvalidSettlementRound.selector, later));
        oracle.recordSettlementPriceWithHints(address(tsla), FRIDAY_CLOSE, _hints(later, first));
        assertEq(oracle.settlementPrice(address(tsla), FRIDAY_CLOSE), 0, "nothing recorded");

        manager.settle(address(callVault), first);
        MockAggregator other = new MockAggregator(8);
        uint80 fake = other.push(400e8, FRIDAY_CLOSE + 1);
        oracle.setFeed(address(tsla), other, 1 days, 1 days);
        assertEq(oracle.recordSettlementPrice(address(tsla), FRIDAY_CLOSE, fake), 260e18, "recorded once, final");
        vm.stopPrank();

        EpochManager.Series memory s = manager.getSeries(id);
        assertEq(s.settlementPrice, 260e18);
        assertEq(s.payoutPerOption, 0, "out of the money at the first print");
        assertEq(s.escrow, 0);
        assertEq(callVault.totalAssets(), 100 * WAD, "no collateral left the vault");
    }

    // ------------------------------------------------------------------ oracle

    function _expectBlocked(uint256 id, bytes memory err) internal {
        vm.expectRevert(err);
        manager.spot(address(tsla));
        vm.expectRevert(err);
        manager.quoteBuy(id, WAD);
        vm.prank(buyer);
        vm.expectRevert(err);
        manager.buy(id, WAD, type(uint256).max, buyer);
    }

    /// The feed answers 0, a negative price, a price stamped in the future, then goes stale. Every price read the
    /// protocol makes refuses it: no buy, no epoch opens, and a proposal (inside or outside the mandate) reverts
    /// rather than being judged or slashed on it. One good print and sales resume.
    function test_ADV_CHEAT_maliciousOracleAnswerBlocksSales() public {
        _depositCall(alice, 100 * WAD);
        _depositPut(alice, 30_000 * USDG_UNIT);
        uint256 id = _openAndPropose(callVault, 275 * WAD, 100 * WAD);
        usdg.mint(buyer, 1000e6);
        vm.prank(buyer);
        usdg.approve(address(manager), type(uint256).max);

        bytes[] memory errs = new bytes[](4);
        feed.set(0);
        errs[0] = abi.encodeWithSelector(SafeStockFeed.InvalidPrice.selector, int256(0));
        _expectBlocked(id, errs[0]);
        vm.prank(agent);
        vm.expectRevert(errs[0]);
        manager.openEpoch(address(putVault));

        feed.set(-250e8);
        errs[1] = abi.encodeWithSelector(SafeStockFeed.InvalidPrice.selector, int256(-250e8));
        _expectBlocked(id, errs[1]);

        feed.push(250e8, block.timestamp + 1 hours);
        errs[2] = abi.encodeWithSelector(SafeStockFeed.InvalidPrice.selector, int256(250e8));
        _expectBlocked(id, errs[2]);

        // Tuesday 16:00 UTC: the future-dated print is now 25 hours old.
        uint256 stampedAt = block.timestamp + 1 hours;
        vm.warp(block.timestamp + 1 days + 2 hours);
        errs[3] = abi.encodeWithSelector(SafeStockFeed.StalePrice.selector, stampedAt, 1 days);
        _expectBlocked(id, errs[3]);

        // An open epoch: neither an honest nor a reckless proposal is judged on a bad live price.
        feed.set(250e8);
        vm.prank(agent);
        manager.openEpoch(address(putVault));
        feed.set(0);
        vm.startPrank(agent);
        vm.expectRevert(errs[0]);
        manager.proposeSeries(address(putVault), 235 * WAD, FRIDAY_CLOSE, 10 * WAD, 10_000);
        vm.expectRevert(errs[0]);
        manager.proposeSeries(address(putVault), 260 * WAD, FRIDAY_CLOSE, 10 * WAD, 10_000);
        vm.stopPrank();
        assertEq(_strikes(), 0);
        assertEq(manager.compensation(address(putVault)), 0);

        assertEq(manager.getSeries(id).sold, 0, "nothing sold at a bad price");
        assertEq(usdg.balanceOf(buyer), 1000e6);
        feed.set(250e8);
        vm.prank(buyer);
        manager.buy(id, WAD, type(uint256).max, buyer);
        assertEq(manager.getSeries(id).sold, WAD);
    }

    /// The first round after expiry is malformed (zero or negative) and the feed then prints normally. That round is
    /// refused, and a later round cannot stand in for it (its predecessor is already after expiry), with one hint or
    /// two. Nothing is ever paid at a price other than the first print: after `settlementGrace` the guardian cancels
    /// and buyers get their premium back (T14). Chainlink's `minAnswer` and MirrorFeed's `InvalidAnswer` keep such a
    /// round from being published in the first place.
    function test_ADV_CHEAT_nonPositiveSettlementPrintNeverPays(int256 answer) public {
        answer = bound(answer, type(int256).min, 0);
        _depositCall(alice, 100 * WAD);
        uint256 id = _openAndPropose(callVault, 275 * WAD, 100 * WAD);
        uint256 premium = _buy(id, 60 * WAD);
        uint80 bad = feed.push(answer, FRIDAY_CLOSE + 1);
        uint80 good = feed.push(300e8, FRIDAY_CLOSE + 1 hours);
        vm.warp(FRIDAY_CLOSE + 2 hours);

        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.InvalidPrice.selector, answer));
        manager.settle(address(callVault), bad);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.InvalidSettlementRound.selector, good));
        manager.settle(address(callVault), good);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.InvalidSettlementRound.selector, good));
        oracle.recordSettlementPriceWithHints(address(tsla), FRIDAY_CLOSE, _hints(good, bad));
        assertEq(oracle.settlementPrice(address(tsla), FRIDAY_CLOSE), 0);

        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(EpochManager.TooEarly.selector, uint256(FRIDAY_CLOSE) + 7 days));
        manager.emergencyCancel(address(callVault));
        vm.warp(FRIDAY_CLOSE + 7 days);
        vm.prank(guardian);
        manager.emergencyCancel(address(callVault));
        vm.prank(buyer);
        assertEq(manager.redeem(id, 60 * WAD, buyer), premium, "premium refunded, nothing paid at a made-up price");
        assertEq(callVault.totalAssets(), 100 * WAD);
        assertEq(tsla.balanceOf(buyer), 0);
    }

    /// The first round after expiry is stamped an hour ahead of the chain. It is refused until the chain reaches
    /// that time, then it (and only it) settles the series.
    function test_ADV_CHEAT_futureDatedSettlementPrintWaits() public {
        _depositCall(alice, 100 * WAD);
        uint256 id = _openAndPropose(callVault, 275 * WAD, 100 * WAD);
        _buy(id, 60 * WAD);
        vm.warp(FRIDAY_CLOSE + 60);
        uint80 r = feed.push(300e8, FRIDAY_CLOSE + 1 hours);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.InvalidPrice.selector, int256(300e8)));
        manager.settle(address(callVault), r);
        assertTrue(callVault.locked(), "waits");

        vm.warp(FRIDAY_CLOSE + 1 hours);
        manager.settle(address(callVault), r);
        assertEq(manager.getSeries(id).settlementPrice, 300e18);
    }

    // ------------------------------------------------------------------ fake vault

    /// An attacker clones the vault implementation, wires it to the real manager and calls every entry point with
    /// it. The manager only knows vaults its factory registered: VaultNotRegistered (or WrongState) everywhere, the
    /// attacker cannot register it, and it cannot lock or settle a real vault or mint options as a fake manager.
    function test_ADV_CHEAT_fakeVaultNotFromFactory() public {
        address attacker = makeAddr("attacker");
        vm.startPrank(attacker);
        StrikeVault fake = StrikeVault(Clones.clone(address(vaultImpl)));
        fake.initialize(
            IStrikeVault.InitParams({
                asset: address(tsla),
                premiumToken: address(usdg),
                underlying: address(tsla),
                isCall: true,
                manager: address(manager),
                depositCap: type(uint256).max,
                name: "Strike TSLA Covered Call",
                symbol: "sTSLA-CC"
            })
        );
        bytes memory unknown = abi.encodeWithSelector(EpochManager.VaultNotRegistered.selector, address(fake));
        vm.expectRevert(unknown);
        manager.abortEpoch(address(fake));
        vm.expectRevert(unknown);
        manager.setVaultAgent(address(fake), agentId);
        vm.expectRevert(unknown);
        manager.previewProposal(address(fake), 275 * WAD, FRIDAY_CLOSE, WAD, 10_000);
        bytes32 factoryRole = manager.FACTORY_ROLE();
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, attacker, factoryRole)
        );
        manager.registerVault(address(fake), attacker, agentId, _mandate());
        vm.expectRevert(StrikeVault.NotManager.selector);
        callVault.lock();
        vm.expectRevert(StrikeVault.NotManager.selector);
        callVault.settleEpoch(0, 0);
        vm.expectRevert(OptionToken.NotManager.selector);
        options.mint(attacker, 1, WAD);
        vm.stopPrank();

        // Even the vault's real agent and the keeper cannot run an epoch on it.
        vm.prank(agent);
        vm.expectRevert(unknown);
        manager.openEpoch(address(fake));
        vm.prank(keeper);
        vm.expectRevert(unknown);
        manager.openEpoch(address(fake));
        vm.prank(agent);
        vm.expectRevert(unknown);
        manager.proposeSeries(address(fake), 275 * WAD, FRIDAY_CLOSE, WAD, 10_000);
        vm.prank(agent);
        vm.expectRevert(_wrongState(EpochManager.EpochState.Open, EpochManager.EpochState.Idle));
        manager.proposeByDelta(address(fake), 2000, FRIDAY_CLOSE, WAD, 10_000);
        vm.expectRevert(_wrongState(EpochManager.EpochState.Selling, EpochManager.EpochState.Idle));
        manager.settle(address(fake), 1);

        assertEq(manager.vaultCount(), 2);
        assertFalse(manager.vaultConfig(address(fake)).registered);
        assertFalse(callVault.locked());
    }

    // ------------------------------------------------------------------ ERC-8056 multiplier

    /// A split or dividend multiplier (0.5x to 10x) took effect before the epoch. Spot, the buy quote, the settlement
    /// price and the payout all use the feed's price per raw token; nothing multiplies it again. A double application
    /// would have paid (S·m − K) / (S·m) per option instead of (S − K) / S.
    function test_ADV_CHEAT_multiplierNeverAppliedTwice(uint256 multiplier) public {
        multiplier = bound(multiplier, 0.5e18, 10e18);
        tsla.scheduleMultiplier(multiplier, MONDAY - 3 days);
        tsla.applyMultiplier();
        _depositCall(alice, 100 * WAD);
        assertEq(manager.spot(address(tsla)), 250 * WAD);

        uint256 id = _openAndPropose(callVault, 275 * WAD, 100 * WAD);
        (uint256 quote,) = manager.quoteBuy(id, 10 * WAD);
        (uint256 fair,) = pricer.quote(250 * WAD, 275 * WAD, FRIDAY_CLOSE - block.timestamp, 0.6e18, true);
        assertEq(quote, Decimals.valueInUsd(10 * WAD, fair, 18, 6, Math.Rounding.Ceil));

        _buy(id, 60 * WAD);
        manager.settle(address(callVault), _expireAt(300e8));
        EpochManager.Series memory s = manager.getSeries(id);
        uint256 perOption = Math.mulDiv(25 * WAD, WAD, 300 * WAD);
        assertEq(s.settlementPrice, 300 * WAD);
        assertEq(s.payoutPerOption, perOption);
        vm.prank(buyer);
        uint256 paid = manager.redeem(id, 60 * WAD, buyer);
        assertEq(paid, Math.mulDiv(60 * WAD, perOption, WAD));
        if (multiplier != WAD) {
            uint256 scaled = 300 * multiplier;
            uint256 doubled = scaled > 275 * WAD ? Math.mulDiv(scaled - 275 * WAD, WAD, scaled) : 0;
            assertTrue(perOption != doubled, "the multiplier did not enter the payout");
        }
    }
}
