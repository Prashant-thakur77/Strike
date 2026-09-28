// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @notice ERC-8004 Identity Registry stand-in: an ERC-721 where each token id is an agent identity.
contract MockIdentityRegistry is ERC721 {
    uint256 public nextId = 1;

    constructor() ERC721("Agent Identity", "AGENT") {}

    function register() external returns (uint256 id) {
        id = nextId++;
        _mint(msg.sender, id);
    }
}
