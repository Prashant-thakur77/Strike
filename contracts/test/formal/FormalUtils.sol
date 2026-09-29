// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Helpers shared by the Halmos properties in this folder.
/// @dev `concreteDecimals` turns a symbolic decimals value into a literal on every path. Halmos then explores one
///      path per value (so the property is still proven for every value in the range) while `10 ** decimals` stays
///      concrete, which keeps the SMT queries linear in the symbolic amounts. A value outside 0..18 reverts, and a
///      reverting path is discarded (it is not a counterexample).
library FormalUtils {
    function concreteDecimals(uint8 d) internal pure returns (uint8) {
        if (d == 0) return 0;
        if (d == 1) return 1;
        if (d == 2) return 2;
        if (d == 3) return 3;
        if (d == 4) return 4;
        if (d == 5) return 5;
        if (d == 6) return 6;
        if (d == 7) return 7;
        if (d == 8) return 8;
        if (d == 9) return 9;
        if (d == 10) return 10;
        if (d == 11) return 11;
        if (d == 12) return 12;
        if (d == 13) return 13;
        if (d == 14) return 14;
        if (d == 15) return 15;
        if (d == 16) return 16;
        if (d == 17) return 17;
        if (d == 18) return 18;
        revert("decimals out of range");
    }

    /// @dev Stablecoin decimals: 6 (the deployed USDG) or 18.
    function concreteUsdDecimals(uint8 u) internal pure returns (uint8) {
        if (u == 6) return 6;
        if (u == 18) return 18;
        revert("usd decimals out of range");
    }
}
