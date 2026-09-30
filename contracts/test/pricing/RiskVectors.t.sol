// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {RiskLib} from "../../src/pricing/RiskLib.sol";
import {Test} from "forge-std/Test.sol";

/// @notice The Solidity risk engine must reproduce the Rust (Stylus) engine exactly on generated vectors: 200 greeks,
///         150 implied volatilities and 60 scenario grids.
/// @dev Regenerate with `cargo run --release --example gen_vectors -- ../../contracts/test/vectors/pricer.json`
///      (writes risk.json next to it). `research/risk_reference.py --check` compares the same file with mpmath.
contract RiskVectorsTest is Test {
    string internal json;

    function setUp() public {
        json = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/risk.json"));
    }

    function test_greeksMatchStylusVectorsExactly() public view {
        uint256[] memory spot = vm.parseJsonUintArray(json, ".greeks.spot");
        uint256[] memory strike = vm.parseJsonUintArray(json, ".greeks.strike");
        uint256[] memory time = vm.parseJsonUintArray(json, ".greeks.time");
        uint256[] memory sigma = vm.parseJsonUintArray(json, ".greeks.sigma");
        bool[] memory isCall = vm.parseJsonBoolArray(json, ".greeks.isCall");
        int256[] memory delta = vm.parseJsonIntArray(json, ".greeks.delta");
        uint256[] memory gamma = vm.parseJsonUintArray(json, ".greeks.gamma");
        uint256[] memory vega = vm.parseJsonUintArray(json, ".greeks.vega");
        int256[] memory theta = vm.parseJsonIntArray(json, ".greeks.theta");

        assertEq(spot.length, 200);
        for (uint256 i; i < spot.length; ++i) {
            (int256 d, uint256 g, uint256 v, int256 t) =
                RiskLib.greeks(spot[i], strike[i], time[i], sigma[i], isCall[i]);
            string memory at = vm.toString(i);
            assertEq(d, delta[i], string.concat("delta at ", at));
            assertEq(g, gamma[i], string.concat("gamma at ", at));
            assertEq(v, vega[i], string.concat("vega at ", at));
            assertEq(t, theta[i], string.concat("theta at ", at));
        }
    }

    function test_impliedVolMatchesStylusVectorsExactly() public view {
        uint256[] memory price = vm.parseJsonUintArray(json, ".impliedVol.price");
        uint256[] memory spot = vm.parseJsonUintArray(json, ".impliedVol.spot");
        uint256[] memory strike = vm.parseJsonUintArray(json, ".impliedVol.strike");
        uint256[] memory time = vm.parseJsonUintArray(json, ".impliedVol.time");
        bool[] memory isCall = vm.parseJsonBoolArray(json, ".impliedVol.isCall");
        uint256[] memory iv = vm.parseJsonUintArray(json, ".impliedVol.iv");

        assertEq(price.length, 150);
        for (uint256 i; i < price.length; ++i) {
            uint256 got = RiskLib.impliedVol(price[i], spot[i], strike[i], time[i], isCall[i]);
            assertEq(got, iv[i], string.concat("implied vol at ", vm.toString(i)));
        }
    }

    function test_scenarioLossMatchesStylusVectorsExactly() public view {
        int256[] memory shocks = vm.parseJsonIntArray(json, ".scenario.shocks");
        bool[] memory isCall = vm.parseJsonBoolArray(json, ".scenario.isCall");
        uint256[] memory strike = vm.parseJsonUintArray(json, ".scenario.strike");
        uint256[] memory sold = vm.parseJsonUintArray(json, ".scenario.sold");
        uint256[] memory spot = vm.parseJsonUintArray(json, ".scenario.spot");
        uint256[] memory worst = vm.parseJsonUintArray(json, ".scenario.worst");
        uint256[] memory losses = vm.parseJsonUintArray(json, ".scenario.losses");

        assertEq(shocks.length, 13);
        assertEq(isCall.length, 60);
        assertEq(losses.length, 60 * 13);
        for (uint256 i; i < isCall.length; ++i) {
            (uint256 w, uint256[] memory l) = RiskLib.scenarioLoss(isCall[i], strike[i], sold[i], spot[i], shocks);
            assertEq(w, worst[i], string.concat("worst at ", vm.toString(i)));
            for (uint256 j; j < shocks.length; ++j) {
                assertEq(l[j], losses[i * 13 + j], string.concat("loss at ", vm.toString(i)));
            }
        }
    }
}
