// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {StockCollateral} from "../../examples/StockCollateral.sol";
import {IAggregatorV3} from "../../src/interfaces/IAggregatorV3.sol";
import {IStockToken} from "../../src/interfaces/IStockToken.sol";
import {SafeStockFeed} from "../../src/libraries/SafeStockFeed.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";

/// @notice The SafeStockFeed example consumer (examples/StockCollateral.sol) on Robinhood Chain mainnet (4663), with
///         the real stock tokens, their real ERC-8056 multipliers and the real Chainlink feeds. Skipped unless
///         ROBINHOOD_RPC_URL is set, and skipped (not failed) when that RPC cannot be reached:
///         ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com forge test --match-path "test/fork/*"
/// @dev Token and feed addresses from docs/research.md (docs.robinhood.com/chain/contracts, docs.chain.link).
contract StockCollateralForkTest is Test {
    address internal constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address internal constant NVDA_FEED = 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15;

    // Real feeds have a 24 h heartbeat and pause over weekends; the same limits as RobinhoodFork.t.sol.
    uint32 internal constant MAX_AGE = 3 days;
    uint32 internal constant GRACE = 1 days;

    address internal alice = makeAddr("alice");
    bool internal enabled;

    function setUp() public {
        string memory rpc = vm.envOr("ROBINHOOD_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        uint256 forkBlock = vm.envOr("FORK_BLOCK", uint256(0));
        // An unreachable RPC skips the suite instead of failing it.
        if (forkBlock == 0) {
            try vm.createSelectFork(rpc) returns (uint256) {
                enabled = true;
            } catch {}
        } else {
            try vm.createSelectFork(rpc, forkBlock) returns (uint256) {
                enabled = true;
            } catch {}
        }
    }

    modifier onFork() {
        vm.skip(!enabled);
        _;
    }

    function _market(address token, address feed) internal returns (StockCollateral) {
        return new StockCollateral(token, IAggregatorV3(feed), MAX_AGE, GRACE, 5000, IAggregatorV3(address(0)), 0);
    }

    function _depositNvda(StockCollateral market, uint256 raw) internal {
        deal(NVDA, alice, raw);
        vm.startPrank(alice);
        IERC20(NVDA).approve(address(market), raw);
        market.deposit(raw);
        vm.stopPrank();
    }

    /// NVDA carries a dividend multiplier above 1.0 on mainnet. The example values 10 raw NVDA at exactly
    /// 10 × the raw feed answer; applying the multiplier on top would overstate it.
    function test_fork_nvdaCollateralMultiplierNotAppliedTwice() public onFork {
        StockCollateral market = _market(NVDA, NVDA_FEED);
        _depositNvda(market, 10e18);
        (bool pending, uint256 at) = SafeStockFeed.corporateAction(NVDA, GRACE);
        if (pending) {
            // A real NVDA corporate action is in progress: the example must refuse to value the collateral.
            vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.CorporateActionPending.selector, NVDA, at));
            market.collateralValue(alice);
            return;
        }

        uint256 m = IStockToken(NVDA).uiMultiplier();
        assertGt(m, 1e18, "NVDA should have a dividend multiplier");
        (, int256 answer,,,) = IAggregatorV3(NVDA_FEED).latestRoundData();
        uint256 feedWad = uint256(answer) * 1e10; // 8 → 18 decimals, nothing else

        uint256 value = market.collateralValue(alice);
        assertEq(market.price(), feedWad, "price is the raw feed");
        assertEq(value, 10 * feedWad, "10 raw NVDA x raw feed");
        assertEq(market.borrowLimit(alice), value / 2);

        // The two ways to double-count, both strictly larger than the correct value.
        uint256 feedTimesMultiplier = 10e18 * (feedWad * m / 1e18) / 1e18;
        uint256 uiBalanceTimesFeed = IStockToken(NVDA).balanceOfUI(address(market)) * feedWad / 1e18;
        assertGt(feedTimesMultiplier, value);
        assertGt(uiBalanceTimesFeed, value);

        // The display price per wallet share is feed ÷ multiplier, and wallet shares × it gives back the value.
        uint256 sharePrice = market.sharePrice();
        assertEq(sharePrice, feedWad * 1e18 / m);
        assertLt(sharePrice, feedWad);
        assertApproxEqAbs(IStockToken(NVDA).balanceOfUI(address(market)) * sharePrice / 1e18, value, 100);
    }

    /// Every mainnet stock token with a Chainlink feed: the example's price is the raw feed answer.
    function test_fork_everyTokenUsesFeedAsIs() public onFork {
        address[8] memory tokens = [
            0x322F0929c4625eD5bAd873c95208D54E1c003b2d, // TSLA
            NVDA,
            0x12f190a9F9d7D37a250758b26824B97CE941bF54, // AMZN
            0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A, // PLTR
            0x86923f96303D656E4aa86D9d42D1e57ad2023fdC, // AMD
            0x117cc2133c37B721F49dE2A7a74833232B3B4C0C, // SPY
            0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9, // AAPL
            0xD5f3879160bc7c32ebb4dC785F8a4F505888de68 // QQQ
        ];
        address[8] memory feeds = [
            0x4A1166a659A55625345e9515b32adECea5547C38,
            NVDA_FEED,
            0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C,
            0x820ABedFF239034956B7A9d2F0a331f9F075eB4c,
            0x943A29E7ae51A4798823ca9eEd2ed533B2A22C72,
            0x319724394D3A0e3669269846abE664Cd621f9f6A,
            0x6B22A786bAa607d76728168703a39Ea9C99f2cD0,
            0x80901d846d5D7B030F26B480776EE3b29374C2ae
        ];
        for (uint256 i; i < tokens.length; ++i) {
            StockCollateral market = _market(tokens[i], feeds[i]);
            (bool pending, uint256 at) = SafeStockFeed.corporateAction(tokens[i], GRACE);
            if (pending) {
                vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.CorporateActionPending.selector, tokens[i], at));
                market.price();
                continue;
            }
            (, int256 answer,,,) = IAggregatorV3(feeds[i]).latestRoundData();
            assertEq(market.price(), uint256(answer) * 1e10);
            assertEq(market.sharePrice(), uint256(answer) * 1e10 * 1e18 / IStockToken(tokens[i]).uiMultiplier());
        }
    }

    /// The real token's pause flags, the real feed's age and a scheduled multiplier change each stop the valuation
    /// with the library's error.
    function test_fork_revertsWithLibraryErrors() public onFork {
        StockCollateral market = _market(NVDA, NVDA_FEED);
        _depositNvda(market, 10e18);
        vm.skip(_pending()); // a real corporate action in progress is covered by the test above

        vm.mockCall(NVDA, abi.encodeWithSelector(IStockToken.paused.selector), abi.encode(true));
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.TokenPaused.selector, NVDA));
        market.collateralValue(alice);
        vm.clearMockedCalls();

        vm.mockCall(NVDA, abi.encodeWithSelector(IStockToken.oraclePaused.selector), abi.encode(true));
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.FeedPaused.selector, NVDA));
        market.collateralValue(alice);
        vm.clearMockedCalls();

        // A 2-for-1 split announced for tomorrow.
        uint256 at = block.timestamp + 1 days;
        uint256 m = IStockToken(NVDA).uiMultiplier();
        vm.mockCall(NVDA, abi.encodeWithSelector(IStockToken.newUIMultiplier.selector), abi.encode(2 * m));
        vm.mockCall(NVDA, abi.encodeWithSelector(IStockToken.effectiveAt.selector), abi.encode(at));
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.CorporateActionPending.selector, NVDA, at));
        market.collateralValue(alice);
        vm.clearMockedCalls();

        (,,, uint256 updatedAt,) = IAggregatorV3(NVDA_FEED).latestRoundData();
        vm.warp(updatedAt + MAX_AGE + 1);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.StalePrice.selector, updatedAt, MAX_AGE));
        market.collateralValue(alice);
    }

    function _pending() internal view returns (bool pending) {
        (pending,) = SafeStockFeed.corporateAction(NVDA, GRACE);
    }
}
