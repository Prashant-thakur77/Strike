// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IAggregatorV3} from "../../src/interfaces/IAggregatorV3.sol";
import {SafeStockFeed} from "../../src/libraries/SafeStockFeed.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";
import {MockStockToken, MockStockTokenNoOraclePause} from "../mocks/MockStockToken.sol";
import {Test} from "forge-std/Test.sol";

/// @title SafeStockFeedConformance
/// @notice The rules SafeStockFeed enforces, as a test suite any oracle wrapper can inherit. Implement the hooks
///         below (deploy a token/feed pair and the wrapper, push feed rounds, pause, schedule a multiplier change,
///         read the price through the wrapper) and every rule runs against your contract, one test each.
/// @dev The suite drives the token and feed only through the hooks and reads only through `_readPrice` (and
///      `_settlementPrice`, `_setSequencer` where the wrapper supports them), so the wrapper is tested from the
///      outside, as a lending market or perps protocol would call it. Rules that do not apply (no settlement, no
///      sequencer check) are reported as skipped, not passed. Configure the wrapper with the constants below.
///      `SafeStockFeedConformanceWithMocks` implements the token and feed hooks with Strike's mocks, leaving only
///      `_deployWrapper` and `_readPrice` to write.
abstract contract SafeStockFeedConformance is Test {
    /// @notice Staleness limit the wrapper must be configured with.
    uint32 internal constant MAX_AGE = 1 hours;
    /// @notice Corporate-action grace the wrapper must be configured with.
    uint32 internal constant CA_GRACE = 1 days;
    /// @notice Sequencer grace the wrapper must be configured with (when it checks the sequencer).
    uint32 internal constant SEQ_GRACE = 1 hours;
    /// @notice Suite start time: Monday 2026-10-05 14:00 UTC.
    uint256 internal constant START = 1_791_208_800;
    /// @notice Settlement target used by the settlement rules: one day after `START`.
    uint256 internal constant TARGET = START + 1 days;

    /// @notice The stock token under test (set from `_deploy`).
    address internal token;

    // ------------------------------------------------------------------ hooks: implement these

    /// @notice Deploy a fresh token/feed pair and the wrapper that reads it; return the token.
    /// @param feedDecimals Decimals of the feed (8 for every Robinhood Chain stock feed).
    /// @param withOraclePause False deploys a token without `oraclePaused()` (as on testnet), where calls revert.
    function _deploy(uint8 feedDecimals, bool withOraclePause) internal virtual returns (address);

    /// @notice Record a feed round with this answer and timestamp; return its round id (phase << 64 | round).
    function _pushRound(int256 answer, uint256 updatedAt) internal virtual returns (uint80);

    /// @notice Start a new feed phase (an aggregator upgrade): round numbering restarts at 1.
    function _newFeedPhase() internal virtual;

    function _setTokenPaused(bool paused) internal virtual;

    function _setOraclePaused(bool paused) internal virtual;

    /// @notice Schedule an ERC-8056 multiplier change (`newUIMultiplier`, `effectiveAt`).
    function _scheduleMultiplier(uint256 multiplier, uint256 effectiveAt) internal virtual;

    /// @notice Make the scheduled multiplier current (`uiMultiplier = newUIMultiplier`).
    function _applyMultiplier() internal virtual;

    /// @notice Latest price through the wrapper, WAD per raw token. Must revert with SafeStockFeed's errors.
    function _readPrice() internal virtual returns (uint256 priceWad);

    /// @notice Move chain time. Override if the wrapper needs more than a warp (a keeper, a block roll).
    function _warp(uint256 timestamp) internal virtual {
        vm.warp(timestamp);
    }

    /// @notice True when the wrapper exposes a settlement price (SafeStockFeed.settlementPrice).
    function _supportsSettlement() internal virtual returns (bool) {
        return false;
    }

    /// @notice Settlement price for `target` through the wrapper, proven by `hints`.
    function _settlementPrice(uint80[] memory, uint256) internal virtual returns (uint256) {
        vm.skip(true, "the wrapper has no settlement price");
        return 0;
    }

    /// @notice True when the wrapper checks an L2 sequencer uptime feed (SafeStockFeed.checkSequencer).
    function _supportsSequencer() internal virtual returns (bool) {
        return false;
    }

    /// @notice Report the sequencer as `answer` (0 = up) since `startedAt`.
    function _setSequencer(int256, uint256) internal virtual {
        vm.skip(true, "the wrapper has no sequencer check");
    }

    // ------------------------------------------------------------------ setup

    function setUp() public virtual {
        _warp(START);
        token = _deploy(8, true);
        _setPrice(250e8);
    }

    function _setPrice(int256 answer) internal returns (uint80) {
        return _pushRound(answer, block.timestamp);
    }

    function _hints(uint80 a) internal pure returns (uint80[] memory h) {
        h = new uint80[](1);
        h[0] = a;
    }

    function _hints(uint80 a, uint80 b) internal pure returns (uint80[] memory h) {
        h = new uint80[](2);
        (h[0], h[1]) = (a, b);
    }

    function _requireSettlement() internal {
        vm.skip(!_supportsSettlement(), "the wrapper has no settlement price");
    }

    // ------------------------------------------------------------------ live price

    function test_conformance_freshPriceIsReturnedInWad() public {
        assertEq(_readPrice(), 250e18);
    }

    /// Any feed decimals normalise to 18.
    function testFuzz_conformance_decimalsNormalised(uint8 feedDecimals) public {
        feedDecimals = uint8(bound(feedDecimals, 0, 36));
        token = _deploy(feedDecimals, true);
        _setPrice(int256(250 * 10 ** uint256(feedDecimals)));
        assertEq(_readPrice(), 250e18);
    }

    /// The feed prices one raw token including the ERC-8056 multiplier: after a split takes effect and the grace
    /// has passed, the price read is the feed answer unchanged, never answer × uiMultiplier.
    function testFuzz_conformance_multiplierIsNeverApplied(uint256 multiplier) public {
        multiplier = bound(multiplier, 0.5e18, 10e18);
        _scheduleMultiplier(multiplier, block.timestamp);
        _applyMultiplier();
        _warp(block.timestamp + CA_GRACE);
        _setPrice(360e8);
        assertEq(_readPrice(), 360e18, "feed answer, not answer x uiMultiplier");
    }

    function test_conformance_stalePriceReverts() public {
        _warp(START + MAX_AGE);
        assertEq(_readPrice(), 250e18, "exactly maxPriceAge old is still fresh");
        _warp(START + MAX_AGE + 1);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.StalePrice.selector, START, MAX_AGE));
        _readPrice();
    }

    function test_conformance_zeroAnswerReverts() public {
        _setPrice(0);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.InvalidPrice.selector, int256(0)));
        _readPrice();
    }

    function testFuzz_conformance_negativeAnswerReverts(int256 answer) public {
        answer = bound(answer, type(int256).min, -1);
        _setPrice(answer);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.InvalidPrice.selector, answer));
        _readPrice();
    }

    function test_conformance_futureTimestampReverts() public {
        _pushRound(251e8, block.timestamp + 1);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.InvalidPrice.selector, int256(251e8)));
        _readPrice();
    }

    // ------------------------------------------------------------------ pause layers

    function test_conformance_tokenPauseReverts() public {
        _setTokenPaused(true);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.TokenPaused.selector, token));
        _readPrice();
        _setTokenPaused(false);
        assertEq(_readPrice(), 250e18);
    }

    function test_conformance_oraclePauseReverts() public {
        _setOraclePaused(true);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.FeedPaused.selector, token));
        _readPrice();
        _setOraclePaused(false);
        assertEq(_readPrice(), 250e18);
    }

    /// Both layers paused: the token pause is reported first.
    function test_conformance_tokenPauseIsCheckedBeforeOraclePause() public {
        _setOraclePaused(true);
        _setTokenPaused(true);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.TokenPaused.selector, token));
        _readPrice();
    }

    /// A token without `oraclePaused()` (the testnet tokens) is read as not paused, not as broken.
    function test_conformance_missingOraclePausedIsNotPaused() public {
        token = _deploy(8, false);
        _setPrice(250e8);
        assertEq(_readPrice(), 250e18);
    }

    // ------------------------------------------------------------------ corporate actions (ERC-8056)

    function test_conformance_scheduledCorporateActionReverts() public {
        uint256 effectiveAt = START + 2 days;
        _scheduleMultiplier(2e18, effectiveAt);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.CorporateActionPending.selector, token, effectiveAt));
        _readPrice();
    }

    /// From announcement until `effectiveAt + grace`, then prices flow again.
    function test_conformance_corporateActionWindowClosesAfterGrace() public {
        uint256 effectiveAt = START + 2 days;
        _scheduleMultiplier(2e18, effectiveAt);
        _warp(effectiveAt);
        _applyMultiplier();
        _setPrice(250e8);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.CorporateActionPending.selector, token, effectiveAt));
        _readPrice();

        _warp(effectiveAt + CA_GRACE - 1);
        _setPrice(250e8);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.CorporateActionPending.selector, token, effectiveAt));
        _readPrice();

        _warp(effectiveAt + CA_GRACE);
        _setPrice(250e8);
        assertEq(_readPrice(), 250e18);
    }

    // ------------------------------------------------------------------ sequencer

    function test_conformance_sequencerDownAndGrace() public {
        vm.skip(!_supportsSequencer(), "the wrapper has no sequencer check");
        _setSequencer(1, START - 1 days);
        vm.expectRevert(SafeStockFeed.SequencerDown.selector);
        _readPrice();

        uint256 upSince = block.timestamp - SEQ_GRACE + 1;
        _setSequencer(0, upSince);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.SequencerGracePeriod.selector, upSince));
        _readPrice();

        _setSequencer(0, block.timestamp - SEQ_GRACE);
        assertEq(_readPrice(), 250e18);
    }

    // ------------------------------------------------------------------ settlement round

    /// The settlement round is the first at or after the target: neither an earlier nor a later print is accepted.
    function test_conformance_settlementIsFirstRoundAtOrAfterTarget() public {
        _requireSettlement();
        uint80 before = _pushRound(251e8, TARGET - 10);
        uint80 first = _pushRound(252e8, TARGET + 5);
        uint80 later = _pushRound(253e8, TARGET + 20);
        _warp(TARGET + 30);

        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.MissingHint.selector, 0));
        _settlementPrice(new uint80[](0), TARGET);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.InvalidSettlementRound.selector, before));
        _settlementPrice(_hints(before), TARGET);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.InvalidSettlementRound.selector, later));
        _settlementPrice(_hints(later), TARGET);

        assertEq(_settlementPrice(_hints(first), TARGET), 252e18);
    }

    /// Round 1 of the first phase has no predecessor: it must be within maxPriceAge of the target.
    function test_conformance_settlementFirstRoundOfFirstPhaseMustBeFresh() public {
        _requireSettlement();
        uint80 round1 = uint80((uint256(1) << 64) | 1); // pushed in setUp at START
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.InvalidSettlementRound.selector, round1));
        _settlementPrice(_hints(round1), START - MAX_AGE - 1);
        assertEq(_settlementPrice(_hints(round1), START - MAX_AGE), 250e18);
    }

    /// Round 1 of a new phase needs the previous phase's last round as its second hint: that round predates the
    /// target and has no successor.
    function test_conformance_settlementAcrossPhaseChange() public {
        _requireSettlement();
        uint80 notLast = _pushRound(249e8, TARGET - 20);
        uint80 last = _pushRound(251e8, TARGET - 10);
        _newFeedPhase();
        uint80 first = _pushRound(260e8, TARGET + 5);
        _pushRound(261e8, TARGET + 10);
        _warp(TARGET + 30);

        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.MissingHint.selector, 1));
        _settlementPrice(_hints(first), TARGET);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.InvalidSettlementRound.selector, notLast));
        _settlementPrice(_hints(first, notLast), TARGET);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.InvalidSettlementRound.selector, first));
        _settlementPrice(_hints(first, first), TARGET);

        assertEq(_settlementPrice(_hints(first, last), TARGET), 260e18);
    }

    /// When the old phase already printed at or after the target, that print settles, not the new phase's first.
    function test_conformance_settlementPhaseChangeCannotSkipOldPhase() public {
        _requireSettlement();
        _pushRound(251e8, TARGET - 10);
        uint80 last = _pushRound(252e8, TARGET + 1);
        _newFeedPhase();
        uint80 first = _pushRound(260e8, TARGET + 5);
        _warp(TARGET + 30);

        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.InvalidSettlementRound.selector, last));
        _settlementPrice(_hints(first, last), TARGET);
        assertEq(_settlementPrice(_hints(last), TARGET), 252e18);
    }

    /// A print within the corporate-action grace of `effectiveAt` moves the target to `effectiveAt + grace`; the
    /// next hint must be the first round at or after it.
    function test_conformance_settlementCorporateActionHint() public {
        _requireSettlement();
        _scheduleMultiplier(2e18, TARGET);
        _pushRound(250e8, TARGET - 10);
        uint80 inWindow = _pushRound(251e8, TARGET + 5);
        uint80 tooEarly = _pushRound(125e8, TARGET + CA_GRACE - 1);
        uint80 first = _pushRound(126e8, TARGET + CA_GRACE + 2);
        _pushRound(127e8, TARGET + CA_GRACE + 60);
        _warp(TARGET + CA_GRACE + 100);

        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.MissingHint.selector, 1));
        _settlementPrice(_hints(inWindow), TARGET);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.InvalidSettlementRound.selector, tooEarly));
        _settlementPrice(_hints(inWindow, tooEarly), TARGET);

        assertEq(_settlementPrice(_hints(inWindow, first), TARGET), 126e18);
    }

    function test_conformance_settlementRespectsPauseLayers() public {
        _requireSettlement();
        uint80 first = _pushRound(252e8, TARGET + 5);
        _warp(TARGET + 30);

        _setTokenPaused(true);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.TokenPaused.selector, token));
        _settlementPrice(_hints(first), TARGET);
        _setTokenPaused(false);

        _setOraclePaused(true);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.FeedPaused.selector, token));
        _settlementPrice(_hints(first), TARGET);
        _setOraclePaused(false);

        assertEq(_settlementPrice(_hints(first), TARGET), 252e18);
    }

    function test_conformance_settlementRejectsInvalidRounds() public {
        _requireSettlement();
        uint80 zero = _pushRound(0, TARGET + 5);
        _warp(TARGET + 30);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.InvalidPrice.selector, int256(0)));
        _settlementPrice(_hints(zero), TARGET);

        uint80 future = _pushRound(251e8, block.timestamp + 1);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.InvalidPrice.selector, int256(251e8)));
        _settlementPrice(_hints(future), TARGET + 6);
    }
}

