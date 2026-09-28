// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {ERC1155Supply} from "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Supply.sol";

/// @title OptionToken
/// @notice ERC-1155 option positions. One id per series:
///         `uint256(keccak256(abi.encode(vault, underlying, strike, expiry, isCall)))`.
/// @dev Only the EpochManager mints (on purchase) and burns (on redemption). The manager is set once.
contract OptionToken is ERC1155Supply, AccessControl {
    string public constant name = "Strike Options";
    string public constant symbol = "STRIKE-OPT";

    /// @notice The EpochManager, the only minter and burner.
    address public manager;

    event ManagerSet(address indexed manager);

    error NotManager();
    error ManagerAlreadySet();
    error ZeroAddress();

    constructor(string memory uri_, address admin) ERC1155(uri_) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice One-time wiring to the EpochManager.
    function setManager(address manager_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (manager != address(0)) revert ManagerAlreadySet();
        if (manager_ == address(0)) revert ZeroAddress();
        manager = manager_;
        emit ManagerSet(manager_);
    }

    /// @notice Metadata URI template (ERC-1155 `{id}` substitution).
    function setURI(string calldata uri_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setURI(uri_);
    }

    function mint(address to, uint256 id, uint256 amount) external {
        if (msg.sender != manager) revert NotManager();
        _mint(to, id, amount, "");
    }

    function burn(address from, uint256 id, uint256 amount) external {
        if (msg.sender != manager) revert NotManager();
        _burn(from, id, amount);
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC1155, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
