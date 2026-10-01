// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {BlackScholesLib} from "../../src/pricing/BlackScholesLib.sol";
import {BlackScholesRef} from "../../src/pricing/BlackScholesRef.sol";
import {RiskLib} from "../../src/pricing/RiskLib.sol";
import {Test, stdError} from "forge-std/Test.sol";

/// @notice Audit 2026-10-01 (v3): the risk engine (`RiskLib`, and the Rust twin over FFI) at the edges of its
///         domain. The engine is view-only in the protocol: `greeks` feeds the `SeriesRisk` event, the rest the
///         `RiskLens`; a revert here costs nobody funds, a wrong number misleads the risk panel.
contract AuditV3RiskTest is Test {
    BlackScholesRef internal engine;
    string internal cli;

    struct V {
        uint256 s;
        uint256 k;
        uint256 t;
        uint256 v;
        bool call;
    }

    function setUp() public {
        engine = new BlackScholesRef();
        cli = vm.envOr("PRICER_CLI", string(""));
    }

    /// Corners of the input domain (spot and strike in [1e-12, 1e12] USD, tenor in [1 s, 2 y], vol in [1%, 500%]).
    function _vectors() internal pure returns (V[] memory vs) {
        vs = new V[](12);
        vs[0] = V(100e18, 1000e18, 1, 0.01e18, true); // deep out of the money, one second, 1%: phi(d1) = 0
        vs[1] = V(1000e18, 100e18, 1, 0.01e18, true); // deep in the money: premium = intrinsic value
        vs[2] = V(1e6, 1e6, 1, 0.01e18, true); // smallest spot, strike, tenor and vol
        vs[3] = V(1e30, 1e30, 2 * 365 days, 5e18, false); // largest
        vs[4] = V(1e6, 1e30, 1, 0.01e18, false); // S / K = 1e-24
        vs[5] = V(1e30, 1e6, 2 * 365 days, 5e18, true); // S / K = 1e24
        vs[6] = V(250e18, 250e18, 1, 0.6e18, true); // at the money with one second left
        vs[7] = V(250e18, 250e18, 2 * 365 days, 5e18, false); // at the money, two years, 500%
        vs[8] = V(250e18, 275e18, 7 days, 0.6e18, true); // the weekly TSLA call
        vs[9] = V(250e18, 235e18, 7 days, 0.6e18, false); // and put
        vs[10] = V(1e18, 1e18 + 1, 1 hours, 0.05e18, true); // a strike one wei above spot
        vs[11] = V(5000e18, 4999.99e18, 30 days, 2e18, false);
    }

    function _boundaryShocks() internal pure returns (int256[] memory shocks) {
        shocks = new int256[](3);
        (shocks[0], shocks[1], shocks[2]) = (-0.999999e18, 0, 10e18);
    }

    function _code(bytes memory err) internal pure returns (uint8 code) {
        assertEq(err.length, 36, "revert data");
        assertEq(bytes4(err), BlackScholesLib.PricerInputOutOfRange.selector);
        assembly {
            code := mload(add(err, 36))
        }
    }

    // ================================================================== held
    /// At every corner the greeks and the scenario loss are computed without a revert and inside their bounds,
    /// and the implied volatility of the engine's own premium either reproduces it or is refused with code 6
    /// (premium at intrinsic value or the cap) or 7 (outside [5%, 500%]), never with anything else.
    function test_AUDIT3_safe_riskEngineEdgeVectors() public {
        V[] memory vs = _vectors();
        for (uint256 i; i < vs.length; ++i) {
            V memory x = vs[i];
            (uint256 p, int256 quoteDelta) = engine.quote(x.s, x.k, x.t, x.v, x.call);
            (int256 delta, uint256 gamma, uint256 vega, int256 theta) = engine.greeks(x.s, x.k, x.t, x.v, x.call);
            assertEq(delta, quoteDelta, "delta");
            assertLe(theta, 0, "theta");
            assertLe(vega, x.s * 6 / 10, "vega");
            gamma;
            _checkImpliedVol(p, x);

            (uint256 worst, uint256[] memory losses) = engine.scenarioLoss(x.call, x.k, 1e30, x.s, _boundaryShocks()); // 1e12 options
            assertEq(losses.length, 3);
            for (uint256 j; j < 3; ++j) {
                assertLe(losses[j], worst);
                uint256 shocked = RiskLib.shockedSpot(x.s, _boundaryShocks()[j]);
                assertLe(losses[j], x.call ? 1e30 * shocked / 1e18 : 1e30 * x.k / 1e18, "loss bound");
            }
        }
    }

    function _checkImpliedVol(uint256 p, V memory x) internal view {
        try engine.impliedVol(p, x.s, x.k, x.t, x.call) returns (uint256 iv) {
            assertGe(iv, RiskLib.IV_MIN);
            assertLe(iv, RiskLib.IV_MAX);
            (uint256 q,) = engine.quote(x.s, x.k, x.t, iv, x.call);
            (,, uint256 vega,) = engine.greeks(x.s, x.k, x.t, iv, x.call);
            assertLe(q > p ? q - p : p - q, _ivTolerance(x.s, vega), "premium at the solved sigma");
        } catch (bytes memory err) {
            uint8 code = _code(err);
            assertTrue(code == 6 || code == 7, "unexpected rejection");
        }
    }

    /// The solver stops once a step moves sigma by at most 1e-12 (the premium then moves by at most about
    /// vega x 1e-12), the bracket is that narrow, or the premium is within spot / 1e15 of the target.
    function _ivTolerance(uint256 spot, uint256 vega) internal pure returns (uint256) {
        return vega / 5e11 + spot / 1e14 + 2;
    }

    /// For any premium, spot, strike and tenor, `impliedVol` either returns a sigma inside [5%, 500%] whose premium
    /// is the target to within the solver's tolerance, or reverts with code 6 or 7. No other revert, no panic.
    function testFuzz_AUDIT3_safe_impliedVolTerminatesInRange(uint256 p, uint256 s, uint256 k, uint256 t, bool call)
        public
        view
    {
        s = bound(s, 1e6, 1e30);
        k = bound(k, s / 4 < 1e6 ? 1e6 : s / 4, s * 4 > 1e30 ? 1e30 : s * 4);
        t = bound(t, 1, 2 * 365 days);
        p = bound(p, 0, call ? s : k);
        _checkImpliedVol(p, V(s, k, t, 0, call));
    }

    /// I-02 (Info, no fix): an absurd position (more options than there are wei) overflows the payout product.
    /// Solidity reverts with a checked-arithmetic panic; the Rust engine's `mul_wad` panics on the same product,
    /// which is a revert in Stylus (without the panic code). Both refuse; only the revert data differs. The
    /// largest position the protocol can represent (1e12 options at the largest price) does not overflow.
    function test_AUDIT3_info_scenarioLossOverflowRevertsOnBothSides() public {
        int256[] memory none = new int256[](1);
        vm.expectRevert(stdError.arithmeticError);
        engine.scenarioLoss(true, 100e18, type(uint256).max, 110e18, none);
        vm.expectRevert(stdError.arithmeticError);
        engine.scenarioLoss(false, 100e18, type(uint256).max, 90e18, none);
        engine.scenarioLoss(true, 1e30, 1e30, 1e30, _boundaryShocks());
        engine.scenarioLoss(false, 1e30, 1e30, 1e30, _boundaryShocks());
    }

    // ------------------------------------------------------------------ Rust twin over FFI (needs PRICER_CLI)

    function _ffi(string memory name, uint256 a, uint256 b, uint256 c, uint256 d, bool e)
        internal
        returns (bytes memory)
    {
        string[] memory cmd = new string[](7);
        (cmd[0], cmd[1]) = (cli, name);
        (cmd[2], cmd[3], cmd[4], cmd[5]) = (vm.toString(a), vm.toString(b), vm.toString(c), vm.toString(d));
        cmd[6] = e ? "1" : "0";
        return vm.ffi(cmd);
    }

    /// The corner vectors give identical greeks, implied volatility (or rejection code) and scenario losses in the
    /// Rust engine compiled into the Stylus contract.
    function test_AUDIT3_safe_edgeVectorsRustEqualsSolidity() public {
        vm.skip(bytes(cli).length == 0);
        V[] memory vs = _vectors();
        for (uint256 i; i < vs.length; ++i) {
            _rustGreeksEqual(vs[i]);
            _rustImpliedVolEqual(vs[i]);
            _rustScenarioEqual(vs[i]);
        }
    }

    function _rustGreeksEqual(V memory x) internal {
        (bool ok, int256 rd, uint256 rg, uint256 rv, int256 rt,) =
            abi.decode(_ffi("greeks", x.s, x.k, x.t, x.v, x.call), (bool, int256, uint256, uint256, int256, uint8));
        (int256 d, uint256 g, uint256 v, int256 t) = engine.greeks(x.s, x.k, x.t, x.v, x.call);
        assertTrue(ok);
        assertEq(d, rd, "delta");
        assertEq(g, rg, "gamma");
        assertEq(v, rv, "vega");
        assertEq(t, rt, "theta");
    }

    function _rustImpliedVolEqual(V memory x) internal {
        (uint256 p,) = engine.quote(x.s, x.k, x.t, x.v, x.call);
        (bool ok, uint256 rustIv, uint8 rustCode) =
            abi.decode(_ffi("iv", p, x.s, x.k, x.t, x.call), (bool, uint256, uint8));
        try engine.impliedVol(p, x.s, x.k, x.t, x.call) returns (uint256 iv) {
            assertTrue(ok, "rust rejected");
            assertEq(iv, rustIv, "implied vol");
        } catch (bytes memory err) {
            assertFalse(ok, "rust accepted");
            assertEq(_code(err), rustCode, "code");
        }
    }

    function _rustScenarioEqual(V memory x) internal {
        string[] memory cmd = new string[](7);
        (cmd[0], cmd[1], cmd[2]) = (cli, "scenario", x.call ? "1" : "0");
        (cmd[3], cmd[4], cmd[5]) = (vm.toString(x.k), vm.toString(uint256(1e30)), vm.toString(x.s));
        cmd[6] = "-999999000000000000,0,10000000000000000000";
        (bool ok, uint256 rustWorst, uint256[] memory rustLosses,) =
            abi.decode(vm.ffi(cmd), (bool, uint256, uint256[], uint8));
        (uint256 worst, uint256[] memory losses) = engine.scenarioLoss(x.call, x.k, 1e30, x.s, _boundaryShocks());
        assertTrue(ok);
        assertEq(worst, rustWorst, "worst");
        assertEq(losses, rustLosses, "losses");
    }
}
