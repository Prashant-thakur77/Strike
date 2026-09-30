// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {BlackScholesLib} from "../../src/pricing/BlackScholesLib.sol";
import {RiskLib} from "../../src/pricing/RiskLib.sol";
import {Test} from "forge-std/Test.sol";

/// @notice Differential fuzz for the risk engine: random inputs go to `RiskLib` and, over FFI, to the Rust engine
///         compiled into the Stylus contract. Values, rejections and error codes must be identical.
/// @dev Needs the CLI and FFI. Skipped unless PRICER_CLI is set:
///      cargo build --release --example pricer_cli --manifest-path stylus/pricer/Cargo.toml
///      PRICER_CLI=$PWD/../stylus/pricer/target/release/examples/pricer_cli forge test --ffi --match-path "test/differential/*"
contract RiskDifferentialTest is Test {
    string internal cli;

    function setUp() public {
        cli = vm.envOr("PRICER_CLI", string(""));
    }

    // ------------------------------------------------------------------ FFI

    /// Runs `pricer_cli <name> a b c d e` and returns its ABI output.
    function _ffi(string memory name, uint256 a, uint256 b, uint256 c, uint256 d, bool e)
        internal
        returns (bytes memory)
    {
        string[] memory cmd = new string[](7);
        cmd[0] = cli;
        cmd[1] = name;
        cmd[2] = vm.toString(a);
        cmd[3] = vm.toString(b);
        cmd[4] = vm.toString(c);
        cmd[5] = vm.toString(d);
        cmd[6] = e ? "1" : "0";
        return vm.ffi(cmd);
    }

    function _rustGreeks(uint256 s, uint256 k, uint256 t, uint256 v, bool isCall)
        internal
        returns (bool ok, int256 delta, uint256 gamma, uint256 vega, int256 theta, uint8 code)
    {
        bytes memory out = _ffi("greeks", s, k, t, v, isCall);
        (ok, delta, gamma, vega, theta, code) = abi.decode(out, (bool, int256, uint256, uint256, int256, uint8));
    }

    function _rustIv(uint256 p, uint256 s, uint256 k, uint256 t, bool isCall)
        internal
        returns (bool ok, uint256 sigma, uint8 code)
    {
        (ok, sigma, code) = abi.decode(_ffi("iv", p, s, k, t, isCall), (bool, uint256, uint8));
    }

    function _rustScenario(bool isCall, uint256 k, uint256 sold, uint256 s, int256[] memory shocks)
        internal
        returns (bool ok, uint256 worst, uint256[] memory losses, uint8 code)
    {
        string memory csv = "";
        for (uint256 i; i < shocks.length; ++i) {
            csv = string.concat(csv, i == 0 ? "" : ",", vm.toString(shocks[i]));
        }
        string[] memory cmd = new string[](7);
        (cmd[0], cmd[1], cmd[2], cmd[3], cmd[4], cmd[5], cmd[6]) =
        (cli, "scenario", isCall ? "1" : "0", vm.toString(k), vm.toString(sold), vm.toString(s), csv);
        (ok, worst, losses, code) = abi.decode(vm.ffi(cmd), (bool, uint256, uint256[], uint8));
    }

    /// Asserts that a Solidity revert matches the Rust rejection code.
    function _sameRejection(bool rustOk, uint8 rustCode, bytes memory err) internal pure {
        assertFalse(rustOk, "rust accepted, solidity rejected");
        assertEq(err, abi.encodeWithSelector(BlackScholesLib.PricerInputOutOfRange.selector, rustCode));
    }

    // ------------------------------------------------------------------ greeks

    /// In-range inputs: identical delta, gamma, vega and theta.
    function testFuzz_greeksRustEqualsSolidity(uint256 s, uint256 k, uint256 t, uint256 v, bool isCall) public {
        vm.skip(bytes(cli).length == 0);
        s = bound(s, 1e6, 1e12 * 1e18);
        uint256 kMax = s * 4 > 1e12 * 1e18 ? 1e12 * 1e18 : s * 4;
        k = bound(k, s / 4 + 1e6, kMax);
        t = bound(t, 1, 2 * 365 days);
        v = bound(v, 0.01e18, 5e18);
        (bool ok, int256 rd, uint256 rg, uint256 rv, int256 rt,) = _rustGreeks(s, k, t, v, isCall);
        (int256 sd, uint256 sg, uint256 sv, int256 st) = RiskLib.greeks(s, k, t, v, isCall);
        assertTrue(ok);
        assertEq(sd, rd, "delta");
        assertEq(sg, rg, "gamma");
        assertEq(sv, rv, "vega");
        assertEq(st, rt, "theta");
    }

    /// Unbounded inputs: both reject exactly the same inputs with the same code.
    function testFuzz_greeksSameRejections(uint64 s, uint64 k, uint32 t, uint64 v, bool isCall) public {
        vm.skip(bytes(cli).length == 0);
        (bool ok,,,,, uint8 code) = _rustGreeks(s, k, t, v, isCall);
        try this.solidityGreeks(s, k, t, v, isCall) {
            assertTrue(ok, "solidity accepted, rust rejected");
        } catch (bytes memory err) {
            _sameRejection(ok, code, err);
        }
    }

    // ------------------------------------------------------------------ implied volatility

    /// Premiums produced by the pricer at sigma in [1%, 500%]: same sigma, or the same rejection (sigma below 5%,
    /// or a premium at intrinsic value).
    function testFuzz_impliedVolRustEqualsSolidity(uint256 s, uint256 k, uint256 t, uint256 v, bool isCall) public {
        vm.skip(bytes(cli).length == 0);
        s = bound(s, 1e15, 1e24);
        k = bound(k, s / 2, s * 2);
        t = bound(t, 1 hours, 365 days);
        v = bound(v, 0.01e18, 5e18);
        (uint256 p,) = BlackScholesLib.quote(s, k, t, v, isCall);
        _compareIv(p, s, k, t, isCall);
    }

    /// Arbitrary premiums, including outside the no-arbitrage bounds.
    function testFuzz_impliedVolArbitraryPrice(uint256 p, uint256 s, uint256 k, uint256 t, bool isCall) public {
        vm.skip(bytes(cli).length == 0);
        s = bound(s, 1e15, 1e24);
        k = bound(k, s / 2, s * 2);
        t = bound(t, 1 hours, 365 days);
        p = bound(p, 0, isCall ? s + 1 : k + 1);
        _compareIv(p, s, k, t, isCall);
    }

    function _compareIv(uint256 p, uint256 s, uint256 k, uint256 t, bool isCall) internal {
        (bool ok, uint256 rustSigma, uint8 code) = _rustIv(p, s, k, t, isCall);
        try this.solidityImpliedVol(p, s, k, t, isCall) returns (uint256 sigma) {
            assertTrue(ok, "solidity accepted, rust rejected");
            assertEq(sigma, rustSigma, "implied vol");
        } catch (bytes memory err) {
            _sameRejection(ok, code, err);
        }
    }

    // ------------------------------------------------------------------ scenario loss

    /// Random shock vectors (some out of range): identical losses, worst case and rejections.
    function testFuzz_scenarioRustEqualsSolidity(
        bool isCall,
        uint256 k,
        uint256 sold,
        uint256 s,
        int64[6] memory raw,
        uint8 n
    ) public {
        vm.skip(bytes(cli).length == 0);
        s = bound(s, 1e6, 1e12 * 1e18);
        k = bound(k, 1e6, 1e12 * 1e18);
        sold = bound(sold, 0, 1e36);
        int256[] memory shocks = new int256[](bound(n, 0, 6));
        for (uint256 i; i < shocks.length; ++i) {
            // Mostly (-100%, +1000%], sometimes just outside it.
            shocks[i] = bound(int256(raw[i]), -1.01e18, 10.01e18);
        }
        (bool ok, uint256 rustWorst, uint256[] memory rustLosses, uint8 code) =
            _rustScenario(isCall, k, sold, s, shocks);
        try this.solidityScenario(isCall, k, sold, s, shocks) returns (uint256 worst, uint256[] memory losses) {
            assertTrue(ok, "solidity accepted, rust rejected");
            assertEq(worst, rustWorst, "worst");
            assertEq(losses, rustLosses, "losses");
        } catch (bytes memory err) {
            _sameRejection(ok, code, err);
        }
    }

    // ------------------------------------------------------------------ external wrappers for try/catch

    function solidityGreeks(uint256 s, uint256 k, uint256 t, uint256 v, bool isCall)
        external
        pure
        returns (int256, uint256, uint256, int256)
    {
        return RiskLib.greeks(s, k, t, v, isCall);
    }

    function solidityImpliedVol(uint256 p, uint256 s, uint256 k, uint256 t, bool isCall)
        external
        pure
        returns (uint256)
    {
        return RiskLib.impliedVol(p, s, k, t, isCall);
    }

    function solidityScenario(bool isCall, uint256 k, uint256 sold, uint256 s, int256[] memory shocks)
        external
        pure
        returns (uint256, uint256[] memory)
    {
        return RiskLib.scenarioLoss(isCall, k, sold, s, shocks);
    }
}
