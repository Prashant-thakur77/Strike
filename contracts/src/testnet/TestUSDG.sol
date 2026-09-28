// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title TestUSDG (LOCAL DEVNETS ONLY)
/// @notice 6-decimal stand-in for USDG on local anvil chains. Real deployments use Paxos USDG.
contract TestUSDG is ERC20 {
    constructor() ERC20("Test Global Dollar", "USDG") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function faucet(uint256 amount) external {
        _mint(msg.sender, amount);
    }
}
