// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {BlackScholesLib} from "../../src/pricing/BlackScholesLib.sol";
import {Test} from "forge-std/Test.sol";

/// @notice Differential fuzz: random inputs go to the Solidity pricer and, over FFI, to the Rust pricer that is
///         compiled into the Stylus contract. Results must be identical.
/// @dev Needs the CLI and FFI. Skipped unless PRICER_CLI is set:
///      cargo build --release --example pricer_cli --manifest-path stylus/pricer/Cargo.toml
///      PRICER_CLI=$PWD/../stylus/pricer/target/release/examples/pricer_cli forge test --ffi --match-path "test/differential/*"
contract PricerDifferentialTest is Test {
    string internal cli;

    function setUp() public {
        cli = vm.envOr("PRICER_CLI", string(""));
    }

    function _rust(uint256 s, uint256 k, uint256 t, uint256 v, bool isCall)
        internal
        returns (bool ok, uint256 price, int256 delta, uint8 code)
    {
        string[] memory cmd = new string[](6);
        cmd[0] = cli;
        cmd[1] = vm.toString(s);
        cmd[2] = vm.toString(k);
        cmd[3] = vm.toString(t);
        cmd[4] = vm.toString(v);
        cmd[5] = isCall ? "1" : "0";
        (ok, price, delta, code) = abi.decode(vm.ffi(cmd), (bool, uint256, int256, uint8));
    }

    /// In-range inputs: identical price and delta.
    function testFuzz_rustEqualsSolidity(uint256 s, uint256 k, uint256 t, uint256 v, bool isCall) public {
        vm.skip(bytes(cli).length == 0);
        s = bound(s, 1e6, 1e12 * 1e18);
        uint256 kMax = s * 4 > 1e12 * 1e18 ? 1e12 * 1e18 : s * 4;
        k = bound(k, s / 4 + 1e6, kMax);
        t = bound(t, 1, 2 * 365 days);
        v = bound(v, 0.01e18, 5e18);
        (bool ok, uint256 rp, int256 rd,) = _rust(s, k, t, v, isCall);
        (uint256 sp, int256 sd) = BlackScholesLib.quote(s, k, t, v, isCall);
        assertTrue(ok);
        assertEq(sp, rp, "price");
        assertEq(sd, rd, "delta");
    }

    /// Unbounded inputs: both reject exactly the same inputs with the same error code.
    function testFuzz_sameRejections(uint64 s, uint64 k, uint32 t, uint64 v, bool isCall) public {
        vm.skip(bytes(cli).length == 0);
        (bool ok,,, uint8 code) = _rust(s, k, t, v, isCall);
        try this.solidityQuote(s, k, t, v, isCall) {
            assertTrue(ok, "solidity accepted, rust rejected");
        } catch (bytes memory err) {
            assertFalse(ok, "rust accepted, solidity rejected");
            assertEq(err, abi.encodeWithSelector(BlackScholesLib.PricerInputOutOfRange.selector, code));
        }
    }

    function solidityQuote(uint256 s, uint256 k, uint256 t, uint256 v, bool isCall)
        external
        pure
        returns (uint256, int256)
    {
        return BlackScholesLib.quote(s, k, t, v, isCall);
    }
}
