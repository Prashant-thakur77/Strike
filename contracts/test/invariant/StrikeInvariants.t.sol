// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {EpochManager} from "../../src/core/EpochManager.sol";
import {RiskLens} from "../../src/core/RiskLens.sol";
import {Decimals} from "../../src/libraries/Decimals.sol";
import {RiskLib} from "../../src/pricing/RiskLib.sol";
import {StrikeVault} from "../../src/vaults/StrikeVault.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {StrikeBase} from "../utils/StrikeBase.sol";
import {StrikeHandler} from "./StrikeHandler.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {console2} from "forge-std/console2.sol";

/// @notice The invariants from docs/design.md §6, checked after every step of random action sequences.
abstract contract StrikeInvariants is StrikeBase {
    uint256 internal constant ACC = 1e36;
    StrikeHandler internal handler;
    StrikeVault internal vault;
    RiskLens internal lens;

    function _targetVault() internal view virtual returns (StrikeVault);

    function setUp() public override {
        super.setUp();
        vault = _targetVault();
        // Let the agent survive many reckless proposals so epochs keep running.
        vm.prank(admin);
        registry.setParams(MIN_BOND, SLASH, 10_000, 8 days);
        usdg.mint(agent, 1_000_000e6);
        vm.startPrank(agent);
        usdg.approve(address(registry), 1_000_000e6);
        registry.postBond(agentId, 1_000_000e6);
        vm.stopPrank();

        lens = new RiskLens(manager);
        handler = new StrikeHandler(manager, vault, usdg, feed, calendar, agent, buyer, fees);
        targetContract(address(handler));
    }

    /// 1. Collateral locked for a live series always covers its worst-case payout, and never exceeds the vault.
    function invariant_collateralCoversMaxPayout() public view {
        (EpochManager.EpochState state,, uint256 id,,) = manager.epochs(address(vault));
        if (state != EpochManager.EpochState.Selling) return;
        EpochManager.Series memory s = manager.getSeries(id);
        uint256 maxPayout = s.isCall ? s.sold : Decimals.valueInUsd(s.sold, s.strike, 18, 6, Math.Rounding.Floor);
        assertGe(s.collateral, maxPayout, "collateral < max payout");
        assertLe(s.collateral, vault.totalAssets(), "collateral > vault assets");
    }

    /// 2. Shares × price = assets, up to the ERC-4626 virtual-share rounding.
    function invariant_shareAccounting() public view {
        uint256 supply = vault.totalSupply();
        uint256 assets = vault.totalAssets();
        uint256 c = vault.convertToAssets(supply);
        assertLe(c, assets, "shares worth more than assets");
        assertLe(assets - c, assets / (supply + 1) + 1, "shares worth too little");
    }

    /// 3a. While locked, collateral changes only inside settlement.
    function invariant_noLeakageWhileLocked() public view {
        if (vault.locked()) assertEq(vault.totalAssets(), handler.assetsAtLock(), "assets moved while locked");
    }

    /// 3b. The vault holds every asset it accounts for.
    function invariant_assetBacking() public view {
        uint256 need = vault.totalAssets() + vault.pendingDepositAssets() + vault.reservedRedeemAssets();
        if (!vault.isCall()) need += _premiumOwed();
        assertGe(MockERC20(vault.asset()).balanceOf(address(vault)), need, "vault under-backed");
    }

    /// 4. A settled series stays settled at the price first recorded.
    function invariant_settlementIsFinal() public view {
        for (uint256 i; i < handler.seriesCount(); ++i) {
            uint256 id = handler.seriesIds(i);
            EpochManager.Series memory s = manager.getSeries(id);
            uint256 recorded = handler.recordedSettlement(id);
            if (recorded != 0) {
                assertTrue(s.settled, "settled flag flipped");
                assertEq(s.settlementPrice, recorded, "settlement price changed");
                assertEq(oracle.settlementPrice(s.underlying, s.expiry), recorded, "oracle record changed");
            }
        }
    }

    /// 5. The manager can pay every option holder and every depositor what it owes them.
    function invariant_managerSolvency() public view {
        uint256 tokenOwed;
        uint256 usdgOwed = manager.compensation(address(vault));
        for (uint256 i; i < handler.seriesCount(); ++i) {
            EpochManager.Series memory s = manager.getSeries(handler.seriesIds(i));
            if (s.cancelled) usdgOwed += s.escrow;
            else if (s.settled) s.isCall ? tokenOwed += s.escrow : usdgOwed += s.escrow;
            else usdgOwed += s.premium; // escrowed until settlement
        }
        assertGe(tsla.balanceOf(address(manager)), tokenOwed, "manager short of payout tokens");
        assertGe(usdg.balanceOf(address(manager)), usdgOwed, "manager short of USDG");
    }

    /// 6. The vault can pay every holder's accrued and claimable premium.
    function invariant_premiumSolvency() public view {
        uint256 bal = usdg.balanceOf(address(vault));
        if (!vault.isCall()) {
            bal -= Math.min(bal, vault.totalAssets() + vault.pendingDepositAssets() + vault.reservedRedeemAssets());
        }
        assertGe(bal, _premiumOwed(), "premium insolvent");
    }

    /// 8. Liveness: holders of settled (or cancelled) options can always redeem them.
    function invariant_optionHoldersCanAlwaysRedeem() public view {
        assertFalse(handler.redeemFailed(), "an option redemption reverted");
    }

    /// 7. Deposits and withdrawals alone never lower the share price.
    function invariant_roundingNeverLowersSharePrice() public view {
        assertFalse(handler.sharePriceDropped(), "share price fell on deposit/withdraw");
    }

    /// 8. Performance fee high-water mark (D31): total fees never exceed perf × the highest cumulative net premium
    ///    the vault reached; every fee leaves total fees ≤ perf × the cumulative net at that time; and the carried
    ///    loss is exactly the distance from the high-water mark.
    function invariant_feeHighWaterMark() public view {
        int256 hwm = handler.highWaterMark();
        assertLe(handler.totalFees(), uint256(hwm) * fees.perfFeeBps() / 10_000, "fees above perf x high-water mark");
        assertFalse(handler.feeAboveCumulativeNet(), "fees above perf x cumulative net");
        assertEq(fees.lossCarried(address(vault)), uint256(hwm - handler.cumulativeNet()), "carry != hwm - net");
        // Nobody claims in the handler, so every fee is still claimable.
        assertEq(fees.totalClaimable(), handler.totalFees());
    }

    /// 11. Risk engine (v3): for the live series, the worst payout the `RiskLens` finds on a wide stress grid at the
    ///    current feed price (spot −99.99% … +1000%) fits in the locked collateral, both in collateral units (with
    ///    settlement rounding) and in USD value at the shocked spot.
    function invariant_worstCaseScenarioWithinCollateral() public view {
        (EpochManager.EpochState state,, uint256 id,,) = manager.epochs(address(vault));
        if (state != EpochManager.EpochState.Selling) return;
        (, int256 answer,,,) = feed.latestRoundData();
        (,, uint64 sigma,,,,) = manager.underlyings(address(tsla));
        int256[] memory shocks = new int256[](8);
        (shocks[0], shocks[1], shocks[2], shocks[3]) = (-0.9999e18, -0.5e18, -0.3e18, -0.1e18);
        (shocks[4], shocks[5], shocks[6], shocks[7]) = (0.1e18, 0.3e18, 1e18, 10e18);
        // The handler keeps the feed price positive.
        // forge-lint: disable-next-line(unsafe-typecast)
        RiskLens.SeriesRisk memory r = lens.seriesRiskAt(id, uint256(answer) * 1e10, sigma, shocks);
        assertLe(r.worstPayout, r.collateral, "worst-case payout > locked collateral");
        uint256 shocked = RiskLib.shockedSpot(r.spot, r.worstShock);
        // Call collateral: 18-decimal TSLA at the shocked spot; put collateral: 6-decimal USDG.
        uint256 value = vault.isCall() ? r.collateral * shocked / WAD : r.collateral * 1e12;
        assertLe(r.worstLoss, value, "worst-case loss > collateral value");
    }

    /// Coverage: how often each action actually ran (run with -vv to print).
    function afterInvariant() external view {
        assertGt(handler.calls(), 0);
        string[12] memory names = [
            "deposit",
            "redeem",
            "requestDeposit",
            "requestRedeem",
            "cancelDeposit",
            "claim",
            "transfer",
            "propose",
            "reckless",
            "buy",
            "settle",
            "redeemOptions"
        ];
        for (uint256 i; i < names.length; ++i) {
            console2.log(names[i], handler.counts(bytes32(bytes(names[i]))));
        }
    }

    function _premiumOwed() internal view returns (uint256 owed) {
        owed = vault.unallocatedPremium();
        uint256 acc = vault.accPremiumPerShare();
        for (uint256 i; i < handler.actorCount(); ++i) {
            address a = handler.actors(i);
            owed += vault.pendingPremium(a);
            (uint64 dEpoch, uint192 dAmount) = vault.depositRequests(a);
            if (dAmount != 0 && dEpoch <= vault.lastProcessedEpoch()) {
                (,, uint256 accAt,) = vault.epochSnapshots(dEpoch);
                owed += vault.claimableDepositShares(a) * (acc - accAt) / ACC;
            }
            (uint64 rEpoch, uint192 rAmount) = vault.redeemRequests(a);
            if (rAmount != 0 && rEpoch <= vault.lastProcessedEpoch()) {
                (,,, uint256 perShare) = vault.epochSnapshots(rEpoch);
                owed += uint256(rAmount) * perShare / ACC;
            }
        }
    }
}

contract CallVaultInvariantTest is StrikeInvariants {
    function _targetVault() internal view override returns (StrikeVault) {
        return callVault;
    }
}

contract PutVaultInvariantTest is StrikeInvariants {
    function _targetVault() internal view override returns (StrikeVault) {
        return putVault;
    }
}
