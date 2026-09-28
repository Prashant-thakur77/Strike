// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title IStockToken
/// @notice The parts of a Robinhood Chain stock token that Strike reads. Names match the live contracts on chain
///         4663 (ERC-8056 scaled UI amounts plus two pause layers). `oraclePaused()` is missing on the testnet tokens,
///         so SafeStockFeed calls every function defensively.
interface IStockToken {
    /// @notice Current UI multiplier (1e18 = 1.0). UI balance = raw balance × uiMultiplier.
    function uiMultiplier() external view returns (uint256);

    /// @notice Multiplier that applies from `effectiveAt` (equals `uiMultiplier` once in effect).
    function newUIMultiplier() external view returns (uint256);

    /// @notice When the latest multiplier change takes (or took) effect.
    function effectiveAt() external view returns (uint256);

    function balanceOfUI(address account) external view returns (uint256);

    function paused() external view returns (bool);

    function oraclePaused() external view returns (bool);
}
