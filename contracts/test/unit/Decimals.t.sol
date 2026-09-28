// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Decimals} from "../../src/libraries/Decimals.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Test, stdError} from "forge-std/Test.sol";

/// @notice Exposes the internal library functions so reverts cross a call boundary.
contract DecimalsHarness {
    function toWad(uint256 amount, uint8 decimals) external pure returns (uint256) {
        return Decimals.toWad(amount, decimals);
    }

    function fromWad(uint256 wad, uint8 decimals, Math.Rounding rounding) external pure returns (uint256) {
        return Decimals.fromWad(wad, decimals, rounding);
    }

    function valueWad(uint256 amount, uint256 priceWad, uint8 tokenDecimals, Math.Rounding rounding)
        external
        pure
        returns (uint256)
    {
        return Decimals.valueWad(amount, priceWad, tokenDecimals, rounding);
    }

    function valueInUsd(
        uint256 amount,
        uint256 priceWad,
        uint8 tokenDecimals,
        uint8 usdDecimals,
        Math.Rounding rounding
    ) external pure returns (uint256) {
        return Decimals.valueInUsd(amount, priceWad, tokenDecimals, usdDecimals, rounding);
    }

    function wadUnit() external pure returns (uint256) {
        return Decimals.WAD;
    }
}

contract DecimalsTest is Test {
    DecimalsHarness internal h;

    function setUp() public {
        h = new DecimalsHarness();
    }

    function test_WAD_isOneE18() public view {
        assertEq(h.wadUnit(), 1e18);
    }

    // ------------------------------------------------------------------ toWad

    function test_toWad_scalesUp() public view {
        assertEq(h.toWad(1e6, 6), 1e18);
        assertEq(h.toWad(250e8, 8), 250e18);
        assertEq(h.toWad(7, 0), 7e18);
        assertEq(h.toWad(0, 6), 0);
    }

    function test_toWad_identityAt18() public view {
        assertEq(h.toWad(123_456_789, 18), 123_456_789);
    }

    function test_toWad_revertsAbove18Decimals() public {
        vm.expectRevert(abi.encodeWithSelector(Decimals.UnsupportedDecimals.selector, uint8(19)));
        h.toWad(1, 19);
        vm.expectRevert(abi.encodeWithSelector(Decimals.UnsupportedDecimals.selector, uint8(255)));
        h.toWad(1, 255);
    }

    function test_toWad_revertsOnOverflow() public {
        vm.expectRevert(stdError.arithmeticError);
        h.toWad(type(uint256).max, 0);
    }

    // ------------------------------------------------------------------ fromWad

    function test_fromWad_scalesDown() public view {
        assertEq(h.fromWad(1e18, 6, Math.Rounding.Floor), 1e6);
        assertEq(h.fromWad(250e18, 8, Math.Rounding.Floor), 250e8);
        assertEq(h.fromWad(5e18, 0, Math.Rounding.Floor), 5);
        assertEq(h.fromWad(42, 18, Math.Rounding.Floor), 42);
    }

    function test_fromWad_roundsInTheRequestedDirection() public view {
        // 1.5e12 wei of a WAD is 1.5 units of a 6-decimal token.
        assertEq(h.fromWad(1.5e12, 6, Math.Rounding.Floor), 1);
        assertEq(h.fromWad(1.5e12, 6, Math.Rounding.Ceil), 2);
        assertEq(h.fromWad(1, 6, Math.Rounding.Floor), 0);
        assertEq(h.fromWad(1, 6, Math.Rounding.Ceil), 1);
        // Exact values do not round.
        assertEq(h.fromWad(2e12, 6, Math.Rounding.Ceil), 2);
    }

    function test_fromWad_revertsAbove18Decimals() public {
        vm.expectRevert(abi.encodeWithSelector(Decimals.UnsupportedDecimals.selector, uint8(19)));
        h.fromWad(1e18, 19, Math.Rounding.Floor);
    }

    // ------------------------------------------------------------------ valueWad

    function test_valueWad_pricesTokenAmounts() public view {
        // 2 tokens (18 decimals) at $250 = $500.
        assertEq(h.valueWad(2e18, 250e18, 18, Math.Rounding.Floor), 500e18);
        // 3 USDG (6 decimals) at $1 = $3.
        assertEq(h.valueWad(3e6, 1e18, 6, Math.Rounding.Floor), 3e18);
        assertEq(h.valueWad(0, 250e18, 18, Math.Rounding.Floor), 0);
    }

    function test_valueWad_roundsInTheRequestedDirection() public view {
        // 1 wei of an 18-decimal token at $0.5 = 0.5 wei of USD.
        assertEq(h.valueWad(1, 0.5e18, 18, Math.Rounding.Floor), 0);
        assertEq(h.valueWad(1, 0.5e18, 18, Math.Rounding.Ceil), 1);
    }

    // ------------------------------------------------------------------ valueInUsd

    function test_valueInUsd_pricesInStablecoinUnits() public view {
        // 2 TSLA at $250 = 500 USDG (6 decimals).
        assertEq(h.valueInUsd(2e18, 250e18, 18, 6, Math.Rounding.Floor), 500e6);
        // 1 wei of TSLA at $250 is 2.5e-16 USDG: rounds to 0 or 1.
        assertEq(h.valueInUsd(1, 250e18, 18, 6, Math.Rounding.Floor), 0);
        assertEq(h.valueInUsd(1, 250e18, 18, 6, Math.Rounding.Ceil), 1);
        // 18-decimal stablecoin equals valueWad.
        assertEq(h.valueInUsd(3e18, 7e18, 18, 18, Math.Rounding.Floor), 21e18);
        // 0-decimal token, 0-decimal stablecoin.
        assertEq(h.valueInUsd(4, 3e18, 0, 0, Math.Rounding.Floor), 12);
    }

    function test_valueInUsd_acceptsBoundaryDecimals() public view {
        assertEq(h.valueInUsd(1e36, 1e18, 36, 18, Math.Rounding.Floor), 1e18);
    }

    function test_valueInUsd_revertsOnUsdDecimalsAbove18() public {
        vm.expectRevert(abi.encodeWithSelector(Decimals.UnsupportedDecimals.selector, uint8(19)));
        h.valueInUsd(1e18, 1e18, 18, 19, Math.Rounding.Floor);
    }

    function test_valueInUsd_revertsOnTokenDecimalsAbove36() public {
        vm.expectPartialRevert(Decimals.UnsupportedDecimals.selector);
        h.valueInUsd(1e18, 1e18, 37, 6, Math.Rounding.Floor);
    }

    /// Bug: the tokenDecimals > 36 branch reports `usdDecimals` (6) instead of the offending `tokenDecimals` (37).
    function test_regression_valueInUsdReportsTheBadTokenDecimals() public {
        vm.expectRevert(abi.encodeWithSelector(Decimals.UnsupportedDecimals.selector, uint8(37)));
        h.valueInUsd(1e18, 1e18, 37, 6, Math.Rounding.Floor);
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_toWadFromWad_roundTrips(uint256 amount, uint8 decimals) public view {
        decimals = uint8(bound(decimals, 0, 18));
        amount = bound(amount, 0, type(uint128).max);
        uint256 wad = h.toWad(amount, decimals);
        assertEq(h.fromWad(wad, decimals, Math.Rounding.Floor), amount);
        assertEq(h.fromWad(wad, decimals, Math.Rounding.Ceil), amount);
    }

    function testFuzz_fromWad_ceilIsFloorOrFloorPlusOne(uint256 wad, uint8 decimals) public view {
        decimals = uint8(bound(decimals, 0, 18));
        uint256 lo = h.fromWad(wad, decimals, Math.Rounding.Floor);
        uint256 hi = h.fromWad(wad, decimals, Math.Rounding.Ceil);
        assertGe(hi, lo);
        assertLe(hi - lo, 1);
        // Floor never over-states: scaling it back up stays at or below the input.
        assertLe(lo * 10 ** (18 - decimals), wad);
    }

    function testFuzz_valueInUsd_matchesValueWadThenFromWad(
        uint256 amount,
        uint256 priceWad,
        uint8 tokenDecimals,
        uint8 usdDecimals
    ) public view {
        amount = bound(amount, 0, 1e30);
        priceWad = bound(priceWad, 0, 1e24);
        tokenDecimals = uint8(bound(tokenDecimals, 0, 36));
        usdDecimals = uint8(bound(usdDecimals, 0, 18));
        // Exact at 18 decimals: one mulDiv equals valueWad.
        assertEq(
            h.valueInUsd(amount, priceWad, tokenDecimals, 18, Math.Rounding.Floor),
            h.valueWad(amount, priceWad, tokenDecimals, Math.Rounding.Floor)
        );
        // Rounding once is never worse than rounding twice.
        uint256 once = h.valueInUsd(amount, priceWad, tokenDecimals, usdDecimals, Math.Rounding.Floor);
        uint256 twice = h.fromWad(
            h.valueWad(amount, priceWad, tokenDecimals, Math.Rounding.Floor), usdDecimals, Math.Rounding.Floor
        );
        assertGe(once, twice);
        uint256 onceUp = h.valueInUsd(amount, priceWad, tokenDecimals, usdDecimals, Math.Rounding.Ceil);
        assertGe(onceUp, once);
        assertLe(onceUp - once, 1);
    }

    function testFuzz_toWad_revertsAbove18(uint8 decimals) public {
        decimals = uint8(bound(decimals, 19, 255));
        vm.expectRevert(abi.encodeWithSelector(Decimals.UnsupportedDecimals.selector, decimals));
        h.toWad(1, decimals);
    }
}
