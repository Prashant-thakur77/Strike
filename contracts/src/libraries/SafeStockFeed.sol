// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IAggregatorV3} from "../interfaces/IAggregatorV3.sol";
import {IStockToken} from "../interfaces/IStockToken.sol";

/// @title SafeStockFeed
/// @notice One call to read a Robinhood Chain stock-token price safely. It checks staleness, both pause layers
///         (token and oracle), ERC-8056 corporate actions in progress and the L2 sequencer, and normalises decimals.
/// @dev The Chainlink stock feed already prices one raw token *including* the ERC-8056 `uiMultiplier`. This library
///      never multiplies a feed price by the multiplier; doing so double-counts splits and dividends.
library SafeStockFeed {
    struct Config {
        IAggregatorV3 feed; // Chainlink feed for the token (price per raw token)
        uint32 maxPriceAge; // staleness limit for live reads
        uint32 corporateActionGrace; // pause window around a multiplier change
        uint8 feedDecimals;
    }

    enum Status {
        Ok,
        InvalidPrice,
        StalePrice,
        TokenPaused,
        FeedPaused,
        CorporateActionPending
    }

    error InvalidPrice(int256 answer);
    error StalePrice(uint256 updatedAt, uint256 maxAge);
    error TokenPaused(address token);
    error FeedPaused(address token);
    error CorporateActionPending(address token, uint256 effectiveAt);
    error InvalidSettlementRound(uint80 roundId);
    error SequencerDown();
    error SequencerGracePeriod(uint256 upSince);

    /// @notice Latest price (WAD per raw token). Reverts unless every check passes.
    function latest(Config memory c, address token) internal view returns (uint256 priceWad, uint256 updatedAt) {
        checkToken(token, c.corporateActionGrace);
        int256 answer;
        (, answer,, updatedAt,) = c.feed.latestRoundData();
        if (answer <= 0 || updatedAt > block.timestamp) revert InvalidPrice(answer);
        if (block.timestamp - updatedAt > c.maxPriceAge) revert StalePrice(updatedAt, c.maxPriceAge);
        priceWad = toWad(answer, c.feedDecimals);
    }

    /// @notice Non-reverting version of `latest` for apps and agents.
    function status(Config memory c, address token)
        internal
        view
        returns (Status s, uint256 priceWad, uint256 updatedAt)
    {
        if (_flag(token, IStockToken.paused.selector)) return (Status.TokenPaused, 0, 0);
        if (_flag(token, IStockToken.oraclePaused.selector)) return (Status.FeedPaused, 0, 0);
        (bool pending,) = corporateAction(token, c.corporateActionGrace);
        if (pending) return (Status.CorporateActionPending, 0, 0);
        int256 answer;
        (, answer,, updatedAt,) = c.feed.latestRoundData();
        if (answer <= 0 || updatedAt > block.timestamp) return (Status.InvalidPrice, 0, updatedAt);
        priceWad = toWad(answer, c.feedDecimals);
        if (block.timestamp - updatedAt > c.maxPriceAge) return (Status.StalePrice, priceWad, updatedAt);
        return (Status.Ok, priceWad, updatedAt);
    }

    /// @notice Settlement price: the first feed round published at or after `target`.
    /// @dev Round ids are (phase << 64 | aggregatorRound). Inside a phase, round `roundId - 1` must predate the
    ///      target. At the first round of a phase there is no predecessor, so the print must be within
    ///      `maxPriceAge` of the target. Rejects prints within the corporate-action window of a multiplier change.
    function settlementPrice(Config memory c, address token, uint80 roundId, uint256 target)
        internal
        view
        returns (uint256 priceWad, uint256 updatedAt)
    {
        if (_flag(token, IStockToken.paused.selector)) revert TokenPaused(token);
        if (_flag(token, IStockToken.oraclePaused.selector)) revert FeedPaused(token);
        int256 answer;
        (, answer,, updatedAt,) = c.feed.getRoundData(roundId);
        if (answer <= 0 || updatedAt > block.timestamp) revert InvalidPrice(answer);
        if (updatedAt < target) revert InvalidSettlementRound(roundId);
        // The low 64 bits are the aggregator round; truncation is the point.
        // forge-lint: disable-next-line(unsafe-typecast)
        if (uint64(roundId) > 1) {
            (,,, uint256 prevUpdatedAt,) = c.feed.getRoundData(roundId - 1);
            if (prevUpdatedAt >= target) revert InvalidSettlementRound(roundId);
        } else if (updatedAt - target > c.maxPriceAge) {
            revert InvalidSettlementRound(roundId);
        }
        (bool ok, uint256 at) = _uint(token, IStockToken.effectiveAt.selector);
        if (ok && at != 0 && updatedAt + c.corporateActionGrace > at && at + c.corporateActionGrace > updatedAt) {
            revert CorporateActionPending(token, at);
        }
        priceWad = toWad(answer, c.feedDecimals);
    }

    /// @notice Reverts if the token or its oracle is paused, or a corporate action is in progress.
    function checkToken(address token, uint32 grace) internal view {
        if (_flag(token, IStockToken.paused.selector)) revert TokenPaused(token);
        if (_flag(token, IStockToken.oraclePaused.selector)) revert FeedPaused(token);
        (bool pending, uint256 at) = corporateAction(token, grace);
        if (pending) revert CorporateActionPending(token, at);
    }

    /// @notice A multiplier change is scheduled, or took effect less than `grace` ago. False for plain ERC-20s.
    function corporateAction(address token, uint32 grace) internal view returns (bool pending, uint256 effectiveAt) {
        (bool ok1, uint256 current) = _uint(token, IStockToken.uiMultiplier.selector);
        (bool ok2, uint256 next) = _uint(token, IStockToken.newUIMultiplier.selector);
        (bool ok3, uint256 at) = _uint(token, IStockToken.effectiveAt.selector);
        if (!ok1 || !ok2 || !ok3) return (false, 0);
        return (current != next || block.timestamp < at + grace, at);
    }

    /// @notice Chainlink L2 sequencer uptime check (answer 0 = up). Skipped when no feed is configured.
    function checkSequencer(IAggregatorV3 sequencerFeed, uint32 grace) internal view {
        if (address(sequencerFeed) == address(0)) return;
        (, int256 answer, uint256 startedAt,,) = sequencerFeed.latestRoundData();
        if (answer != 0) revert SequencerDown();
        if (block.timestamp - startedAt < grace) revert SequencerGracePeriod(startedAt);
    }

    /// @notice Feed answer scaled to 18 decimals, used as-is (no multiplier).
    function toWad(int256 answer, uint8 feedDecimals) internal pure returns (uint256) {
        // answer > 0 is checked by every caller.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 a = uint256(answer);
        return feedDecimals <= 18 ? a * 10 ** (18 - feedDecimals) : a / 10 ** (feedDecimals - 18);
    }

    function _flag(address token, bytes4 selector) private view returns (bool) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSelector(selector));
        return ok && data.length >= 32 && abi.decode(data, (bool));
    }

    function _uint(address token, bytes4 selector) private view returns (bool, uint256) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSelector(selector));
        if (!ok || data.length < 32) return (false, 0);
        return (true, abi.decode(data, (uint256)));
    }
}
