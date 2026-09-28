// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {MirrorFeed} from "../../src/testnet/MirrorFeed.sol";
import {TestStockToken} from "../../src/testnet/TestStockToken.sol";
import {TestUSDG} from "../../src/testnet/TestUSDG.sol";
import {Test} from "forge-std/Test.sol";

contract TestnetContractsTest is Test {
    address internal admin = makeAddr("admin");
    MirrorFeed internal feed;
    TestStockToken internal token;

    function setUp() public {
        vm.warp(1_791_208_800);
        feed = new MirrorFeed(admin, 8, "TSLA / USD");
        token = new TestStockToken(admin, "Tesla", "TSLA");
    }

    function test_mirrorFeed_pushAndRead() public {
        vm.prank(admin);
        uint80 r = feed.push(250e8, uint64(block.timestamp - 10));
        (uint80 id, int256 answer,, uint256 at,) = feed.latestRoundData();
        assertEq(id, r);
        assertEq(answer, 250e8);
        assertEq(at, block.timestamp - 10);
        assertEq(feed.decimals(), 8);
        assertEq(feed.description(), "TSLA / USD");
    }

    function test_mirrorFeed_reverts() public {
        vm.expectRevert(MirrorFeed.NoDataPresent.selector);
        feed.latestRoundData();
        vm.startPrank(admin);
        vm.expectRevert(MirrorFeed.InvalidAnswer.selector);
        feed.push(0, uint64(block.timestamp));
        vm.expectRevert(MirrorFeed.StaleUpdate.selector);
        feed.push(1, uint64(block.timestamp + 1)); // future
        feed.push(1, uint64(block.timestamp));
        vm.expectRevert(MirrorFeed.StaleUpdate.selector);
        feed.push(1, uint64(block.timestamp)); // not newer
        vm.stopPrank();
        vm.expectRevert();
        feed.push(1, uint64(block.timestamp)); // not a keeper
    }

    function test_testStock_faucetCooldown() public {
        vm.startPrank(makeAddr("user"));
        token.faucet();
        assertEq(token.balanceOf(makeAddr("user")), 10e18);
        vm.expectRevert(abi.encodeWithSelector(TestStockToken.FaucetCooldown.selector, block.timestamp + 1 days));
        token.faucet();
        vm.warp(block.timestamp + 1 days);
        token.faucet();
        vm.stopPrank();
        assertEq(token.balanceOf(makeAddr("user")), 20e18);
    }

    function test_testStock_erc8056AndPauses() public {
        vm.startPrank(admin);
        token.mint(admin, 4e18);
        token.scheduleMultiplier(2e18, block.timestamp);
        assertEq(token.uiMultiplier(), 2e18);
        assertEq(token.balanceOfUI(admin), 8e18);
        token.scheduleMultiplier(3e18, block.timestamp + 1 days);
        assertEq(token.uiMultiplier(), 2e18);
        assertEq(token.newUIMultiplier(), 3e18);
        assertEq(token.effectiveAt(), block.timestamp + 1 days);
        token.setPaused(true, true);
        assertTrue(token.paused());
        assertTrue(token.oraclePaused());
        vm.expectRevert(TestStockToken.TokenIsPaused.selector);
        token.transfer(address(1), 1);
        vm.stopPrank();
        vm.expectRevert();
        token.mint(address(this), 1);
    }

    function test_testUsdg() public {
        TestUSDG u = new TestUSDG();
        u.faucet(5e6);
        assertEq(u.balanceOf(address(this)), 5e6);
        assertEq(u.decimals(), 6);
    }
}
