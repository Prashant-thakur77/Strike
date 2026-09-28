// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title IStrikeVault
/// @notice The surface of a Strike vault that the `EpochManager` and the `VaultFactory` use.
interface IStrikeVault {
    struct InitParams {
        address asset; // collateral: the stock token (call vault) or USDG (put vault)
        address premiumToken; // USDG
        address underlying; // the stock token priced by the option
        bool isCall;
        address manager; // EpochManager
        uint256 depositCap; // max managed assets (TVL cap)
        string name;
        string symbol;
    }

    function initialize(InitParams calldata params) external;

    /// @notice Starts an epoch: from now on deposits and redemptions are queued.
    function lock() external;

    /// @notice Ends the epoch: sends `payout` collateral to the manager, distributes `premium` USDG (already
    ///         transferred to the vault) to shareholders, processes the queue and unlocks.
    function settleEpoch(uint256 payout, uint256 premium) external;

    function locked() external view returns (bool);

    function currentEpoch() external view returns (uint64);

    function premiumToken() external view returns (address);

    function underlying() external view returns (address);

    function isCall() external view returns (bool);
}
