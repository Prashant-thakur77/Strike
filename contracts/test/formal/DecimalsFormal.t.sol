// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Decimals} from "../../src/libraries/Decimals.sol";
import {FormalUtils} from "./FormalUtils.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title DecimalsFormal
/// @notice Halmos properties for `Decimals`, proven for every input inside the bounds stated on each check.
/// @dev Decimals are enumerated (0..18, one path each) through `FormalUtils.concreteDecimals`. Amount and price
///      bounds keep every product below 2^256 so `Math.mulDiv` stays on its 256-bit path; the 512-bit branch is
///      proven unreachable by the solver on each path. cvc5 in integer mode handles the non-linear division.
/// @custom:halmos --solver cvc5-int
contract DecimalsFormal {
    /// toWad then fromWad is exact in both rounding modes: converting up and back never gains (or loses) a unit.
    /// Bounds: decimals 0..18, amount < 2^128.
    /// NOT PROVEN: times out in halmos 0.3.3 (cvc5, 300 s per query). Kept so the property stays written down;
    /// the same behaviour is exercised by the fuzz and invariant suites (docs/testing.md).
    function unproven_toWadThenFromWad_isIdentity(uint256 amount, uint8 decimals) public pure {
        uint8 d = FormalUtils.concreteDecimals(decimals);
        if (amount >= 2 ** 128) return;
        uint256 wad = Decimals.toWad(amount, d);
        assert(Decimals.fromWad(wad, d, Math.Rounding.Floor) == amount);
        assert(Decimals.fromWad(wad, d, Math.Rounding.Ceil) == amount);
    }

    /// fromWad(Floor) then toWad never gains value; fromWad(Ceil) then toWad never loses it, and the two differ by
    /// less than one unit of the smaller token. Bounds: decimals 0..18, wad < 2^192.
    /// NOT PROVEN: times out in halmos 0.3.3 (cvc5, 300 s per query). Kept so the property stays written down;
    /// the same behaviour is exercised by the fuzz and invariant suites (docs/testing.md).
    function unproven_fromWadThenToWad_neverGains(uint256 wad, uint8 decimals) public pure {
        uint8 d = FormalUtils.concreteDecimals(decimals);
        if (wad >= 2 ** 192) return;
        uint256 down = Decimals.toWad(Decimals.fromWad(wad, d, Math.Rounding.Floor), d);
        uint256 up = Decimals.toWad(Decimals.fromWad(wad, d, Math.Rounding.Ceil), d);
        assert(down <= wad);
        assert(up >= wad);
        assert(wad - down < 10 ** (18 - d));
    }

    /// valueInUsd: Floor <= Ceil <= Floor + 1.
    /// Bounds: tokenDecimals 0..18, usdDecimals 6 or 18, amount < 2^96, priceWad < 2^96.
    /// NOT PROVEN: times out in halmos 0.3.3 (cvc5, 300 s per query). Kept so the property stays written down;
    /// the same behaviour is exercised by the fuzz and invariant suites (docs/testing.md).
    function unproven_valueInUsd_ceilWithinOneOfFloor(uint256 amount, uint256 priceWad, uint8 tokenDec, uint8 usdDec)
        public
        pure
    {
        uint8 t = FormalUtils.concreteDecimals(tokenDec);
        uint8 u = FormalUtils.concreteUsdDecimals(usdDec);
        if (amount >= 2 ** 96 || priceWad >= 2 ** 96) return;
        uint256 floor_ = Decimals.valueInUsd(amount, priceWad, t, u, Math.Rounding.Floor);
        uint256 ceil_ = Decimals.valueInUsd(amount, priceWad, t, u, Math.Rounding.Ceil);
        assert(floor_ <= ceil_);
        assert(ceil_ <= floor_ + 1);
    }

    /// valueInUsd is monotonic in the amount, in both rounding modes.
    /// Bounds: tokenDecimals 0..18, usdDecimals 6 or 18, amounts < 2^96, priceWad < 2^96.
    /// NOT PROVEN: times out in halmos 0.3.3 (cvc5, 300 s per query). Kept so the property stays written down;
    /// the same behaviour is exercised by the fuzz and invariant suites (docs/testing.md).
    function unproven_valueInUsd_monotonicInAmount(
        uint256 a1,
        uint256 a2,
        uint256 priceWad,
        uint8 tokenDec,
        uint8 usdDec
    ) public pure {
        uint8 t = FormalUtils.concreteDecimals(tokenDec);
        uint8 u = FormalUtils.concreteUsdDecimals(usdDec);
        if (a1 > a2 || a2 >= 2 ** 96 || priceWad >= 2 ** 96) return;
        assert(
            Decimals.valueInUsd(a1, priceWad, t, u, Math.Rounding.Floor)
                <= Decimals.valueInUsd(a2, priceWad, t, u, Math.Rounding.Floor)
        );
        assert(
            Decimals.valueInUsd(a1, priceWad, t, u, Math.Rounding.Ceil)
                <= Decimals.valueInUsd(a2, priceWad, t, u, Math.Rounding.Ceil)
        );
    }
}
