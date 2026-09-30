// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IPricer} from "../interfaces/IPricer.sol";
import {IRiskEngine} from "../interfaces/IRiskEngine.sol";
import {BlackScholesLib} from "./BlackScholesLib.sol";
import {RiskLib} from "./RiskLib.sol";

/// @title BlackScholesRef
/// @notice Solidity reference pricer and risk engine. Same ABI and same results as the Stylus pricer, so the
///         `EpochManager` can use either one.
contract BlackScholesRef is IRiskEngine {
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

    /// @inheritdoc IRiskEngine
    function greeks(uint256 spot, uint256 strike, uint256 timeToExpiry, uint256 sigma, bool isCall)
        external
        pure
        returns (int256, uint256, uint256, int256)
    {
        return RiskLib.greeks(spot, strike, timeToExpiry, sigma, isCall);
    }

    /// @inheritdoc IRiskEngine
    function impliedVol(uint256 price_, uint256 spot, uint256 strike, uint256 timeToExpiry, bool isCall)
        external
        pure
        returns (uint256)
    {
        return RiskLib.impliedVol(price_, spot, strike, timeToExpiry, isCall);
    }

    /// @inheritdoc IRiskEngine
    function scenarioLoss(bool isCall, uint256 strike, uint256 sold, uint256 spot, int256[] calldata shocks)
        external
        pure
        returns (uint256, uint256[] memory)
    {
        return RiskLib.scenarioLoss(isCall, strike, sold, spot, shocks);
    }
}
