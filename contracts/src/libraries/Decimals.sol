// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title Decimals
/// @notice The one place Strike converts between token units and 18-decimal (WAD) USD values.
/// @dev Callers choose the rounding direction. Rule: round up what the vault receives or locks, round down what
///      the vault pays out.
library Decimals {
    uint256 internal constant WAD = 1e18;

    error UnsupportedDecimals(uint8 decimals);

    /// @notice Scale a value with `decimals` decimals to 18 decimals (exact for decimals <= 18).
    function toWad(uint256 amount, uint8 decimals) internal pure returns (uint256) {
        if (decimals > 18) revert UnsupportedDecimals(decimals);
        return amount * 10 ** (18 - decimals);
    }

    /// @notice Scale an 18-decimal value to `decimals` decimals.
    function fromWad(uint256 wad, uint8 decimals, Math.Rounding rounding) internal pure returns (uint256) {
        if (decimals > 18) revert UnsupportedDecimals(decimals);
        return Math.mulDiv(wad, 10 ** decimals, WAD, rounding);
    }

    /// @notice USD value (WAD) of `amount` base units of a token with `tokenDecimals`, at `priceWad` per whole token.
    function valueWad(uint256 amount, uint256 priceWad, uint8 tokenDecimals, Math.Rounding rounding)
        internal
        pure
        returns (uint256)
    {
        return Math.mulDiv(amount, priceWad, 10 ** tokenDecimals, rounding);
    }

    /// @notice USD value of `amount` base units at `priceWad`, expressed in a stablecoin with `usdDecimals`, in one
    ///         mulDiv so rounding happens once.
    function valueInUsd(
        uint256 amount,
        uint256 priceWad,
        uint8 tokenDecimals,
        uint8 usdDecimals,
        Math.Rounding rounding
    ) internal pure returns (uint256) {
        if (usdDecimals > 18 || tokenDecimals > 36) revert UnsupportedDecimals(usdDecimals);
        return Math.mulDiv(amount, priceWad * 10 ** usdDecimals, 10 ** tokenDecimals * WAD, rounding);
    }
}
