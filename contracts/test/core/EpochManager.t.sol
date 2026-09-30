// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AgentRegistry} from "../../src/agents/AgentRegistry.sol";
import {EpochManager} from "../../src/core/EpochManager.sol";
import {FeeManager} from "../../src/core/FeeManager.sol";
import {IPricer} from "../../src/interfaces/IPricer.sol";
import {IStockOracle} from "../../src/interfaces/IStockOracle.sol";
import {MandateGuard} from "../../src/libraries/MandateGuard.sol";
import {VaultFactory} from "../../src/vaults/VaultFactory.sol";
import {StrikeBase} from "../utils/StrikeBase.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Every EpochManager function and custom error.
contract EpochManagerTest is StrikeBase {
    // ------------------------------------------------------------------ constructor & admin

    function test_constructor_zeroAddresses() public {
        vm.expectRevert(EpochManager.ZeroAddress.selector);
        new EpochManager(address(0), usdg, options, pricer, fees, oracle, registry);
        vm.expectRevert(EpochManager.ZeroAddress.selector);
        new EpochManager(admin, IERC20(address(0)), options, pricer, fees, oracle, registry);
        vm.expectRevert(EpochManager.ZeroAddress.selector);
        new EpochManager(admin, usdg, options, IPricer(address(0)), fees, oracle, registry);
        vm.expectRevert(EpochManager.ZeroAddress.selector);
        new EpochManager(admin, usdg, options, pricer, fees, IStockOracle(address(0)), registry);
        vm.expectRevert(EpochManager.ZeroAddress.selector);
        new EpochManager(admin, usdg, options, pricer, fees, oracle, AgentRegistry(address(0)));
    }

    function test_constructor_readsUsdgDecimals() public view {
        assertEq(manager.usdgDecimals(), 6);
        assertEq(address(manager.optionToken()), address(options));
        assertEq(address(manager.agents()), address(registry));
    }

    function test_setUnderlying() public {
        vm.startPrank(admin);
        vm.expectRevert(EpochManager.ZeroAddress.selector);
        manager.setUnderlying(address(0), true);
        vm.expectRevert(abi.encodeWithSelector(EpochManager.UnsupportedByOracle.selector, address(usdg)));
        manager.setUnderlying(address(usdg), true);
        manager.setUnderlying(address(tsla), false);
        vm.stopPrank();
        (uint8 dec, bool allowed,,,,,) = manager.underlyings(address(tsla));
        assertEq(dec, 18);
        assertFalse(allowed);
        vm.expectRevert(abi.encodeWithSelector(EpochManager.UnderlyingNotAllowed.selector, address(tsla)));
        manager.spot(address(tsla));
    }

    function test_sigma() public {
        vm.prank(keeper);
        manager.setSigma(address(tsla), 0.75e18); // +25%, the largest step
        (,, uint64 sigma,,,,) = manager.underlyings(address(tsla));
        assertEq(sigma, 0.75e18);
        // Once an hour.
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(EpochManager.TooEarly.selector, block.timestamp + 1 hours));
        manager.setSigma(address(tsla), 0.8e18);
        vm.warp(block.timestamp + 1 hours);
        // More than 25% at once.
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(EpochManager.SigmaOutOfBounds.selector, uint64(0.55e18)));
        manager.setSigma(address(tsla), 0.55e18);
        vm.prank(keeper);
        manager.setSigma(address(tsla), 0.5625e18); // -25%
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(EpochManager.SigmaOutOfBounds.selector, uint64(2e18)));
        manager.setSigma(address(tsla), 2e18);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(EpochManager.SigmaOutOfBounds.selector, uint64(0.1e18)));
        manager.setSigmaBounds(address(tsla), 0.2e18, 1e18, 0.1e18);
        vm.expectRevert();
        manager.setSigma(address(tsla), 0.5e18); // not a keeper
    }

    function test_spotBuffer() public {
        vm.expectRevert();
        manager.setSpotBuffer(address(tsla), 50); // not admin
        vm.startPrank(admin);
        vm.expectRevert(EpochManager.InvalidTimings.selector);
        manager.setSpotBuffer(address(tsla), 201);
        manager.setSpotBuffer(address(tsla), 50);
        vm.stopPrank();
        (,,,,, uint16 buffer,) = manager.underlyings(address(tsla));
        assertEq(buffer, 50);
    }

    function test_setters() public {
        vm.startPrank(admin);
        manager.setPricer(pricer);
        manager.setFeeManager(fees);
        manager.setOracle(oracle);
        manager.setTimings(2 days, 2 hours, 3 days);
        assertEq(manager.proposalTimeout(), 2 days);
        assertEq(manager.saleCutoff(), 2 hours);
        assertEq(manager.settlementGrace(), 3 days);
        vm.expectRevert(EpochManager.ZeroAddress.selector);
        manager.setPricer(IPricer(address(0)));
        vm.expectRevert(EpochManager.ZeroAddress.selector);
        manager.setFeeManager(FeeManager(address(0)));
        vm.expectRevert(EpochManager.ZeroAddress.selector);
        manager.setOracle(IStockOracle(address(0)));
        vm.expectRevert(EpochManager.InvalidTimings.selector);
        manager.setTimings(0, 1 hours, 3 days);
        vm.expectRevert(EpochManager.InvalidTimings.selector);
        manager.setTimings(1 days, 2 days, 3 days);
        vm.expectRevert(EpochManager.InvalidTimings.selector);
        manager.setTimings(1 days, 1 hours, 31 days);
        vm.stopPrank();
    }

    function test_pauseRoles() public {
        vm.expectRevert();
        manager.pause();
        vm.prank(guardian);
        manager.pause();
        assertTrue(manager.paused());
        vm.prank(guardian);
        manager.unpause();
        assertFalse(manager.paused());
    }

    // ------------------------------------------------------------------ registration

    function test_registerVault_errors() public {
        vm.expectRevert();
        manager.registerVault(address(callVault), curator, agentId, _mandate()); // not the factory
        bytes32 role = manager.FACTORY_ROLE();
        vm.prank(admin);
        manager.grantRole(role, address(this));
        vm.expectRevert(EpochManager.ZeroAddress.selector);
        manager.registerVault(address(0), curator, agentId, _mandate());
        vm.expectRevert(abi.encodeWithSelector(EpochManager.VaultAlreadyRegistered.selector, address(callVault)));
        manager.registerVault(address(callVault), curator, agentId, _mandate());
    }

    function test_registerVault_rejectsBadMandate() public {
        VaultFactory.CreateParams memory p = _params(true, 1000 * WAD);
        p.mandate.minDeltaBps = 5000;
        p.mandate.maxDeltaBps = 1000;
        vm.expectRevert(
            abi.encodeWithSelector(
                MandateGuard.InvalidMandate.selector, uint8(MandateGuard.MandateError.DeltaBandInverted)
            )
        );
        vm.prank(curator);
        factory.createVault(p);
    }

    function test_views() public view {
        assertEq(manager.vaultCount(), 2);
        assertEq(manager.allVaults(0), address(callVault));
        EpochManager.VaultConfig memory v = manager.vaultConfig(address(callVault));
        assertEq(v.curator, curator);
        assertEq(v.agentId, agentId);
        assertTrue(v.registered);
        assertEq(manager.spot(address(tsla)), 250 * WAD);
        assertEq(
            manager.seriesIdOf(address(1), address(2), 3, 4, true),
            uint256(keccak256(abi.encode(address(1), address(2), uint256(3), uint64(4), true)))
        );
    }

    function test_revert_vaultNotRegistered() public {
        vm.expectRevert(abi.encodeWithSelector(EpochManager.VaultNotRegistered.selector, address(1)));
        manager.openEpoch(address(1));
    }

    // ------------------------------------------------------------------ open / propose

    function test_openEpoch_errors() public {
        vm.expectRevert(abi.encodeWithSelector(EpochManager.NotAgent.selector, address(this)));
        manager.openEpoch(address(callVault));

        vm.warp(MONDAY + 5 days); // Saturday
        feed.set(250e8);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(EpochManager.MarketClosed.selector, MONDAY + 5 days));
        manager.openEpoch(address(callVault));

        vm.warp(MONDAY);
        feed.set(250e8);
        vm.prank(keeper); // keepers may open too
        manager.openEpoch(address(callVault));
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(
                EpochManager.WrongState.selector, EpochManager.EpochState.Idle, EpochManager.EpochState.Open
            )
        );
        manager.openEpoch(address(callVault));
    }

    function test_openEpoch_whenPaused() public {
        vm.prank(guardian);
        manager.pause();
        vm.prank(agent);
        vm.expectRevert();
        manager.openEpoch(address(callVault));
    }

    function test_proposeSeries_errors() public {
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(
                EpochManager.WrongState.selector, EpochManager.EpochState.Open, EpochManager.EpochState.Idle
            )
        );
        manager.proposeSeries(address(callVault), 275 * WAD, FRIDAY_CLOSE, 1, 10_000);
        vm.expectRevert(abi.encodeWithSelector(EpochManager.NotAgent.selector, address(this)));
        manager.proposeSeries(address(callVault), 275 * WAD, FRIDAY_CLOSE, 1, 10_000);
    }

    function test_proposeSeries_expiredIsTenorOutOfRange() public {
        _depositCall(alice, 10 * WAD);
        vm.prank(agent);
        manager.openEpoch(address(callVault));
        (MandateGuard.Reason r,,,) =
            manager.previewProposal(address(callVault), 275 * WAD, uint64(block.timestamp - 1), 1, 10_000);
        assertEq(uint8(r), uint8(MandateGuard.Reason.TenorOutOfRange));
    }

    // ------------------------------------------------------------------ buy

    function _selling() internal returns (uint256 seriesId) {
        _depositCall(alice, 10 * WAD);
        seriesId = _openAndPropose(callVault, 275 * WAD, 5 * WAD);
    }

    function test_buy_errors() public {
        uint256 id = _selling();
        vm.expectRevert(EpochManager.ZeroAmount.selector);
        manager.buy(id, 0, 1, buyer);
        vm.expectRevert(EpochManager.ZeroAddress.selector);
        manager.buy(id, 1, 1, address(0));
        vm.expectRevert(abi.encodeWithSelector(EpochManager.SeriesUnknown.selector, 123));
        manager.buy(123, 1, 1, buyer);
        vm.expectRevert(abi.encodeWithSelector(EpochManager.ExceedsSize.selector, 6 * WAD, 5 * WAD));
        manager.buy(id, 6 * WAD, type(uint256).max, buyer);
        (uint256 premium,) = manager.quoteBuy(id, 1 * WAD);
        vm.expectRevert(abi.encodeWithSelector(EpochManager.PremiumTooHigh.selector, premium, premium - 1));
        manager.buy(id, 1 * WAD, premium - 1, buyer);
    }

    function test_buy_marketClosedAndSaleCutoff() public {
        uint256 id = _selling();
        vm.warp(MONDAY + 12 hours); // 02:00 New York
        feed.set(250e8);
        vm.expectRevert(abi.encodeWithSelector(EpochManager.MarketClosed.selector, MONDAY + 12 hours));
        manager.buy(id, 1, type(uint256).max, buyer);
        vm.warp(FRIDAY_CLOSE - 30 minutes);
        feed.set(250e8);
        vm.expectRevert(abi.encodeWithSelector(EpochManager.SaleClosed.selector, FRIDAY_CLOSE));
        manager.buy(id, 1, type(uint256).max, buyer);
    }

    function test_buy_exceedsCapacity() public {
        _depositPut(alice, 23_500 * USDG_UNIT);
        uint256 id = _openAndPropose(putVault, 235 * WAD, 100 * WAD);
        // The curator's cap was only a proposal-time check; capacity is enforced again per buy.
        _buy(id, 100 * WAD);
        vm.expectRevert();
        manager.buy(id, 1, type(uint256).max, buyer);
    }

    function test_buy_pricesFromLiveSpot() public {
        uint256 id = _selling();
        (uint256 p1,) = manager.quoteBuy(id, WAD);
        feed.set(265e8); // spot rallies: calls get dearer
        (uint256 p2,) = manager.quoteBuy(id, WAD);
        assertGt(p2, p1);
        vm.expectRevert(abi.encodeWithSelector(EpochManager.SeriesUnknown.selector, 1));
        manager.quoteBuy(1, WAD);
    }

    // ------------------------------------------------------------------ settle / redeem

    function test_settle_errors() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                EpochManager.WrongState.selector, EpochManager.EpochState.Selling, EpochManager.EpochState.Idle
            )
        );
        manager.settle(address(callVault), 1);
        uint256 id = _selling();
        vm.expectRevert(abi.encodeWithSelector(EpochManager.NotExpired.selector, FRIDAY_CLOSE));
        manager.settle(address(callVault), 1);
        id;
    }

    function test_settle_isRetryableAndSingle() public {
        uint256 id = _selling();
        _buy(id, 1 * WAD);
        vm.warp(FRIDAY_CLOSE + 60);
        uint80 beforeExpiry = feed.currentRoundId();
        vm.expectRevert(); // no print after expiry yet
        manager.settle(address(callVault), beforeExpiry);
        uint80 round = feed.set(250e8);
        manager.settle(address(callVault), round);
        vm.expectRevert(
            abi.encodeWithSelector(
                EpochManager.WrongState.selector, EpochManager.EpochState.Selling, EpochManager.EpochState.Idle
            )
        );
        manager.settle(address(callVault), round);
    }

    function test_redeem_errors() public {
        uint256 id = _selling();
        _buy(id, 1 * WAD);
        vm.startPrank(buyer);
        vm.expectRevert(EpochManager.ZeroAmount.selector);
        manager.redeem(id, 0, buyer);
        vm.expectRevert(EpochManager.ZeroAddress.selector);
        manager.redeem(id, 1, address(0));
        vm.expectRevert(abi.encodeWithSelector(EpochManager.SeriesUnknown.selector, 7));
        manager.redeem(7, 1, buyer);
        vm.expectRevert(abi.encodeWithSelector(EpochManager.SeriesNotFinal.selector, id));
        manager.redeem(id, 1, buyer);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ abort / cancel

    function test_abort_errors() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                EpochManager.WrongState.selector, EpochManager.EpochState.Open, EpochManager.EpochState.Idle
            )
        );
        manager.abortEpoch(address(callVault));
    }

    function test_emergencyCancel_errors() public {
        vm.prank(guardian);
        vm.expectRevert(
            abi.encodeWithSelector(
                EpochManager.WrongState.selector, EpochManager.EpochState.Selling, EpochManager.EpochState.Idle
            )
        );
        manager.emergencyCancel(address(callVault));
        _selling();
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(EpochManager.TooEarly.selector, uint256(FRIDAY_CLOSE) + 7 days));
        manager.emergencyCancel(address(callVault));
        vm.expectRevert();
        manager.emergencyCancel(address(callVault)); // not a guardian
    }

    function test_setVaultAgent_admin() public {
        vm.prank(admin);
        manager.setVaultAgent(address(callVault), 99);
        assertEq(manager.vaultConfig(address(callVault)).agentId, 99);
    }
}
