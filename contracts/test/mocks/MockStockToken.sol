// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Robinhood Chain stock token as implemented on chain 4663: ERC-20 (18 decimals) + ERC-8056 scaled UI
///         amounts + token and oracle pauses. Function names match the live contracts (see docs/research.md).
contract MockStockToken is ERC20 {
    uint256 public uiMultiplier = 1e18;
    uint256 public newUIMultiplier = 1e18;
    uint256 public effectiveAt;
    bool public tokenPaused;
    bool public oraclePaused;

    event UIMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 effectiveAtTimestamp);

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function paused() external view returns (bool) {
        return tokenPaused;
    }

    function setTokenPaused(bool p) external {
        tokenPaused = p;
    }

    function setOraclePaused(bool p) external {
        oraclePaused = p;
    }

    /// @notice Schedule a split or dividend adjustment. Before `at`, uiMultiplier is the old value.
    function scheduleMultiplier(uint256 multiplier, uint256 at) external {
        emit UIMultiplierUpdated(uiMultiplier, multiplier, at);
        newUIMultiplier = multiplier;
        effectiveAt = at;
    }

    /// @notice Apply a scheduled change (the live token switches at effectiveAt; tests call this after warping).
    function applyMultiplier() external {
        uiMultiplier = newUIMultiplier;
    }

    function balanceOfUI(address account) external view returns (uint256) {
        return balanceOf(account) * uiMultiplier / 1e18;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!tokenPaused, "paused");
        super._update(from, to, value);
    }
}

/// @notice Testnet variant: `oraclePaused()` does not exist and calls to it revert.
contract MockStockTokenNoOraclePause is ERC20 {
    constructor() ERC20("Tesla testnet", "TSLA") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function paused() external pure returns (bool) {
        return false;
    }
}
