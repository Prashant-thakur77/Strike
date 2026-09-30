// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {BlackScholesLib as BS} from "./BlackScholesLib.sol";

/// @title RiskLib
/// @notice Risk engine on the fixed-point Black-Scholes of `BlackScholesLib`: greeks, implied volatility and the
///         vault's payout under spot shocks.
/// @dev Mirrors `stylus/pricer/src/risk.rs` operation for operation, so the Solidity reference and the Stylus
///      contract return identical results (checked by `RiskVectors.t.sol` and the differential fuzz suite). Errors
///      are `BlackScholesLib.PricerInputOutOfRange(which)`, extending its codes with 6, 7 and 8.
library RiskLib {
    uint256 internal constant WAD = 1e18;
    /// @notice Implied volatility search range: the protocol's sigma range, 5% to 500%.
    uint256 internal constant IV_MIN = WAD / 20;
    uint256 internal constant IV_MAX = 5 * WAD;
    /// @notice The search stops once a step moves sigma by at most this much (1e-12 in volatility)...
    uint256 internal constant IV_TOL = 1e6;
    /// @notice ... or once the premium is within spot / 1e15 of the target (the engine's own accuracy).
    uint256 internal constant IV_PRICE_TOL_DIV = 1e15;
    /// @notice Upper bound on solver rounds (Newton usually needs 3 to 8).
    uint256 internal constant IV_MAX_ROUNDS = 64;
    /// @notice Largest upward spot shock, +1000%. Downward shocks must stay above -100%.
    uint256 internal constant MAX_SHOCK = 10 * WAD;

    /// @notice The option price is not strictly between intrinsic value and the cap (S for a call, K for a put).
    uint8 internal constant ERR_PRICE = 6;
    /// @notice The price is valid but its implied volatility lies outside [IV_MIN, IV_MAX].
    uint8 internal constant ERR_IV = 7;
    /// @notice A spot shock is at or below -100% or above +1000%.
    uint8 internal constant ERR_SHOCK = 8;

    uint256 private constant WAD2 = 1e36;
    /// @dev theta per year / (2 × 365) = theta per day.
    uint256 private constant TWO_DAYS_PER_YEAR = 730;

    /// @dev Solver state, in memory to keep the stack shallow.
    struct Search {
        uint256 price;
        uint256 spot;
        uint256 strike;
        uint256 time;
        bool isCall;
        uint256 lo;
        uint256 hi;
    }

    /// @notice Standard normal density φ(x) for x = |x| >= 0 (WAD).
    function pdf(uint256 x) internal pure returns (uint256) {
        return BS.divWad(BS.expNeg(BS.mulWad(x, x) / 2), BS.SQRT_2PI);
    }

    /// @notice Greeks per option (one token), WAD, at r = 0. Same inputs and input checks as `quote`.
    /// @return delta dPrice/dSpot (negative for puts).
    /// @return gamma φ(d1) / (S σ √T): dDelta/dSpot per $1 of spot.
    /// @return vega S φ(d1) √T: dPrice/dSigma per 1.00 of volatility.
    /// @return theta −S φ(d1) σ / (2 √T) / 365: dPrice/dt per calendar day.
    function greeks(uint256 spot, uint256 strike, uint256 time, uint256 sigma, bool isCall)
        internal
        pure
        returns (int256 delta, uint256 gamma, uint256 vega, int256 theta)
    {
        BS.checkInputs(spot, strike, time, sigma);
        (uint256 d1Abs, bool d1Neg, uint256 volSqrtT, uint256 sqrtT) = BS.d1(spot, strike, time, sigma);
        delta = BS.deltaFrom(BS.normalCdf(d1Abs, d1Neg), isCall);
        uint256 phi = pdf(d1Abs);
        gamma = phi * WAD2 / (spot * volSqrtT);
        uint256 spotPhi = spot * phi; // WAD², at most 1e30 × 4e17
        vega = spotPhi * sqrtT / WAD2;
        // At most 1e30 × 4e17 × 5e18 / (1.8e14 × 730 × 1e18) < 2^255, so the cast is exact.
        // forge-lint: disable-next-line(unsafe-typecast)
        theta = -int256(spotPhi * sigma / (sqrtT * TWO_DAYS_PER_YEAR * WAD));
    }

    /// @notice Volatility (WAD, in [5%, 500%]) at which `BlackScholesLib.quote` returns `price`.
    /// @dev Newton's method on sigma inside a bracket [lo, hi] that every evaluation tightens (the premium rises
    ///      with sigma). A Newton step that would leave the bracket, or a zero vega, falls back to bisection. The
    ///      first guess is the larger of the at-the-money approximation and the premium's inflection point in
    ///      sigma, √(2 |ln(S/K)| / T), from which Newton converges monotonically (Manaster and Koehler, 1982).
    function impliedVol(uint256 price, uint256 spot, uint256 strike, uint256 time, bool isCall)
        internal
        pure
        returns (uint256 sigma)
    {
        BS.checkInputs(spot, strike, time, IV_MIN);
        uint256 intrinsic;
        uint256 cap;
        if (isCall) (intrinsic, cap) = (spot > strike ? spot - strike : 0, spot);
        else (intrinsic, cap) = (strike > spot ? strike - spot : 0, strike);
        if (price <= intrinsic || price >= cap) revert BS.PricerInputOutOfRange(ERR_PRICE);

        Search memory s = Search(price, spot, strike, time, isCall, IV_MIN, IV_MAX);
        (uint256 pLo,) = _priceVega(s, IV_MIN);
        if (price <= pLo) {
            if (price == pLo) return IV_MIN;
            revert BS.PricerInputOutOfRange(ERR_IV);
        }
        (uint256 pHi,) = _priceVega(s, IV_MAX);
        if (price >= pHi) {
            if (price == pHi) return IV_MAX;
            revert BS.PricerInputOutOfRange(ERR_IV);
        }

        sigma = _firstGuess(price - intrinsic, spot, strike, time);
        if (sigma < IV_MIN) sigma = IV_MIN;
        else if (sigma > IV_MAX) sigma = IV_MAX;

        bool done;
        for (uint256 i; i < IV_MAX_ROUNDS; ++i) {
            (sigma, done) = _step(s, sigma);
            if (done) break;
        }
    }

    /// @notice Spot moved by `shock` (WAD, -0.3e18 = -30%), rounded down.
    function shockedSpot(uint256 spot, int256 shock) internal pure returns (uint256) {
        if (shock < 0) {
            if (shock <= -1e18) revert BS.PricerInputOutOfRange(ERR_SHOCK); // at or below -100%
            // -WAD < shock < 0, so the cast is exact.
            // forge-lint: disable-next-line(unsafe-typecast)
            return BS.mulWad(spot, WAD - uint256(-shock));
        }
        // shock >= 0, so the cast is exact.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 up = uint256(shock);
        if (up > MAX_SHOCK) revert BS.PricerInputOutOfRange(ERR_SHOCK);
        return BS.mulWad(spot, WAD + up);
    }

    /// @notice USD value (WAD) the vault pays on `sold` options (WAD) settling at `price`, with settlement
    ///         rounding: a call pays (S - K) / S tokens per option, valued at S; a put pays K - S.
    function payoutValue(bool isCall, uint256 strike, uint256 sold, uint256 price) internal pure returns (uint256) {
        if (isCall) {
            if (price <= strike) return 0;
            uint256 perOption = BS.divWad(price - strike, price);
            return BS.mulWad(BS.mulWad(sold, perOption), price);
        }
        return strike > price ? BS.mulWad(sold, strike - price) : 0;
    }

    /// @notice The vault's payout (USD, WAD) at each shocked spot, and the worst (largest) of them.
    /// @param sold Options, WAD (1e18 = one option on one token).
    /// @param shocks Relative spot moves, WAD, each in (-100%, +1000%].
    function scenarioLoss(bool isCall, uint256 strike, uint256 sold, uint256 spot, int256[] memory shocks)
        internal
        pure
        returns (uint256 worst, uint256[] memory losses)
    {
        if (spot < BS.MIN_PRICE || spot > BS.MAX_PRICE) revert BS.PricerInputOutOfRange(BS.ERR_SPOT);
        if (strike < BS.MIN_PRICE || strike > BS.MAX_PRICE) revert BS.PricerInputOutOfRange(BS.ERR_STRIKE);
        losses = new uint256[](shocks.length);
        for (uint256 i; i < shocks.length; ++i) {
            uint256 loss = payoutValue(isCall, strike, sold, shockedSpot(spot, shocks[i]));
            if (loss > worst) worst = loss;
            losses[i] = loss;
        }
    }

    /// @dev One solver round: evaluate at `sigma`, tighten the bracket, take a Newton step (or bisect).
    function _step(Search memory s, uint256 sigma) private pure returns (uint256 next, bool done) {
        (uint256 p, uint256 vega) = _priceVega(s, sigma);
        if (p == s.price) return (sigma, true);
        bool above = p > s.price;
        if (above) s.hi = sigma;
        else s.lo = sigma;
        uint256 diff = above ? p - s.price : s.price - p;
        // Newton step when it lands strictly inside the bracket, bisection otherwise.
        next = (s.lo + s.hi) >> 1;
        if (vega != 0) {
            uint256 step = BS.divWad(diff, vega);
            if (above) {
                if (step < sigma - s.lo) next = sigma - step;
            } else if (step < s.hi - sigma) {
                next = sigma + step;
            }
        }
        uint256 moved = next > sigma ? next - sigma : sigma - next;
        done = moved <= IV_TOL || s.hi - s.lo <= IV_TOL || diff <= s.spot / IV_PRICE_TOL_DIV;
    }

    /// @dev Premium and vega at `sigma` (inputs already checked).
    function _priceVega(Search memory s, uint256 sigma) private pure returns (uint256 price, uint256 vega) {
        (uint256 d1Abs, bool d1Neg, uint256 volSqrtT, uint256 sqrtT) = BS.d1(s.spot, s.strike, s.time, sigma);
        (uint256 nd1, uint256 nd2) = BS.cdfs(d1Abs, d1Neg, volSqrtT);
        vega = s.spot * pdf(d1Abs) * sqrtT / WAD2;
        price = BS.premium(s.spot, s.strike, nd1, nd2, s.isCall);
    }

    /// @dev max(ATM guess, inflection point): time value ≈ S σ √T / √(2π), σ* = √(2 |ln(S/K)| / T).
    function _firstGuess(uint256 timeValue, uint256 spot, uint256 strike, uint256 time)
        private
        pure
        returns (uint256 sigma)
    {
        uint256 tWad = time * WAD / BS.SECONDS_PER_YEAR;
        sigma = timeValue * BS.SQRT_2PI * WAD / (spot * BS.sqrt(tWad * WAD));
        uint256 lnAbs = spot >= strike ? BS.lnGeOne(BS.divWad(spot, strike)) : BS.lnGeOne(BS.divWad(strike, spot));
        uint256 inflection = BS.sqrt(lnAbs * (2 * WAD) / tWad * WAD);
        if (inflection > sigma) sigma = inflection;
    }
}
