// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {EpochManager} from "../../src/core/EpochManager.sol";
import {AdversarialBase} from "./AdversarialBase.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

/// @notice DOUBLE-SPEND, v3 only: the fee high-water mark (`FeeManager.lossCarried`). Sequences of epochs are in
///         `integration/FeeHighWaterMark.t.sol` and `testFuzz_AUDIT3_safe_feeChargedOnlyAtNewHighWaterMark`; the known
///         dilution limit (L-02) in `test_AUDIT3_lossCarryDilutedByLaterDeposits`. Map: docs/security/adversarial.md
///         (on main).
contract AdversarialDoubleSpendV3Test is AdversarialBase {
    /// The put vault loses in epoch 1, so it carries a loss. The agent, which receives half of every fee, tries to
    /// clear the carry or charge again: `chargeFee` is EpochManager-only and a replayed settle reverts, so the carry
    /// is untouched. Epoch 2 earns more than the loss: the fee is charged once, on the excess only; replaying the
    /// settlement charges nothing more, and the agent's cut is claimed once.
    function test_ADV_DOUBLESPEND_feeChargedOnceAboveHighWaterMark() public {
        _depositPut(alice, 100_000 * USDG_UNIT);
        uint256 id1 = _openAndPropose(putVault, 235 * WAD, 400 * WAD);
        uint256 p1 = _buy(id1, 100 * WAD);
        uint80 r1 = _expireAt(233e8); // each put pays 2 USDG
        manager.settle(address(putVault), r1);
        uint256 loss = manager.getSeries(id1).escrow - p1;
        assertEq(fees.lossCarried(address(putVault)), loss);
        assertEq(fees.totalClaimable(), 0);

        bytes32 role = fees.DEPOSITOR_ROLE();
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, agent, role));
        fees.chargeFee(address(putVault), 10 * loss, 0);
        bytes memory closed = _wrongState(EpochManager.EpochState.Selling, EpochManager.EpochState.Idle);
        vm.prank(agent);
        vm.expectRevert(closed);
        manager.settle(address(putVault), r1);
        assertEq(fees.lossCarried(address(putVault)), loss, "the carry is untouched");

        vm.warp(NEXT_MONDAY);
        feed.set(250e8);
        vm.prank(agent);
        manager.openEpoch(address(putVault));
        vm.prank(agent);
        (, uint256 id2) = manager.proposeSeries(address(putVault), 235 * WAD, NEXT_FRIDAY_CLOSE, 400 * WAD, 10_000);
        uint256 p2 = _buy(id2, 400 * WAD);
        vm.warp(NEXT_FRIDAY_CLOSE + 60);
        uint80 r2 = feed.set(250e8);
        manager.settle(address(putVault), r2);
        assertGt(p2, loss, "epoch 2 recovers more than the loss");
        uint256 fee = (p2 - loss) * 1000 / 10_000;
        assertEq(fees.totalClaimable(), fee, "fee on the excess only");
        assertEq(fees.lossCarried(address(putVault)), 0);

        vm.expectRevert(closed);
        manager.settle(address(putVault), r2);
        assertEq(fees.totalClaimable(), fee, "not charged twice");
        vm.prank(agent);
        assertEq(fees.claim(), (p2 - loss) * 1000 * 5000 / 1e8);
        vm.prank(agent);
        assertEq(fees.claim(), 0);
        assertApproxEqAbs(putVault.pendingPremium(alice), p1 + p2 - fee, 2);
    }
}
