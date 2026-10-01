// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {StrikeBase} from "../utils/StrikeBase.sol";
import {console2} from "forge-std/console2.sol";

/// @notice Audit 2026-10-01 (v3): the performance fee's per-vault high-water mark (`FeeManager.lossCarried`).
contract AuditV3FeeTest is StrikeBase {
    uint256 internal constant PUT_STRIKE = 235 * WAD;
    uint256 internal constant DEPOSIT = 100_000 * USDG_UNIT;

    /// Open the put vault's epoch, propose `size` puts at 235 expiring at `expiry`, sell `amount`.
    function _sellPuts(uint64 expiry, uint256 size, uint256 amount) internal returns (uint256 id, uint256 premium) {
        vm.prank(agent);
        manager.openEpoch(address(putVault));
        bool ok;
        vm.prank(agent);
        (ok, id) = manager.proposeSeries(address(putVault), PUT_STRIKE, expiry, size, 10_000);
        assertTrue(ok, "proposal rejected");
        premium = _buy(id, amount);
    }

    /// Epoch 1: 100 puts settle at 215, so each pays 20 USDG, far above its premium. Returns the net loss.
    function _losingEpoch() internal returns (uint256 loss) {
        (uint256 id, uint256 premium) = _sellPuts(FRIDAY_CLOSE, 400 * WAD, 100 * WAD);
        manager.settle(address(putVault), _expireAt(215e8));
        uint256 payout = manager.getSeries(id).escrow;
        assertGt(payout, premium, "epoch 1 must lose");
        loss = payout - premium;
        assertEq(fees.lossCarried(address(putVault)), loss);
        assertEq(fees.totalClaimable(), 0);
    }

    /// Monday noon New York after epoch 1, spot back at 250.
    function _nextMonday() internal {
        vm.warp(FRIDAY_CLOSE + 3 days - 4 hours);
        feed.set(250e8);
    }

    function _value(address who) internal view returns (uint256) {
        return putVault.convertToAssets(putVault.balanceOf(who)) + putVault.pendingPremium(who);
    }

    // ================================================================== L-02
    /// L-02 (Low, documented, no code fix): the carried loss is an absolute USDG amount per vault, not a mark per
    /// share. A deposit after a losing epoch dilutes it: the vault's cumulative net reaches a new high and a fee is
    /// charged while the depositors who bore the loss are still under water. The agent (half of every fee) can do
    /// this on purpose with its own capital for one epoch.
    function test_AUDIT3_lossCarryDilutedByLaterDeposits() public {
        _depositPut(alice, DEPOSIT);
        uint256 loss = _losingEpoch();
        assertLt(_value(alice), DEPOSIT);

        // Bob (say, the agent) deposits nine times the vault between the epochs.
        _depositPut(bob, 9 * DEPOSIT);
        _nextMonday();
        (, uint256 premium2) = _sellPuts(NEXT_FRIDAY_CLOSE, 4000 * WAD, 2000 * WAD);
        vm.warp(NEXT_FRIDAY_CLOSE + 60);
        manager.settle(address(putVault), feed.set(250e8));

        // The vault as a whole is above its high-water mark, so the fee is charged on the excess, as designed...
        uint256 fee = fees.totalClaimable();
        assertGt(premium2, loss);
        assertEq(fee, (premium2 - loss) * 1000 / 10_000);
        assertEq(fees.lossCarried(address(putVault)), 0);
        // ...while alice, who bore the whole loss, has recovered only her tenth of epoch 2's premium.
        console2.log("loss carried after epoch 1 (USDG units)", loss);
        console2.log("premium of epoch 2 (USDG units)        ", premium2);
        console2.log("fee charged in epoch 2 (USDG units)    ", fee);
        console2.log("alice: deposit minus value (USDG units)", DEPOSIT - _value(alice));
        assertGt(fee, 0);
        assertLt(
            _value(alice), DEPOSIT, "AUDIT L-02: a fee was charged while the loss-bearing depositor is under water"
        );
    }

    /// L-02, the other direction: the carry outlives the depositors who created it. A newcomer to an emptied vault
    /// earns premium fee-free until a loss it never bore is "recovered"; the treasury and the agent get nothing.
    function test_AUDIT3_lossCarrySurvivesDepositorExit() public {
        _depositPut(alice, DEPOSIT);
        uint256 loss = _losingEpoch();
        uint256 shares = putVault.balanceOf(alice);
        vm.prank(alice);
        putVault.redeem(shares, alice, alice);
        assertLe(putVault.totalAssets(), 1);
        assertEq(fees.lossCarried(address(putVault)), loss);

        _depositPut(bob, DEPOSIT);
        _nextMonday();
        (, uint256 premium2) = _sellPuts(NEXT_FRIDAY_CLOSE, 400 * WAD, 100 * WAD);
        vm.warp(NEXT_FRIDAY_CLOSE + 60);
        manager.settle(address(putVault), feed.set(250e8));
        assertLt(premium2, loss);
        assertEq(fees.totalClaimable(), 0, "AUDIT L-02: no fee on a newcomer's premium");
        assertEq(fees.lossCarried(address(putVault)), loss - premium2);
        assertApproxEqAbs(putVault.pendingPremium(bob), premium2, 2);
    }

    // ================================================================== held
    /// Over any sequence of epochs the fee is exactly `perfFeeBps` of the part of each epoch's net premium above
    /// the vault's previous high-water mark, the carry is the distance below that mark, and the agent's cut never
    /// exceeds the fee. The invariant suite checks the same through full epochs (`invariant_feeHighWaterMark`).
    function testFuzz_AUDIT3_safe_feeChargedOnlyAtNewHighWaterMark(
        uint64[16] memory premiums,
        uint64[16] memory payouts
    ) public {
        bytes32 role = fees.DEPOSITOR_ROLE();
        vm.prank(admin);
        fees.grantRole(role, address(this));
        address vault = makeAddr("vault");
        int256 cumulative;
        int256 highWaterMark;
        for (uint256 i; i < 16; ++i) {
            (uint256 fee, uint256 agentCut) = fees.chargeFee(vault, premiums[i], payouts[i]);
            cumulative += int256(uint256(premiums[i])) - int256(uint256(payouts[i]));
            uint256 base = cumulative > highWaterMark ? uint256(cumulative - highWaterMark) : 0;
            assertEq(fee, base * 1000 / 10_000, "fee");
            assertEq(agentCut, base * 1000 * 5000 / 1e8, "agent cut");
            assertLe(agentCut, fee);
            if (cumulative > highWaterMark) highWaterMark = cumulative;
            assertEq(fees.lossCarried(vault), uint256(highWaterMark - cumulative), "carry");
        }
    }

    /// Slashed bonds paid to depositors are not premium (they do not shrink the carry), and an aborted epoch
    /// leaves the carry alone.
    function test_AUDIT3_safe_compensationAndAbortLeaveCarryAlone() public {
        _depositPut(alice, DEPOSIT);
        vm.prank(agent);
        manager.openEpoch(address(putVault));
        // A near-the-money put (delta ~0.45) breaks the delta band: rejected, 25 USDG slashed to this vault.
        vm.prank(agent);
        (bool ok,) = manager.proposeSeries(address(putVault), 248 * WAD, FRIDAY_CLOSE, 100 * WAD, 10_000);
        assertFalse(ok);
        assertEq(manager.compensation(address(putVault)), SLASH);
        uint256 id;
        vm.prank(agent);
        (ok, id) = manager.proposeSeries(address(putVault), PUT_STRIKE, FRIDAY_CLOSE, 400 * WAD, 10_000);
        assertTrue(ok);
        uint256 premium = _buy(id, 100 * WAD);
        uint256 vaultBefore = usdg.balanceOf(address(putVault));
        manager.settle(address(putVault), _expireAt(215e8));
        uint256 payout = manager.getSeries(id).escrow;
        uint256 loss = payout - premium;
        assertEq(fees.lossCarried(address(putVault)), loss, "the slash does not count as premium");
        assertEq(usdg.balanceOf(address(putVault)), vaultBefore + premium + SLASH - payout);

        // Epoch 2 is opened, nothing is proposed, anyone aborts it after the timeout: the carry is unchanged.
        _nextMonday();
        vm.prank(agent);
        manager.openEpoch(address(putVault));
        vm.warp(block.timestamp + 1 days + 1);
        manager.abortEpoch(address(putVault));
        assertEq(fees.lossCarried(address(putVault)), loss);
    }
}
