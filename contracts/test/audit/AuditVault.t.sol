// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {EpochManager} from "../../src/core/EpochManager.sol";
import {StrikeVault} from "../../src/vaults/StrikeVault.sol";
import {MockIdentityRegistry} from "../mocks/MockIdentityRegistry.sol";
import {MockReputationRegistry} from "../mocks/MockReputationRegistry.sol";
import {StrikeBase} from "../utils/StrikeBase.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/// @notice Buyer contract whose ERC-1155 hook tries to re-enter the manager and the vault.
contract ReentrantBuyer is IERC1155Receiver {
    EpochManager internal immutable manager;
    StrikeVault internal immutable vault;
    IERC20 internal immutable usdg;
    uint256 public seriesId;
    uint256 public reentryAttempts;
    uint256 public reentrySuccesses;

    constructor(EpochManager m, StrikeVault v, IERC20 u) {
        manager = m;
        vault = v;
        usdg = u;
    }

    function buy(uint256 id, uint256 amount) external {
        seriesId = id;
        usdg.approve(address(manager), type(uint256).max);
        manager.buy(id, amount, type(uint256).max, address(this));
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external returns (bytes4) {
        _attempt(abi.encodeCall(EpochManager.buy, (seriesId, 1, type(uint256).max, address(this))), address(manager));
        _attempt(abi.encodeCall(EpochManager.redeem, (seriesId, 1, address(this))), address(manager));
        _attempt(abi.encodeCall(EpochManager.settle, (address(vault), 0)), address(manager));
        _attempt(abi.encodeCall(EpochManager.abortEpoch, (address(vault))), address(manager));
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return this.onERC1155BatchReceived.selector;
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == type(IERC1155Receiver).interfaceId;
    }

    function _attempt(bytes memory data, address target) internal {
        ++reentryAttempts;
        (bool ok,) = target.call(data);
        if (ok) ++reentrySuccesses;
    }
}

/// @notice Audit 2026-09-29: vault accounting, queue, premium accumulator, reentrancy, ERC-4626 behaviour.
///         Tests named `safe_` check a property that held; "informational" tests document behaviour
///         integrators must know about and also pass.
contract AuditVaultTest is StrikeBase {
    function _requestDepositCall(address who, uint256 amount) internal {
        tsla.mint(who, amount);
        vm.startPrank(who);
        tsla.approve(address(callVault), amount);
        callVault.requestDeposit(amount, who);
        vm.stopPrank();
    }

    function _pricePerShare(StrikeVault v) internal view returns (uint256) {
        return (v.totalAssets() + 1) * 1e36 / (v.totalSupply() + 1);
    }

    // ------------------------------------------------------------------ reentrancy

    /// An ERC-1155 receiver hook cannot re-enter buy, redeem, settle or abort.
    function test_AUDIT_safe_erc1155HookCannotReenter() public {
        _depositCall(alice, 100 * WAD);
        uint256 seriesId = _openAndPropose(callVault, 275 * WAD, 100 * WAD);
        ReentrantBuyer attacker = new ReentrantBuyer(manager, callVault, IERC20(address(usdg)));
        usdg.mint(address(attacker), 1_000_000e6);
        attacker.buy(seriesId, 10 * WAD);
        assertEq(attacker.reentryAttempts(), 4);
        assertEq(attacker.reentrySuccesses(), 0, "a hook re-entered the manager");
        assertEq(manager.getSeries(seriesId).sold, 10 * WAD);
    }

    // ------------------------------------------------------------------ rounding

    /// Splitting a purchase into many small buys never costs less premium or locks less collateral
    /// (ceil rounding per buy favours the vault), for calls and puts.
    function test_AUDIT_safe_splitBuysNeverCheaper() public {
        _depositCall(alice, 100 * WAD);
        _depositPut(alice, 100_000 * USDG_UNIT);
        uint256 callId = _openAndPropose(callVault, 275 * WAD, 100 * WAD);
        uint256 putId = _openAndPropose(putVault, 235 * WAD, 100 * WAD);

        uint256[2] memory ids = [callId, putId];
        for (uint256 j; j < 2; ++j) {
            uint256 snap = vm.snapshotState();
            uint256 whole = _buy(ids[j], 7 * WAD + 13);
            uint256 wholeCollateral = manager.getSeries(ids[j]).collateral;
            vm.revertToState(snap);
            uint256 split;
            for (uint256 i; i < 7; ++i) {
                split += _buy(ids[j], WAD);
            }
            split += _buy(ids[j], 13);
            assertGe(split, whole, "split buys cheaper");
            assertGe(manager.getSeries(ids[j]).collateral, wholeCollateral, "split buys lock less collateral");
        }
        // Dust buys still pay at least one USDG unit.
        assertGe(_buy(callId, 1), 1);
    }

    /// Many holders redeeming odd amounts never overdraw a series' escrow (puts, in the money).
    function test_AUDIT_safe_splitRedeemsNeverExceedEscrow() public {
        _depositPut(alice, 30_000 * USDG_UNIT);
        uint256 seriesId = _openAndPropose(putVault, 235 * WAD, 100 * WAD);
        _buy(seriesId, 99 * WAD + 777);
        manager.settle(address(putVault), _expireAt(212.345678e8));
        uint256 escrow = manager.getSeries(seriesId).escrow;
        uint256 paid;
        vm.startPrank(buyer);
        for (uint256 i; i < 33; ++i) {
            paid += manager.redeem(seriesId, 3 * WAD + i, buyer);
        }
        uint256 rest = options.balanceOf(buyer, seriesId);
        paid += manager.redeem(seriesId, rest, buyer);
        vm.stopPrank();
        assertLe(paid, escrow);
        assertEq(manager.getSeries(seriesId).escrow, escrow - paid);
        assertGe(usdg.balanceOf(address(manager)), manager.getSeries(seriesId).escrow);
    }

    /// Fifty small queued deposits and redemptions over two epochs (one in the money): every claim
    /// succeeds, the vault stays solvent for managed + reserved assets, the price per share never drops through
    /// the queue alone, and premium paid out never exceeds premium received.
    function test_AUDIT_safe_manySmallQueueRequestsNoDrift() public {
        _depositCall(alice, 1000 * WAD);
        uint256 premiumIn;
        address[] memory users = new address[](50);
        for (uint256 e; e < 2; ++e) {
            uint64 expiry = e == 0 ? FRIDAY_CLOSE : NEXT_FRIDAY_CLOSE;
            if (e == 1) {
                vm.warp(FRIDAY_CLOSE + 3 days - 6 hours); // Monday 14:00 UTC
                feed.set(250e8);
            }
            vm.prank(agent);
            manager.openEpoch(address(callVault));
            vm.prank(agent);
            (, uint256 id) = manager.proposeSeries(address(callVault), 275 * WAD, expiry, 900 * WAD, 10_000);
            premiumIn += _buy(id, 800 * WAD + e);
            for (uint256 i; i < 50; ++i) {
                users[i] = address(uint160(0xA000 + i));
                if (e == 0) {
                    _requestDepositCall(users[i], 1 + i * 1e15 + i);
                } else {
                    uint256 bal = callVault.balanceOf(users[i]);
                    if (bal > 1) {
                        vm.prank(users[i]);
                        callVault.requestRedeem(bal / 2 + 1);
                    }
                }
            }
            vm.warp(expiry + 60);
            uint80 round = feed.set(e == 0 ? int256(260e8) : int256(290e8));
            uint256 ppsBefore = _pricePerShare(callVault);
            manager.settle(address(callVault), round);
            // e == 1 settles in the money; the payout (not the queue) lowers the price per share.
            if (e == 0) assertGe(_pricePerShare(callVault), ppsBefore, "queue lowered the price per share");
            for (uint256 i; i < 50; ++i) {
                if (e == 0) callVault.claimDeposit(users[i]);
                else if (callVault.claimableRedeemAssets(users[i]) != 0) callVault.claimRedeem(users[i]);
            }
            assertGe(
                tsla.balanceOf(address(callVault)),
                callVault.totalAssets() + callVault.reservedRedeemAssets() + callVault.pendingDepositAssets(),
                "vault insolvent for its own accounting"
            );
        }
        uint256 premiumOut;
        for (uint256 i; i < 50; ++i) {
            vm.prank(users[i]);
            premiumOut += callVault.claimPremium();
        }
        vm.prank(alice);
        premiumOut += callVault.claimPremium();
        assertLe(premiumOut, premiumIn, "premium overpaid");
        assertLe(premiumOut + usdg.balanceOf(address(fees)), premiumIn);
    }

    // ------------------------------------------------------------------ timing around expiry

    /// A deposit queued after expiry (outcome known, before settle) earns none of that epoch's
    /// premium, and a redemption queued after an in-the-money expiry still bears the payout.
    function test_AUDIT_safe_queueAfterExpiryCapturesNothing() public {
        _depositCall(alice, 100 * WAD);
        uint256 seriesId = _openAndPropose(callVault, 275 * WAD, 100 * WAD);
        uint256 premium = _buy(seriesId, 60 * WAD);
        uint80 round = _expireAt(300e8); // in the money: 5 tokens owed
        _requestDepositCall(bob, 100 * WAD);
        uint256 aliceShares = callVault.balanceOf(alice);
        vm.prank(alice);
        callVault.requestRedeem(aliceShares);
        manager.settle(address(callVault), round);

        uint256 bobShares = callVault.claimDeposit(bob);
        assertEq(callVault.pendingPremium(bob), 0, "late depositor captured the epoch's premium");
        assertApproxEqAbs(callVault.convertToAssets(bobShares), 100 * WAD, 2);
        uint256 aliceAssets = callVault.claimRedeem(alice);
        assertApproxEqAbs(aliceAssets, 95 * WAD, 1e3, "late redeemer escaped the payout");
        assertApproxEqAbs(callVault.pendingPremium(alice), premium, 2); // losing epoch: no performance fee
    }

    /// Share transfers mid-epoch move no already-accrued premium; a donation of assets or USDG does
    /// not change the price per share or anyone's premium.
    function test_AUDIT_safe_transfersAndDonations() public {
        _depositCall(alice, 100 * WAD);
        uint256 seriesId = _openAndPropose(callVault, 275 * WAD, 100 * WAD);
        uint256 premium = _buy(seriesId, 50 * WAD);
        manager.settle(address(callVault), _expireAt(260e8));
        uint256 alicePremium = callVault.pendingPremium(alice);
        uint256 pps = _pricePerShare(callVault);

        vm.prank(alice);
        callVault.transfer(bob, 40 * WAD);
        assertEq(callVault.pendingPremium(alice), alicePremium);
        assertEq(callVault.pendingPremium(bob), 0);
        tsla.mint(address(callVault), 1000 * WAD);
        usdg.mint(address(callVault), 1000e6);
        assertEq(_pricePerShare(callVault), pps);
        assertEq(callVault.pendingPremium(alice) + callVault.pendingPremium(bob), alicePremium);
        assertLe(alicePremium, premium);
    }

    // ------------------------------------------------------------------ informational

    /// Informational (I-01). While an epoch runs, `totalAssets`/`convertToAssets` ignore the open
    /// option liability (and exclude accrued USDG premium). Shares stay transferable, so an integrator pricing
    /// shares with `convertToAssets` (lending collateral, secondary market) overvalues them when calls are deep in
    /// the money: here 1 share reports 1 token while the vault already owes 1/6 of its tokens.
    function test_AUDIT_info_sharePriceIgnoresOpenLiability() public {
        _depositCall(alice, 100 * WAD);
        uint256 seriesId = _openAndPropose(callVault, 275 * WAD, 100 * WAD);
        _buy(seriesId, 100 * WAD);
        vm.warp(FRIDAY_CLOSE - 2 hours);
        feed.set(330e8); // (330 - 275) / 330 = 1/6 of every token is owed to option holders
        assertApproxEqAbs(callVault.convertToAssets(WAD), WAD, 1);
        assertTrue(callVault.locked());
        vm.prank(alice);
        assertTrue(callVault.transfer(bob, 10 * WAD));
    }

    /// FIXED (I-02, informational). An agent's ERC-8004 link is checked only when set. After the identity
    /// NFT changes hands, the agent's rejections and PnL keep being posted as feedback to the new owner's identity.
    function test_AUDIT_info_identityTransferMisdirectsFeedback() public {
        MockIdentityRegistry identity = new MockIdentityRegistry();
        MockReputationRegistry reputation = new MockReputationRegistry();
        vm.startPrank(admin);
        registry.setIdentityRegistry(IERC721(address(identity)));
        registry.setReputationRegistry(reputation);
        vm.stopPrank();
        vm.startPrank(agent);
        uint256 identityId = identity.register();
        registry.setIdentity(agentId, identityId);
        identity.transferFrom(agent, bob, identityId); // sold or given away
        vm.stopPrank();

        _depositCall(alice, 100 * WAD);
        vm.prank(agent);
        manager.openEpoch(address(callVault));
        vm.prank(agent);
        manager.proposeSeries(address(callVault), 252 * WAD, FRIDAY_CLOSE, 50 * WAD, 10_000); // rejected
        // FIXED (I-02): the rejection is still recorded on Strike, but no feedback lands on bob's identity.
        assertEq(reputation.count(), 0, "no feedback on a transferred identity");
        assertEq(registry.getAgent(agentId).strikes, 1);
    }
}
