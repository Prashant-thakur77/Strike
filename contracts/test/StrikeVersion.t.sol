// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {StrikeVersion} from "../src/StrikeVersion.sol";
import {Test} from "forge-std/Test.sol";

contract StrikeVersionTest is Test {
    function test_version() public pure {
        assertEq(StrikeVersion.VERSION, "0.1.0");
    }
}
