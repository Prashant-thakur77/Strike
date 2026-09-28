// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {BlackScholesLib} from "../../src/pricing/BlackScholesLib.sol";
import {BlackScholesRef} from "../../src/pricing/BlackScholesRef.sol";
import {Test} from "forge-std/Test.sol";

contract BlackScholesLibTest is Test {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant WEEK = 7 days;
    BlackScholesRef internal pricer;

    function setUp() public {
        pricer = new BlackScholesRef();
    }

    // ---------------------------------------------------------------- known values

    /// S=250, K=275, 7d, 60% vol. Closed form (Python, math.erfc): 1.36028323765224, delta 0.13446874601280.
    function test_quote_weeklyOtmCall() public view {
        (uint256 p, int256 d) = pricer.quote(250 * WAD, 275 * WAD, WEEK, 0.6e18, true);
        assertApproxEqAbs(p, 1_360_283_237_652_240_000, 1e9);
        assertApproxEqAbs(d, 134_468_746_012_801_400, 1e6);
    }

    function test_quote_atmCallEqualsPut() public view {
        // At the money with r = 0, call and put prices are equal.
        (uint256 c,) = pricer.quote(100 * WAD, 100 * WAD, 30 days, 0.5e18, true);
        (uint256 p,) = pricer.quote(100 * WAD, 100 * WAD, 30 days, 0.5e18, false);
        assertApproxEqAbs(c, p, 10);
    }

    function test_priceAndDeltaMatchQuote() public view {
        (uint256 p, int256 d) = pricer.quote(123 * WAD, 130 * WAD, 3 days, 0.8e18, false);
        assertEq(pricer.price(123 * WAD, 130 * WAD, 3 days, 0.8e18, false), p);
        assertEq(pricer.delta(123 * WAD, 130 * WAD, 3 days, 0.8e18, false), d);
    }

    function test_deepItmCallApproachesIntrinsic() public view {
        (uint256 p, int256 d) = pricer.quote(200 * WAD, 100 * WAD, 1 days, 0.3e18, true);
        assertApproxEqAbs(p, 100 * WAD, 1e9);
        assertEq(d, int256(WAD));
    }

    function test_deepOtmPutIsWorthless() public view {
        (uint256 p, int256 d) = pricer.quote(200 * WAD, 100 * WAD, 1 days, 0.3e18, false);
        assertEq(p, 0);
        assertEq(d, 0);
    }

    // ---------------------------------------------------------------- building blocks

    function test_lnGeOne() public pure {
        assertEq(BlackScholesLib.lnGeOne(WAD), 0);
        assertApproxEqAbs(BlackScholesLib.lnGeOne(2 * WAD), 693_147_180_559_945_309, 2);
        // e truncated to 18 decimals, so ln is 1 minus ~1e-17.
        assertApproxEqAbs(BlackScholesLib.lnGeOne(2_718_281_828_459_045_235), WAD, 20);
    }

    function test_expNeg() public pure {
        assertEq(BlackScholesLib.expNeg(0), WAD);
        assertApproxEqAbs(BlackScholesLib.expNeg(WAD), 367_879_441_171_442_321, 2);
        assertEq(BlackScholesLib.expNeg(42 * WAD), 0);
    }

    function test_normalCdf() public pure {
        assertEq(BlackScholesLib.normalCdf(0, false), WAD / 2);
        assertEq(BlackScholesLib.normalCdf(0, true), WAD / 2);
        assertApproxEqAbs(BlackScholesLib.normalCdf(1.96e18, false), 975_002_104_851_780_000, 1e4);
        assertApproxEqAbs(BlackScholesLib.normalCdf(8e18, true), 622, 1); // tail branch: N(-8) = 6.22e-16
        assertEq(BlackScholesLib.normalTail(38 * WAD), 0);
    }

    function testFuzz_sqrtIsFloor(uint256 x) public pure {
        uint256 r = BlackScholesLib.sqrt(x);
        assertLe(r * r, x);
        if (r < type(uint128).max) assertGt((r + 1) * (r + 1), x);
    }

    // ---------------------------------------------------------------- errors

    function test_revert_spotOutOfRange() public {
        vm.expectRevert(abi.encodeWithSelector(BlackScholesLib.PricerInputOutOfRange.selector, uint8(1)));
        pricer.quote(0, WAD, WEEK, 0.5e18, true);
        vm.expectRevert(abi.encodeWithSelector(BlackScholesLib.PricerInputOutOfRange.selector, uint8(1)));
        pricer.quote(1e13 * WAD, WAD, WEEK, 0.5e18, true);
    }

    function test_revert_strikeOutOfRange() public {
        vm.expectRevert(abi.encodeWithSelector(BlackScholesLib.PricerInputOutOfRange.selector, uint8(2)));
        pricer.quote(WAD, 1, WEEK, 0.5e18, true);
    }

    function test_revert_timeOutOfRange() public {
        vm.expectRevert(abi.encodeWithSelector(BlackScholesLib.PricerInputOutOfRange.selector, uint8(3)));
        pricer.quote(WAD, WAD, 0, 0.5e18, true);
        vm.expectRevert(abi.encodeWithSelector(BlackScholesLib.PricerInputOutOfRange.selector, uint8(3)));
        pricer.quote(WAD, WAD, 2 * 365 days + 1, 0.5e18, true);
    }

    function test_revert_volOutOfRange() public {
        vm.expectRevert(abi.encodeWithSelector(BlackScholesLib.PricerInputOutOfRange.selector, uint8(4)));
        pricer.quote(WAD, WAD, WEEK, 0.001e18, true);
        vm.expectRevert(abi.encodeWithSelector(BlackScholesLib.PricerInputOutOfRange.selector, uint8(4)));
        pricer.quote(WAD, WAD, WEEK, 6e18, true);
    }

    // ---------------------------------------------------------------- properties (fuzz)

    function _bound(uint256 s, uint256 k, uint256 t, uint256 v)
        internal
        pure
        returns (uint256, uint256, uint256, uint256)
    {
        return (bound(s, WAD, 5000 * WAD), bound(k, WAD, 5000 * WAD), bound(t, 60, 365 days), bound(v, 0.05e18, 3e18));
    }

    /// C - P = S - K (r = 0), up to 1e-14 of the larger of S and K.
    function testFuzz_putCallParity(uint256 s, uint256 k, uint256 t, uint256 v) public pure {
        (s, k, t, v) = _bound(s, k, t, v);
        (uint256 c,) = BlackScholesLib.quote(s, k, t, v, true);
        (uint256 p,) = BlackScholesLib.quote(s, k, t, v, false);
        int256 lhs = int256(c) - int256(p);
        int256 rhs = int256(s) - int256(k);
        uint256 tol = (s > k ? s : k) / 1e14 + 4;
        assertApproxEqAbs(lhs, rhs, tol);
    }

    /// Premium is within [intrinsic, cap]; delta within [0,1] for calls and [-1,0] for puts.
    function testFuzz_bounds(uint256 s, uint256 k, uint256 t, uint256 v, bool isCall) public pure {
        (s, k, t, v) = _bound(s, k, t, v);
        (uint256 p, int256 d) = BlackScholesLib.quote(s, k, t, v, isCall);
        uint256 cap = isCall ? s : k;
        uint256 intrinsic = isCall ? (s > k ? s - k : 0) : (k > s ? k - s : 0);
        assertLe(p, cap);
        assertGe(p + cap / 1e14 + 4, intrinsic);
        if (isCall) {
            assertGe(d, 0);
            assertLe(d, int256(WAD));
        } else {
            assertLe(d, 0);
            assertGe(d, -int256(WAD));
        }
    }

    /// A call is worth more with a higher spot, a lower strike, more time and more volatility.
    function testFuzz_callMonotonicity(uint256 s, uint256 k, uint256 t, uint256 v) public pure {
        (s, k, t, v) = _bound(s, k, t, v);
        (uint256 base,) = BlackScholesLib.quote(s, k, t, v, true);
        uint256 tol = s / 1e14 + 4;
        (uint256 up,) = BlackScholesLib.quote(s + s / 100, k, t, v, true);
        assertGe(up + tol, base, "spot");
        (uint256 lowK,) = BlackScholesLib.quote(s, k - k / 100, t, v, true);
        assertGe(lowK + tol, base, "strike");
        (uint256 moreT,) = BlackScholesLib.quote(s, k, t + 1 days, v, true);
        assertGe(moreT + tol, base, "time");
        (uint256 moreV,) = BlackScholesLib.quote(s, k, t, v + 0.05e18, true);
        assertGe(moreV + tol, base, "vol");
    }

    /// Call delta minus put delta is exactly one.
    function testFuzz_deltaParity(uint256 s, uint256 k, uint256 t, uint256 v) public pure {
        (s, k, t, v) = _bound(s, k, t, v);
        (, int256 dc) = BlackScholesLib.quote(s, k, t, v, true);
        (, int256 dp) = BlackScholesLib.quote(s, k, t, v, false);
        assertEq(dc - dp, int256(WAD));
    }

    function test_gas_quote() public {
        uint256 g = gasleft();
        pricer.quote(250 * WAD, 275 * WAD, WEEK, 0.6e18, true);
        emit log_named_uint("BlackScholesRef.quote gas", g - gasleft());
    }
}
