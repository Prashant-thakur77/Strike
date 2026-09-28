// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {EpochManager} from "../../src/core/EpochManager.sol";
import {SafeStockFeed} from "../../src/libraries/SafeStockFeed.sol";
import {MarketCalendar} from "../../src/oracle/MarketCalendar.sol";
import {BlackScholesLib} from "../../src/pricing/BlackScholesLib.sol";
import {VaultFactory} from "../../src/vaults/VaultFactory.sol";
import {StrikeBase} from "../utils/StrikeBase.sol";

/// @notice Rare branches: rounding at capacity, the minimum premium, clamped solver bounds, empty calendar weeks.
contract EdgeBranchesTest is StrikeBase {
    function test_buy_exceedsCapacityThroughRounding() public {
        // 235 USDG backs exactly one 235-strike put. Three buys of a third each round collateral up
        // (78.333334 USDG each), so the third would need 235.000002 USDG.
        _depositPut(alice, 235 * USDG_UNIT);
        uint256 id = _openAndPropose(putVault, 235 * WAD, 1 * WAD);
        uint256 third = uint256(1e18) / 3;
        _buy(id, third);
        _buy(id, third);
        (uint256 premium,) = manager.quoteBuy(id, third);
        usdg.mint(buyer, premium);
        vm.startPrank(buyer);
        usdg.approve(address(manager), premium);
        vm.expectRevert(abi.encodeWithSelector(EpochManager.ExceedsCapacity.selector, 235_000_002, 235 * USDG_UNIT));
        manager.buy(id, third, premium, buyer);
        vm.stopPrank();
    }

    function test_buy_minimumPremiumIsOneUnit() public {
        _depositCall(alice, 10 * WAD);
        uint256 id = _openAndPropose(callVault, 275 * WAD, 10 * WAD);
        feed.set(50e8); // spot collapses: the 275 call is worth nothing
        (uint256 premium,) = manager.quoteBuy(id, 1);
        assertEq(premium, 1);
    }

    function test_buy_afterSettlementIsWrongState() public {
        _depositCall(alice, 10 * WAD);
        uint256 id = _openAndPropose(callVault, 275 * WAD, 10 * WAD);
        _buy(id, 1 * WAD);
        manager.settle(address(callVault), _expireAt(250e8));
        vm.expectRevert(
            abi.encodeWithSelector(
                EpochManager.WrongState.selector, EpochManager.EpochState.Selling, EpochManager.EpochState.Idle
            )
        );
        manager.buy(id, 1, type(uint256).max, buyer);
    }

    function test_registerVault_delistedUnderlying() public {
        vm.prank(admin);
        manager.setUnderlying(address(tsla), false);
        VaultFactory.CreateParams memory p = _params(true, 1000 * WAD);
        vm.prank(curator);
        vm.expectRevert(abi.encodeWithSelector(EpochManager.UnderlyingNotAllowed.selector, address(tsla)));
        factory.createVault(p);
    }

    function test_previewProposal_zeroStrikeReverts() public {
        _depositPut(alice, 1000 * USDG_UNIT);
        vm.expectRevert(abi.encodeWithSelector(BlackScholesLib.PricerInputOutOfRange.selector, uint8(2)));
        manager.previewProposal(address(putVault), 0, FRIDAY_CLOSE, 1, 10_000);
    }

    function test_strikeForDelta_clampsSearchRange() public view {
        // Tiny spot: the lower bound clamps to the pricer minimum.
        uint256 k = pricer.strikeForDelta(2e6, 0.2e18, 7 days, 0.6e18, true);
        assertGt(k, 2e6);
        // Huge spot: the upper bound clamps to the pricer maximum.
        k = pricer.strikeForDelta(5e29, 0.2e18, 7 days, 0.6e18, true);
        assertGt(k, 5e29);
        assertLe(k, 1e30);
    }

    function test_calendar_noSessionInWindow() public {
        uint256[] memory days_ = new uint256[](20);
        uint256 start = MONDAY / 1 days;
        for (uint256 i; i < 20; ++i) {
            days_[i] = start + i;
        }
        MarketCalendar closed = new MarketCalendar(address(this), days_, new uint256[](0));
        assertEq(closed.weeklyExpiry(MONDAY), 0);
        assertEq(closed.nextSessionClose(MONDAY), 0);
    }

    function test_settlementPrint_mustBePositive() public {
        feed.push(0, FRIDAY_CLOSE + 10);
        uint80 r = feed.currentRoundId();
        vm.warp(FRIDAY_CLOSE + 60);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.InvalidPrice.selector, int256(0)));
        oracle.recordSettlementPrice(address(tsla), FRIDAY_CLOSE, r);
    }
}
