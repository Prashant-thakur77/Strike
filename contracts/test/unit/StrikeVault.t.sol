// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IStrikeVault} from "../../src/interfaces/IStrikeVault.sol";
import {StrikeVault} from "../../src/vaults/StrikeVault.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {ERC4626Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Test} from "forge-std/Test.sol";

/// @notice Unit tests for StrikeVault. The vault is a fresh clone whose manager is a plain address, so the tests
///         drive lock() / settleEpoch() directly instead of going through the EpochManager.
contract StrikeVaultTest is Test {
    uint256 internal constant CAP = 1_000_000e18;
    uint256 internal constant ACC = 1e36;

    address internal mgr = makeAddr("manager");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    MockERC20 internal stock; // 18-decimal collateral of the call vault
    MockERC20 internal usdg; // 6-decimal premium token
    StrikeVault internal impl;
    StrikeVault internal vault;

    function setUp() public {
        stock = new MockERC20("Tesla", "TSLA", 18);
        usdg = new MockERC20("Global Dollar", "USDG", 6);
        impl = new StrikeVault();
        vault = _newVault(address(stock), true, CAP);
    }

    // ------------------------------------------------------------------ helpers

    function _initParams(address asset_, bool isCall, uint256 cap)
        internal
        view
        returns (IStrikeVault.InitParams memory)
    {
        return IStrikeVault.InitParams({
            asset: asset_,
            premiumToken: address(usdg),
            underlying: address(stock),
            isCall: isCall,
            manager: mgr,
            depositCap: cap,
            name: "Strike Test Vault",
            symbol: "sTEST"
        });
    }

    function _newVault(address asset_, bool isCall, uint256 cap) internal returns (StrikeVault v) {
        v = StrikeVault(Clones.clone(address(impl)));
        v.initialize(_initParams(asset_, isCall, cap));
    }

    function _mintApprove(address who, uint256 amount) internal {
        stock.mint(who, amount);
        vm.prank(who);
        stock.approve(address(vault), amount);
    }

    function _deposit(address who, uint256 amount) internal returns (uint256 shares) {
        _mintApprove(who, amount);
        vm.prank(who);
        shares = vault.deposit(amount, who);
    }

    function _lock() internal {
        vm.prank(mgr);
        vault.lock();
    }

    /// Settle like the EpochManager: the premium USDG is transferred in first.
    function _settle(uint256 payout, uint256 premium) internal {
        usdg.mint(address(vault), premium);
        vm.prank(mgr);
        vault.settleEpoch(payout, premium);
    }

    function _requestDeposit(address who, uint256 amount) internal {
        _mintApprove(who, amount);
        vm.prank(who);
        vault.requestDeposit(amount, who);
    }

    function _requestRedeem(address who, uint256 shares) internal {
        vm.prank(who);
        vault.requestRedeem(shares);
    }

    function _depositRequest(address who) internal view returns (uint64 epoch, uint256 amount) {
        (epoch, amount) = vault.depositRequests(who);
    }

    function _redeemRequest(address who) internal view returns (uint64 epoch, uint256 amount) {
        (epoch, amount) = vault.redeemRequests(who);
    }

    /// The vault's collateral balance covers managed assets, queued deposits and reserved redemptions.
    function _assertSolvent() internal view {
        assertGe(
            stock.balanceOf(address(vault)),
            vault.totalAssets() + vault.pendingDepositAssets() + vault.reservedRedeemAssets(),
            "collateral shortfall"
        );
    }

    // ================================================================== initialize

    function test_initialize_setsConfiguration() public view {
        assertEq(vault.manager(), mgr);
        assertEq(vault.asset(), address(stock));
        assertEq(vault.underlying(), address(stock));
        assertEq(vault.premiumToken(), address(usdg));
        assertTrue(vault.isCall());
        assertEq(vault.depositCap(), CAP);
        assertEq(vault.name(), "Strike Test Vault");
        assertEq(vault.symbol(), "sTEST");
        assertEq(vault.decimals(), 18);
        assertFalse(vault.locked());
        assertEq(vault.currentEpoch(), 0);
        assertEq(vault.lastProcessedEpoch(), 0);
        assertEq(vault.totalAssets(), 0);
        assertEq(vault.totalSupply(), 0);
        assertEq(vault.accPremiumPerShare(), 0);
        assertEq(vault.unallocatedPremium(), 0);
    }

    function test_initialize_putVaultUsesUsdgCollateral() public {
        StrikeVault put = _newVault(address(usdg), false, 5_000_000e6);
        assertEq(put.asset(), address(usdg));
        assertEq(put.underlying(), address(stock));
        assertFalse(put.isCall());
        assertEq(put.decimals(), 6);
    }

    function test_initialize_revertsOnImplementation() public {
        IStrikeVault.InitParams memory p = _initParams(address(stock), true, CAP);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(p);
    }

    function test_initialize_revertsWhenCalledTwice() public {
        IStrikeVault.InitParams memory p = _initParams(address(stock), true, CAP);
        p.manager = alice;
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        vault.initialize(p);
        assertEq(vault.manager(), mgr);
    }

    function test_initialize_revertsOnZeroAsset() public {
        StrikeVault v = StrikeVault(Clones.clone(address(impl)));
        IStrikeVault.InitParams memory p = _initParams(address(stock), true, CAP);
        p.asset = address(0);
        vm.expectRevert(StrikeVault.ZeroAddress.selector);
        v.initialize(p);
    }

    function test_initialize_revertsOnZeroPremiumToken() public {
        StrikeVault v = StrikeVault(Clones.clone(address(impl)));
        IStrikeVault.InitParams memory p = _initParams(address(stock), true, CAP);
        p.premiumToken = address(0);
        vm.expectRevert(StrikeVault.ZeroAddress.selector);
        v.initialize(p);
    }

    function test_initialize_revertsOnZeroUnderlying() public {
        StrikeVault v = StrikeVault(Clones.clone(address(impl)));
        IStrikeVault.InitParams memory p = _initParams(address(stock), true, CAP);
        p.underlying = address(0);
        vm.expectRevert(StrikeVault.ZeroAddress.selector);
        v.initialize(p);
    }

    function test_initialize_revertsOnZeroManager() public {
        StrikeVault v = StrikeVault(Clones.clone(address(impl)));
        IStrikeVault.InitParams memory p = _initParams(address(stock), true, CAP);
        p.manager = address(0);
        vm.expectRevert(StrikeVault.ZeroAddress.selector);
        v.initialize(p);
    }

    // ================================================================== totalAssets & max*

    function test_totalAssets_tracksDepositsAndWithdrawals() public {
        _deposit(alice, 100e18);
        assertEq(vault.totalAssets(), 100e18);
        vm.prank(alice);
        vault.withdraw(30e18, alice, alice);
        assertEq(vault.totalAssets(), 70e18);
    }

    function test_totalAssets_excludesQueuedDepositsAndReservedRedemptions() public {
        _deposit(alice, 100e18);
        _lock();
        _requestDeposit(bob, 50e18);
        _requestRedeem(alice, 40e18);
        // Queued deposits are not collateral; escrowed shares still are.
        assertEq(vault.totalAssets(), 100e18);
        assertEq(stock.balanceOf(address(vault)), 150e18);

        _settle(0, 10e6);
        // 40 reserved for alice, 50 added for bob.
        assertEq(vault.reservedRedeemAssets(), 40e18);
        assertEq(vault.totalAssets(), 110e18);
        assertEq(stock.balanceOf(address(vault)), 150e18);
    }

    function test_totalAssets_putVaultIgnoresPremiumInSameToken() public {
        StrikeVault put = _newVault(address(usdg), false, 5_000_000e6);
        usdg.mint(alice, 1000e6);
        vm.startPrank(alice);
        usdg.approve(address(put), 1000e6);
        put.deposit(1000e6, alice);
        vm.stopPrank();
        uint256 priceBefore = put.convertToAssets(1e6);

        vm.prank(mgr);
        put.lock();
        usdg.mint(address(put), 50e6);
        vm.prank(mgr);
        put.settleEpoch(0, 50e6);

        assertEq(usdg.balanceOf(address(put)), 1050e6);
        assertEq(put.totalAssets(), 1000e6);
        assertEq(put.convertToAssets(1e6), priceBefore);
        assertEq(put.pendingPremium(alice), 50e6);
        vm.prank(alice);
        put.claimPremium();
        vm.prank(alice);
        put.redeem(1000e6, alice, alice);
        assertEq(usdg.balanceOf(alice), 1050e6);
        assertEq(usdg.balanceOf(address(put)), 0);
    }

    function test_maxDeposit_isRemainingCapWhenUnlocked() public {
        assertEq(vault.maxDeposit(alice), CAP);
        _deposit(alice, 400_000e18);
        assertEq(vault.maxDeposit(bob), 600_000e18);
    }

    function test_maxDeposit_zeroAtCap() public {
        _deposit(alice, CAP);
        assertEq(vault.maxDeposit(alice), 0);
        assertEq(vault.maxMint(alice), 0);
    }

    function test_maxDeposit_zeroWhileLocked() public {
        _lock();
        assertEq(vault.maxDeposit(alice), 0);
    }

    function test_maxMint_isConvertedMaxDeposit() public {
        assertEq(vault.maxMint(alice), CAP);
        _deposit(alice, 100e18);
        _lock();
        _settle(50e18, 0); // loss: each share is now worth half an asset
        uint256 md = vault.maxDeposit(alice);
        assertEq(md, CAP - 50e18);
        uint256 mm = vault.maxMint(alice);
        assertEq(mm, Math.mulDiv(md, 100e18 + 1, 50e18 + 1));
        assertEq(mm, vault.convertToShares(md));

        // Minting the max stays inside the cap; one more share does not.
        _mintApprove(bob, md);
        vm.expectRevert(abi.encodeWithSelector(ERC4626Upgradeable.ERC4626ExceededMaxMint.selector, bob, mm + 1, mm));
        vm.prank(bob);
        vault.mint(mm + 1, bob);
        vm.prank(bob);
        uint256 paid = vault.mint(mm, bob);
        assertLe(paid, md);
        assertLe(vault.totalAssets(), CAP);
    }

    function test_maxMint_zeroWhileLocked() public {
        _deposit(alice, 1e18);
        _lock();
        assertEq(vault.maxMint(alice), 0);
    }

    function test_maxWithdrawAndMaxRedeem_unlocked() public {
        _deposit(alice, 100e18);
        assertEq(vault.maxRedeem(alice), 100e18);
        assertEq(vault.maxWithdraw(alice), 100e18);
        assertEq(vault.maxRedeem(bob), 0);
        assertEq(vault.maxWithdraw(bob), 0);
    }

    function test_maxWithdrawAndMaxRedeem_zeroWhileLocked() public {
        _deposit(alice, 100e18);
        _lock();
        assertEq(vault.maxRedeem(alice), 0);
        assertEq(vault.maxWithdraw(alice), 0);
        _settle(0, 0);
        assertEq(vault.maxRedeem(alice), 100e18);
        assertEq(vault.maxWithdraw(alice), 100e18);
    }

    // ================================================================== deposit / mint / withdraw / redeem

    function test_deposit_mintsSharesOneToOneOnEmptyVault() public {
        _mintApprove(alice, 100e18);
        vm.expectEmit(address(vault));
        emit IERC4626.Deposit(alice, bob, 100e18, 100e18);
        vm.prank(alice);
        uint256 shares = vault.deposit(100e18, bob);
        assertEq(shares, 100e18);
        assertEq(vault.balanceOf(bob), 100e18);
        assertEq(vault.balanceOf(alice), 0);
        assertEq(stock.balanceOf(address(vault)), 100e18);
    }

    function test_deposit_afterLossMintsMoreShares() public {
        _deposit(alice, 100e18);
        _lock();
        _settle(50e18, 0);
        uint256 shares = _deposit(bob, 50e18);
        assertEq(shares, Math.mulDiv(50e18, 100e18 + 1, 50e18 + 1));
        assertApproxEqAbs(shares, 100e18, 2);
    }

    function test_deposit_revertsWhileLocked() public {
        _mintApprove(alice, 1e18);
        _lock();
        vm.expectRevert(abi.encodeWithSelector(ERC4626Upgradeable.ERC4626ExceededMaxDeposit.selector, alice, 1e18, 0));
        vm.prank(alice);
        vault.deposit(1e18, alice);
    }

    function test_deposit_revertsAboveCap() public {
        _deposit(alice, CAP - 10e18);
        _mintApprove(bob, 11e18);
        vm.expectRevert(
            abi.encodeWithSelector(ERC4626Upgradeable.ERC4626ExceededMaxDeposit.selector, bob, 11e18, 10e18)
        );
        vm.prank(bob);
        vault.deposit(11e18, bob);
    }

    function test_mint_pullsPreviewedAssets() public {
        _deposit(alice, 100e18);
        _lock();
        _settle(20e18, 0);
        uint256 expected = vault.previewMint(10e18);
        _mintApprove(bob, expected);
        vm.expectEmit(address(vault));
        emit IERC4626.Deposit(bob, bob, expected, 10e18);
        vm.prank(bob);
        uint256 assets = vault.mint(10e18, bob);
        assertEq(assets, expected);
        assertEq(vault.balanceOf(bob), 10e18);
        assertEq(vault.totalAssets(), 80e18 + expected);
    }

    function test_mint_revertsWhileLocked() public {
        _mintApprove(alice, 1e18);
        _lock();
        vm.expectRevert(abi.encodeWithSelector(ERC4626Upgradeable.ERC4626ExceededMaxMint.selector, alice, 1e18, 0));
        vm.prank(alice);
        vault.mint(1e18, alice);
    }

    function test_withdraw_burnsSharesAndPaysReceiver() public {
        _deposit(alice, 100e18);
        vm.expectEmit(address(vault));
        emit IERC4626.Withdraw(alice, bob, alice, 40e18, 40e18);
        vm.prank(alice);
        uint256 shares = vault.withdraw(40e18, bob, alice);
        assertEq(shares, 40e18);
        assertEq(stock.balanceOf(bob), 40e18);
        assertEq(vault.balanceOf(alice), 60e18);
        assertEq(vault.totalAssets(), 60e18);
    }

    function test_withdraw_spendsAllowanceForOtherCaller() public {
        _deposit(alice, 100e18);
        vm.prank(alice);
        vault.approve(bob, 25e18);
        vm.prank(bob);
        vault.withdraw(25e18, bob, alice);
        assertEq(vault.allowance(alice, bob), 0);
        assertEq(stock.balanceOf(bob), 25e18);

        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, bob, 0, 1e18));
        vm.prank(bob);
        vault.withdraw(1e18, bob, alice);
    }

    function test_withdraw_revertsWhileLocked() public {
        _deposit(alice, 100e18);
        _lock();
        vm.expectRevert(abi.encodeWithSelector(ERC4626Upgradeable.ERC4626ExceededMaxWithdraw.selector, alice, 1e18, 0));
        vm.prank(alice);
        vault.withdraw(1e18, alice, alice);
    }

    function test_redeem_paysProRataAssets() public {
        _deposit(alice, 100e18);
        _lock();
        _settle(40e18, 0);
        uint256 expected = Math.mulDiv(50e18, 60e18 + 1, 100e18 + 1);
        vm.expectEmit(address(vault));
        emit IERC4626.Withdraw(alice, alice, alice, expected, 50e18);
        vm.prank(alice);
        uint256 assets = vault.redeem(50e18, alice, alice);
        assertEq(assets, expected);
        assertEq(stock.balanceOf(alice), expected);
        assertEq(vault.totalAssets(), 60e18 - expected);
    }

    function test_redeem_revertsWhileLocked() public {
        _deposit(alice, 100e18);
        _lock();
        vm.expectRevert(abi.encodeWithSelector(ERC4626Upgradeable.ERC4626ExceededMaxRedeem.selector, alice, 1e18, 0));
        vm.prank(alice);
        vault.redeem(1e18, alice, alice);
    }

    function test_donation_doesNotChangeSharePrice() public {
        _deposit(alice, 100e18);
        uint256 priceBefore = vault.convertToAssets(1e18);
        uint256 sharesQuoteBefore = vault.previewDeposit(10e18);

        stock.mint(carol, 50e18);
        vm.prank(carol);
        stock.transfer(address(vault), 50e18);

        assertEq(stock.balanceOf(address(vault)), 150e18);
        assertEq(vault.totalAssets(), 100e18);
        assertEq(vault.convertToAssets(1e18), priceBefore);
        assertEq(vault.previewDeposit(10e18), sharesQuoteBefore);
        assertEq(_deposit(bob, 10e18), sharesQuoteBefore);

        // Alice gets exactly her deposit back, not the donation.
        vm.prank(alice);
        assertEq(vault.redeem(100e18, alice, alice), 100e18);
        assertEq(stock.balanceOf(alice), 100e18);
        // The donation also leaves the deposit cap untouched.
        assertEq(vault.maxDeposit(alice), CAP - 10e18);
    }

    // ================================================================== requestDeposit / cancel / claim

    function test_requestDeposit_queuesAssets() public {
        _deposit(alice, 100e18);
        _lock();
        _mintApprove(bob, 50e18);
        vm.expectEmit(address(vault));
        emit StrikeVault.DepositRequested(bob, 1, 50e18);
        vm.prank(bob);
        vault.requestDeposit(50e18, bob);

        (uint64 epoch, uint256 amount) = _depositRequest(bob);
        assertEq(epoch, 1);
        assertEq(amount, 50e18);
        assertEq(vault.pendingDepositAssets(), 50e18);
        assertEq(stock.balanceOf(address(vault)), 150e18);
        assertEq(stock.balanceOf(bob), 0);
        assertEq(vault.balanceOf(bob), 0);
        assertEq(vault.totalAssets(), 100e18);
    }

    function test_requestDeposit_payerCanDifferFromReceiver() public {
        _lock();
        _mintApprove(bob, 5e18);
        vm.expectEmit(address(vault));
        emit StrikeVault.DepositRequested(alice, 1, 5e18);
        vm.prank(bob);
        vault.requestDeposit(5e18, alice);
        (, uint256 amount) = _depositRequest(alice);
        assertEq(amount, 5e18);
        (, uint256 bobAmount) = _depositRequest(bob);
        assertEq(bobAmount, 0);
        assertEq(stock.balanceOf(bob), 0);
    }

    function test_requestDeposit_accumulatesWithinEpoch() public {
        _lock();
        _requestDeposit(alice, 5e18);
        _requestDeposit(alice, 7e18);
        (uint64 epoch, uint256 amount) = _depositRequest(alice);
        assertEq(epoch, 1);
        assertEq(amount, 12e18);
        assertEq(vault.pendingDepositAssets(), 12e18);
    }

    function test_requestDeposit_revertsWhenUnlocked() public {
        _mintApprove(alice, 1e18);
        vm.expectRevert(StrikeVault.VaultNotLocked.selector);
        vm.prank(alice);
        vault.requestDeposit(1e18, alice);
    }

    function test_requestDeposit_revertsOnZeroAmount() public {
        _lock();
        vm.expectRevert(StrikeVault.ZeroAmount.selector);
        vm.prank(alice);
        vault.requestDeposit(0, alice);
    }

    function test_requestDeposit_revertsOnZeroReceiver() public {
        _lock();
        _mintApprove(alice, 1e18);
        vm.expectRevert(StrikeVault.ZeroAddress.selector);
        vm.prank(alice);
        vault.requestDeposit(1e18, address(0));
    }

    function test_requestDeposit_revertsAboveCapCountingQueue() public {
        _deposit(alice, 900_000e18);
        _lock();
        _requestDeposit(bob, 60_000e18);
        _mintApprove(carol, 50_000e18);
        vm.expectRevert(abi.encodeWithSelector(StrikeVault.DepositCapExceeded.selector, 50_000e18, 40_000e18));
        vm.prank(carol);
        vault.requestDeposit(50_000e18, carol);
        // Exactly the remaining room is fine.
        vm.prank(carol);
        vault.requestDeposit(40_000e18, carol);
        assertEq(vault.totalAssets() + vault.pendingDepositAssets(), CAP);
    }

    function test_requestDeposit_revertsWhenCapFull() public {
        _deposit(alice, CAP);
        _lock();
        _mintApprove(bob, 1);
        vm.expectRevert(abi.encodeWithSelector(StrikeVault.DepositCapExceeded.selector, 1, 0));
        vm.prank(bob);
        vault.requestDeposit(1, bob);
    }

    function test_cancelDepositRequest_refunds() public {
        _lock();
        _requestDeposit(alice, 30e18);
        vm.expectEmit(address(vault));
        emit StrikeVault.DepositRequestCancelled(alice, 1, 30e18);
        vm.prank(alice);
        vault.cancelDepositRequest();

        assertEq(stock.balanceOf(alice), 30e18);
        assertEq(vault.pendingDepositAssets(), 0);
        (uint64 epoch, uint256 amount) = _depositRequest(alice);
        assertEq(epoch, 0);
        assertEq(amount, 0);
    }

    function test_cancelDepositRequest_refundsReceiverNotPayer() public {
        _lock();
        _mintApprove(bob, 3e18);
        vm.prank(bob);
        vault.requestDeposit(3e18, alice);
        // The request belongs to the receiver: the payer cannot cancel it.
        vm.expectRevert(StrikeVault.NoPendingRequest.selector);
        vm.prank(bob);
        vault.cancelDepositRequest();
        vm.prank(alice);
        vault.cancelDepositRequest();
        assertEq(stock.balanceOf(alice), 3e18);
    }

    function test_cancelDepositRequest_freesCap() public {
        _deposit(alice, CAP - 10e18);
        _lock();
        _requestDeposit(bob, 10e18);
        vm.prank(bob);
        vault.cancelDepositRequest();
        _requestDeposit(carol, 10e18);
        assertEq(vault.pendingDepositAssets(), 10e18);
    }

    function test_cancelDepositRequest_revertsWithoutRequest() public {
        _lock();
        vm.expectRevert(StrikeVault.NoPendingRequest.selector);
        vm.prank(alice);
        vault.cancelDepositRequest();
    }

    function test_cancelDepositRequest_revertsAfterProcessing() public {
        _lock();
        _requestDeposit(alice, 30e18);
        _settle(0, 0);
        vm.expectRevert(StrikeVault.NoPendingRequest.selector);
        vm.prank(alice);
        vault.cancelDepositRequest();
        // Still processed (not pending) once the next epoch starts.
        _lock();
        vm.expectRevert(StrikeVault.NoPendingRequest.selector);
        vm.prank(alice);
        vault.cancelDepositRequest();
    }

    function test_claimDeposit_transfersSharesAtSettlementPrice() public {
        _deposit(alice, 100e18);
        _lock();
        _requestDeposit(bob, 50e18);
        _settle(20e18, 0); // closing: 80 assets, 100 shares

        uint256 expected = Math.mulDiv(50e18, 100e18 + 1, 80e18 + 1);
        assertEq(vault.claimableDepositShares(bob), expected);
        assertEq(vault.balanceOf(address(vault)), expected);

        vm.expectEmit(address(vault));
        emit StrikeVault.DepositClaimed(bob, 1, 50e18, expected);
        vm.prank(carol); // anyone may call
        uint256 shares = vault.claimDeposit(bob);

        assertEq(shares, expected);
        assertEq(vault.balanceOf(bob), expected);
        assertEq(vault.balanceOf(carol), 0);
        assertEq(vault.balanceOf(address(vault)), 0);
        assertEq(vault.claimableDepositShares(bob), 0);
        (, uint256 amount) = _depositRequest(bob);
        assertEq(amount, 0);
    }

    function test_claimDeposit_worksDuringNextEpoch() public {
        _lock();
        _requestDeposit(alice, 10e18);
        _settle(0, 0);
        _lock();
        assertEq(vault.claimDeposit(alice), 10e18);
        assertEq(vault.balanceOf(alice), 10e18);
    }

    function test_claimDeposit_revertsWithoutRequest() public {
        vm.expectRevert(StrikeVault.NoProcessedRequest.selector);
        vault.claimDeposit(alice);
    }

    function test_claimDeposit_revertsWhilePending() public {
        _lock();
        _requestDeposit(alice, 10e18);
        vm.expectRevert(StrikeVault.NoProcessedRequest.selector);
        vault.claimDeposit(alice);
    }

    function test_claimDeposit_revertsOnSecondClaim() public {
        _lock();
        _requestDeposit(alice, 10e18);
        _settle(0, 0);
        vault.claimDeposit(alice);
        vm.expectRevert(StrikeVault.NoProcessedRequest.selector);
        vault.claimDeposit(alice);
    }

    function test_requestDeposit_autoClaimsProcessedRequest() public {
        _lock();
        _requestDeposit(alice, 100e18);
        _settle(0, 0);
        _lock();

        _mintApprove(alice, 10e18);
        vm.expectEmit(address(vault));
        emit StrikeVault.DepositClaimed(alice, 1, 100e18, 100e18);
        vm.expectEmit(address(vault));
        emit StrikeVault.DepositRequested(alice, 2, 10e18);
        vm.prank(alice);
        vault.requestDeposit(10e18, alice);

        assertEq(vault.balanceOf(alice), 100e18);
        (uint64 epoch, uint256 amount) = _depositRequest(alice);
        assertEq(epoch, 2);
        assertEq(amount, 10e18);
        assertEq(vault.pendingDepositAssets(), 10e18);
    }

    function test_requestDeposit_byThirdPartyAutoClaimsReceiver() public {
        _lock();
        _requestDeposit(alice, 100e18);
        _settle(0, 0);
        _lock();
        _mintApprove(bob, 1e18);
        vm.prank(bob);
        vault.requestDeposit(1e18, alice);
        assertEq(vault.balanceOf(alice), 100e18);
        (uint64 epoch, uint256 amount) = _depositRequest(alice);
        assertEq(epoch, 2);
        assertEq(amount, 1e18);
    }

    // ================================================================== requestRedeem / claim

    function test_requestRedeem_escrowsShares() public {
        _deposit(alice, 100e18);
        _lock();
        vm.expectEmit(address(vault));
        emit StrikeVault.RedeemRequested(alice, 1, 40e18);
        _requestRedeem(alice, 40e18);

        assertEq(vault.balanceOf(alice), 60e18);
        assertEq(vault.balanceOf(address(vault)), 40e18);
        assertEq(vault.pendingRedeemShares(), 40e18);
        assertEq(vault.totalSupply(), 100e18);
        (uint64 epoch, uint256 amount) = _redeemRequest(alice);
        assertEq(epoch, 1);
        assertEq(amount, 40e18);
    }

    function test_requestRedeem_accumulatesWithinEpoch() public {
        _deposit(alice, 100e18);
        _lock();
        _requestRedeem(alice, 40e18);
        _requestRedeem(alice, 10e18);
        (, uint256 amount) = _redeemRequest(alice);
        assertEq(amount, 50e18);
        assertEq(vault.pendingRedeemShares(), 50e18);
    }

    function test_requestRedeem_revertsWhenUnlocked() public {
        _deposit(alice, 100e18);
        vm.expectRevert(StrikeVault.VaultNotLocked.selector);
        vm.prank(alice);
        vault.requestRedeem(1e18);
    }

    function test_requestRedeem_revertsOnZeroAmount() public {
        _deposit(alice, 100e18);
        _lock();
        vm.expectRevert(StrikeVault.ZeroAmount.selector);
        vm.prank(alice);
        vault.requestRedeem(0);
    }

    function test_requestRedeem_revertsAboveBalance() public {
        _deposit(alice, 100e18);
        _lock();
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, alice, 100e18, 101e18));
        vm.prank(alice);
        vault.requestRedeem(101e18);
    }

    function test_claimRedeem_paysAssetsAtSettlementPrice() public {
        _deposit(alice, 100e18);
        _deposit(bob, 100e18);
        _lock();
        _requestRedeem(alice, 50e18);
        _settle(40e18, 0); // closing: 160 assets, 200 shares

        uint256 expected = Math.mulDiv(50e18, 160e18 + 1, 200e18 + 1);
        assertEq(vault.claimableRedeemAssets(alice), expected);
        assertEq(vault.reservedRedeemAssets(), expected);

        vm.expectEmit(address(vault));
        emit StrikeVault.RedeemClaimed(alice, 1, 50e18, expected);
        vm.prank(carol); // anyone may call
        uint256 assets = vault.claimRedeem(alice);

        assertEq(assets, expected);
        assertEq(stock.balanceOf(alice), expected);
        assertEq(stock.balanceOf(carol), 0);
        assertEq(vault.reservedRedeemAssets(), 0);
        assertEq(vault.claimableRedeemAssets(alice), 0);
        (, uint256 amount) = _redeemRequest(alice);
        assertEq(amount, 0);
        _assertSolvent();
    }

    function test_claimRedeem_revertsWithoutRequest() public {
        vm.expectRevert(StrikeVault.NoProcessedRequest.selector);
        vault.claimRedeem(alice);
    }

    function test_claimRedeem_revertsOnSecondClaim() public {
        _deposit(alice, 100e18);
        _lock();
        _requestRedeem(alice, 10e18);
        _settle(0, 0);
        vault.claimRedeem(alice);
        vm.expectRevert(StrikeVault.NoProcessedRequest.selector);
        vault.claimRedeem(alice);
    }

    function test_requestRedeem_autoClaimsProcessedRequest() public {
        _deposit(alice, 100e18);
        _lock();
        _requestRedeem(alice, 30e18);
        _settle(0, 0);
        _lock();

        vm.expectEmit(address(vault));
        emit StrikeVault.RedeemClaimed(alice, 1, 30e18, 30e18);
        vm.expectEmit(address(vault));
        emit StrikeVault.RedeemRequested(alice, 2, 20e18);
        _requestRedeem(alice, 20e18);

        assertEq(stock.balanceOf(alice), 30e18);
        assertEq(vault.reservedRedeemAssets(), 0);
        (uint64 epoch, uint256 amount) = _redeemRequest(alice);
        assertEq(epoch, 2);
        assertEq(amount, 20e18);
    }

    function test_requestRedeem_autoClaimsZeroAssetRedemptionAndItsPremium() public {
        _deposit(alice, 100e18);
        _lock();
        _requestRedeem(alice, 100e18);
        _settle(100e18, 50e6); // the epoch paid out every asset but earned premium
        assertEq(vault.claimableRedeemAssets(alice), 0);
        assertEq(vault.totalSupply(), 0);

        // A new deposit and a new request clear the old (worthless) request and credit its premium.
        _deposit(alice, 1e18);
        _lock();
        vm.expectEmit(address(vault));
        emit StrikeVault.RedeemClaimed(alice, 1, 100e18, 0);
        _requestRedeem(alice, 1e18);
        assertEq(vault.pendingPremium(alice), 50e6);
    }

    /// Bug: claimRedeem is documented to pay out a *processed* redemption and reverts NoProcessedRequest when there
    ///      is none, like claimDeposit. For a queued request that has not been processed yet it silently returns 0,
    ///      because the post-check `assets == 0 && redeemRequests[account].amount == 0` passes while the request is
    ///      still stored.
    function test_regression_claimRedeemRevertsForUnprocessedRequest() public {
        _deposit(alice, 100e18);
        _lock();
        _requestRedeem(alice, 40e18);
        vm.expectRevert(StrikeVault.NoProcessedRequest.selector);
        vault.claimRedeem(alice);
    }

    /// Bug: a processed redemption worth 0 assets (e.g. the epoch paid out every asset) cannot be claimed.
    ///      _claimRedeemIfProcessed deletes the request and credits the epoch's premium, then the post-check
    ///      `assets == 0 && redeemRequests[account].amount == 0` is true and reverts NoProcessedRequest, rolling
    ///      everything back. The redeemer's premium for that epoch stays locked until they acquire new shares and
    ///      call requestRedeem in a later epoch.
    function test_regression_claimRedeemWorksForProcessedZeroAssetRequest() public {
        _deposit(alice, 100e18);
        _lock();
        _requestRedeem(alice, 100e18);
        _settle(100e18, 50e6);
        assertEq(vault.claimableRedeemAssets(alice), 0);

        assertEq(vault.claimRedeem(alice), 0);
        (, uint256 amount) = _redeemRequest(alice);
        assertEq(amount, 0);
        assertEq(vault.pendingPremium(alice), 50e6);
    }

    // ================================================================== premium

    function test_pendingPremium_zeroWhenNothingDistributed() public {
        assertEq(vault.pendingPremium(alice), 0);
        _deposit(alice, 100e18);
        _lock();
        _settle(0, 0);
        assertEq(vault.pendingPremium(alice), 0);
    }

    function test_claimPremium_returnsZeroWhenNothingOwed() public {
        _deposit(alice, 100e18);
        usdg.mint(address(vault), 1e6); // stray balance is not premium
        vm.recordLogs();
        vm.prank(alice);
        assertEq(vault.claimPremium(), 0);
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(usdg.balanceOf(alice), 0);
    }

    function test_premium_splitsProRataBetweenHolders() public {
        _deposit(alice, 300e18);
        _deposit(bob, 100e18);
        _lock();
        _settle(0, 400e6);
        assertEq(vault.accPremiumPerShare(), Math.mulDiv(400e6, ACC, 400e18));
        assertEq(vault.pendingPremium(alice), 300e6);
        assertEq(vault.pendingPremium(bob), 100e6);

        vm.expectEmit(address(vault));
        emit StrikeVault.PremiumClaimed(alice, 300e6);
        vm.prank(alice);
        assertEq(vault.claimPremium(), 300e6);
        assertEq(usdg.balanceOf(alice), 300e6);
        assertEq(vault.pendingPremium(alice), 0);

        vm.prank(alice);
        assertEq(vault.claimPremium(), 0);

        vm.prank(bob);
        assertEq(vault.claimPremium(), 100e6);
        assertEq(usdg.balanceOf(address(vault)), 0);
    }

    function test_premium_accumulatesAcrossEpochs() public {
        _deposit(alice, 100e18);
        _lock();
        _settle(0, 10e6);
        _lock();
        _settle(0, 15e6);
        assertEq(vault.pendingPremium(alice), 25e6);
    }

    function test_premium_shareTransferMovesFuturePremiumNotPast() public {
        _deposit(alice, 100e18);
        _deposit(bob, 100e18);
        _lock();
        _settle(0, 200e6); // 100 each

        vm.prank(alice);
        vault.transfer(carol, 50e18);
        assertEq(vault.pendingPremium(alice), 100e6);
        assertEq(vault.pendingPremium(carol), 0);

        _lock();
        _settle(0, 200e6); // 1 USDG per share
        assertEq(vault.pendingPremium(alice), 150e6);
        assertEq(vault.pendingPremium(bob), 200e6);
        assertEq(vault.pendingPremium(carol), 50e6);
    }

    function test_premium_transferFromMovesFuturePremiumNotPast() public {
        _deposit(alice, 100e18);
        _lock();
        _settle(0, 100e6);
        vm.prank(alice);
        vault.approve(bob, 100e18);
        vm.prank(bob);
        vault.transferFrom(alice, carol, 100e18);
        _lock();
        _settle(0, 30e6);
        assertEq(vault.pendingPremium(alice), 100e6);
        assertEq(vault.pendingPremium(carol), 30e6);
        assertEq(vault.pendingPremium(bob), 0);
    }

    function test_premiumCheckpoint_movesToAccumulatorOnBalanceChange() public {
        _deposit(alice, 100e18);
        assertEq(vault.premiumCheckpoint(alice), 0);
        _lock();
        _settle(0, 10e6);
        uint256 acc = vault.accPremiumPerShare();
        // A view does not checkpoint; a balance change checkpoints both sides.
        assertEq(vault.premiumCheckpoint(alice), 0);
        vm.prank(alice);
        vault.transfer(bob, 1e18);
        assertEq(vault.premiumCheckpoint(alice), acc);
        assertEq(vault.premiumCheckpoint(bob), acc);
        // Escrowing shares never checkpoints the vault itself.
        _lock();
        _requestRedeem(alice, 1e18);
        assertEq(vault.premiumCheckpoint(address(vault)), 0);
        // Claiming checkpoints too.
        _settle(0, 10e6);
        vm.prank(bob);
        vault.claimPremium();
        assertEq(vault.premiumCheckpoint(bob), vault.accPremiumPerShare());
    }

    function test_premium_selfTransferKeepsPremium() public {
        _deposit(alice, 100e18);
        _lock();
        _settle(0, 100e6);
        vm.prank(alice);
        vault.transfer(alice, 100e18);
        assertEq(vault.pendingPremium(alice), 100e6);
        vm.prank(alice);
        assertEq(vault.claimPremium(), 100e6);
    }

    function test_premium_survivesRedeemingAllShares() public {
        _deposit(alice, 100e18);
        _lock();
        _settle(0, 7e6);
        vm.prank(alice);
        vault.redeem(100e18, alice, alice);
        assertEq(vault.pendingPremium(alice), 7e6);
        vm.prank(alice);
        assertEq(vault.claimPremium(), 7e6);
    }

    function test_pendingPremium_ofVaultIsZero() public {
        _deposit(alice, 100e18);
        _lock();
        _requestRedeem(alice, 50e18);
        _requestDeposit(bob, 50e18);
        _settle(0, 100e6);
        _lock();
        _settle(0, 100e6);
        assertGt(vault.balanceOf(address(vault)), 0);
        assertEq(vault.pendingPremium(address(vault)), 0);
    }

    function test_premium_queuedRedeemEarnsItsEpochPremium() public {
        _deposit(alice, 100e18);
        _deposit(bob, 100e18);
        _lock();
        _requestRedeem(alice, 100e18);
        _settle(0, 200e6); // the escrowed shares carried this epoch's risk
        vault.claimRedeem(alice);
        assertEq(vault.pendingPremium(alice), 100e6);
        assertEq(vault.pendingPremium(bob), 100e6);

        // No premium for later epochs: the shares are gone.
        _lock();
        _settle(0, 50e6);
        assertEq(vault.pendingPremium(alice), 100e6);
        assertEq(vault.pendingPremium(bob), 150e6);
    }

    function test_premium_queuedDepositSkipsItsEpochButEarnsLaterEpochsBeforeClaim() public {
        _deposit(alice, 100e18);
        _lock();
        _requestDeposit(bob, 100e18);
        _settle(0, 100e6); // bob's assets were not collateral this epoch
        assertEq(vault.pendingPremium(alice), 100e6);

        _lock();
        _settle(0, 200e6); // bob's (unclaimed) shares earn this one
        assertEq(vault.pendingPremium(alice), 200e6);
        vault.claimDeposit(bob);
        assertEq(vault.pendingPremium(bob), 100e6);

        vm.prank(alice);
        vault.claimPremium();
        vm.prank(bob);
        vault.claimPremium();
        assertEq(usdg.balanceOf(alice) + usdg.balanceOf(bob), 300e6);
    }

    function test_unallocatedPremium_heldWhileSupplyIsZero() public {
        _lock();
        usdg.mint(address(vault), 100e6);
        vm.expectEmit(address(vault));
        emit StrikeVault.EpochSettled(1, 0, 100e6, 0, 0, 0);
        vm.prank(mgr);
        vault.settleEpoch(0, 100e6);
        assertEq(vault.unallocatedPremium(), 100e6);
        assertEq(vault.accPremiumPerShare(), 0);
        (,, uint256 accPremium, uint256 perShare) = vault.epochSnapshots(1);
        assertEq(accPremium, 0);
        assertEq(perShare, 0);
    }

    function test_unallocatedPremium_paidWithNextPremium() public {
        _lock();
        _settle(0, 100e6);
        _deposit(alice, 100e18);
        _lock();
        _settle(0, 50e6);
        assertEq(vault.unallocatedPremium(), 0);
        assertEq(vault.pendingPremium(alice), 150e6);
        (,,, uint256 perShare) = vault.epochSnapshots(2);
        assertEq(perShare, Math.mulDiv(150e6, ACC, 100e18));
    }

    function test_unallocatedPremium_paidEvenWithoutNewPremium() public {
        _lock();
        _settle(0, 100e6);
        _deposit(alice, 100e18);
        _lock();
        _settle(0, 0);
        assertEq(vault.unallocatedPremium(), 0);
        assertEq(vault.pendingPremium(alice), 100e6);
    }

    function test_unallocatedPremium_reachesFirstQueuedDepositors() public {
        _lock();
        _requestDeposit(bob, 100e18);
        _settle(0, 100e6); // no shares existed while this premium was earned
        assertEq(vault.unallocatedPremium(), 100e6);
        _lock();
        _settle(0, 0);
        vault.claimDeposit(bob);
        assertEq(vault.pendingPremium(bob), 100e6);
    }

    // ================================================================== manager hooks

    function test_lock_startsEpoch() public {
        vm.expectEmit(address(vault));
        emit StrikeVault.EpochLocked(1);
        _lock();
        assertTrue(vault.locked());
        assertEq(vault.currentEpoch(), 1);
        _settle(0, 0);
        vm.expectEmit(address(vault));
        emit StrikeVault.EpochLocked(2);
        _lock();
        assertEq(vault.currentEpoch(), 2);
    }

    function test_lock_revertsForNonManager() public {
        vm.expectRevert(StrikeVault.NotManager.selector);
        vm.prank(alice);
        vault.lock();
    }

    function test_lock_revertsWhenLocked() public {
        _lock();
        vm.expectRevert(StrikeVault.VaultLocked.selector);
        vm.prank(mgr);
        vault.lock();
    }

    function test_settleEpoch_revertsForNonManager() public {
        _lock();
        vm.expectRevert(StrikeVault.NotManager.selector);
        vm.prank(alice);
        vault.settleEpoch(0, 0);
    }

    function test_settleEpoch_revertsWhenUnlocked() public {
        vm.expectRevert(StrikeVault.VaultNotLocked.selector);
        vm.prank(mgr);
        vault.settleEpoch(0, 0);
    }

    function test_settleEpoch_revertsWhenPayoutExceedsAssets() public {
        _deposit(alice, 100e18);
        _lock();
        _requestDeposit(bob, 50e18); // queued assets cannot pay option holders
        vm.expectRevert(abi.encodeWithSelector(StrikeVault.PayoutExceedsAssets.selector, 100e18 + 1, 100e18));
        vm.prank(mgr);
        vault.settleEpoch(100e18 + 1, 0);
    }

    function test_settleEpoch_paysManagerAndUnlocks() public {
        _deposit(alice, 100e18);
        _lock();
        uint256 acc = Math.mulDiv(10e6, ACC, 100e18);
        usdg.mint(address(vault), 10e6);
        vm.expectEmit(address(vault));
        emit StrikeVault.EpochSettled(1, 30e18, 10e6, 70e18, 100e18, acc);
        vm.prank(mgr);
        vault.settleEpoch(30e18, 10e6);

        assertEq(stock.balanceOf(mgr), 30e18);
        assertEq(stock.balanceOf(address(vault)), 70e18);
        assertEq(vault.totalAssets(), 70e18);
        assertFalse(vault.locked());
        assertEq(vault.lastProcessedEpoch(), 1);
        assertEq(vault.accPremiumPerShare(), acc);
        (uint256 assets, uint256 supply, uint256 accPremium, uint256 perShare) = vault.epochSnapshots(1);
        assertEq(assets, 70e18);
        assertEq(supply, 100e18);
        assertEq(accPremium, acc);
        assertEq(perShare, acc);
    }

    function test_settleEpoch_fullPayoutAllowed() public {
        _deposit(alice, 100e18);
        _lock();
        _settle(100e18, 0);
        assertEq(vault.totalAssets(), 0);
        assertEq(stock.balanceOf(mgr), 100e18);
        assertEq(vault.convertToAssets(100e18), 0);
    }

    function test_settleEpoch_zeroPayoutTransfersNothing() public {
        _deposit(alice, 100e18);
        _lock();
        _settle(0, 0);
        assertEq(stock.balanceOf(mgr), 0);
        assertEq(vault.totalAssets(), 100e18);
    }

    function test_settleEpoch_processesQueueAtClosingPrice() public {
        _deposit(alice, 100e18);
        _deposit(bob, 100e18);
        _lock();
        _requestRedeem(alice, 50e18);
        _requestDeposit(carol, 60e18);
        _settle(40e18, 0); // closing: 160 assets, 200 shares

        uint256 redeemAssets = Math.mulDiv(50e18, 160e18 + 1, 200e18 + 1);
        uint256 depositShares = Math.mulDiv(60e18, 200e18 + 1, 160e18 + 1);
        assertEq(vault.pendingRedeemShares(), 0);
        assertEq(vault.pendingDepositAssets(), 0);
        assertEq(vault.reservedRedeemAssets(), redeemAssets);
        assertEq(vault.totalAssets(), 160e18 - redeemAssets + 60e18);
        assertEq(vault.totalSupply(), 150e18 + depositShares);
        assertEq(vault.balanceOf(address(vault)), depositShares);
        assertEq(vault.claimableRedeemAssets(alice), redeemAssets);
        assertEq(vault.claimableDepositShares(carol), depositShares);
        _assertSolvent();

        // Both sides of the queue got the same price.
        vault.claimDeposit(carol);
        vault.claimRedeem(alice);
        assertApproxEqAbs(vault.previewRedeem(vault.balanceOf(carol)), 60e18, 2);
        assertEq(stock.balanceOf(alice), redeemAssets);
        _assertSolvent();
    }

    // ================================================================== views

    function test_claimableViews_zeroWithoutRequests() public view {
        assertEq(vault.claimableDepositShares(alice), 0);
        assertEq(vault.claimableRedeemAssets(alice), 0);
    }

    function test_claimableViews_zeroWhilePending() public {
        _deposit(alice, 100e18);
        _lock();
        _requestRedeem(alice, 10e18);
        _requestDeposit(bob, 10e18);
        assertEq(vault.claimableDepositShares(bob), 0);
        assertEq(vault.claimableRedeemAssets(alice), 0);
        _settle(0, 0);
        assertEq(vault.claimableDepositShares(bob), 10e18);
        assertEq(vault.claimableRedeemAssets(alice), 10e18);
    }

    // ================================================================== fuzz

    /// Instant deposit then redeem never returns more than was deposited, whatever the share price.
    function testFuzz_depositRedeem_roundTripNeverProfits(uint256 seed, uint256 loss, uint256 amount) public {
        seed = bound(seed, 1, CAP / 2);
        _deposit(bob, seed);
        loss = bound(loss, 0, seed);
        if (loss != 0) {
            _lock();
            _settle(loss, 0);
        }
        amount = bound(amount, 1, vault.maxDeposit(alice));
        uint256 shares = _deposit(alice, amount);
        vm.prank(alice);
        uint256 out = vault.redeem(shares, alice, alice);
        assertLe(out, amount);
        _assertSolvent();
    }

    /// Holders can never be owed more premium than the vault received, and all of it is claimable.
    function testFuzz_premium_sumNeverExceedsDistributed(
        uint256 a,
        uint256 b,
        uint256 moved,
        uint256 premium1,
        uint256 premium2
    ) public {
        a = bound(a, 1, CAP / 2);
        b = bound(b, 1, CAP / 2);
        premium1 = bound(premium1, 0, 1e15);
        premium2 = bound(premium2, 0, 1e15);
        _deposit(alice, a);
        _deposit(bob, b);
        _lock();
        _settle(0, premium1);

        moved = bound(moved, 0, a);
        vm.prank(alice);
        vault.transfer(carol, moved);
        _lock();
        _settle(0, premium2);

        uint256 owed = vault.pendingPremium(alice) + vault.pendingPremium(bob) + vault.pendingPremium(carol);
        assertLe(owed, premium1 + premium2);
        assertApproxEqAbs(owed, premium1 + premium2, 6);

        vm.prank(alice);
        vault.claimPremium();
        vm.prank(bob);
        vault.claimPremium();
        vm.prank(carol);
        vault.claimPremium();
        assertEq(usdg.balanceOf(alice) + usdg.balanceOf(bob) + usdg.balanceOf(carol), owed);
    }

    /// A queued deposit, settled at any closing price and claimed, is worth at most the assets put in.
    function testFuzz_queuedDeposit_sharesWorthAtMostAssets(uint256 seed, uint256 loss, uint256 amount, uint256 premium)
        public
    {
        seed = bound(seed, 0, CAP / 2);
        if (seed != 0) _deposit(bob, seed);
        _lock();
        amount = bound(amount, 1, CAP - seed);
        _requestDeposit(alice, amount);
        loss = bound(loss, 0, seed);
        _settle(loss, bound(premium, 0, 1e15));

        uint256 shares = vault.claimDeposit(alice);
        assertGt(shares, 0);
        assertLe(vault.previewRedeem(shares), amount);
        vm.prank(alice);
        assertLe(vault.redeem(shares, alice, alice), amount);
        _assertSolvent();
    }

    /// A queued redemption never dilutes the holders who stay, and the vault stays solvent.
    function testFuzz_queuedRedeem_doesNotDiluteRemainingHolders(uint256 a, uint256 b, uint256 shares, uint256 loss)
        public
    {
        a = bound(a, 1, CAP / 2);
        b = bound(b, 1, CAP / 2);
        _deposit(alice, a);
        _deposit(bob, b);
        _lock();
        shares = bound(shares, 1, a);
        _requestRedeem(alice, shares);
        loss = bound(loss, 0, a + b);
        _settle(loss, 0);

        (uint256 assets, uint256 supply,,) = vault.epochSnapshots(1);
        uint256 bobAtClose = Math.mulDiv(b, assets + 1, supply + 1);
        assertGe(vault.previewRedeem(b), bobAtClose);
        assertEq(vault.claimableRedeemAssets(alice), Math.mulDiv(shares, assets + 1, supply + 1));
        _assertSolvent();

        if (vault.claimableRedeemAssets(alice) != 0) {
            uint256 paid = vault.claimRedeem(alice);
            assertEq(stock.balanceOf(alice), paid);
        }
        vm.prank(bob);
        vault.redeem(b, bob, bob);
        _assertSolvent();
    }
}
