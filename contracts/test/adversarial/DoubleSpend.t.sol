// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {EpochManager} from "../../src/core/EpochManager.sol";
import {MandateGuard} from "../../src/libraries/MandateGuard.sol";
import {UsdgDrip} from "../../src/testnet/UsdgDrip.sol";
import {StrikeVault} from "../../src/vaults/StrikeVault.sol";
import {AdversarialBase} from "./AdversarialBase.sol";
import {ERC4626Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC1155Errors, IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

/// @dev Calls the faucet twice in one transaction.
contract DoubleDripper {
    UsdgDrip internal immutable faucet;

    constructor(UsdgDrip faucet_) {
        faucet = faucet_;
    }

    function dripTwice() external {
        faucet.drip();
        faucet.drip();
    }
}

/// @notice DOUBLE-SPEND: the same claim (options, premium, shares, a slashed bond, a faucet drip, collateral) is
///         used twice. Each test asserts that the second use reverts or pays nothing and that the books balance.
///         Map: docs/security/adversarial.md#double-spend.
contract AdversarialDoubleSpendTest is AdversarialBase {
    /// The buyer of 60 in-the-money options redeems 40, gives 20 to Bob, then both try again. Burned options cannot
    /// be redeemed twice; the transferred ones pay once, to their holder; the total paid never exceeds the escrow.
    function test_ADV_DOUBLESPEND_redeemOptionsTwice() public {
        _depositCall(alice, 100 * WAD);
        uint256 id = _openAndPropose(callVault, 275 * WAD, 100 * WAD);
        _buy(id, 60 * WAD);
        manager.settle(address(callVault), _expireAt(300e8));
        uint256 escrow = manager.getSeries(id).escrow;
        assertGt(escrow, 0);

        vm.startPrank(buyer);
        options.safeTransferFrom(buyer, bob, id, 20 * WAD, "");
        uint256 a = manager.redeem(id, 40 * WAD, buyer);
        vm.expectRevert();
        manager.redeem(id, 40 * WAD, buyer);
        vm.expectRevert(abi.encodeWithSelector(IERC1155Errors.ERC1155InsufficientBalance.selector, buyer, 0, 1, id));
        manager.redeem(id, 1, buyer);
        vm.stopPrank();
        vm.startPrank(bob);
        uint256 b = manager.redeem(id, 20 * WAD, bob);
        vm.expectRevert(abi.encodeWithSelector(IERC1155Errors.ERC1155InsufficientBalance.selector, bob, 0, 1, id));
        manager.redeem(id, 1, bob);
        vm.stopPrank();

        assertLe(a + b, escrow);
        assertEq(manager.getSeries(id).escrow, escrow - a - b);
        assertEq(tsla.balanceOf(buyer), a);
        assertEq(tsla.balanceOf(bob), b);
        assertGe(tsla.balanceOf(address(manager)), manager.getSeries(id).escrow, "the escrow stays covered");
    }

    /// Alice claims her premium twice, moves her shares to a fresh address and back, and claims again; the agent
    /// claims its fee twice. Every second claim pays 0; the premium does not travel with the shares; the claims add up
    /// to no more than the vault received.
    function test_ADV_DOUBLESPEND_claimPremiumTwice() public {
        _depositCall(alice, 60 * WAD);
        _depositCall(bob, 40 * WAD);
        uint256 id = _openAndPropose(callVault, 275 * WAD, 100 * WAD);
        uint256 premium = _buy(id, 100 * WAD);
        manager.settle(address(callVault), _expireAt(260e8));
        uint256 fee = premium * 1000 / 10_000;
        uint256 toVault = premium - fee;

        vm.prank(alice);
        uint256 c1 = callVault.claimPremium();
        assertApproxEqAbs(c1, toVault * 60 / 100, 2);
        vm.prank(alice);
        assertEq(callVault.claimPremium(), 0, "second claim");

        address carol = makeAddr("carol");
        uint256 shares = callVault.balanceOf(alice);
        vm.prank(alice);
        callVault.transfer(carol, shares);
        assertEq(callVault.pendingPremium(carol), 0, "premium does not travel with the shares");
        vm.prank(carol);
        assertEq(callVault.claimPremium(), 0);
        vm.prank(carol);
        callVault.transfer(alice, shares);
        vm.prank(alice);
        assertEq(callVault.claimPremium(), 0, "nor come back with them");

        vm.prank(bob);
        uint256 c2 = callVault.claimPremium();
        assertLe(c1 + c2, toVault);
        assertEq(usdg.balanceOf(alice), c1);
        assertEq(usdg.balanceOf(carol), 0);

        vm.prank(agent);
        uint256 f = fees.claim();
        assertGt(f, 0);
        vm.prank(agent);
        assertEq(fees.claim(), 0, "the fee is claimed once");
    }

    /// Alice redeems more shares than she owns, then all of them twice, then withdraws again: ERC-4626 limits refuse
    /// each extra. Bob cannot redeem her shares without an allowance. While the vault is locked, shares queued for
    /// redemption are held by the vault, so they cannot be queued again or transferred, and the claim pays once.
    function test_ADV_DOUBLESPEND_redeemSharesTwice() public {
        _depositCall(alice, 10 * WAD);
        uint256 shares = callVault.balanceOf(alice);
        vm.startPrank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(ERC4626Upgradeable.ERC4626ExceededMaxRedeem.selector, alice, shares + 1, shares)
        );
        callVault.redeem(shares + 1, alice, alice);
        callVault.redeem(shares, alice, alice);
        vm.expectRevert(abi.encodeWithSelector(ERC4626Upgradeable.ERC4626ExceededMaxRedeem.selector, alice, shares, 0));
        callVault.redeem(shares, alice, alice);
        vm.expectRevert(abi.encodeWithSelector(ERC4626Upgradeable.ERC4626ExceededMaxWithdraw.selector, alice, 1, 0));
        callVault.withdraw(1, alice, alice);
        vm.stopPrank();
        assertEq(tsla.balanceOf(alice), 10 * WAD);

        _depositCall(alice, 10 * WAD);
        shares = callVault.balanceOf(alice);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, bob, 0, shares));
        callVault.redeem(shares, bob, alice);

        vm.prank(agent);
        manager.openEpoch(address(callVault));
        vm.startPrank(alice);
        callVault.requestRedeem(shares);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, alice, 0, 1));
        callVault.requestRedeem(1);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, alice, 0, shares));
        callVault.transfer(bob, shares);
        vm.stopPrank();
        vm.prank(curator);
        manager.abortEpoch(address(callVault));

        vm.prank(bob); // anyone may push the claim; it pays the owner
        assertEq(callVault.claimRedeem(alice), 10 * WAD);
        vm.expectRevert(StrikeVault.NoProcessedRequest.selector);
        callVault.claimRedeem(alice);
        assertEq(tsla.balanceOf(alice), 20 * WAD);
        assertEq(tsla.balanceOf(bob), 0);
        assertEq(callVault.reservedRedeemAssets(), 0);
        assertEq(callVault.totalSupply(), 0);
    }

    /// All of the epoch's premium is in and the first print after expiry is out of the money. Mallory queues a
    /// deposit nine times Alice's before anyone settles, claims her shares after settlement and redeems at once. The
    /// queue is processed after the premium is distributed and at the closing share price: she gets exactly her
    /// deposit back and none of the premium; Alice, who carried the risk, keeps all of it (net of the fee).
    function test_ADV_DOUBLESPEND_depositAroundSettlementCapturesNoPremium() public {
        _depositCall(alice, 100 * WAD);
        uint256 id = _openAndPropose(callVault, 275 * WAD, 100 * WAD);
        uint256 premium = _buy(id, 100 * WAD);
        uint80 round = _expireAt(260e8);

        address mallory = makeAddr("mallory");
        _requestDepositCall(mallory, 900 * WAD);
        manager.settle(address(callVault), round);
        uint256 shares = callVault.claimDeposit(mallory);
        vm.prank(mallory);
        uint256 back = callVault.redeem(shares, mallory, mallory);

        assertEq(back, 900 * WAD, "no assets gained");
        assertEq(callVault.pendingPremium(mallory), 0, "none of the epoch's premium");
        vm.prank(mallory);
        assertEq(callVault.claimPremium(), 0);
        assertApproxEqAbs(callVault.pendingPremium(alice), premium - premium * 1000 / 10_000, 1);
        assertEq(callVault.totalAssets(), 100 * WAD);
    }

    /// One rejected proposal slashes once. A depositor or the curator cannot slash the agent again for it (only the
    /// EpochManager holds SLASHER_ROLE), and the compensation reaches the vault once: zeroed when the epoch closes,
    /// not paid again at the next close.
    function test_ADV_DOUBLESPEND_slashSameRejectionTwice() public {
        _depositCall(alice, 100 * WAD);
        vm.prank(agent);
        manager.openEpoch(address(callVault));
        vm.prank(agent);
        (bool ok,) = manager.proposeSeries(address(callVault), 252 * WAD, FRIDAY_CLOSE, 50 * WAD, 10_000);
        assertFalse(ok);
        assertEq(manager.compensation(address(callVault)), SLASH);

        bytes32 slasher = registry.SLASHER_ROLE();
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, slasher)
        );
        registry.slash(agentId, alice);
        vm.prank(curator);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, curator, slasher)
        );
        registry.slash(agentId, address(callVault));

        vm.prank(curator);
        manager.abortEpoch(address(callVault));
        assertEq(manager.compensation(address(callVault)), 0);
        assertEq(usdg.balanceOf(address(callVault)), SLASH);
        uint256 owed = callVault.pendingPremium(alice);
        assertApproxEqAbs(owed, SLASH, 1);

        vm.prank(agent);
        manager.openEpoch(address(callVault));
        vm.prank(curator);
        manager.abortEpoch(address(callVault));
        assertEq(usdg.balanceOf(address(callVault)), SLASH, "paid once");
        assertEq(callVault.pendingPremium(alice), owed);
        assertEq(_bond(), 1000e6 - SLASH);
        assertEq(_strikes(), 1);
    }

    /// The testnet faucet: a second drip within 24 hours reverts, one second before the cooldown too, and two drips
    /// in one transaction (from a contract) revert together, so the first is undone as well. Different addresses each
    /// get their own drip by design (testnet USDG has no value).
    function test_ADV_DOUBLESPEND_faucetDripTwiceIn24h() public {
        UsdgDrip faucet = new UsdgDrip(usdg, admin);
        usdg.mint(address(faucet), 100e6);
        vm.prank(alice);
        faucet.drip();
        uint256 next = block.timestamp + 1 days;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(UsdgDrip.TooSoon.selector, next));
        faucet.drip();
        vm.warp(next - 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(UsdgDrip.TooSoon.selector, next));
        faucet.drip();

        DoubleDripper twice = new DoubleDripper(faucet);
        vm.expectRevert(abi.encodeWithSelector(UsdgDrip.TooSoon.selector, block.timestamp + 1 days));
        twice.dripTwice();
        assertEq(usdg.balanceOf(address(twice)), 0);
        assertEq(faucet.nextDripAt(address(twice)), 0);

        vm.warp(next);
        vm.prank(alice);
        faucet.drip();
        assertEq(usdg.balanceOf(alice), 20e6);
        assertEq(faucet.remaining(), 80e6);
    }

    /// The put vault's 23,500 USDG backs exactly 100 puts struck at 235. The agent cannot size a series past that,
    /// nor open a second series on the same collateral in the same epoch; queued deposits do not count as collateral
    /// until the epoch closes, and locked collateral cannot be withdrawn. Sold out, the locked collateral equals the
    /// vault's assets; at a crash to zero the payout is covered by it, and the queued deposit is not touched.
    function test_ADV_DOUBLESPEND_sameCollateralForTwoSeries() public {
        _depositPut(alice, 23_500 * USDG_UNIT);
        vm.prank(agent);
        manager.openEpoch(address(putVault));
        (MandateGuard.Reason r,,, uint256 capacity) =
            manager.previewProposal(address(putVault), 235 * WAD, FRIDAY_CLOSE, 100 * WAD + 1, 10_000);
        assertEq(capacity, 100 * WAD);
        assertEq(uint8(r), uint8(MandateGuard.Reason.SizeTooLarge));
        vm.prank(agent);
        (bool ok, uint256 id) = manager.proposeSeries(address(putVault), 235 * WAD, FRIDAY_CLOSE, 100 * WAD, 10_000);
        assertTrue(ok);
        vm.prank(agent);
        vm.expectRevert(_wrongState(EpochManager.EpochState.Open, EpochManager.EpochState.Selling));
        manager.proposeSeries(address(putVault), 230 * WAD, FRIDAY_CLOSE, 100 * WAD, 10_000);

        _requestDepositPut(bob, 1_000_000 * USDG_UNIT);
        assertEq(putVault.totalAssets(), 23_500 * USDG_UNIT, "a queued deposit is not collateral");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ERC4626Upgradeable.ERC4626ExceededMaxWithdraw.selector, alice, 1, 0));
        putVault.withdraw(1, alice, alice);

        _buy(id, 60 * WAD);
        _buyAs(makeAddr("carol"), id, 40 * WAD);
        EpochManager.Series memory s = manager.getSeries(id);
        assertEq(s.collateral, 23_500 * USDG_UNIT);
        assertEq(s.collateral, putVault.totalAssets());
        vm.expectRevert(abi.encodeWithSelector(EpochManager.ExceedsSize.selector, 1, 0));
        manager.buy(id, 1, type(uint256).max, buyer);

        manager.settle(address(putVault), _expireAt(1));
        s = manager.getSeries(id);
        assertLe(s.escrow, s.collateral, "the payout fits the collateral committed once");
        assertEq(putVault.totalAssets(), 23_500 * USDG_UNIT - s.escrow + 1_000_000 * USDG_UNIT);
        uint256 bobShares = putVault.claimDeposit(bob);
        vm.prank(bob);
        uint256 back = putVault.redeem(bobShares, bob, bob);
        assertApproxEqAbs(back, 1_000_000 * USDG_UNIT, 10, "the queued deposit paid nothing toward the series");
    }
}
