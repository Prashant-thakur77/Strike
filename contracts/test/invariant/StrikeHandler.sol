// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {EpochManager} from "../../src/core/EpochManager.sol";
import {MarketCalendar} from "../../src/oracle/MarketCalendar.sol";
import {StrikeVault} from "../../src/vaults/StrikeVault.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";

/// @notice Drives one vault through random sequences of user and protocol actions, week by week, and keeps the
///         ghost state the invariants compare against.
contract StrikeHandler is CommonBase, StdCheats, StdUtils {
    EpochManager internal manager;
    StrikeVault public vault;
    MockERC20 internal asset;
    MockERC20 internal usdg;
    MockAggregator internal feed;
    MarketCalendar internal calendar;
    address internal agent;
    address internal buyer;
    bool internal isCall;

    address[] public actors;
    uint256[] public seriesIds;

    // Ghosts
    int256 public price8 = 250e8;
    uint256 public assetsAtLock;
    bool public sharePriceDropped;
    bool public redeemFailed;
    mapping(uint256 seriesId => uint256 price) public recordedSettlement;
    uint256 public calls;
    mapping(bytes32 action => uint256 count) public counts;

    constructor(
        EpochManager manager_,
        StrikeVault vault_,
        MockERC20 usdg_,
        MockAggregator feed_,
        MarketCalendar calendar_,
        address agent_,
        address buyer_
    ) {
        manager = manager_;
        vault = vault_;
        usdg = usdg_;
        feed = feed_;
        calendar = calendar_;
        agent = agent_;
        buyer = buyer_;
        asset = MockERC20(vault_.asset());
        isCall = vault_.isCall();
        actors.push(makeAddr("inv-alice"));
        actors.push(makeAddr("inv-bob"));
        actors.push(makeAddr("inv-carol"));
    }

    // ------------------------------------------------------------------ helpers

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _unit() internal view returns (uint256) {
        return isCall ? 1e18 : 1e6;
    }

    function _pps() internal view returns (uint256) {
        return (vault.totalAssets() + 1) * 1e18 / (vault.totalSupply() + 1);
    }

    function _refreshPrice() internal {
        feed.set(price8);
    }

    function _state() internal view returns (EpochManager.EpochState state, uint256 seriesId) {
        (state,, seriesId,,) = manager.epochs(address(vault));
    }

    function seriesCount() external view returns (uint256) {
        return seriesIds.length;
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    // ------------------------------------------------------------------ depositor actions

    function deposit(uint256 actorSeed, uint256 amount) external {
        ++calls;
        address who = _actor(actorSeed);
        amount = bound(amount, _unit() / 100, 1000 * _unit());
        asset.mint(who, amount);
        vm.startPrank(who);
        asset.approve(address(vault), amount);
        if (vault.locked()) {
            try vault.requestDeposit(amount, who) {
                ++counts["requestDeposit"];
            } catch {}
        } else {
            uint256 before = _pps();
            vault.deposit(amount, who);
            if (_pps() < before) sharePriceDropped = true;
            ++counts["deposit"];
        }
        vm.stopPrank();
    }

    function redeem(uint256 actorSeed, uint256 fraction) external {
        ++calls;
        address who = _actor(actorSeed);
        uint256 shares = vault.balanceOf(who) * bound(fraction, 1, 100) / 100;
        if (shares == 0) return;
        vm.startPrank(who);
        if (vault.locked()) {
            vault.requestRedeem(shares);
            ++counts["requestRedeem"];
        } else {
            uint256 before = _pps();
            vault.redeem(shares, who, who);
            if (_pps() < before) sharePriceDropped = true;
            ++counts["redeem"];
        }
        vm.stopPrank();
    }

    function claim(uint256 actorSeed) external {
        ++calls;
        address who = _actor(actorSeed);
        if (vault.claimableDepositShares(who) != 0) vault.claimDeposit(who);
        (uint64 rEpoch, uint192 rAmount) = vault.redeemRequests(who);
        if (rAmount != 0 && rEpoch <= vault.lastProcessedEpoch()) vault.claimRedeem(who);
        vm.prank(who);
        vault.claimPremium();
        ++counts["claim"];
    }

    function cancelDeposit(uint256 actorSeed) external {
        ++calls;
        address who = _actor(actorSeed);
        vm.prank(who);
        try vault.cancelDepositRequest() {
            ++counts["cancelDeposit"];
        } catch {}
    }

    function transferShares(uint256 fromSeed, uint256 toSeed, uint256 fraction) external {
        ++calls;
        address from = _actor(fromSeed);
        address to = _actor(toSeed);
        uint256 shares = vault.balanceOf(from) * bound(fraction, 1, 100) / 100;
        if (shares == 0) return;
        vm.prank(from);
        vault.transfer(to, shares);
        ++counts["transfer"];
    }

    // ------------------------------------------------------------------ protocol actions

    /// Warp to the next Monday 15:00 UTC (open in both EST and EDT), open the epoch and propose.
    function openAndPropose(uint256 strikeSeed, uint256 sizeSeed, uint256 bpsSeed) external {
        ++calls;
        (EpochManager.EpochState state,) = _state();
        if (state != EpochManager.EpochState.Idle || vault.totalAssets() == 0) return;
        uint256 day = block.timestamp / 1 days;
        uint256 toMonday = (8 - ((day + 4) % 7)) % 7;
        if (toMonday == 0) toMonday = 7;
        vm.warp((day + toMonday) * 1 days + 15 hours);
        _refreshPrice();
        vm.prank(agent);
        manager.openEpoch(address(vault));
        assetsAtLock = vault.totalAssets();

        uint256 spot = uint256(price8) * 1e10;
        // 4–9% out of the money: inside the mandate's 0.05–0.40 delta band for a four-day tenor at 60% vol.
        uint256 strike = isCall ? spot * bound(strikeSeed, 104, 109) / 100 : spot * bound(strikeSeed, 91, 96) / 100;
        uint64 expiry = uint64(calendar.weeklyExpiry(block.timestamp));
        (,,, uint256 capacity) = manager.previewProposal(address(vault), strike, expiry, 1, 10_000);
        uint256 size = bound(sizeSeed, 1, capacity == 0 ? 1 : capacity);
        uint16 bps = uint16(bound(bpsSeed, 9500, 20_000));
        vm.prank(agent);
        (bool ok, uint256 id) = manager.proposeSeries(address(vault), strike, expiry, size, bps);
        if (ok) {
            seriesIds.push(id);
            ++counts["propose"];
        }
    }

    /// An at-the-money proposal: always outside the delta band, always slashed.
    function recklessPropose() external {
        ++calls;
        (EpochManager.EpochState state,) = _state();
        if (state != EpochManager.EpochState.Open) return;
        _refreshPrice();
        uint64 expiry = uint64(calendar.weeklyExpiry(block.timestamp));
        uint256 spot = uint256(price8) * 1e10;
        vm.prank(agent);
        try manager.proposeSeries(address(vault), isCall ? spot + spot / 100 : spot - spot / 100, expiry, 1, 10_000) {
            ++counts["reckless"];
        } catch {}
    }

    /// Nobody proposed in time: anyone aborts after the timeout.
    function abort() external {
        ++calls;
        (EpochManager.EpochState state,) = _state();
        if (state != EpochManager.EpochState.Open) return;
        vm.warp(block.timestamp + 1 days);
        manager.abortEpoch(address(vault));
        ++counts["abort"];
    }

    function buy(uint256 amountSeed, uint256 moveSeed) external {
        ++calls;
        (EpochManager.EpochState state, uint256 id) = _state();
        if (state != EpochManager.EpochState.Selling) return;
        EpochManager.Series memory s = manager.getSeries(id);
        if (s.sold >= s.size) return;
        // Spot drifts ±3% between purchases.
        price8 = price8 * int256(bound(moveSeed, 97, 103)) / 100;
        _refreshPrice();
        uint256 amount = bound(amountSeed, 1, s.size - s.sold);
        try manager.quoteBuy(id, amount) returns (uint256 premium, uint256) {
            usdg.mint(buyer, premium);
            vm.startPrank(buyer);
            usdg.approve(address(manager), premium);
            try manager.buy(id, amount, premium, buyer) {
                ++counts["buy"];
            } catch {}
            vm.stopPrank();
        } catch {}
    }

    /// Warp past expiry, publish the settlement print (up to ±40% from the last spot) and settle.
    function settle(uint256 moveSeed) external {
        ++calls;
        (EpochManager.EpochState state, uint256 id) = _state();
        if (state != EpochManager.EpochState.Selling) return;
        EpochManager.Series memory s = manager.getSeries(id);
        vm.warp(s.expiry + 60);
        price8 = price8 * int256(bound(moveSeed, 60, 140)) / 100;
        if (price8 < 1e8) price8 = 1e8;
        uint80 round = feed.set(price8);
        manager.settle(address(vault), round);
        recordedSettlement[id] = manager.getSeries(id).settlementPrice;
        ++counts["settle"];
    }

    function redeemOptions(uint256 seriesSeed, uint256 fraction) external {
        ++calls;
        if (seriesIds.length == 0) return;
        uint256 id = seriesIds[seriesSeed % seriesIds.length];
        EpochManager.Series memory s = manager.getSeries(id);
        if (!s.settled && !s.cancelled) return;
        uint256 bal = manager.optionToken().balanceOf(buyer, id);
        uint256 amount = bal * bound(fraction, 1, 100) / 100;
        if (amount == 0) return;
        vm.prank(buyer);
        try manager.redeem(id, amount, buyer) {
            ++counts["redeemOptions"];
        } catch {
            redeemFailed = true;
        }
    }
}
