// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {EpochManager} from "../core/EpochManager.sol";
import {IStrikeVault} from "../interfaces/IStrikeVault.sol";
import {MandateGuard} from "../libraries/MandateGuard.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

/// @title VaultFactory
/// @notice Deploys Strike vaults as EIP-1167 clones of one audited-once implementation and registers them with the
///         EpochManager. Anyone can create a vault (they become its curator) on an allow-listed stock token.
contract VaultFactory is AccessControl {
    /// @notice The StrikeVault implementation every clone delegates to.
    address public immutable implementation;
    EpochManager public immutable manager;
    address public immutable usdg;

    /// @notice Largest deposit cap a new vault may set (the admin keeps mainnet vaults small).
    uint256 public maxDepositCap;

    struct CreateParams {
        address underlying;
        bool isCall;
        address agent;
        uint256 depositCap;
        string name;
        string symbol;
        MandateGuard.Mandate mandate;
    }

    event VaultCreated(
        address indexed vault, address indexed curator, address indexed underlying, bool isCall, address agent
    );
    event MaxDepositCapSet(uint256 maxDepositCap);

    error ZeroAddress();
    error DepositCapTooHigh(uint256 cap, uint256 max);

    constructor(address admin, address implementation_, EpochManager manager_, address usdg_, uint256 maxDepositCap_) {
        if (admin == address(0) || implementation_ == address(0) || address(manager_) == address(0)) {
            revert ZeroAddress();
        }
        if (usdg_ == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        implementation = implementation_;
        manager = manager_;
        usdg = usdg_;
        maxDepositCap = maxDepositCap_;
    }

    function setMaxDepositCap(uint256 cap) external onlyRole(DEFAULT_ADMIN_ROLE) {
        maxDepositCap = cap;
        emit MaxDepositCapSet(cap);
    }

    /// @notice Create a covered-call vault (collateral: the stock token) or a cash-secured-put vault (collateral:
    ///         USDG). The mandate is fixed for the vault's lifetime.
    function createVault(CreateParams calldata p) external returns (address vault) {
        if (p.underlying == address(0)) revert ZeroAddress();
        if (p.depositCap > maxDepositCap) revert DepositCapTooHigh(p.depositCap, maxDepositCap);

        vault = Clones.clone(implementation);
        IStrikeVault(vault)
            .initialize(
                IStrikeVault.InitParams({
                asset: p.isCall ? p.underlying : usdg,
                premiumToken: usdg,
                underlying: p.underlying,
                isCall: p.isCall,
                manager: address(manager),
                depositCap: p.depositCap,
                name: p.name,
                symbol: p.symbol
            })
            );
        manager.registerVault(vault, msg.sender, p.agent, p.mandate);
        emit VaultCreated(vault, msg.sender, p.underlying, p.isCall, p.agent);
    }
}
