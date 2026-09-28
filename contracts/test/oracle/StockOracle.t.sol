// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SafeStockFeed} from "../../src/libraries/SafeStockFeed.sol";
import {MarketCalendar} from "../../src/oracle/MarketCalendar.sol";
import {StockOracle} from "../../src/oracle/StockOracle.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";
import {MockStockToken, MockStockTokenNoOraclePause} from "../mocks/MockStockToken.sol";
import {Test} from "forge-std/Test.sol";

contract StockOracleTest is Test {
    uint256 internal constant MONDAY = 1_791_208_800; // 2026-10-05 14:00 UTC
    uint64 internal constant FRIDAY_CLOSE = 1_791_576_000; // 2026-10-09 20:00 UTC
    uint32 internal constant MAX_AGE = 1 hours;
    uint32 internal constant GRACE = 1 days;

    address internal admin = makeAddr("admin");
    MarketCalendar internal calendar;
    StockOracle internal oracle;
    MockStockToken internal tsla;
    MockAggregator internal feed;

    function setUp() public {
        vm.warp(MONDAY);
        calendar = new MarketCalendar(admin, new uint256[](0), new uint256[](0));
        oracle = new StockOracle(admin, calendar);
        tsla = new MockStockToken("Tesla", "TSLA");
        feed = new MockAggregator(8);
        feed.set(250e8);
        vm.prank(admin);
        oracle.setFeed(address(tsla), feed, MAX_AGE, GRACE);
    }

    // ------------------------------------------------------------------ latestPrice

    function test_latestPrice_normalisesDecimals() public view {
        (uint256 price, uint256 updatedAt) = oracle.latestPrice(address(tsla));
        assertEq(price, 250e18);
        assertEq(updatedAt, MONDAY);
    }

    function testFuzz_staleness(uint256 age) public {
        age = bound(age, 0, 10 days);
        vm.warp(MONDAY + age);
        if (age > MAX_AGE) {
            vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.StalePrice.selector, MONDAY, MAX_AGE));
        }
        oracle.latestPrice(address(tsla));
    }

    function test_revert_invalidPrice() public {
        feed.set(0);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.InvalidPrice.selector, int256(0)));
        oracle.latestPrice(address(tsla));
        feed.set(-1);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.InvalidPrice.selector, int256(-1)));
        oracle.latestPrice(address(tsla));
        feed.push(250e8, block.timestamp + 1); // from the future
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.InvalidPrice.selector, int256(250e8)));
        oracle.latestPrice(address(tsla));
    }

    function test_revert_tokenPaused() public {
        tsla.setTokenPaused(true);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.TokenPaused.selector, address(tsla)));
        oracle.latestPrice(address(tsla));
    }

    function test_revert_feedPaused() public {
        tsla.setOraclePaused(true);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.FeedPaused.selector, address(tsla)));
        oracle.latestPrice(address(tsla));
    }

    function test_testnetTokenWithoutOraclePauseStillWorks() public {
        MockStockTokenNoOraclePause t = new MockStockTokenNoOraclePause();
        vm.prank(admin);
        oracle.setFeed(address(t), feed, MAX_AGE, GRACE);
        (uint256 price,) = oracle.latestPrice(address(t));
        assertEq(price, 250e18);
    }

    function test_revert_unsupported() public {
        vm.expectRevert(abi.encodeWithSelector(StockOracle.Unsupported.selector, address(1)));
        oracle.latestPrice(address(1));
    }

    // ------------------------------------------------------------------ corporate actions (ERC-8056)

    function test_corporateAction_blocksFromAnnouncementUntilGraceAfterEffect() public {
        uint256 effective = MONDAY + 2 days;
        tsla.scheduleMultiplier(4e18, effective); // 4:1 split
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.CorporateActionPending.selector, address(tsla), effective));
        oracle.latestPrice(address(tsla));

        vm.warp(effective);
        tsla.applyMultiplier();
        feed.set(250e8);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.CorporateActionPending.selector, address(tsla), effective));
        oracle.latestPrice(address(tsla));

        vm.warp(effective + GRACE);
        feed.set(250e8);
        (uint256 price,) = oracle.latestPrice(address(tsla));
        assertEq(price, 250e18);
    }

    /// The feed already prices one raw token including the multiplier: the oracle must return it unchanged
    /// (never price × uiMultiplier), and value = raw balance × price = UI balance × per-share price.
    function test_multiplierIsNeverAppliedToFeedPrice() public {
        tsla.scheduleMultiplier(1.05e18, MONDAY); // a 5% stock dividend, already effective
        tsla.applyMultiplier();
        vm.warp(MONDAY + GRACE);
        feed.set(262.5e8); // $250/share × 1.05 shares per raw token
        (uint256 price,) = oracle.latestPrice(address(tsla));
        assertEq(price, 262.5e18);

        tsla.mint(address(this), 10e18);
        uint256 rawValue = tsla.balanceOf(address(this)) * price / 1e18;
        uint256 uiValue = tsla.balanceOfUI(address(this)) * 250e18 / 1e18;
        assertEq(rawValue, uiValue);
    }

    // ------------------------------------------------------------------ status (non-reverting)

    function test_status() public {
        (SafeStockFeed.Status s, uint256 p,) = oracle.status(address(tsla));
        assertEq(uint8(s), uint8(SafeStockFeed.Status.Ok));
        assertEq(p, 250e18);

        vm.warp(MONDAY + MAX_AGE + 1);
        (s,,) = oracle.status(address(tsla));
        assertEq(uint8(s), uint8(SafeStockFeed.Status.StalePrice));

        feed.set(0);
        (s,,) = oracle.status(address(tsla));
        assertEq(uint8(s), uint8(SafeStockFeed.Status.InvalidPrice));

        tsla.scheduleMultiplier(2e18, block.timestamp + 1 days);
        (s,,) = oracle.status(address(tsla));
        assertEq(uint8(s), uint8(SafeStockFeed.Status.CorporateActionPending));

        tsla.setOraclePaused(true);
        (s,,) = oracle.status(address(tsla));
        assertEq(uint8(s), uint8(SafeStockFeed.Status.FeedPaused));

        tsla.setTokenPaused(true);
        (s,,) = oracle.status(address(tsla));
        assertEq(uint8(s), uint8(SafeStockFeed.Status.TokenPaused));
    }

    // ------------------------------------------------------------------ settlement price

    function test_recordSettlementPrice_firstRoundAfterExpiry() public {
        feed.push(251e8, FRIDAY_CLOSE - 10);
        uint80 first = feed.push(260e8, FRIDAY_CLOSE + 5);
        uint80 second = feed.push(270e8, FRIDAY_CLOSE + 500);
        vm.warp(FRIDAY_CLOSE + 1000);

        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.InvalidSettlementRound.selector, second));
        oracle.recordSettlementPrice(address(tsla), FRIDAY_CLOSE, second);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.InvalidSettlementRound.selector, first - 1));
        oracle.recordSettlementPrice(address(tsla), FRIDAY_CLOSE, first - 1);

        vm.expectEmit(true, true, false, true, address(oracle));
        emit StockOracle.SettlementPriceRecorded(address(tsla), FRIDAY_CLOSE, first, 260e18);
        assertEq(oracle.recordSettlementPrice(address(tsla), FRIDAY_CLOSE, first), 260e18);
        // Idempotent: the recorded price never changes, whatever round is passed later.
        assertEq(oracle.recordSettlementPrice(address(tsla), FRIDAY_CLOSE, second), 260e18);
        assertEq(oracle.settlementPrice(address(tsla), FRIDAY_CLOSE), 260e18);
    }

    function test_recordSettlementPrice_waitsOverWeekend() public {
        // Nothing prints after the close until Monday: settlement uses Monday's first print.
        vm.warp(FRIDAY_CLOSE + 2 days);
        uint80 next = feed.currentRoundId() + 1;
        vm.expectRevert(MockAggregator.NoDataPresent.selector);
        oracle.recordSettlementPrice(address(tsla), FRIDAY_CLOSE, next);
        vm.warp(FRIDAY_CLOSE + 3 days - 6 hours);
        uint80 monday = feed.set(240e8);
        assertEq(oracle.recordSettlementPrice(address(tsla), FRIDAY_CLOSE, monday), 240e18);
    }

    function _hints(uint80 a, uint80 b) internal pure returns (uint80[] memory h) {
        h = new uint80[](2);
        (h[0], h[1]) = (a, b);
    }

    function test_recordSettlementPrice_newPhase() public {
        uint80 lastOfPhase1 = feed.currentRoundId();
        feed.newPhase();
        uint80 r = feed.push(255e8, FRIDAY_CLOSE + 30);
        vm.warp(FRIDAY_CLOSE + 100);
        // Round 1 of a new phase needs the previous phase's last round as proof.
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.MissingHint.selector, 1));
        oracle.recordSettlementPrice(address(tsla), FRIDAY_CLOSE, r);
        assertEq(oracle.recordSettlementPriceWithHints(address(tsla), FRIDAY_CLOSE, _hints(r, lastOfPhase1)), 255e18);
    }

    /// The new phase starts long after the close (an upgrade over the weekend): still settles, no age window.
    function test_recordSettlementPrice_newPhaseLate() public {
        uint80 lastOfPhase1 = feed.currentRoundId();
        feed.newPhase();
        uint80 r = feed.push(255e8, FRIDAY_CLOSE + 2 days);
        vm.warp(FRIDAY_CLOSE + 3 days);
        assertEq(oracle.recordSettlementPriceWithHints(address(tsla), FRIDAY_CLOSE, _hints(r, lastOfPhase1)), 255e18);
    }

    /// The old phase printed after the close: that print is the settlement price, not the new phase's round 1.
    function test_revert_recordSettlementPrice_newPhaseWhenOldPhasePrintedAfterExpiry() public {
        uint80 oldFirst = feed.push(260e8, FRIDAY_CLOSE + 5);
        uint80 before = oldFirst - 1;
        feed.newPhase();
        uint80 r = feed.push(300e8, FRIDAY_CLOSE + 2 hours);
        vm.warp(FRIDAY_CLOSE + 3 hours);
        // Claiming the old phase ended before the close: its hinted "last round" has a successor.
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.InvalidSettlementRound.selector, before));
        oracle.recordSettlementPriceWithHints(address(tsla), FRIDAY_CLOSE, _hints(r, before));
        // The true last round of the old phase is after the close.
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.InvalidSettlementRound.selector, oldFirst));
        oracle.recordSettlementPriceWithHints(address(tsla), FRIDAY_CLOSE, _hints(r, oldFirst));
        // A hint from the wrong phase.
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.InvalidSettlementRound.selector, r));
        oracle.recordSettlementPriceWithHints(address(tsla), FRIDAY_CLOSE, _hints(r, r));
        assertEq(oracle.recordSettlementPrice(address(tsla), FRIDAY_CLOSE, oldFirst), 260e18);
    }

    function test_revert_recordSettlementPrice_notExpired() public {
        vm.expectRevert(abi.encodeWithSelector(StockOracle.NotExpired.selector, FRIDAY_CLOSE));
        oracle.recordSettlementPrice(address(tsla), FRIDAY_CLOSE, 1);
    }

    function test_revert_recordSettlementPrice_pausedOrCorporateAction() public {
        uint80 r = feed.push(260e8, FRIDAY_CLOSE + 5);
        vm.warp(FRIDAY_CLOSE + 10);
        tsla.setTokenPaused(true);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.TokenPaused.selector, address(tsla)));
        oracle.recordSettlementPrice(address(tsla), FRIDAY_CLOSE, r);
        tsla.setTokenPaused(false);
        tsla.setOraclePaused(true);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.FeedPaused.selector, address(tsla)));
        oracle.recordSettlementPrice(address(tsla), FRIDAY_CLOSE, r);
        tsla.setOraclePaused(false);
        // A split took effect minutes before the settlement print: that print is skipped and settlement moves to
        // the first print after effectiveAt + grace.
        tsla.scheduleMultiplier(2e18, FRIDAY_CLOSE);
        tsla.applyMultiplier();
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.MissingHint.selector, 1));
        oracle.recordSettlementPrice(address(tsla), FRIDAY_CLOSE, r);
        uint80 during = feed.push(262e8, FRIDAY_CLOSE + GRACE - 1);
        uint80 afterGrace = feed.push(265e8, FRIDAY_CLOSE + GRACE);
        feed.push(270e8, FRIDAY_CLOSE + GRACE + 1);
        vm.warp(FRIDAY_CLOSE + GRACE + 10);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.InvalidSettlementRound.selector, during));
        oracle.recordSettlementPriceWithHints(address(tsla), FRIDAY_CLOSE, _hints(r, during));
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.InvalidSettlementRound.selector, afterGrace + 1));
        oracle.recordSettlementPriceWithHints(address(tsla), FRIDAY_CLOSE, _hints(r, afterGrace + 1));
        assertEq(oracle.recordSettlementPriceWithHints(address(tsla), FRIDAY_CLOSE, _hints(r, afterGrace)), 265e18);
    }

    /// A multiplier change far from expiry does not move the settlement print.
    function test_recordSettlementPrice_distantCorporateActionIgnored() public {
        uint80 r = feed.push(260e8, FRIDAY_CLOSE + 5);
        vm.warp(FRIDAY_CLOSE + 10);
        tsla.scheduleMultiplier(2e18, FRIDAY_CLOSE + 30 days);
        assertEq(oracle.recordSettlementPrice(address(tsla), FRIDAY_CLOSE, r), 260e18);
    }

    // ------------------------------------------------------------------ sequencer

    function test_sequencerUptime() public {
        MockAggregator seq = new MockAggregator(0);
        seq.push(0, MONDAY - 2 hours); // up for two hours
        vm.prank(admin);
        oracle.setSequencerFeed(seq, 1 hours);
        oracle.latestPrice(address(tsla));

        seq.push(1, MONDAY); // down
        vm.expectRevert(SafeStockFeed.SequencerDown.selector);
        oracle.latestPrice(address(tsla));

        seq.push(0, MONDAY - 10 minutes); // back up, still in grace
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.SequencerGracePeriod.selector, MONDAY - 10 minutes));
        oracle.latestPrice(address(tsla));
    }

    // ------------------------------------------------------------------ admin & views

    function test_viewsAndMarketHours() public view {
        assertTrue(oracle.isSupported(address(tsla)));
        assertFalse(oracle.isSupported(address(1)));
        assertTrue(oracle.isMarketOpen());
        assertTrue(oracle.isValidExpiry(FRIDAY_CLOSE));
        assertFalse(oracle.isValidExpiry(FRIDAY_CLOSE + 1));
        SafeStockFeed.Config memory c = oracle.feedConfig(address(tsla));
        assertEq(address(c.feed), address(feed));
        assertEq(c.feedDecimals, 8);
    }

    function test_admin() public {
        vm.startPrank(admin);
        MarketCalendar other = new MarketCalendar(admin, new uint256[](0), new uint256[](0));
        oracle.setCalendar(other);
        assertEq(address(oracle.calendar()), address(other));
        vm.expectRevert(StockOracle.ZeroAddress.selector);
        oracle.setCalendar(MarketCalendar(address(0)));
        vm.expectRevert(StockOracle.ZeroAddress.selector);
        oracle.setFeed(address(0), feed, 1, 1);
        vm.stopPrank();
        vm.expectRevert();
        oracle.setFeed(address(tsla), feed, 1, 1);
        vm.expectRevert(StockOracle.ZeroAddress.selector);
        new StockOracle(address(0), calendar);
    }
}
