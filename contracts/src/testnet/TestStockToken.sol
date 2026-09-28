// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title TestStockToken (TESTNET ONLY)
/// @notice Stand-in for a Robinhood stock token on chains that have none (Arbitrum Sepolia). Same ERC-8056 and pause
///         surface as the real token, plus a rate-limited public faucet.
contract TestStockToken is ERC20, AccessControl {
    uint256 public constant FAUCET_AMOUNT = 10e18;
    uint256 public constant FAUCET_COOLDOWN = 1 days;

    uint256 public uiMultiplier = 1e18;
    uint256 public newUIMultiplier = 1e18;
    uint256 public effectiveAt;
    bool public tokenPaused;
    bool public oraclePaused;
    mapping(address account => uint256) public lastFaucet;

    event UIMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 effectiveAtTimestamp);

    error FaucetCooldown(uint256 availableAt);
    error TokenIsPaused();

    constructor(address admin, string memory name_, string memory symbol_) ERC20(name_, symbol_) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice 10 tokens per address per day.
    function faucet() external {
        uint256 next = lastFaucet[msg.sender] + FAUCET_COOLDOWN;
        if (lastFaucet[msg.sender] != 0 && block.timestamp < next) revert FaucetCooldown(next);
        lastFaucet[msg.sender] = block.timestamp;
        _mint(msg.sender, FAUCET_AMOUNT);
    }

    function mint(address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _mint(to, amount);
    }

    function paused() external view returns (bool) {
        return tokenPaused;
    }

    function setPaused(bool token, bool oracle) external onlyRole(DEFAULT_ADMIN_ROLE) {
        tokenPaused = token;
        oraclePaused = oracle;
    }

    /// @notice Simulate a split or dividend for demos of the corporate-action gate.
    function scheduleMultiplier(uint256 multiplier, uint256 at) external onlyRole(DEFAULT_ADMIN_ROLE) {
        emit UIMultiplierUpdated(uiMultiplier, multiplier, at);
        if (at <= block.timestamp) uiMultiplier = multiplier;
        newUIMultiplier = multiplier;
        effectiveAt = at;
    }

    function balanceOfUI(address account) external view returns (uint256) {
        return balanceOf(account) * uiMultiplier / 1e18;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (tokenPaused) revert TokenIsPaused();
        super._update(from, to, value);
    }
}
