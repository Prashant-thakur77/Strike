// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title UsdgDrip (TESTNETS ONLY)
/// @notice A team-funded faucet for real testnet USDG: anyone can take 10 USDG once every 24 hours per address.
///         It holds USDG; anyone can top it up with a plain transfer. Testnet USDG has no value.
contract UsdgDrip is Ownable {
    using SafeERC20 for IERC20;

    /// @notice USDG per drip (6 decimals).
    uint256 public constant AMOUNT = 10e6;
    /// @notice Time between two drips to the same address.
    uint256 public constant COOLDOWN = 1 days;

    IERC20 public immutable usdg;
    /// @notice When each address can drip next (0 = now: it never dripped).
    mapping(address account => uint256) public nextDripAt;

    event Dripped(address indexed to, uint256 amount);
    event Refilled(address indexed from, uint256 amount);
    event Swept(address indexed to, uint256 amount);

    /// @notice This address dripped less than COOLDOWN ago; it can drip again at `next`.
    error TooSoon(uint256 next);
    /// @notice The faucet holds less than AMOUNT.
    error Empty();

    constructor(IERC20 usdg_, address owner_) Ownable(owner_) {
        usdg = usdg_;
    }

    /// @notice Send AMOUNT USDG to the caller, at most once per COOLDOWN per address.
    function drip() external {
        uint256 next = nextDripAt[msg.sender];
        if (block.timestamp < next) revert TooSoon(next);
        if (remaining() < AMOUNT) revert Empty();
        nextDripAt[msg.sender] = block.timestamp + COOLDOWN;
        emit Dripped(msg.sender, AMOUNT);
        usdg.safeTransfer(msg.sender, AMOUNT);
    }

    /// @notice Pull `amount` USDG from the owner (after an approve). A plain transfer to this contract works too.
    function refill(uint256 amount) external onlyOwner {
        emit Refilled(msg.sender, amount);
        usdg.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Recover `amount` USDG to `to`.
    function sweep(address to, uint256 amount) external onlyOwner {
        emit Swept(to, amount);
        usdg.safeTransfer(to, amount);
    }

    /// @notice USDG left in the faucet.
    function remaining() public view returns (uint256) {
        return usdg.balanceOf(address(this));
    }
}
