// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {EpochManager} from "../../src/core/EpochManager.sol";
import {StrikeBase} from "../utils/StrikeBase.sol";

/// @notice The performance fee through full epochs (D31): after a losing week, the fee is charged only on the part of
///         later net premium that exceeds the vault's carried loss.
contract FeeHighWaterMarkTest is StrikeBase {
    uint256 internal constant PUT_STRIKE = 235 * WAD;

    function setUp() public override {
        super.setUp();
        _depositPut(alice, 100_000 * USDG_UNIT);
    }

    /// Epoch 1 on the put vault: sell `amount` puts struck at 235, settle at `price8`. Returns (premium, payout).
    function _epoch1(uint256 amount, int256 price8) internal returns (uint256 premium, uint256 payout) {
        uint256 id = _openAndPropose(putVault, PUT_STRIKE, 400 * WAD);
        premium = _buy(id, amount);
        manager.settle(address(putVault), _expireAt(price8));
        payout = manager.getSeries(id).escrow;
    }

    /// Epoch 2: the following week, sell `amount` puts, expire out of the money. Returns (premium, fee).
    function _epoch2(uint256 amount) internal returns (uint256 premium, uint256 fee) {
        vm.warp(FRIDAY_CLOSE + 3 days - 4 hours); // Monday 12:00 New York
        feed.set(250e8);
        vm.prank(agent);
        manager.openEpoch(address(putVault));
        vm.prank(agent);
        (, uint256 id) = manager.proposeSeries(address(putVault), PUT_STRIKE, NEXT_FRIDAY_CLOSE, 400 * WAD, 10_000);
        premium = _buy(id, amount);
        uint256 before = fees.totalClaimable();
        vm.warp(NEXT_FRIDAY_CLOSE + 60);
        manager.settle(address(putVault), feed.set(250e8));
        fee = fees.totalClaimable() - before;
    }

    function test_lossThenSmallerGain_noFee() public {
        (uint256 p1, uint256 payout1) = _epoch1(100 * WAD, 215e8); // each put pays 20 USDG
        assertGt(payout1, p1, "epoch 1 must lose");
        uint256 loss = payout1 - p1;
        assertEq(fees.lossCarried(address(putVault)), loss);
        assertEq(fees.totalClaimable(), 0);

        (uint256 p2, uint256 fee2) = _epoch2(100 * WAD);
        assertLt(p2, loss, "epoch 2 must recover less than the loss");
        assertEq(fee2, 0);
        assertEq(fees.lossCarried(address(putVault)), loss - p2);
        // Depositors keep the whole premium while the loss is being recovered.
        assertApproxEqAbs(putVault.pendingPremium(alice), p1 + p2, 2);
    }

    function test_lossThenBiggerGain_feeOnExcessOnly() public {
        (uint256 p1, uint256 payout1) = _epoch1(100 * WAD, 233e8); // each put pays 2 USDG
        assertGt(payout1, p1, "epoch 1 must lose");
        uint256 loss = payout1 - p1;

        (uint256 p2, uint256 fee2) = _epoch2(400 * WAD);
        assertGt(p2, loss, "epoch 2 must recover more than the loss");
        uint256 excess = p2 - loss;
        assertEq(fee2, excess * 1000 / 10_000); // 10% of the excess, not of p2
        assertLt(fee2, p2 * 1000 / 10_000);
        assertEq(fees.claimable(agent), excess * 1000 * 5000 / 1e8);
        assertEq(fees.lossCarried(address(putVault)), 0);
    }

    /// The carry belongs to the vault: a loss in the put vault does not reduce the call vault's fee.
    function test_carryIsPerVault() public {
        _epoch1(100 * WAD, 215e8);
        assertGt(fees.lossCarried(address(putVault)), 0);
        assertEq(fees.lossCarried(address(callVault)), 0);
    }

    /// `EpochSettled` reports the fee actually charged: zero while the carried loss is being recovered.
    function test_epochSettledReportsZeroFeeWhileRecovering() public {
        _epoch1(100 * WAD, 215e8);
        vm.warp(FRIDAY_CLOSE + 3 days - 4 hours);
        feed.set(250e8);
        vm.prank(agent);
        manager.openEpoch(address(putVault));
        vm.prank(agent);
        (, uint256 id) = manager.proposeSeries(address(putVault), PUT_STRIKE, NEXT_FRIDAY_CLOSE, 400 * WAD, 10_000);
        uint256 p2 = _buy(id, 10 * WAD);
        vm.warp(NEXT_FRIDAY_CLOSE + 60);
        uint80 round = feed.set(250e8);
        vm.expectEmit(true, true, true, true, address(manager));
        emit EpochManager.EpochSettled(address(putVault), 2, id, 250 * WAD, 0, p2, 0);
        manager.settle(address(putVault), round);
    }
}
