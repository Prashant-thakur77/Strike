// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IPricer} from "../interfaces/IPricer.sol";
import {BlackScholesLib} from "./BlackScholesLib.sol";

/// @title BlackScholesRef
/// @notice Solidity reference pricer. Same ABI and same results as the Stylus pricer, so the `EpochManager` can use
///         either one.
contract BlackScholesRef is IPricer {
    /// @inheritdoc IPricer
    function quote(uint256 spot, uint256 strike, uint256 timeToExpiry, uint256 sigma, bool isCall)
        external
        pure
        returns (uint256, int256)
    {
        return BlackScholesLib.quote(spot, strike, timeToExpiry, sigma, isCall);
    }

    /// @notice Premium only.
    function price(uint256 spot, uint256 strike, uint256 timeToExpiry, uint256 sigma, bool isCall)
        external
        pure
        returns (uint256 p)
    {
        (p,) = BlackScholesLib.quote(spot, strike, timeToExpiry, sigma, isCall);
    }

    /// @inheritdoc IPricer
    function strikeForDelta(uint256 spot, uint256 targetDelta, uint256 timeToExpiry, uint256 sigma, bool isCall)
        external
        pure
        returns (uint256)
    {
        return BlackScholesLib.strikeForDelta(spot, targetDelta, timeToExpiry, sigma, isCall);
    }

    /// @notice Delta only.
    function delta(uint256 spot, uint256 strike, uint256 timeToExpiry, uint256 sigma, bool isCall)
        external
        pure
        returns (int256 d)
    {
        (, d) = BlackScholesLib.quote(spot, strike, timeToExpiry, sigma, isCall);
    }
}
