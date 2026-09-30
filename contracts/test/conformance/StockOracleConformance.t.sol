// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IAggregatorV3} from "../../src/interfaces/IAggregatorV3.sol";
import {MarketCalendar} from "../../src/oracle/MarketCalendar.sol";
import {StockOracle} from "../../src/oracle/StockOracle.sol";
import {SafeStockFeedConformanceWithMocks} from "./SafeStockFeedConformance.sol";

/// @notice Strike's deployed StockOracle against the SafeStockFeed conformance suite: live price, settlement price
///         (recordSettlementPriceWithHints) and the sequencer check all apply.
contract StockOracleConformanceTest is SafeStockFeedConformanceWithMocks {
    address internal admin = makeAddr("admin");
    StockOracle internal oracle;

    function _deployWrapper(address token_, IAggregatorV3 feed_, IAggregatorV3 sequencer_) internal override {
        oracle = new StockOracle(admin, new MarketCalendar(admin, new uint256[](0), new uint256[](0)));
        vm.startPrank(admin);
        oracle.setFeed(token_, feed_, MAX_AGE, CA_GRACE);
        oracle.setSequencerFeed(sequencer_, SEQ_GRACE);
        vm.stopPrank();
    }

    function _readPrice() internal view override returns (uint256 priceWad) {
        (priceWad,) = oracle.latestPrice(token);
    }

    function _supportsSettlement() internal pure override returns (bool) {
        return true;
    }

    function _settlementPrice(uint80[] memory hints, uint256 target) internal override returns (uint256) {
        return oracle.recordSettlementPriceWithHints(token, uint64(target), hints);
    }

    function _supportsSequencer() internal pure override returns (bool) {
        return true;
    }
}
