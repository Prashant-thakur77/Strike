// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title IPricer
/// @notice Black-Scholes quote engine. Implemented by `BlackScholesRef` (Solidity) and the Stylus pricer (Rust).
interface IPricer {
    /// @notice Premium (USD per token, WAD) and delta (WAD, negative for puts).
    /// @param spot Spot price, USD per token, WAD.
    /// @param strike Strike price, USD per token, WAD.
    /// @param timeToExpiry Seconds to expiry.
    /// @param sigma Annualised volatility, WAD.
    /// @param isCall True for a call, false for a put.
    function quote(uint256 spot, uint256 strike, uint256 timeToExpiry, uint256 sigma, bool isCall)
        external
        view
        returns (uint256 price, int256 delta);

    /// @notice Strike whose |delta| equals `targetDelta` (WAD), found on-chain by bisection over `quote`.
    function strikeForDelta(uint256 spot, uint256 targetDelta, uint256 timeToExpiry, uint256 sigma, bool isCall)
        external
        view
        returns (uint256 strike);
}
