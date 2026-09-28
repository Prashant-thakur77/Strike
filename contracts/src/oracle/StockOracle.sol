// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IAggregatorV3} from "../interfaces/IAggregatorV3.sol";
import {IStockOracle} from "../interfaces/IStockOracle.sol";
import {SafeStockFeed} from "../libraries/SafeStockFeed.sol";
import {MarketCalendar} from "./MarketCalendar.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title StockOracle
/// @notice Registry of Robinhood Chain stock tokens and their Chainlink feeds, read through SafeStockFeed, plus the
///         NYSE calendar. Settlement prices are recorded once per (token, expiry) and shared by every vault.
contract StockOracle is IStockOracle, AccessControl {
    using SafeStockFeed for SafeStockFeed.Config;

    MarketCalendar public calendar;
    /// @notice Optional Chainlink L2 sequencer uptime feed (unset on chains without one).
    IAggregatorV3 public sequencerFeed;
    uint32 public sequencerGrace = 1 hours;

    mapping(address token => SafeStockFeed.Config) internal _configs;
    mapping(address token => mapping(uint64 expiry => uint256 price)) internal _settlementPrices;

    event FeedSet(address indexed token, address feed, uint32 maxPriceAge, uint32 corporateActionGrace);
    event CalendarSet(address calendar);
    event SequencerFeedSet(address feed, uint32 grace);
    event SettlementPriceRecorded(address indexed token, uint64 indexed expiry, uint80 roundId, uint256 price);

    error ZeroAddress();
    error Unsupported(address token);
    error NotExpired(uint64 expiry);

    constructor(address admin, MarketCalendar calendar_) {
        if (admin == address(0) || address(calendar_) == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        calendar = calendar_;
    }

    /// @notice Register (or update) a token's feed. Use addresses from docs.robinhood.com/chain/contracts only.
    function setFeed(address token, IAggregatorV3 feed, uint32 maxPriceAge, uint32 corporateActionGrace)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (token == address(0) || address(feed) == address(0)) revert ZeroAddress();
        _configs[token] = SafeStockFeed.Config(feed, maxPriceAge, corporateActionGrace, feed.decimals());
        emit FeedSet(token, address(feed), maxPriceAge, corporateActionGrace);
    }

    function setCalendar(MarketCalendar calendar_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (address(calendar_) == address(0)) revert ZeroAddress();
        calendar = calendar_;
        emit CalendarSet(address(calendar_));
    }

    function setSequencerFeed(IAggregatorV3 feed, uint32 grace) external onlyRole(DEFAULT_ADMIN_ROLE) {
        sequencerFeed = feed;
        sequencerGrace = grace;
        emit SequencerFeedSet(address(feed), grace);
    }

    /// @inheritdoc IStockOracle
    function latestPrice(address token) external view returns (uint256 priceWad, uint256 updatedAt) {
        SafeStockFeed.checkSequencer(sequencerFeed, sequencerGrace);
        return _config(token).latest(token);
    }

    /// @inheritdoc IStockOracle
    function status(address token) external view returns (SafeStockFeed.Status, uint256, uint256) {
        return _config(token).status(token);
    }

    /// @inheritdoc IStockOracle
    function recordSettlementPrice(address token, uint64 expiry, uint80 roundId) external returns (uint256) {
        uint80[] memory hints = new uint80[](1);
        hints[0] = roundId;
        return _record(token, expiry, hints);
    }

    /// @inheritdoc IStockOracle
    function recordSettlementPriceWithHints(address token, uint64 expiry, uint80[] calldata hints)
        external
        returns (uint256)
    {
        return _record(token, expiry, hints);
    }

    function _record(address token, uint64 expiry, uint80[] memory hints) internal returns (uint256 priceWad) {
        priceWad = _settlementPrices[token][expiry];
        if (priceWad != 0) return priceWad;
        if (block.timestamp < expiry) revert NotExpired(expiry);
        SafeStockFeed.checkSequencer(sequencerFeed, sequencerGrace);
        uint80 roundId;
        (priceWad,, roundId) = _config(token).settlementPrice(token, hints, expiry);
        _settlementPrices[token][expiry] = priceWad;
        emit SettlementPriceRecorded(token, expiry, roundId, priceWad);
    }

    /// @inheritdoc IStockOracle
    function settlementPrice(address token, uint64 expiry) external view returns (uint256) {
        return _settlementPrices[token][expiry];
    }

    function feedConfig(address token) external view returns (SafeStockFeed.Config memory) {
        return _configs[token];
    }

    /// @inheritdoc IStockOracle
    function isSupported(address token) external view returns (bool) {
        return address(_configs[token].feed) != address(0);
    }

    /// @inheritdoc IStockOracle
    function isMarketOpen() external view returns (bool) {
        return calendar.isMarketOpen(block.timestamp);
    }

    /// @inheritdoc IStockOracle
    function isValidExpiry(uint64 expiry) external view returns (bool) {
        return calendar.isSessionClose(expiry);
    }

    function _config(address token) internal view returns (SafeStockFeed.Config memory c) {
        c = _configs[token];
        if (address(c.feed) == address(0)) revert Unsupported(token);
    }
}