/// @title SafeStockFeedConformanceWithMocks
/// @notice The conformance suite with the token and feed hooks implemented by Strike's mocks (`MockStockToken`,
///         `MockAggregator` for the price and the sequencer feed). A wrapper implements `_deployWrapper` and
///         `_readPrice`, and optionally the settlement hooks.
abstract contract SafeStockFeedConformanceWithMocks is SafeStockFeedConformance {
    MockAggregator internal feed;
    /// @notice Sequencer uptime feed, reported up since a day before the suite starts.
    MockAggregator internal sequencer;
    /// @notice The token as a MockStockToken (zero for the variant without `oraclePaused()`).
    MockStockToken internal stock;

    /// @notice Deploy the wrapper for this token, feed and sequencer uptime feed (a wrapper without a sequencer
    ///         check ignores it).
    function _deployWrapper(address token_, IAggregatorV3 feed_, IAggregatorV3 sequencer_) internal virtual;

    function _deploy(uint8 feedDecimals, bool withOraclePause) internal override returns (address token_) {
        feed = new MockAggregator(feedDecimals);
        sequencer = new MockAggregator(0);
        sequencer.push(0, block.timestamp - 1 days);
        if (withOraclePause) {
            stock = new MockStockToken("Stock", "STK");
            token_ = address(stock);
        } else {
            stock = MockStockToken(address(0));
            token_ = address(new MockStockTokenNoOraclePause());
        }
        _deployWrapper(token_, feed, sequencer);
    }

    function _pushRound(int256 answer, uint256 updatedAt) internal override returns (uint80) {
        return feed.push(answer, updatedAt);
    }

    function _newFeedPhase() internal override {
        feed.newPhase();
    }

    function _setTokenPaused(bool paused) internal override {
        stock.setTokenPaused(paused);
    }

    function _setOraclePaused(bool paused) internal override {
        stock.setOraclePaused(paused);
    }

    function _scheduleMultiplier(uint256 multiplier, uint256 effectiveAt) internal override {
        stock.scheduleMultiplier(multiplier, effectiveAt);
    }

    function _applyMultiplier() internal override {
        stock.applyMultiplier();
    }

    function _setSequencer(int256 answer, uint256 startedAt) internal virtual override {
        sequencer.push(answer, startedAt);
    }
}
