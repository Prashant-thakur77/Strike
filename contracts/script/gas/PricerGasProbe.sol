// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IPricer} from "../../src/interfaces/IPricer.sol";
import {IRiskEngine} from "../../src/interfaces/IRiskEngine.sol";

interface IStrikeSolver {
    function strikeForDelta(uint256 spot, uint256 targetDelta, uint256 time, uint256 sigma, bool isCall)
        external
        view
        returns (uint256);
}

/// @notice Measures the gas of one pricer or risk-engine call from inside the EVM, so Solidity and Stylus pricers are compared
///         on the same footing (call overhead included, transaction overhead excluded).
contract PricerGasProbe {
    function measure(IPricer pricer, uint256 spot, uint256 strike, uint256 time, uint256 sigma, bool isCall)
        external
        view
        returns (uint256 gasUsed, uint256 price, int256 delta)
    {
        uint256 before = gasleft();
        (price, delta) = pricer.quote(spot, strike, time, sigma, isCall);
        gasUsed = before - gasleft();
    }

    function measureStrike(IStrikeSolver solver, uint256 spot, uint256 delta, uint256 time, uint256 sigma, bool isCall)
        external
        view
        returns (uint256 gasUsed, uint256 strike)
    {
        uint256 before = gasleft();
        strike = solver.strikeForDelta(spot, delta, time, sigma, isCall);
        gasUsed = before - gasleft();
    }

    function measureGreeks(IRiskEngine engine, uint256 spot, uint256 strike, uint256 time, uint256 sigma, bool isCall)
        external
        view
        returns (uint256 gasUsed, int256 delta, uint256 gamma, uint256 vega, int256 theta)
    {
        uint256 before = gasleft();
        (delta, gamma, vega, theta) = engine.greeks(spot, strike, time, sigma, isCall);
        gasUsed = before - gasleft();
    }

    function measureImpliedVol(
        IRiskEngine engine,
        uint256 price,
        uint256 spot,
        uint256 strike,
        uint256 time,
        bool isCall
    ) external view returns (uint256 gasUsed, uint256 sigma) {
        uint256 before = gasleft();
        sigma = engine.impliedVol(price, spot, strike, time, isCall);
        gasUsed = before - gasleft();
    }

    function measureScenario(
        IRiskEngine engine,
        bool isCall,
        uint256 strike,
        uint256 sold,
        uint256 spot,
        int256[] calldata shocks
    ) external view returns (uint256 gasUsed, uint256 worst) {
        uint256 before = gasleft();
        (worst,) = engine.scenarioLoss(isCall, strike, sold, spot, shocks);
        gasUsed = before - gasleft();
    }

    /// @notice Gas of any read-only call, e.g. `RiskLens.seriesRisk` (the call must succeed).
    function measureCall(address target, bytes calldata data) external view returns (uint256 gasUsed) {
        uint256 before = gasleft();
        (bool ok,) = target.staticcall(data);
        gasUsed = before - gasleft();
        require(ok, "call reverted");
    }
}
