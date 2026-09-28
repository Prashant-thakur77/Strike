// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {OptionToken} from "../../src/tokens/OptionToken.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC1155Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {IERC1155MetadataURI} from "@openzeppelin/contracts/token/ERC1155/extensions/IERC1155MetadataURI.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Test} from "forge-std/Test.sol";

contract OptionTokenTest is Test {
    string internal constant URI = "https://strike.example/api/option/{id}.json";

    address internal admin = makeAddr("admin");
    address internal manager = makeAddr("manager");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    OptionToken internal token;

    function setUp() public {
        token = new OptionToken(URI, admin);
    }

    function _wire() internal {
        vm.prank(admin);
        token.setManager(manager);
    }

    // ------------------------------------------------------------------ constructor

    function test_constructor_setsMetadataAndAdmin() public view {
        assertEq(token.name(), "Strike Options");
        assertEq(token.symbol(), "STRIKE-OPT");
        assertEq(token.uri(1), URI);
        assertTrue(token.hasRole(token.DEFAULT_ADMIN_ROLE(), admin));
        assertFalse(token.hasRole(token.DEFAULT_ADMIN_ROLE(), address(this)));
        assertEq(token.manager(), address(0));
    }

    function test_constructor_revertsOnZeroAdmin() public {
        vm.expectRevert(OptionToken.ZeroAddress.selector);
        new OptionToken(URI, address(0));
    }

    // ------------------------------------------------------------------ setManager

    function test_setManager_setsOnceAndEmits() public {
        vm.expectEmit(address(token));
        emit OptionToken.ManagerSet(manager);
        vm.prank(admin);
        token.setManager(manager);
        assertEq(token.manager(), manager);
    }

    function test_setManager_revertsForNonAdmin() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, alice, token.DEFAULT_ADMIN_ROLE()
            )
        );
        vm.prank(alice);
        token.setManager(manager);
    }

    function test_setManager_revertsOnZeroAddress() public {
        vm.expectRevert(OptionToken.ZeroAddress.selector);
        vm.prank(admin);
        token.setManager(address(0));
    }

    function test_setManager_revertsWhenAlreadySet() public {
        _wire();
        vm.startPrank(admin);
        vm.expectRevert(OptionToken.ManagerAlreadySet.selector);
        token.setManager(bob);
        // The already-set check comes first, even for the zero address.
        vm.expectRevert(OptionToken.ManagerAlreadySet.selector);
        token.setManager(address(0));
        vm.stopPrank();
        assertEq(token.manager(), manager);
    }

    // ------------------------------------------------------------------ setURI

    function test_setURI_updatesTemplate() public {
        vm.prank(admin);
        token.setURI("ipfs://new/{id}");
        assertEq(token.uri(7), "ipfs://new/{id}");
    }

    function test_setURI_revertsForNonAdmin() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, manager, token.DEFAULT_ADMIN_ROLE()
            )
        );
        vm.prank(manager);
        token.setURI("ipfs://x");
    }

    // ------------------------------------------------------------------ mint / burn

    function test_mint_byManager() public {
        _wire();
        vm.expectEmit(address(token));
        emit IERC1155.TransferSingle(manager, address(0), alice, 42, 100);
        vm.prank(manager);
        token.mint(alice, 42, 100);
        assertEq(token.balanceOf(alice, 42), 100);
        assertEq(token.totalSupply(42), 100);
        assertEq(token.totalSupply(), 100);
        assertTrue(token.exists(42));
        assertFalse(token.exists(43));
    }

    function test_mint_revertsForNonManager() public {
        _wire();
        vm.expectRevert(OptionToken.NotManager.selector);
        vm.prank(alice);
        token.mint(alice, 1, 1);
        // Even the admin cannot mint.
        vm.expectRevert(OptionToken.NotManager.selector);
        vm.prank(admin);
        token.mint(alice, 1, 1);
    }

    function test_mint_revertsBeforeManagerIsSet() public {
        vm.expectRevert(OptionToken.NotManager.selector);
        vm.prank(admin);
        token.mint(alice, 1, 1);
    }

    function test_mint_revertsToNonReceiverContract() public {
        _wire();
        vm.expectRevert(abi.encodeWithSelector(IERC1155Errors.ERC1155InvalidReceiver.selector, address(this)));
        vm.prank(manager);
        token.mint(address(this), 1, 1);
    }

    function test_burn_byManager() public {
        _wire();
        vm.startPrank(manager);
        token.mint(alice, 42, 100);
        vm.expectEmit(address(token));
        emit IERC1155.TransferSingle(manager, alice, address(0), 42, 60);
        token.burn(alice, 42, 60);
        vm.stopPrank();
        assertEq(token.balanceOf(alice, 42), 40);
        assertEq(token.totalSupply(42), 40);
    }

    function test_burn_needsNoApproval() public {
        _wire();
        vm.startPrank(manager);
        token.mint(alice, 1, 5);
        token.burn(alice, 1, 5);
        vm.stopPrank();
        assertFalse(token.exists(1));
    }

    function test_burn_revertsForNonManager() public {
        _wire();
        vm.prank(manager);
        token.mint(alice, 1, 5);
        vm.expectRevert(OptionToken.NotManager.selector);
        vm.prank(alice);
        token.burn(alice, 1, 5);
    }

    function test_burn_revertsAboveBalance() public {
        _wire();
        vm.startPrank(manager);
        token.mint(alice, 1, 5);
        vm.expectRevert(abi.encodeWithSelector(IERC1155Errors.ERC1155InsufficientBalance.selector, alice, 5, 6, 1));
        token.burn(alice, 1, 6);
        vm.stopPrank();
    }

    function test_holdersCanTransfer() public {
        _wire();
        vm.prank(manager);
        token.mint(alice, 9, 10);
        vm.prank(alice);
        token.safeTransferFrom(alice, bob, 9, 4, "");
        assertEq(token.balanceOf(alice, 9), 6);
        assertEq(token.balanceOf(bob, 9), 4);
        assertEq(token.totalSupply(9), 10);
    }

    // ------------------------------------------------------------------ ERC-165

    function test_supportsInterface() public view {
        assertTrue(token.supportsInterface(type(IERC165).interfaceId));
        assertTrue(token.supportsInterface(type(IERC1155).interfaceId));
        assertTrue(token.supportsInterface(type(IERC1155MetadataURI).interfaceId));
        assertTrue(token.supportsInterface(type(IAccessControl).interfaceId));
        assertFalse(token.supportsInterface(0xffffffff));
        assertFalse(token.supportsInterface(0x12345678));
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_mintBurn_tracksSupply(uint256 id, uint128 minted, uint128 burned) public {
        burned = uint128(bound(burned, 0, minted));
        _wire();
        vm.startPrank(manager);
        token.mint(alice, id, minted);
        token.burn(alice, id, burned);
        vm.stopPrank();
        assertEq(token.balanceOf(alice, id), uint256(minted) - burned);
        assertEq(token.totalSupply(id), uint256(minted) - burned);
    }

    function testFuzz_mintBurn_onlyManager(address caller) public {
        vm.assume(caller != manager);
        _wire();
        vm.startPrank(caller);
        vm.expectRevert(OptionToken.NotManager.selector);
        token.mint(alice, 1, 1);
        vm.expectRevert(OptionToken.NotManager.selector);
        token.burn(alice, 1, 1);
        vm.stopPrank();
    }
}
