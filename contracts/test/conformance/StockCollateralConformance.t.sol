// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {StockCollateral} from "../../examples/StockCollateral.sol";
import {IAggregatorV3} from "../../src/interfaces/IAggregatorV3.sol";
import {SafeStockFeedConformanceWithMocks} from "./SafeStockFeedConformance.sol";

/// @notice The example lending-collateral consumer (examples/StockCollateral.sol) against the SafeStockFeed
///         conformance suite. It reads live prices and checks the sequencer; it has no settlement price, so the
///         settlement rules are reported as skipped.
contract StockCollateralConformanceTest is SafeStockFeedConformanceWithMocks {
    StockCollateral internal market;

    function _deployWrapper(address token_, IAggregatorV3 feed_, IAggregatorV3 sequencer_) internal override {
        market = new StockCollateral(token_, feed_, MAX_AGE, CA_GRACE, 5000, sequencer_, SEQ_GRACE);
    }

    function _readPrice() internal view override returns (uint256) {
        return market.price();
    }

    function _supportsSequencer() internal pure override returns (bool) {
        return true;
    }
}
