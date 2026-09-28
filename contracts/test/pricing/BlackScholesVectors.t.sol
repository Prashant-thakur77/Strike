// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {BlackScholesLib} from "../../src/pricing/BlackScholesLib.sol";
import {Test} from "forge-std/Test.sol";

/// @notice The Solidity pricer must reproduce the Rust (Stylus) pricer exactly on 300 generated vectors.
/// @dev Regenerate with `cargo run --release --example gen_vectors -- ../../contracts/test/vectors/pricer.json`.
contract BlackScholesVectorsTest is Test {
    function test_matchesStylusVectorsExactly() public view {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/pricer.json"));
        uint256[] memory spot = vm.parseJsonUintArray(json, ".spot");
        uint256[] memory strike = vm.parseJsonUintArray(json, ".strike");
        uint256[] memory time = vm.parseJsonUintArray(json, ".time");
        uint256[] memory sigma = vm.parseJsonUintArray(json, ".sigma");
        bool[] memory isCall = vm.parseJsonBoolArray(json, ".isCall");
        uint256[] memory price = vm.parseJsonUintArray(json, ".price");
        int256[] memory delta = vm.parseJsonIntArray(json, ".delta");

        assertEq(spot.length, 300);
        for (uint256 i; i < spot.length; ++i) {
            (uint256 p, int256 d) = BlackScholesLib.quote(spot[i], strike[i], time[i], sigma[i], isCall[i]);
            assertEq(p, price[i], string.concat("price mismatch at vector ", vm.toString(i)));
            assertEq(d, delta[i], string.concat("delta mismatch at vector ", vm.toString(i)));
        }
    }
}
