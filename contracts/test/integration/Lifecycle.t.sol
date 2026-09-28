// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {EpochManager} from "../../src/core/EpochManager.sol";
import {MandateGuard} from "../../src/libraries/MandateGuard.sol";
import {StrikeBase} from "../utils/StrikeBase.sol";

/// @notice End-to-end epochs: deposit → open → propose → buy → expire → settle → redeem → claim.
contract LifecycleTest is StrikeBase {
    // ------------------------------------------------------------------ covered calls

    function test_callVault_expiresOutOfTheMoney() public {
        _depositCall(alice, 100 * WAD);
        uint256 seriesId = _openAndPropose(callVault, 275 * WAD, 100 * WAD);
        uint256 premium = _buy(seriesId, 50 * WAD);
        assertGt(premium, 0);
        assertEq(options.balanceOf(buyer, seriesId), 50 * WAD);

        uint80 round = _expireAt(260e8);
        manager.settle(address(callVault), round);

        // No payout; the vault keeps every token and the vault unlocks.
        assertEq(callVault.totalAssets(), 100 * WAD);
        assertFalse(callVault.locked());
        (EpochManager.EpochState state,,) = manager.epochs(address(callVault));
        assertEq(uint8(state), uint8(EpochManager.EpochState.Idle));

        // 10% performance fee on the (fully profitable) premium, half to the agent.
        uint256 fee = premium / 10;
        assertEq(fees.claimable(agent), fee / 2);
        assertEq(fees.claimable(treasury), fee - fee / 2);

        // Alice receives the rest in USDG (rounding dust stays in the vault).
        assertApproxEqAbs(callVault.pendingPremium(alice), premium - fee, 1);
        vm.prank(alice);
        uint256 claimed = callVault.claimPremium();
        assertEq(usdg.balanceOf(alice), claimed);

        // Worthless options redeem for nothing.
        vm.prank(buyer);
        assertEq(manager.redeem(seriesId, 50 * WAD, buyer), 0);
        assertEq(options.balanceOf(buyer, seriesId), 0);
    }

    function test_callVault_expiresInTheMoney() public {
        _depositCall(alice, 100 * WAD);
        uint256 seriesId = _openAndPropose(callVault, 275 * WAD, 100 * WAD);
        _buy(seriesId, 60 * WAD);

        uint80 round = _expireAt(300e8);
        manager.settle(address(callVault), round);

        // Each option pays (300 - 275) / 300 = 1/12 of a token.
        uint256 expectedPayout = 60 * WAD / 12;
        assertApproxEqAbs(callVault.totalAssets(), 100 * WAD - expectedPayout, 100);
        vm.prank(buyer);
        uint256 paid = manager.redeem(seriesId, 60 * WAD, buyer);
        assertApproxEqAbs(paid, expectedPayout, 100);
        assertLe(paid, expectedPayout);
        assertEq(tsla.balanceOf(buyer), paid);
        // Worth (S - K) per option in dollars.
        assertApproxEqAbs(paid * 300, 60 * 25 * WAD, 100 * 300);
    }

    function test_callVault_splitRedemptionsNeverExceedEscrow() public {
        _depositCall(alice, 100 * WAD);
        uint256 seriesId = _openAndPropose(callVault, 275 * WAD, 100 * WAD);
        _buy(seriesId, 33 * WAD + 7);
        uint80 round = _expireAt(311e8);
        manager.settle(address(callVault), round);
        vm.startPrank(buyer);
        for (uint256 i; i < 3; ++i) {
            manager.redeem(seriesId, 11 * WAD, buyer);
        }
        manager.redeem(seriesId, 7, buyer);
        vm.stopPrank();
        assertGe(manager.getSeries(seriesId).escrow, 0);
        assertGe(tsla.balanceOf(address(manager)), manager.getSeries(seriesId).escrow);
    }

    // ------------------------------------------------------------------ cash-secured puts

    function test_putVault_expiresInTheMoney() public {
        _depositPut(alice, 30_000 * USDG_UNIT);
        uint256 seriesId = _openAndPropose(putVault, 235 * WAD, 100 * WAD);
        uint256 premium = _buy(seriesId, 100 * WAD);

        uint80 round = _expireAt(200e8);
        manager.settle(address(putVault), round);

        // 100 puts × (235 - 200) = 3,500 USDG.
        assertEq(putVault.totalAssets(), 30_000 * USDG_UNIT - 3500 * USDG_UNIT);
        vm.prank(buyer);
        uint256 paid = manager.redeem(seriesId, 100 * WAD, buyer);
        assertEq(paid, 3500 * USDG_UNIT);
        // Premium was below the payout: no performance fee.
        assertEq(fees.claimable(treasury), 0);
        assertApproxEqAbs(putVault.pendingPremium(alice), premium, 1);
    }

    function test_putVault_collateralCoversCrashToZero() public {
        _depositPut(alice, 23_500 * USDG_UNIT);
        uint256 seriesId = _openAndPropose(putVault, 235 * WAD, 100 * WAD);
        _buy(seriesId, 100 * WAD);
        uint80 round = _expireAt(1); // $0.00000001
        manager.settle(address(putVault), round);
        vm.prank(buyer);
        uint256 paid = manager.redeem(seriesId, 100 * WAD, buyer);
        assertLe(paid, 23_500 * USDG_UNIT);
        assertApproxEqAbs(paid, 23_500 * USDG_UNIT, 1);
    }

    // ------------------------------------------------------------------ queue

    function test_queue_processedAtSettlementPrice() public {
        _depositCall(alice, 100 * WAD);
        uint256 seriesId = _openAndPropose(callVault, 275 * WAD, 100 * WAD);
        uint256 premium = _buy(seriesId, 100 * WAD);

        // While locked, Bob queues a deposit and Alice queues half her shares for redemption.
        tsla.mint(bob, 40 * WAD);
        vm.startPrank(bob);
        tsla.approve(address(callVault), 40 * WAD);
        vm.expectRevert();
        callVault.deposit(40 * WAD, bob);
        callVault.requestDeposit(40 * WAD, bob);
        vm.stopPrank();
        uint256 aliceShares = callVault.balanceOf(alice);
        vm.prank(alice);
        callVault.requestRedeem(aliceShares / 2);

        // ITM: vault pays out 100 × 25/300 tokens.
        uint80 round = _expireAt(300e8);
        manager.settle(address(callVault), round);

        uint256 assetsAfterPayout = 100 * WAD - uint256(100 * WAD) / 12;
        // Alice's redeemed half gets half the post-payout assets.
        uint256 aliceAssets = callVault.claimRedeem(alice);
        assertApproxEqAbs(aliceAssets, assetsAfterPayout / 2, 100);
        // Bob's shares are priced at the same post-settlement share price.
        uint256 bobShares = callVault.claimDeposit(bob);
        assertApproxEqRel(callVault.convertToAssets(bobShares), 40 * WAD, 1e12);
        // Premium: Alice earned all of it (both halves carried the epoch's risk); Bob earned none.
        uint256 fee = 0; // loss-making epoch for the vault → no fee
        assertApproxEqAbs(callVault.pendingPremium(alice), premium - fee, 2);
        assertEq(callVault.pendingPremium(bob), 0);
    }

    function test_queue_cancelDepositBeforeSettlement() public {
        _depositCall(alice, 10 * WAD);
        _openAndPropose(callVault, 275 * WAD, 10 * WAD);
        tsla.mint(bob, 5 * WAD);
        vm.startPrank(bob);
        tsla.approve(address(callVault), 5 * WAD);
        callVault.requestDeposit(5 * WAD, bob);
        callVault.cancelDepositRequest();
        vm.stopPrank();
        assertEq(tsla.balanceOf(bob), 5 * WAD);
        assertEq(callVault.pendingDepositAssets(), 0);
    }

    function test_twoEpochs_depositClaimCreditsLaterPremium() public {
        _depositCall(alice, 50 * WAD);
        uint256 s1 = _openAndPropose(callVault, 275 * WAD, 50 * WAD);
        _buy(s1, 10 * WAD);
        tsla.mint(bob, 50 * WAD);
        vm.startPrank(bob);
        tsla.approve(address(callVault), 50 * WAD);
        callVault.requestDeposit(50 * WAD, bob);
        vm.stopPrank();
        manager.settle(address(callVault), _expireAt(250e8));

        // Epoch 2 (Monday 12:00 New York) while Bob has not claimed his shares yet: he still earns his half.
        vm.warp(FRIDAY_CLOSE + 3 days - 4 hours);
        feed.set(250e8);
        vm.prank(agent);
        manager.openEpoch(address(callVault));
        vm.prank(agent);
        (, uint256 s2) = manager.proposeSeries(address(callVault), 275 * WAD, NEXT_FRIDAY_CLOSE, 100 * WAD, 10_000);
        uint256 p2 = _buy(s2, 100 * WAD);
        vm.warp(NEXT_FRIDAY_CLOSE + 60);
        manager.settle(address(callVault), feed.set(260e8));

        callVault.claimDeposit(bob);
        uint256 net2 = p2 - p2 / 10;
        assertApproxEqRel(callVault.pendingPremium(bob), net2 / 2, 1e14);
    }

    // ------------------------------------------------------------------ rejections, aborts, emergencies

    function test_rejectedProposal_keepsEpochOpen() public {
        _depositCall(alice, 10 * WAD);
        vm.prank(agent);
        manager.openEpoch(address(callVault));
        vm.expectEmit(true, true, true, false, address(manager));
        emit EpochManager.ProposalRejected(
            address(callVault), 1, agent, MandateGuard.Reason.StrikeWrongSide, 0, 0, 0, 0
        );
        vm.prank(agent);
        (bool accepted,) = manager.proposeSeries(address(callVault), 240 * WAD, FRIDAY_CLOSE, 10 * WAD, 10_000);
        assertFalse(accepted);
        (EpochManager.EpochState state,,) = manager.epochs(address(callVault));
        assertEq(uint8(state), uint8(EpochManager.EpochState.Open));
    }

    function test_abortEpoch_afterTimeout() public {
        _depositCall(alice, 10 * WAD);
        vm.prank(agent);
        manager.openEpoch(address(callVault));
        vm.expectRevert(abi.encodeWithSelector(EpochManager.TooEarly.selector, MONDAY + 1 days));
        manager.abortEpoch(address(callVault));
        vm.warp(MONDAY + 1 days);
        manager.abortEpoch(address(callVault));
        assertFalse(callVault.locked());
        uint256 shares = callVault.balanceOf(alice);
        vm.prank(alice);
        callVault.redeem(shares, alice, alice);
        assertEq(tsla.balanceOf(alice), 10 * WAD);
    }

    function test_emergencyCancel_refundsPremium() public {
        _depositCall(alice, 10 * WAD);
        uint256 seriesId = _openAndPropose(callVault, 275 * WAD, 10 * WAD);
        uint256 premium = _buy(seriesId, 10 * WAD);
        vm.warp(FRIDAY_CLOSE + 7 days);
        vm.prank(guardian);
        manager.emergencyCancel(address(callVault));
        assertEq(callVault.totalAssets(), 10 * WAD);
        vm.prank(buyer);
        assertEq(manager.redeem(seriesId, 10 * WAD, buyer), premium);
    }

    function test_settle_withoutSalesNeedsNoPrice() public {
        _depositCall(alice, 10 * WAD);
        _openAndPropose(callVault, 275 * WAD, 10 * WAD);
        vm.warp(FRIDAY_CLOSE + 1);
        manager.settle(address(callVault), 0);
        assertFalse(callVault.locked());
    }

    function test_pause_blocksSalesButNotSettlementOrWithdrawals() public {
        _depositCall(alice, 10 * WAD);
        uint256 seriesId = _openAndPropose(callVault, 275 * WAD, 10 * WAD);
        _buy(seriesId, 5 * WAD);
        vm.prank(guardian);
        manager.pause();
        vm.expectRevert();
        manager.buy(seriesId, 1, type(uint256).max, buyer);
        manager.settle(address(callVault), _expireAt(250e8));
        uint256 shares = callVault.balanceOf(alice);
        vm.prank(alice);
        callVault.redeem(shares, alice, alice);
        assertEq(tsla.balanceOf(alice), 10 * WAD);
    }
}
