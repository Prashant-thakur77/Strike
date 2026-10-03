// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {PendleCollateralAdapter} from "../../src/yield/PendleCollateralAdapter.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {
    MockPT,
    MockPendleMarket,
    MockPendleOracle,
    MockPendleRouter,
    MockReserve,
    MockSY
} from "../mocks/MockPendle.sol";
import {Test} from "forge-std/Test.sol";

/// @notice PendleCollateralAdapter against Pendle stand-ins: every rule, role, error and view. The real router,
///         market and oracle on Robinhood Chain mainnet are in test/fork/PendleCollateralFork.t.sol.
contract PendleCollateralAdapterTest is Test {
    uint256 internal constant START = 1_791_046_890; // 2026-10-03, the fork block's time
    uint256 internal constant MATURITY = 1_805_932_800; // 2027-03-25 00:00 UTC, the real PT-USDG's expiry
    uint256 internal constant UNIT = 1e6;

    address internal vault = makeAddr("vault");
    address internal curator = makeAddr("curator");
    address internal agent = makeAddr("agent");
    address internal stranger = makeAddr("stranger");

    MockERC20 internal usdg;
    MockPT internal pt;
    MockSY internal sy;
    MockPendleMarket internal market;
    MockPendleOracle internal oracle;
    MockPendleRouter internal router;
    MockReserve internal reserve;
    PendleCollateralAdapter internal adapter;

    function setUp() public {
        vm.warp(START);
        usdg = new MockERC20("Global Dollar", "USDG", 6);
        pt = new MockPT(6);
        sy = new MockSY(address(usdg));
        market = new MockPendleMarket(address(sy), address(pt), makeAddr("yt"), MATURITY);
        oracle = new MockPendleOracle();
        router = new MockPendleRouter(usdg, pt, market);
        reserve = new MockReserve();
        reserve.set(6000, 0); // the mandate lets a series lock 60% of the collateral
        adapter = new PendleCollateralAdapter(_config());

        vm.startPrank(curator);
        adapter.setLimits(50_000 * UNIT, 500, 100); // cap 50k, 5% buffer, 1% slippage
        adapter.setEnabled(true);
        vm.stopPrank();
        _deposit(100_000 * UNIT);
    }

    function _config() internal view returns (PendleCollateralAdapter.Config memory) {
        return PendleCollateralAdapter.Config({
            usdg: address(usdg),
            router: address(router),
            oracle: address(oracle),
            market: address(market),
            owner: vault,
            curator: curator,
            allocator: agent,
            reserve: address(reserve),
            twapDuration: 900,
            maxTimeToMaturity: 365 days,
            hardCap: 1_000_000 * UNIT
        });
    }

    function _deposit(uint256 amount) internal {
        usdg.mint(vault, amount);
        vm.startPrank(vault);
        usdg.approve(address(adapter), amount);
        adapter.deposit(amount);
        vm.stopPrank();
    }

    /// The tightest minimum the adapter accepts for a buy of `usdgIn`.
    function _minPt(uint256 usdgIn) internal view returns (uint256) {
        return usdgIn * 1e18 / adapter.ptRate() * (10_000 - adapter.maxSlippageBps()) / 10_000;
    }

    function _allocate(uint256 usdgIn) internal returns (uint256) {
        uint256 minOut = _minPt(usdgIn);
        vm.prank(agent);
        return adapter.allocate(usdgIn, minOut);
    }

    // ------------------------------------------------------------------ constructor

    function test_constructor_setsEverything() public {
        assertEq(address(adapter.usdg()), address(usdg));
        assertEq(address(adapter.router()), address(router));
        assertEq(address(adapter.oracle()), address(oracle));
        assertEq(adapter.market(), address(market));
        assertEq(address(adapter.pt()), address(pt));
        assertEq(adapter.yt(), makeAddr("yt"));
        assertEq(adapter.maturity(), MATURITY);
        assertEq(adapter.owner(), vault);
        assertEq(adapter.curator(), curator);
        assertEq(adapter.allocator(), agent);
        assertEq(address(adapter.reserve()), address(reserve));
        assertEq(adapter.twapDuration(), 900);
        assertEq(adapter.maxTimeToMaturity(), 365 days);
        assertEq(adapter.hardCap(), 1_000_000 * UNIT);
    }

    function test_constructor_startsDisabledWithNoCap() public {
        PendleCollateralAdapter fresh = new PendleCollateralAdapter(_config());
        assertFalse(fresh.enabled());
        assertEq(fresh.cap(), 0);
        assertEq(fresh.bufferBps(), 0);
        assertEq(fresh.maxSlippageBps(), 100);
    }

    function test_constructor_revertsOnZeroAddress() public {
        for (uint256 i; i < 7; ++i) {
            PendleCollateralAdapter.Config memory c = _config();
            if (i == 0) c.usdg = address(0);
            if (i == 1) c.router = address(0);
            if (i == 2) c.oracle = address(0);
            if (i == 3) c.market = address(0);
            if (i == 4) c.owner = address(0);
            if (i == 5) c.curator = address(0);
            if (i == 6) c.reserve = address(0);
            vm.expectRevert(PendleCollateralAdapter.ZeroAddress.selector);
            new PendleCollateralAdapter(c);
        }
    }

    function test_constructor_revertsOnShortTwap() public {
        PendleCollateralAdapter.Config memory c = _config();
        c.twapDuration = 899;
        vm.expectRevert(abi.encodeWithSelector(PendleCollateralAdapter.TwapTooShort.selector, uint32(899)));
        new PendleCollateralAdapter(c);
    }

    function test_constructor_revertsWhenTheSyIsNotUsdg() public {
        MockERC20 other = new MockERC20("Other", "OTH", 6);
        MockSY otherSy = new MockSY(address(other));
        PendleCollateralAdapter.Config memory c = _config();
        c.market = address(new MockPendleMarket(address(otherSy), address(pt), address(1), MATURITY));
        vm.expectRevert(
            abi.encodeWithSelector(PendleCollateralAdapter.WrongAsset.selector, address(other), address(usdg))
        );
        new PendleCollateralAdapter(c);
    }

    function test_constructor_revertsOnDecimalsMismatch() public {
        MockPT pt18 = new MockPT(18);
        PendleCollateralAdapter.Config memory c = _config();
        c.market = address(new MockPendleMarket(address(sy), address(pt18), address(1), MATURITY));
        vm.expectRevert(abi.encodeWithSelector(PendleCollateralAdapter.DecimalsMismatch.selector, 18, 6));
        new PendleCollateralAdapter(c);
    }

    // ------------------------------------------------------------------ deposit / withdraw

    function test_deposit_pullsUsdgFromTheVault() public {
        usdg.mint(vault, 7 * UNIT);
        vm.startPrank(vault);
        usdg.approve(address(adapter), 7 * UNIT);
        vm.expectEmit(address(adapter));
        emit PendleCollateralAdapter.Deposited(7 * UNIT);
        adapter.deposit(7 * UNIT);
        vm.stopPrank();
        assertEq(adapter.liquidAssets(), 100_007 * UNIT);
    }

    function test_deposit_onlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(PendleCollateralAdapter.Unauthorized.selector, stranger));
        adapter.deposit(1);
    }

    function test_deposit_revertsOnZero() public {
        vm.prank(vault);
        vm.expectRevert(PendleCollateralAdapter.ZeroAmount.selector);
        adapter.deposit(0);
    }

    function test_withdraw_paysLiquidUsdg() public {
        vm.expectEmit(address(adapter));
        emit PendleCollateralAdapter.Withdrawn(stranger, 10 * UNIT);
        vm.prank(vault);
        adapter.withdraw(10 * UNIT, stranger);
        assertEq(usdg.balanceOf(stranger), 10 * UNIT);
    }

    function test_withdraw_worksWhileDisabled() public {
        vm.prank(curator);
        adapter.setEnabled(false);
        vm.prank(vault);
        adapter.withdraw(100_000 * UNIT, vault);
        assertEq(adapter.totalAssets(), 0);
    }

    function test_withdraw_onlyOwner() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PendleCollateralAdapter.Unauthorized.selector, agent));
        adapter.withdraw(1, agent);
    }

    function test_withdraw_revertsOnZeroAmountOrReceiver() public {
        vm.startPrank(vault);
        vm.expectRevert(PendleCollateralAdapter.ZeroAmount.selector);
        adapter.withdraw(0, vault);
        vm.expectRevert(PendleCollateralAdapter.ZeroAddress.selector);
        adapter.withdraw(1, address(0));
        vm.stopPrank();
    }

    function test_withdraw_revertsAboveLiquid() public {
        _allocate(30_000 * UNIT);
        vm.prank(vault);
        vm.expectRevert(
            abi.encodeWithSelector(PendleCollateralAdapter.InsufficientLiquid.selector, 80_000 * UNIT, 70_000 * UNIT)
        );
        adapter.withdraw(80_000 * UNIT, vault);
    }

    // ------------------------------------------------------------------ allocate

    function test_allocate_buysPtAndKeepsTheReserve() public {
        uint256 minOut = _minPt(30_000 * UNIT);
        uint256 expected = 30_000 * UNIT * 1e18 / 0.985e18 * 9980 / 10_000;
        vm.expectEmit(address(adapter));
        emit PendleCollateralAdapter.Allocated(agent, 30_000 * UNIT, expected, 0.985e18);
        vm.prank(agent);
        uint256 out = adapter.allocate(30_000 * UNIT, minOut);
        assertEq(out, expected);
        assertEq(adapter.ptBalance(), expected);
        assertEq(adapter.liquidAssets(), 70_000 * UNIT);
        assertGe(adapter.liquidAssets(), adapter.requiredLiquidity());
        // 20 bps of price impact, marked at the oracle.
        assertApproxEqAbs(adapter.totalAssets(), 99_940 * UNIT, UNIT);
    }

    function test_allocate_revertsWhenDisabled() public {
        vm.prank(curator);
        adapter.setEnabled(false);
        vm.prank(agent);
        vm.expectRevert(PendleCollateralAdapter.Disabled.selector);
        adapter.allocate(1 * UNIT, 0);
    }

    function test_allocate_onlyAllocator() public {
        for (uint256 i; i < 3; ++i) {
            address who = i == 0 ? vault : i == 1 ? curator : stranger;
            vm.prank(who);
            vm.expectRevert(abi.encodeWithSelector(PendleCollateralAdapter.Unauthorized.selector, who));
            adapter.allocate(1 * UNIT, 0);
        }
    }

    function test_allocate_revertsOnZero() public {
        vm.prank(agent);
        vm.expectRevert(PendleCollateralAdapter.ZeroAmount.selector);
        adapter.allocate(0, 0);
    }

    function test_allocate_revertsAtOrAfterMaturity() public {
        vm.warp(MATURITY);
        vm.prank(agent);
        vm.expectRevert(PendleCollateralAdapter.MarketExpired.selector);
        adapter.allocate(1 * UNIT, 0);
    }

    function test_allocate_revertsWhenMaturityIsTooFar() public {
        PendleCollateralAdapter.Config memory c = _config();
        c.maxTimeToMaturity = 28 days; // four weekly epochs
        PendleCollateralAdapter short = new PendleCollateralAdapter(c);
        vm.startPrank(curator);
        short.setLimits(1000 * UNIT, 0, 100);
        short.setEnabled(true);
        vm.stopPrank();
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(PendleCollateralAdapter.MaturityTooFar.selector, MATURITY - START, 28 days)
        );
        short.allocate(1 * UNIT, 0);
        // Four weeks before maturity the same adapter may buy.
        vm.warp(MATURITY - 28 days);
        usdg.mint(vault, 10_000 * UNIT);
        vm.startPrank(vault);
        usdg.approve(address(short), 10_000 * UNIT);
        short.deposit(10_000 * UNIT);
        vm.stopPrank();
        uint256 minOut = _minPt(1000 * UNIT);
        vm.prank(agent);
        assertGt(short.allocate(1000 * UNIT, minOut), 0);
    }

    function test_allocate_revertsWhenTheOracleNeedsMoreObservations() public {
        oracle.set(0.985e18, true, true);
        vm.prank(agent);
        vm.expectRevert(PendleCollateralAdapter.OracleNotReady.selector);
        adapter.allocate(1 * UNIT, 0);
    }

    function test_allocate_revertsWhenTheOldestObservationIsTooRecent() public {
        oracle.set(0.985e18, false, false);
        vm.prank(agent);
        vm.expectRevert(PendleCollateralAdapter.OracleNotReady.selector);
        adapter.allocate(1 * UNIT, 0);
    }

    function test_allocate_revertsOnALooseMinimum() public {
        uint256 floor = _minPt(1000 * UNIT);
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(PendleCollateralAdapter.SlippageBoundTooLoose.selector, floor - 1, floor)
        );
        adapter.allocate(1000 * UNIT, floor - 1);
    }

    function test_allocate_revertsWhenTheMarketPaysBelowTheMinimum() public {
        // The market trades 2% below the oracle: the router's own check stops the buy.
        router.set(0.985e18 * 102 / 100, 0, false);
        uint256 minOut = _minPt(1000 * UNIT);
        vm.prank(agent);
        vm.expectRevert(bytes("Slippage: INSUFFICIENT_PT_OUT"));
        adapter.allocate(1000 * UNIT, minOut);
    }

    function test_allocate_checksTheOutputItself() public {
        // A router that ignores the minimum is caught by the adapter's balance check.
        router.set(0.985e18 * 102 / 100, 0, true);
        uint256 minOut = _minPt(1000 * UNIT);
        uint256 got = 1000 * UNIT * 1e18 / (0.985e18 * 102 / 100);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PendleCollateralAdapter.OutputTooLow.selector, got, minOut));
        adapter.allocate(1000 * UNIT, minOut);
    }

    function test_allocate_revertsAboveTheCap() public {
        vm.prank(curator);
        adapter.setLimits(10_000 * UNIT, 500, 100);
        uint256 minOut = _minPt(10_100 * UNIT);
        vm.prank(agent);
        vm.expectPartialRevert(PendleCollateralAdapter.CapExceeded.selector);
        adapter.allocate(10_100 * UNIT, minOut);
    }

    function test_allocate_revertsWhenItWouldBreachTheReserve() public {
        // 60% reserve + 5% buffer: at most ~35k of 100k can go into PT.
        uint256 minOut = _minPt(36_000 * UNIT);
        vm.prank(agent);
        vm.expectPartialRevert(PendleCollateralAdapter.ReserveBreached.selector);
        adapter.allocate(36_000 * UNIT, minOut);
        _allocate(34_900 * UNIT);
    }

    function test_allocate_respectsALiveSeriesWorstCase() public {
        // A live series could lock 90k: only 100k - 90k - 5% buffer is free.
        reserve.set(0, 90_000 * UNIT);
        assertApproxEqAbs(adapter.allocatable(), 5000 * UNIT, UNIT);
        uint256 minOut = _minPt(5100 * UNIT);
        vm.prank(agent);
        vm.expectPartialRevert(PendleCollateralAdapter.ReserveBreached.selector);
        adapter.allocate(5100 * UNIT, minOut);
    }

    /// Whatever the amount and the reserve, an allocation either keeps liquid >= required or reverts.
    function testFuzz_allocate_neverLeavesTheReserveShort(uint256 usdgIn, uint256 shareBps, uint256 bufferBps) public {
        usdgIn = bound(usdgIn, 1, 120_000 * UNIT);
        shareBps = bound(shareBps, 0, 10_000);
        bufferBps = bound(bufferBps, 0, 2000);
        reserve.set(shareBps, 0);
        vm.prank(curator);
        adapter.setLimits(1_000_000 * UNIT, uint16(bufferBps), 100);
        uint256 free = adapter.allocatable();
        uint256 minOut = usdgIn * 1e18 / 0.985e18 * 9900 / 10_000;
        vm.prank(agent);
        try adapter.allocate(usdgIn, minOut) {
            // `allocatable` ignores the price impact, which lowers the reserve too, so a buy can pass it slightly.
            assertGe(adapter.liquidAssets(), adapter.requiredLiquidity(), "reserve breached");
        } catch {
            // Reverting is always allowed; above the free amount it is required.
            assertTrue(usdgIn > free || minOut == 0, "a fitting allocation reverted");
        }
        assertGe(adapter.totalAssets(), 100_000 * UNIT - usdgIn / 100 - 2, "lost more than the price impact");
    }

    // ------------------------------------------------------------------ deallocate / redeem

    function test_deallocate_sellsPtWithinTheBound() public {
        uint256 ptOut = _allocate(30_000 * UNIT);
        uint256 floor = ptOut * 0.985e18 / 1e18 * 9900 / 10_000;
        uint256 expected = ptOut * 0.985e18 / 1e18 * 9980 / 10_000;
        vm.expectEmit(address(adapter));
        emit PendleCollateralAdapter.Deallocated(agent, ptOut, expected, 0.985e18);
        vm.prank(agent);
        uint256 got = adapter.deallocate(ptOut, floor);
        assertEq(got, expected);
        assertEq(adapter.ptBalance(), 0);
        // The round trip costs the price impact twice.
        assertApproxEqAbs(adapter.liquidAssets(), 99_880 * UNIT, 2 * UNIT);
    }

    function test_deallocate_curatorIsBoundToo() public {
        uint256 ptOut = _allocate(1000 * UNIT);
        vm.prank(curator);
        vm.expectPartialRevert(PendleCollateralAdapter.SlippageBoundTooLoose.selector);
        adapter.deallocate(ptOut, 0);
    }

    function test_deallocate_ownerSetsItsOwnLimitWithoutTheOracle() public {
        uint256 ptOut = _allocate(1000 * UNIT);
        oracle.setBroken(true);
        oracle.set(0.985e18, true, false);
        vm.expectEmit(address(adapter));
        emit PendleCollateralAdapter.Deallocated(vault, ptOut, ptOut * 0.985e18 / 1e18 * 9980 / 10_000, 0);
        vm.prank(vault);
        adapter.deallocate(ptOut, 0);
        assertEq(adapter.ptBalance(), 0);
    }

    function test_deallocate_onlyOwnerAllocatorOrCurator() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(PendleCollateralAdapter.Unauthorized.selector, stranger));
        adapter.deallocate(1, 0);
    }

    function test_deallocate_revertsOnZero() public {
        vm.prank(agent);
        vm.expectRevert(PendleCollateralAdapter.ZeroAmount.selector);
        adapter.deallocate(0, 0);
    }

    function test_deallocate_revertsWhenTheOracleIsNotReady() public {
        uint256 ptOut = _allocate(1000 * UNIT);
        oracle.set(0.985e18, true, true);
        vm.prank(agent);
        vm.expectRevert(PendleCollateralAdapter.OracleNotReady.selector);
        adapter.deallocate(ptOut, ptOut);
    }

    function test_deallocate_checksTheOutputItself() public {
        uint256 ptOut = _allocate(1000 * UNIT);
        router.set(0.985e18 * 98 / 100, 0, true);
        uint256 floor = ptOut * 0.985e18 / 1e18 * 9900 / 10_000;
        vm.prank(agent);
        vm.expectPartialRevert(PendleCollateralAdapter.OutputTooLow.selector);
        adapter.deallocate(ptOut, floor);
    }

    function test_deallocate_redeemsAtParAfterMaturity() public {
        uint256 ptOut = _allocate(1000 * UNIT);
        vm.warp(MATURITY);
        vm.expectEmit(address(adapter));
        emit PendleCollateralAdapter.Redeemed(ptOut, ptOut);
        vm.prank(agent);
        assertEq(adapter.deallocate(ptOut, ptOut), ptOut);
    }

    function test_redeemMatured_anyoneAfterMaturity() public {
        uint256 ptOut = _allocate(30_000 * UNIT);
        vm.warp(MATURITY + 1);
        assertEq(adapter.ptRate(), 1e18);
        assertEq(adapter.totalAssets(), 70_000 * UNIT + ptOut);
        vm.prank(stranger);
        assertEq(adapter.redeemMatured(), ptOut);
        assertEq(adapter.ptBalance(), 0);
        // Bought at a discount, redeemed at par: the fixed yield, less the entry's price impact.
        assertGt(adapter.liquidAssets(), 100_000 * UNIT + 380 * UNIT);
    }

    function test_redeemMatured_revertsBeforeMaturity() public {
        vm.expectRevert(PendleCollateralAdapter.MarketNotExpired.selector);
        adapter.redeemMatured();
    }

    function test_redeemMatured_revertsWithNoPt() public {
        vm.warp(MATURITY);
        vm.expectRevert(PendleCollateralAdapter.ZeroAmount.selector);
        adapter.redeemMatured();
    }

    function test_redeem_checksTheOutput() public {
        uint256 ptOut = _allocate(1000 * UNIT);
        vm.warp(MATURITY);
        router.set(0.985e18, 0, true); // pays half
        vm.prank(vault);
        vm.expectRevert(abi.encodeWithSelector(PendleCollateralAdapter.OutputTooLow.selector, ptOut / 2, ptOut));
        adapter.deallocate(ptOut, ptOut);
    }

    // ------------------------------------------------------------------ curator

    function test_setEnabled_onlyCurator() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PendleCollateralAdapter.Unauthorized.selector, agent));
        adapter.setEnabled(false);
        vm.expectEmit(address(adapter));
        emit PendleCollateralAdapter.EnabledSet(false);
        vm.prank(curator);
        adapter.setEnabled(false);
        assertFalse(adapter.enabled());
    }

    function test_setLimits_boundsAndEvent() public {
        vm.startPrank(curator);
        vm.expectRevert(PendleCollateralAdapter.LimitTooHigh.selector);
        adapter.setLimits(1_000_000 * UNIT + 1, 0, 0);
        vm.expectRevert(PendleCollateralAdapter.LimitTooHigh.selector);
        adapter.setLimits(0, 10_001, 0);
        vm.expectRevert(PendleCollateralAdapter.LimitTooHigh.selector);
        adapter.setLimits(0, 0, 301);
        vm.expectEmit(address(adapter));
        emit PendleCollateralAdapter.LimitsSet(1, 2, 300);
        adapter.setLimits(1, 2, 300);
        vm.stopPrank();
        assertEq(adapter.cap(), 1);
        assertEq(adapter.bufferBps(), 2);
        assertEq(adapter.maxSlippageBps(), 300);
    }

    function test_setLimits_onlyCurator() public {
        vm.prank(vault);
        vm.expectRevert(abi.encodeWithSelector(PendleCollateralAdapter.Unauthorized.selector, vault));
        adapter.setLimits(0, 0, 0);
    }

    function test_setAllocator_onlyCurator() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PendleCollateralAdapter.Unauthorized.selector, agent));
        adapter.setAllocator(agent);
        vm.expectEmit(address(adapter));
        emit PendleCollateralAdapter.AllocatorSet(stranger);
        vm.prank(curator);
        adapter.setAllocator(stranger);
        assertEq(adapter.allocator(), stranger);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PendleCollateralAdapter.Unauthorized.selector, agent));
        adapter.allocate(1 * UNIT, 0);
    }

    // ------------------------------------------------------------------ views

    function test_ptRate_neverAboveParAndParAtMaturity() public {
        oracle.set(1.02e18, false, true);
        assertEq(adapter.ptRate(), 1e18);
        oracle.set(0.97e18, false, true);
        assertEq(adapter.ptRate(), 0.97e18);
        vm.warp(MATURITY);
        assertEq(adapter.ptRate(), 1e18);
    }

    function test_ptValue_zeroWithoutPtEvenIfTheOracleFails() public {
        oracle.setBroken(true);
        assertEq(adapter.ptValue(), 0);
        assertEq(adapter.totalAssets(), 100_000 * UNIT);
    }

    function test_ptValue_marksAtTheOracle() public {
        uint256 ptOut = _allocate(10_000 * UNIT);
        oracle.set(0.95e18, false, true);
        assertEq(adapter.ptValue(), ptOut * 0.95e18 / 1e18);
    }

    function test_requiredLiquidity_isCappedAtTheCollateral() public {
        reserve.set(10_000, 1);
        assertEq(adapter.requiredLiquidity(), adapter.totalAssets());
    }

    function test_allocatable_branches() public {
        assertApproxEqAbs(adapter.allocatable(), 35_000 * UNIT, UNIT);
        vm.prank(curator);
        adapter.setLimits(20_000 * UNIT, 500, 100);
        assertEq(adapter.allocatable(), 20_000 * UNIT); // the cap binds
        _allocate(19_000 * UNIT);
        vm.prank(curator);
        adapter.setLimits(18_000 * UNIT, 500, 100); // the position is now above the cap
        assertEq(adapter.allocatable(), 0);
        reserve.set(10_000, 0); // the reserve binds
        assertEq(adapter.allocatable(), 0);
        vm.prank(curator);
        adapter.setEnabled(false);
        assertEq(adapter.allocatable(), 0);
        vm.prank(curator);
        adapter.setEnabled(true);
        vm.warp(MATURITY);
        assertEq(adapter.allocatable(), 0);
    }

    function test_shortfall_afterAWithdrawalOrAPriceFall() public {
        _allocate(34_000 * UNIT);
        assertEq(adapter.shortfall(), 0);
        // The vault pays a settlement out of the liquid USDG: now PT must be sold to restore the rule.
        vm.prank(vault);
        adapter.withdraw(20_000 * UNIT, vault);
        uint256 gap = adapter.shortfall();
        assertGt(gap, 0);
        assertEq(gap, adapter.requiredLiquidity() - adapter.liquidAssets());
    }

    function test_oracleReady_readsBothFlags() public {
        assertTrue(adapter.oracleReady());
        oracle.set(0.985e18, true, true);
        assertFalse(adapter.oracleReady());
        oracle.set(0.985e18, false, false);
        assertFalse(adapter.oracleReady());
    }
}
