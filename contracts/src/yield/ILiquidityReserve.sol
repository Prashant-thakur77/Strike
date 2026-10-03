// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Tells a collateral adapter how much of its collateral must stay liquid (in the vault's asset) right now.
interface ILiquidityReserve {
    /// @param collateral The adapter's collateral at its current mark (liquid plus the PT's value).
    /// @return need Assets that must stay liquid to pay the worst case of any series the vault is short, or could
    ///         be short before the adapter can act again.
    function requiredLiquidity(uint256 collateral) external view returns (uint256 need);
}
