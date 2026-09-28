// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IPricer} from "../../src/interfaces/IPricer.sol";

interface IStrikeSolver {
    function strikeForDelta(uint256 spot, uint256 targetDelta, uint256 time, uint256 sigma, bool isCall)
        external
        view
        returns (uint256);
}

/// @notice Measures the gas of one `quote` call from inside the EVM, so Solidity and Stylus pricers are compared
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
}
