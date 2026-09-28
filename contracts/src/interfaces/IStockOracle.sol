// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SafeStockFeed} from "../libraries/SafeStockFeed.sol";

/// @title IStockOracle
/// @notice Safe stock-token prices and US market hours for Strike (and any other Robinhood Chain protocol).
interface IStockOracle {
    /// @notice Latest price, WAD per raw token. Reverts with a SafeStockFeed error unless every check passes.
    function latestPrice(address token) external view returns (uint256 priceWad, uint256 updatedAt);

    /// @notice Non-reverting status for apps and agents.
    function status(address token)
        external
        view
        returns (SafeStockFeed.Status feedStatus, uint256 priceWad, uint256 updatedAt);

    /// @notice Fix the settlement price for (token, expiry) from the first round at or after expiry. Idempotent.
    function recordSettlementPrice(address token, uint64 expiry, uint80 roundId) external returns (uint256 priceWad);

    /// @notice Same, with extra hints for the rare cases one round cannot prove: the first round of a new Chainlink
    ///         phase (add the previous phase's last round) and a print inside a corporate-action window (add the
    ///         first round after `effectiveAt + grace`, plus its phase hint if needed). Idempotent.
    function recordSettlementPriceWithHints(address token, uint64 expiry, uint80[] calldata hints)
        external
        returns (uint256 priceWad);

    /// @notice Recorded settlement price (0 if not recorded yet).
    function settlementPrice(address token, uint64 expiry) external view returns (uint256);

    function isSupported(address token) external view returns (bool);

    /// @notice US regular session is open now.
    function isMarketOpen() external view returns (bool);

    /// @notice `expiry` is an NYSE session close.
    function isValidExpiry(uint64 expiry) external view returns (bool);
}
