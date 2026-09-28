// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title BlackScholesLib
/// @notice Fixed-point (WAD) Black-Scholes price and delta for European options, zero interest rate.
/// @dev Mirrors `stylus/pricer/src/math.rs` operation for operation, so the Solidity reference and the Stylus
///      pricer return identical results. `ln` uses the atanh series, `exp` a range-reduced Taylor series and the
///      normal CDF the Hart (1968) rational approximation as published by West (2005). All intermediate values are
///      unsigned; signs are tracked explicitly so rounding is identical in both languages.
library BlackScholesLib {
    uint256 internal constant WAD = 1e18;
    /// @dev ln(2) * 1e18, rounded down.
    uint256 internal constant LN2 = 693_147_180_559_945_309;
    uint256 internal constant SECONDS_PER_YEAR = 31_536_000;
    /// @dev sqrt(2 * pi) * 1e18, rounded down.
    uint256 internal constant SQRT_2PI = 2_506_628_274_631_000_502;

    uint256 internal constant MIN_PRICE = 1e6;
    uint256 internal constant MAX_PRICE = 1e12 * WAD;
    uint256 internal constant MIN_TIME = 1;
    uint256 internal constant MAX_TIME = 2 * SECONDS_PER_YEAR;
    uint256 internal constant MIN_VOL = WAD / 100;
    uint256 internal constant MAX_VOL = 5 * WAD;

    uint8 internal constant ERR_SPOT = 1;
    uint8 internal constant ERR_STRIKE = 2;
    uint8 internal constant ERR_TIME = 3;
    uint8 internal constant ERR_VOL = 4;

    uint256 private constant A0 = 35_262_496_599_891_100;
    uint256 private constant A1 = 700_383_064_443_688_000;
    uint256 private constant A2 = 6_373_962_203_531_650_000;
    uint256 private constant A3 = 33_912_866_078_383_000_000;
    uint256 private constant A4 = 112_079_291_497_871_000_000;
    uint256 private constant A5 = 221_213_596_169_931_000_000;
    uint256 private constant A6 = 220_206_867_912_376_000_000;
    uint256 private constant B0 = 88_388_347_648_318_400;
    uint256 private constant B1 = 1_755_667_163_182_640_000;
    uint256 private constant B2 = 16_064_177_579_207_000_000;
    uint256 private constant B3 = 86_780_732_202_946_100_000;
    uint256 private constant B4 = 296_564_248_779_674_000_000;
    uint256 private constant B5 = 637_333_633_378_831_000_000;
    uint256 private constant B6 = 793_826_512_519_948_000_000;
    uint256 private constant B7 = 440_413_735_824_752_000_000;
    uint256 private constant CUTOFF = 7_071_067_811_865_470_000;
    uint256 private constant TAIL_ZERO = 37 * WAD;
    uint256 private constant EXP_ZERO = 42 * WAD;

    /// @notice An input is outside the supported range. which: 1 spot, 2 strike, 3 time, 4 volatility.
    error PricerInputOutOfRange(uint8 which);

    /// @notice Premium (USD per token, WAD) and delta (WAD, negative for puts).
    /// @param spot Spot price, USD per token, WAD.
    /// @param strike Strike price, USD per token, WAD.
    /// @param time Seconds to expiry.
    /// @param sigma Annualised volatility, WAD (0.6e18 = 60%).
    /// @param isCall True for a call, false for a put.
    function quote(uint256 spot, uint256 strike, uint256 time, uint256 sigma, bool isCall)
        internal
        pure
        returns (uint256 price, int256 delta)
    {
        if (spot < MIN_PRICE || spot > MAX_PRICE) revert PricerInputOutOfRange(ERR_SPOT);
        if (strike < MIN_PRICE || strike > MAX_PRICE) revert PricerInputOutOfRange(ERR_STRIKE);
        if (time < MIN_TIME || time > MAX_TIME) revert PricerInputOutOfRange(ERR_TIME);
        if (sigma < MIN_VOL || sigma > MAX_VOL) revert PricerInputOutOfRange(ERR_VOL);

        (uint256 nd1, uint256 nd2) = _cdfs(spot, strike, time, sigma);

        if (isCall) {
            uint256 a = _mulWad(spot, nd1);
            uint256 b = _mulWad(strike, nd2);
            price = a > b ? a - b : 0;
            // nd1 <= 1e18, so the cast is exact.
            // forge-lint: disable-next-line(unsafe-typecast)
            delta = int256(nd1);
        } else {
            uint256 a = _mulWad(strike, WAD - nd2);
            uint256 b = _mulWad(spot, WAD - nd1);
            price = a > b ? a - b : 0;
            // forge-lint: disable-next-line(unsafe-typecast)
            delta = int256(nd1) - int256(WAD);
        }
    }

    /// @notice Floor of the square root (integer Newton iteration, same as the Rust side).
    function sqrt(uint256 x) internal pure returns (uint256 z) {
        if (x == 0) return 0;
        uint256 bits = _bitLen(x);
        z = uint256(1) << ((bits + 1) / 2);
        while (true) {
            uint256 y = (z + x / z) >> 1;
            if (y >= z) return z;
            z = y;
        }
    }

    /// @notice e^(-y) for y >= 0 (WAD).
    function expNeg(uint256 y) internal pure returns (uint256) {
        if (y >= EXP_ZERO) return 0;
        uint256 k = y / LN2;
        uint256 r = y - k * LN2;
        uint256 eNegR = (WAD * WAD) / _expSmall(r);
        return eNegR >> k;
    }

    /// @notice ln(x) for x >= 1 (WAD). Returns a non-negative WAD.
    function lnGeOne(uint256 x) internal pure returns (uint256) {
        uint256 q = x / WAD;
        uint256 k = _bitLen(q) - 1;
        uint256 m = x >> k;
        uint256 z = _divWad(m - WAD, m + WAD);
        uint256 z2 = _mulWad(z, z);
        uint256 sum = 0;
        uint256 term = z;
        uint256 n = 1;
        while (term != 0) {
            sum += term / n;
            term = _mulWad(term, z2);
            n += 2;
        }
        return k * LN2 + sum * 2;
    }

    /// @notice N(-x) for x >= 0 (WAD).
    function normalTail(uint256 x) internal pure returns (uint256) {
        if (x > TAIL_ZERO) return 0;
        uint256 e = expNeg(_mulWad(x, x) / 2);
        if (x < CUTOFF) {
            uint256 num = _mulWad(A0, x) + A1;
            num = _mulWad(num, x) + A2;
            num = _mulWad(num, x) + A3;
            num = _mulWad(num, x) + A4;
            num = _mulWad(num, x) + A5;
            num = _mulWad(num, x) + A6;
            num = _mulWad(e, num);
            uint256 den = _mulWad(B0, x) + B1;
            den = _mulWad(den, x) + B2;
            den = _mulWad(den, x) + B3;
            den = _mulWad(den, x) + B4;
            den = _mulWad(den, x) + B5;
            den = _mulWad(den, x) + B6;
            den = _mulWad(den, x) + B7;
            return _divWad(num, den);
        }
        uint256 b = x + WAD * 65 / 100;
        b = x + _divWad(4 * WAD, b);
        b = x + _divWad(3 * WAD, b);
        b = x + _divWad(2 * WAD, b);
        b = x + _divWad(WAD, b);
        return _divWad(_divWad(e, b), SQRT_2PI);
    }

    /// @notice Standard normal CDF of a signed value given as (|x|, x < 0).
    function normalCdf(uint256 abs, bool negative) internal pure returns (uint256) {
        uint256 tail = normalTail(abs);
        return negative ? tail : WAD - tail;
    }

    /// @dev N(d1) and N(d2).
    function _cdfs(uint256 spot, uint256 strike, uint256 time, uint256 sigma)
        private
        pure
        returns (uint256 nd1, uint256 nd2)
    {
        (uint256 d1Abs, bool d1Neg, uint256 volSqrtT) = _d1(spot, strike, time, sigma);
        nd1 = normalCdf(d1Abs, d1Neg);
        // d2 = d1 - sigma sqrt(T).
        if (d1Neg) {
            nd2 = normalCdf(d1Abs + volSqrtT, true);
        } else if (d1Abs >= volSqrtT) {
            nd2 = normalCdf(d1Abs - volSqrtT, false);
        } else {
            nd2 = normalCdf(volSqrtT - d1Abs, true);
        }
    }

    /// @dev |d1|, sign of d1, and sigma sqrt(T).
    function _d1(uint256 spot, uint256 strike, uint256 time, uint256 sigma)
        private
        pure
        returns (uint256 d1Abs, bool d1Neg, uint256 volSqrtT)
    {
        uint256 tWad = time * WAD / SECONDS_PER_YEAR;
        volSqrtT = _mulWad(sigma, sqrt(tWad * WAD));
        uint256 halfVar = _mulWad(_mulWad(sigma, sigma), tWad) / 2;

        // ln(S/K) as (|ln|, sign).
        (uint256 lnAbs, bool lnNeg) =
            spot >= strike ? (lnGeOne(_divWad(spot, strike)), false) : (lnGeOne(_divWad(strike, spot)), true);

        // d1 numerator = ln(S/K) + sigma^2 T / 2.
        uint256 d1Num;
        if (!lnNeg) {
            d1Num = lnAbs + halfVar;
        } else if (lnAbs > halfVar) {
            d1Num = lnAbs - halfVar;
            d1Neg = true;
        } else {
            d1Num = halfVar - lnAbs;
        }
        d1Abs = _divWad(d1Num, volSqrtT);
    }

    function _expSmall(uint256 r) private pure returns (uint256 sum) {
        sum = WAD;
        uint256 term = WAD;
        uint256 n = 1;
        while (true) {
            term = _mulWad(term, r) / n;
            if (term == 0) break;
            sum += term;
            ++n;
        }
    }

    function _mulWad(uint256 a, uint256 b) private pure returns (uint256) {
        return a * b / WAD;
    }

    function _divWad(uint256 a, uint256 b) private pure returns (uint256) {
        return a * WAD / b;
    }

    /// @dev Number of significant bits (0 for 0).
    function _bitLen(uint256 x) private pure returns (uint256) {
        return x == 0 ? 0 : Math.log2(x) + 1;
    }
}
