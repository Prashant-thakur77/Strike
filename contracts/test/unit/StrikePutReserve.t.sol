// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {MandateGuard} from "../../src/libraries/MandateGuard.sol";
import {StrikeVault} from "../../src/vaults/StrikeVault.sol";
import {VaultFactory} from "../../src/vaults/VaultFactory.sol";
import {PendleCollateralAdapter} from "../../src/yield/PendleCollateralAdapter.sol";
import {StrikePutReserve} from "../../src/yield/StrikePutReserve.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockPT, MockPendleMarket, MockPendleOracle, MockPendleRouter, MockSY} from "../mocks/MockPendle.sol";
import {StrikeBase} from "../utils/StrikeBase.sol";

/// @notice StrikePutReserve against the real EpochManager and StrikeVault (StrikeBase's mock-token deployment): the
///         liquid USDG a put vault needs through a whole epoch, and the adapter held to it.
contract StrikePutReserveTest is StrikeBase {
    StrikeVault internal put60; // a put vault whose mandate sells at most 60% of capacity
    StrikePutReserve internal reserve;

    function setUp() public override {
        super.setUp();
        MandateGuard.Mandate memory m = _mandate();
        m.maxShareSoldBps = 6000;
        VaultFactory.CreateParams memory p = _params(false, 10_000_000 * USDG_UNIT);
        p.mandate = m;
        vm.prank(curator);
        put60 = StrikeVault(factory.createVault(p));
        reserve = new StrikePutReserve(manager, address(put60));
    }

    function _depositPut60(address who, uint256 amount) internal {
        usdg.mint(who, amount);
        vm.startPrank(who);
        usdg.approve(address(put60), amount);
        put60.deposit(amount, who);
        vm.stopPrank();
    }

    function test_constructor_readsTheMandate() public view {
        assertEq(address(reserve.manager()), address(manager));
        assertEq(reserve.vault(), address(put60));
        assertEq(reserve.maxShareSoldBps(), 6000);
    }

    function test_constructor_rejectsACallVault() public {
        vm.expectRevert(abi.encodeWithSelector(StrikePutReserve.NotAPutVault.selector, address(callVault)));
        new StrikePutReserve(manager, address(callVault));
    }

    function test_constructor_rejectsAnUnregisteredVault() public {
        // A put vault clone the EpochManager never registered.
        StrikeVault loose = StrikeVault(address(new LooseVault(address(usdg))));
        vm.expectRevert(abi.encodeWithSelector(StrikePutReserve.VaultNotRegistered.selector, address(loose)));
        new StrikePutReserve(manager, address(loose));
    }

    function test_constructor_rejectsAVaultInAnotherAsset() public {
        address other = address(new MockERC20("Other", "OTH", 6));
        LooseVault loose = new LooseVault(other);
        vm.expectRevert(abi.encodeWithSelector(StrikePutReserve.WrongAsset.selector, other, address(usdg)));
        new StrikePutReserve(manager, address(loose));
    }

    function test_requiredLiquidity_idleIsTheMandateShare() public view {
        assertEq(reserve.requiredLiquidity(100_000 * USDG_UNIT), 60_000 * USDG_UNIT);
        assertEq(reserve.requiredLiquidity(1), 1); // rounds up
        assertEq(reserve.requiredLiquidity(0), 0);
    }

    function test_requiredLiquidity_followsTheEpoch() public {
        _depositPut60(alice, 100_000 * USDG_UNIT);
        // Open: no series yet, the mandate share.
        vm.prank(agent);
        manager.openEpoch(address(put60));
        assertEq(reserve.requiredLiquidity(100_000 * USDG_UNIT), 60_000 * USDG_UNIT);

        // Selling: 200 puts at $230 could lock 46,000 USDG, under the 60% share.
        vm.prank(agent);
        (bool accepted, uint256 seriesId) =
            manager.proposeSeries(address(put60), 230 * WAD, FRIDAY_CLOSE, 200 * WAD, 10_000);
        assertTrue(accepted);
        assertEq(reserve.requiredLiquidity(100_000 * USDG_UNIT), 60_000 * USDG_UNIT);
        // With the collateral marked down to 70k, the live series' 46,000 binds instead of 60% of 70k (42,000).
        assertEq(reserve.requiredLiquidity(70_000 * USDG_UNIT), 46_000 * USDG_UNIT);

        // Buys lock collateral, never more than size x strike (plus a unit of rounding per buy).
        _buy(seriesId, 150 * WAD);
        assertEq(manager.getSeries(seriesId).collateral, 34_500 * USDG_UNIT);
        assertEq(reserve.requiredLiquidity(0), 46_000 * USDG_UNIT);

        // Settled: back to the share of what is left.
        uint80 roundId = _expireAt(240e8);
        manager.settle(address(put60), roundId);
        assertEq(reserve.requiredLiquidity(100_000 * USDG_UNIT), 60_000 * USDG_UNIT);
    }

    /// The adapter on top of the reserve: with a 60% mandate share and a 5% buffer, 35% of the collateral can earn.
    function test_adapterOnTheReserve_capsTheAllocationAtTheIdleShare() public {
        MockPT pt = new MockPT(6);
        MockPendleMarket market =
            new MockPendleMarket(address(new MockSY(address(usdg))), address(pt), address(1), MONDAY + 120 days);
        MockPendleRouter router = new MockPendleRouter(usdg, pt, market);
        MockPendleOracle oracle_ = new MockPendleOracle();
        address sleeveOwner = makeAddr("sleeveOwner");
        PendleCollateralAdapter adapter = new PendleCollateralAdapter(
            PendleCollateralAdapter.Config({
                usdg: address(usdg),
                router: address(router),
                oracle: address(oracle_),
                market: address(market),
                owner: sleeveOwner,
                curator: curator,
                allocator: agent,
                reserve: address(reserve),
                twapDuration: 900,
                maxTimeToMaturity: 180 days,
                hardCap: 1_000_000 * USDG_UNIT
            })
        );
        vm.startPrank(curator);
        adapter.setLimits(1_000_000 * USDG_UNIT, 500, 100);
        adapter.setEnabled(true);
        vm.stopPrank();
        usdg.mint(sleeveOwner, 100_000 * USDG_UNIT);
        vm.startPrank(sleeveOwner);
        usdg.approve(address(adapter), 100_000 * USDG_UNIT);
        adapter.deposit(100_000 * USDG_UNIT);
        vm.stopPrank();

        assertEq(adapter.allocatable(), 35_000 * USDG_UNIT);
        uint256 minOut = 35_100 * USDG_UNIT * 1e18 / 0.985e18 * 99 / 100;
        vm.prank(agent);
        vm.expectPartialRevert(PendleCollateralAdapter.ReserveBreached.selector);
        adapter.allocate(35_100 * USDG_UNIT, minOut);
        minOut = 34_000 * USDG_UNIT * 1e18 / 0.985e18 * 99 / 100;
        vm.prank(agent);
        adapter.allocate(34_000 * USDG_UNIT, minOut);
        assertGe(adapter.liquidAssets(), adapter.requiredLiquidity());
    }
}

/// @notice Answers the reserve's constructor checks like a put vault that was never registered.
contract LooseVault {
    address public asset;

    constructor(address asset_) {
        asset = asset_;
    }

    function isCall() external pure returns (bool) {
        return false;
    }
}
