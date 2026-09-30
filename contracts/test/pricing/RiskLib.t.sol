// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {BlackScholesLib} from "../../src/pricing/BlackScholesLib.sol";
import {BlackScholesRef} from "../../src/pricing/BlackScholesRef.sol";
import {RiskLib} from "../../src/pricing/RiskLib.sol";
import {Test} from "forge-std/Test.sol";

contract RiskLibTest is Test {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant WEEK = 7 days;
    BlackScholesRef internal engine;

    function setUp() public {
        engine = new BlackScholesRef();
    }

    function _grid() internal pure returns (int256[] memory shocks) {
        shocks = new int256[](13);
        for (uint256 i; i < 13; ++i) {
            shocks[i] = (int256(i) - 6) * 0.05e18;
        }
    }

    // ---------------------------------------------------------------- greeks: known values

    /// S=250, K=275, 7 days, 60% vol. mpmath at 50 digits (research/risk_reference.py): delta 0.134468746012801522,
    /// gamma 0.010423844089171537, vega 7.49660020111651645, theta -0.321282865762136419 per day.
    function test_greeks_weeklyOtmCallMatchesMpmath() public view {
        (int256 d, uint256 g, uint256 v, int256 t) = engine.greeks(250 * WAD, 275 * WAD, WEEK, 0.6e18, true);
        assertApproxEqRel(d, 134_468_746_012_801_522, 1e6); // 1e-12 relative
        assertApproxEqRel(g, 10_423_844_089_171_537, 1e6);
        assertApproxEqRel(v, 7_496_600_201_116_516_450, 1e6);
        assertApproxEqRel(t, -321_282_865_762_136_419, 1e6);
    }

    function test_greeks_putSharesGammaVegaTheta() public view {
        (int256 dc, uint256 gc, uint256 vc, int256 tc) = engine.greeks(250 * WAD, 275 * WAD, WEEK, 0.6e18, true);
        (int256 dp, uint256 gp, uint256 vp, int256 tp) = engine.greeks(250 * WAD, 275 * WAD, WEEK, 0.6e18, false);
        assertEq(dc - dp, int256(WAD));
        assertEq(gc, gp);
        assertEq(vc, vp);
        assertEq(tc, tp);
    }

    function testFuzz_greeks_deltaEqualsQuoteDelta(uint256 s, uint256 k, uint256 t, uint256 v, bool isCall)
        public
        view
    {
        s = bound(s, 1e18, 10_000e18);
        k = bound(k, s / 2, s * 2);
        t = bound(t, 1 hours, 365 days);
        v = bound(v, 0.05e18, 3e18);
        (, int256 qd) = engine.quote(s, k, t, v, isCall);
        (int256 d, uint256 g, uint256 vega, int256 theta) = engine.greeks(s, k, t, v, isCall);
        assertEq(d, qd);
        // Long option: gamma and vega never negative, theta never positive (r = 0).
        assertGe(g, 0);
        assertGe(vega, 0);
        assertLe(theta, 0);
    }

    /// Vega is the derivative of the premium in sigma (central difference over ±1e-6 of volatility).
    function testFuzz_greeks_vegaIsPriceDerivative(uint256 s, uint256 m, uint256 t, uint256 v, bool isCall)
        public
        view
    {
        s = bound(s, 20e18, 2000e18);
        uint256 k = s * bound(m, 80, 120) / 100;
        t = bound(t, 2 days, 60 days);
        v = bound(v, 0.1e18, 1.5e18);
        (,, uint256 vega,) = engine.greeks(s, k, t, v, isCall);
        (uint256 up,) = engine.quote(s, k, t, v + 1e12, isCall);
        (uint256 dn,) = engine.quote(s, k, t, v - 1e12, isCall);
        uint256 fd = (up - dn) * WAD / 2e12;
        assertApproxEqAbs(fd, vega, vega / 1e5 + s / 1e8);
    }

    function test_greeks_rejectLikeQuote() public {
        vm.expectRevert(abi.encodeWithSelector(BlackScholesLib.PricerInputOutOfRange.selector, uint8(1)));
        engine.greeks(0, WAD, 1 days, 0.5e18, true);
        vm.expectRevert(abi.encodeWithSelector(BlackScholesLib.PricerInputOutOfRange.selector, uint8(3)));
        engine.greeks(WAD, WAD, 0, 0.5e18, true);
        vm.expectRevert(abi.encodeWithSelector(BlackScholesLib.PricerInputOutOfRange.selector, uint8(4)));
        engine.greeks(WAD, WAD, 1 days, 6e18, true);
    }

    // ---------------------------------------------------------------- implied volatility

    /// mpmath's exact premium for the weekly call (1.360283237652240758) implies 60%.
    function test_impliedVol_mpmathPremium() public view {
        uint256 iv = engine.impliedVol(1_360_283_237_652_240_758, 250 * WAD, 275 * WAD, WEEK, true);
        assertApproxEqAbs(iv, 0.6e18, 1e9);
    }

    /// Round trip: price(σ) → impliedVol → σ. The recovered σ always reproduces the premium to rounding noise, and
    /// equals σ within 1e-8 whenever the premium carries information (vega ≥ 1e-6 of spot).
    function testFuzz_impliedVol_roundTrip(uint256 s, uint256 m, uint256 t, uint256 v, bool isCall) public view {
        s = bound(s, 1e18, 5000e18);
        uint256 k = s * bound(m, 70, 130) / 100;
        t = bound(t, 1 hours, 90 days);
        v = bound(v, 0.05e18, 5e18);
        (uint256 p,) = engine.quote(s, k, t, v, isCall);
        uint256 intrinsic = isCall ? (s > k ? s - k : 0) : (k > s ? k - s : 0);
        vm.assume(p > intrinsic && p < (isCall ? s : k));
        uint256 iv = engine.impliedVol(p, s, k, t, isCall);
        (uint256 p2,) = engine.quote(s, k, t, iv, isCall);
        assertApproxEqAbs(p2, p, s / 1e13, "premium");
        (,, uint256 vega,) = engine.greeks(s, k, t, v, isCall);
        if (vega * 1e6 >= s) assertApproxEqAbs(iv, v, 1e10, "sigma");
    }

    function test_impliedVol_rejectsOutsideNoArbitrageBounds() public {
        bytes memory price = abi.encodeWithSelector(BlackScholesLib.PricerInputOutOfRange.selector, uint8(6));
        vm.expectRevert(price);
        engine.impliedVol(0, 100 * WAD, 100 * WAD, WEEK, true); // at intrinsic (0)
        vm.expectRevert(price);
        engine.impliedVol(100 * WAD, 100 * WAD, 100 * WAD, WEEK, true); // at the cap (spot)
        vm.expectRevert(price);
        engine.impliedVol(10 * WAD, 110 * WAD, 100 * WAD, WEEK, true); // at intrinsic (10)
        vm.expectRevert(price);
        engine.impliedVol(100 * WAD, 100 * WAD, 100 * WAD, WEEK, false); // at the cap (strike)
    }

    function test_impliedVol_rejectsOutsideSigmaRange() public {
        bytes memory range = abi.encodeWithSelector(BlackScholesLib.PricerInputOutOfRange.selector, uint8(7));
        (uint256 low,) = engine.quote(100 * WAD, 100 * WAD, WEEK, 0.02e18, true);
        vm.expectRevert(range);
        engine.impliedVol(low, 100 * WAD, 100 * WAD, WEEK, true);
        vm.expectRevert(range);
        engine.impliedVol(99 * WAD, 100 * WAD, 100 * WAD, WEEK, true);
    }

    function test_impliedVol_exactBounds() public view {
        (uint256 pLo,) = engine.quote(100 * WAD, 100 * WAD, WEEK, RiskLib.IV_MIN, true);
        (uint256 pHi,) = engine.quote(100 * WAD, 100 * WAD, WEEK, RiskLib.IV_MAX, true);
        assertEq(engine.impliedVol(pLo, 100 * WAD, 100 * WAD, WEEK, true), RiskLib.IV_MIN);
        assertEq(engine.impliedVol(pHi, 100 * WAD, 100 * WAD, WEEK, true), RiskLib.IV_MAX);
    }

    // ---------------------------------------------------------------- scenario loss

    function test_scenarioLoss_knownValues() public view {
        int256[] memory shocks = new int256[](3);
        (shocks[0], shocks[1], shocks[2]) = (-0.2e18, 0, 0.2e18);
        // 10 calls struck at 110, spot 100: +20% pays 10 × (120 − 110) = $100 (to rounding).
        (uint256 worst, uint256[] memory l) = engine.scenarioLoss(true, 110 * WAD, 10 * WAD, 100 * WAD, shocks);
        assertEq(l[0], 0);
        assertEq(l[1], 0);
        assertApproxEqAbs(l[2], 100 * WAD, 1e6);
        assertEq(worst, l[2]);
        // 10 puts struck at 90: −20% pays 10 × (90 − 80) = $100 exactly.
        (worst, l) = engine.scenarioLoss(false, 90 * WAD, 10 * WAD, 100 * WAD, shocks);
        assertEq(l[0], 100 * WAD);
        assertEq(worst, 100 * WAD);
        assertEq(l[2], 0);
    }

    /// Worst case on the ±30% grid: calls at +30%, puts at −30%, and never above the collateral's value.
    function testFuzz_scenarioLoss_worstAtGridEdge(uint256 s, uint256 m, uint256 sold, bool isCall) public view {
        s = bound(s, 1e18, 5000e18);
        uint256 k = s * bound(m, 70, 130) / 100;
        sold = bound(sold, 0, 1e30);
        (uint256 worst, uint256[] memory l) = engine.scenarioLoss(isCall, k, sold, s, _grid());
        assertEq(worst, isCall ? l[12] : l[0]);
        uint256 shocked = isCall ? s * 13 / 10 : s * 7 / 10;
        // Call collateral: `sold` tokens worth `shocked` each; put collateral: `sold × K`.
        assertLe(worst, (isCall ? shocked : k) * sold / WAD);
        for (uint256 i = 1; i < 13; ++i) {
            if (isCall) assertGe(l[i], l[i - 1]);
            else assertLe(l[i], l[i - 1]);
        }
    }

    function test_scenarioLoss_rejects() public {
        int256[] memory bad = new int256[](1);
        bad[0] = -1e18;
        bytes memory shock = abi.encodeWithSelector(BlackScholesLib.PricerInputOutOfRange.selector, uint8(8));
        vm.expectRevert(shock);
        engine.scenarioLoss(true, WAD, WAD, WAD, bad);
        bad[0] = 10e18 + 1;
        vm.expectRevert(shock);
        engine.scenarioLoss(true, WAD, WAD, WAD, bad);
        vm.expectRevert(abi.encodeWithSelector(BlackScholesLib.PricerInputOutOfRange.selector, uint8(1)));
        engine.scenarioLoss(true, WAD, WAD, 0, new int256[](0));
        vm.expectRevert(abi.encodeWithSelector(BlackScholesLib.PricerInputOutOfRange.selector, uint8(2)));
        engine.scenarioLoss(true, 0, WAD, WAD, new int256[](0));
        (uint256 worst, uint256[] memory l) = engine.scenarioLoss(true, WAD, WAD, WAD, new int256[](0));
        assertEq(worst, 0);
        assertEq(l.length, 0);
    }
}
