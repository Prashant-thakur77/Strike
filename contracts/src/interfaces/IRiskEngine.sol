// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IPricer} from "./IPricer.sol";

/// @title IRiskEngine
/// @notice Black-Scholes risk engine on top of the pricer: greeks, implied volatility and the vault's payout under
///         spot shocks. Implemented by `BlackScholesRef` (Solidity, `RiskLib`) and the Stylus pricer (Rust,
///         `stylus/pricer/src/risk.rs`), with identical results. Errors are the pricer's
///         `PricerInputOutOfRange(which)`: 1 spot, 2 strike, 3 time, 4 volatility, 6 option price outside
///         no-arbitrage bounds, 7 implied volatility outside [5%, 500%], 8 spot shock outside (-100%, +1000%].
interface IRiskEngine is IPricer {
    /// @notice Greeks per option (one token), WAD, at r = 0.
    /// @param spot Spot price, USD per token, WAD.
    /// @param strike Strike price, USD per token, WAD.
    /// @param timeToExpiry Seconds to expiry.
    /// @param sigma Annualised volatility, WAD.
    /// @param isCall True for a call, false for a put.
    /// @return delta dPrice/dSpot (negative for puts).
    /// @return gamma dDelta/dSpot, per $1 of spot.
    /// @return vega dPrice/dSigma, per 1.00 (100 points) of volatility.
    /// @return theta dPrice/dt, per calendar day (never positive).
    function greeks(uint256 spot, uint256 strike, uint256 timeToExpiry, uint256 sigma, bool isCall)
        external
        view
        returns (int256 delta, uint256 gamma, uint256 vega, int256 theta);

    /// @notice Volatility (WAD) in [5%, 500%] at which `quote` returns `price` (USD per token, WAD). Newton's method
    ///         with a bisection fallback. Reverts with code 6 if `price` is not strictly between intrinsic value and
    ///         the cap (spot for a call, strike for a put), 7 if its volatility is outside [5%, 500%].
    function impliedVol(uint256 price, uint256 spot, uint256 strike, uint256 timeToExpiry, bool isCall)
        external
        view
        returns (uint256 sigma);

    /// @notice The vault's payout (USD, WAD) on `sold` options at each spot shock, with settlement rounding: a call
    ///         pays (S - K) / S tokens per option, valued at S; a put pays K - S.
    /// @param sold Options sold, WAD (1e18 = one option on one token).
    /// @param shocks Relative spot moves, WAD (-0.3e18 = -30%), each in (-100%, +1000%].
    /// @return worst The largest payout.
    /// @return losses The payout at each shock, in order.
    function scenarioLoss(bool isCall, uint256 strike, uint256 sold, uint256 spot, int256[] calldata shocks)
        external
        view
        returns (uint256 worst, uint256[] memory losses);
}
