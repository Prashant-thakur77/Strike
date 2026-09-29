// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {StockCollateral} from "../../examples/StockCollateral.sol";
import {IAggregatorV3} from "../../src/interfaces/IAggregatorV3.sol";
import {SafeStockFeed} from "../../src/libraries/SafeStockFeed.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockStockToken, MockStockTokenNoOraclePause} from "../mocks/MockStockToken.sol";
import {Test} from "forge-std/Test.sol";

/// @notice The SafeStockFeed example consumer (examples/StockCollateral.sol) against the repo's mocks.
contract StockCollateralTest is Test {
    uint256 internal constant MONDAY = 1_791_208_800; // 2026-10-05 14:00 UTC
    uint32 internal constant MAX_AGE = 1 hours;
    uint32 internal constant GRACE = 1 days;
    uint256 internal constant LTV = 5000;

    MockStockToken internal nvda;
    MockAggregator internal feed;
    StockCollateral internal market;
    address internal alice = makeAddr("alice");

    function setUp() public {
        vm.warp(MONDAY);
        nvda = new MockStockToken("NVIDIA", "NVDA");
        feed = new MockAggregator(8);
        feed.set(180e8);
        market = _market(address(nvda), IAggregatorV3(address(0)));
        nvda.mint(alice, 100e18);
        vm.startPrank(alice);
        nvda.approve(address(market), type(uint256).max);
        market.deposit(10e18);
        vm.stopPrank();
    }

    function _market(address token, IAggregatorV3 sequencer) internal returns (StockCollateral) {
        return new StockCollateral(token, feed, MAX_AGE, GRACE, LTV, sequencer, 1 hours);
    }

    // ------------------------------------------------------------------ valuation

    function test_valuesRawBalanceAtFeedPrice() public view {
        assertEq(market.price(), 180e18);
        assertEq(market.collateralValue(alice), 1800e18);
        assertEq(market.borrowLimit(alice), 900e18);
        assertEq(market.sharePrice(), 180e18); // multiplier 1.0
        assertEq(nvda.balanceOf(address(market)), 10e18);
    }

    /// A 2-for-1 split: raw balances stay, the multiplier doubles and the feed (per raw token) keeps pricing the
    /// raw token. The collateral value must not move; only the per-share display halves.
    function test_splitDoesNotDoubleTheValue() public {
        nvda.scheduleMultiplier(2e18, block.timestamp);
        nvda.applyMultiplier();
        vm.warp(block.timestamp + GRACE);
        feed.set(180e8);

        uint256 value = market.collateralValue(alice);
        assertEq(value, 1800e18, "raw x feed");
        assertEq(market.sharePrice(), 90e18, "feed / multiplier");
        // The wallet's view gives the same total: UI balance x UI share price.
        uint256 uiBalance = nvda.balanceOfUI(address(market)); // alice's 10 raw tokens show as 20 shares
        assertEq(uiBalance, 20e18);
        assertEq(uiBalance * market.sharePrice() / 1e18, value);
        // The bug the library prevents: multiplying the feed by the multiplier doubles the collateral.
        assertEq(10e18 * (market.price() * nvda.uiMultiplier() / 1e18) / 1e18, 2 * value);
    }

    function testFuzz_valueIgnoresMultiplier(uint256 raw, uint256 multiplier, int256 answer) public {
        raw = bound(raw, 0, 1e30);
        multiplier = bound(multiplier, 1e16, 100e18);
        answer = bound(answer, 1, 1e14);
        nvda.scheduleMultiplier(multiplier, block.timestamp);
        nvda.applyMultiplier();
        vm.warp(block.timestamp + GRACE);
        feed.set(answer);
        address bob = makeAddr("bob");
        nvda.mint(bob, raw);
        vm.startPrank(bob);
        nvda.approve(address(market), raw);
        market.deposit(raw);
        vm.stopPrank();

        uint256 priceWad = uint256(answer) * 1e10;
        assertEq(market.collateralValue(bob), raw * priceWad / 1e18);
        assertEq(market.sharePrice(), priceWad * 1e18 / multiplier);
        assertEq(market.uiMultiplier(), multiplier);
    }

    function test_plainErc20HasMultiplierOne() public {
        MockERC20 plain = new MockERC20("Plain", "PLN", 18);
        StockCollateral m = _market(address(plain), IAggregatorV3(address(0)));
        assertEq(m.uiMultiplier(), 1e18);
        assertEq(m.sharePrice(), 180e18);
    }

    function test_testnetTokenWithoutOraclePause() public {
        MockStockTokenNoOraclePause t = new MockStockTokenNoOraclePause();
        StockCollateral m = _market(address(t), IAggregatorV3(address(0)));
        assertEq(m.price(), 180e18);
    }

    function test_zeroMultiplierReadsAsOne() public {
        nvda.scheduleMultiplier(0, block.timestamp);
        nvda.applyMultiplier();
        vm.warp(block.timestamp + GRACE);
        feed.set(180e8);
        assertEq(market.uiMultiplier(), 1e18);
    }

    // ------------------------------------------------------------------ reverts with the library's errors

    function test_revert_tokenPaused() public {
        nvda.setTokenPaused(true);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.TokenPaused.selector, address(nvda)));
        market.collateralValue(alice);
    }

    function test_revert_feedPaused() public {
        nvda.setOraclePaused(true);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.FeedPaused.selector, address(nvda)));
        market.collateralValue(alice);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.FeedPaused.selector, address(nvda)));
        market.sharePrice();
    }

    function test_revert_stalePrice() public {
        vm.warp(MONDAY + MAX_AGE + 1);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.StalePrice.selector, MONDAY, MAX_AGE));
        market.borrowLimit(alice);
    }

    function test_revert_invalidPrice() public {
        feed.set(0);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.InvalidPrice.selector, int256(0)));
        market.collateralValue(alice);
    }

    /// Scheduled but not yet effective, then inside the grace after it applies, then fine.
    function test_revert_corporateActionPending() public {
        uint256 at = block.timestamp + 2 days;
        nvda.scheduleMultiplier(2e18, at);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.CorporateActionPending.selector, address(nvda), at));
        market.collateralValue(alice);

        vm.warp(at);
        nvda.applyMultiplier();
        feed.set(180e8);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.CorporateActionPending.selector, address(nvda), at));
        market.sharePrice();

        vm.warp(at + GRACE);
        feed.set(180e8);
        assertEq(market.collateralValue(alice), 1800e18);
        assertEq(market.sharePrice(), 90e18);
    }

    function test_revert_sequencerDownAndGrace() public {
        MockAggregator seq = new MockAggregator(0);
        seq.set(1); // 1 = down
        StockCollateral m = _market(address(nvda), IAggregatorV3(address(seq)));
        vm.expectRevert(SafeStockFeed.SequencerDown.selector);
        m.price();

        seq.set(0); // back up just now
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.SequencerGracePeriod.selector, block.timestamp));
        m.price();

        vm.warp(block.timestamp + 1 hours);
        feed.set(180e8);
        assertEq(m.price(), 180e18);
    }

    // ------------------------------------------------------------------ deposits

    function test_withdraw() public {
        vm.prank(alice);
        market.withdraw(4e18);
        assertEq(market.collateralOf(alice), 6e18);
        assertEq(nvda.balanceOf(alice), 94e18);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StockCollateral.InsufficientCollateral.selector, 7e18, 6e18));
        market.withdraw(7e18);
    }

    function test_revert_constructor() public {
        vm.expectRevert(StockCollateral.ZeroAddress.selector);
        new StockCollateral(address(0), feed, MAX_AGE, GRACE, LTV, IAggregatorV3(address(0)), 0);
        vm.expectRevert(StockCollateral.ZeroAddress.selector);
        new StockCollateral(address(nvda), IAggregatorV3(address(0)), MAX_AGE, GRACE, LTV, IAggregatorV3(address(0)), 0);
        vm.expectRevert(abi.encodeWithSelector(StockCollateral.LtvTooHigh.selector, 10_000));
        new StockCollateral(address(nvda), feed, MAX_AGE, GRACE, 10_000, IAggregatorV3(address(0)), 0);
    }
}
