// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AgentRegistry} from "../../src/agents/AgentRegistry.sol";
import {EpochManager} from "../../src/core/EpochManager.sol";
import {FeeManager} from "../../src/core/FeeManager.sol";
import {IAggregatorV3} from "../../src/interfaces/IAggregatorV3.sol";
import {IStockToken} from "../../src/interfaces/IStockToken.sol";
import {MandateGuard} from "../../src/libraries/MandateGuard.sol";
import {SafeStockFeed} from "../../src/libraries/SafeStockFeed.sol";
import {MarketCalendar} from "../../src/oracle/MarketCalendar.sol";
import {StockOracle} from "../../src/oracle/StockOracle.sol";
import {BlackScholesRef} from "../../src/pricing/BlackScholesRef.sol";
import {OptionToken} from "../../src/tokens/OptionToken.sol";
import {StrikeVault} from "../../src/vaults/StrikeVault.sol";
import {VaultFactory} from "../../src/vaults/VaultFactory.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Test} from "forge-std/Test.sol";

/// @notice Fork tests against Robinhood Chain mainnet (4663): real stock tokens, real Chainlink feeds, real USDG,
///         real ERC-8056 multipliers and pause functions. Skipped unless ROBINHOOD_RPC_URL is set:
///         ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com forge test --match-path "test/fork/*"
/// @dev Addresses from docs.robinhood.com/chain/contracts and docs.chain.link (see docs/research.md).
contract RobinhoodForkTest is Test {
    uint256 internal constant FORK_BLOCK = 74_708_484; // 2026-09-28 08:39 UTC (Monday, before the open)

    address internal constant TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;
    address internal constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address internal constant SPY = 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C;
    address internal constant TSLA_FEED = 0x4A1166a659A55625345e9515b32adECea5547C38;
    address internal constant NVDA_FEED = 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15;
    address internal constant SPY_FEED = 0x319724394D3A0e3669269846abE664Cd621f9f6A;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant ERC8004_IDENTITY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;

    address internal admin = makeAddr("admin");
    MarketCalendar internal calendar;
    StockOracle internal oracle;
    bool internal enabled;

    function setUp() public {
        string memory rpc = vm.envOr("ROBINHOOD_RPC_URL", string(""));
        enabled = bytes(rpc).length != 0;
        if (!enabled) return;
        vm.createSelectFork(rpc, FORK_BLOCK);
        vm.startPrank(admin);
        calendar = new MarketCalendar(admin, new uint256[](0), new uint256[](0));
        oracle = new StockOracle(admin, calendar);
        // Real feeds have a 24h heartbeat and a 0.5% deviation threshold.
        oracle.setFeed(TSLA, IAggregatorV3(TSLA_FEED), 3 days, 1 days);
        oracle.setFeed(NVDA, IAggregatorV3(NVDA_FEED), 3 days, 1 days);
        oracle.setFeed(SPY, IAggregatorV3(SPY_FEED), 3 days, 1 days);
        vm.stopPrank();
    }

    modifier onFork() {
        vm.skip(!enabled);
        _;
    }

    /// The real feed price is returned as-is (8 → 18 decimals), never multiplied by uiMultiplier.
    function test_fork_realFeedUsedAsIs() public onFork {
        address[3] memory tokens = [TSLA, NVDA, SPY];
        address[3] memory feeds = [TSLA_FEED, NVDA_FEED, SPY_FEED];
        for (uint256 i; i < 3; ++i) {
            (, int256 answer,,,) = IAggregatorV3(feeds[i]).latestRoundData();
            (uint256 price,) = oracle.latestPrice(tokens[i]);
            assertEq(price, uint256(answer) * 1e10);
        }
    }

    /// NVDA and SPY carry dividend multipliers above 1.0 on mainnet. Strike's price equals the feed exactly; a naive
    /// integration that multiplies again would overstate NVDA by the multiplier.
    function test_fork_multiplierIsNotAppliedTwice() public onFork {
        uint256 m = IStockToken(NVDA).uiMultiplier();
        assertGt(m, 1e18, "NVDA should have a dividend multiplier");
        assertEq(IStockToken(NVDA).newUIMultiplier(), m, "no change pending");
        (, int256 answer,,,) = IAggregatorV3(NVDA_FEED).latestRoundData();
        (uint256 price,) = oracle.latestPrice(NVDA);
        uint256 doubleCounted = price * m / 1e18;
        assertEq(price, uint256(answer) * 1e10);
        assertGt(doubleCounted, price);

        // UI balances scale raw balances by the multiplier.
        address holder = makeAddr("holder");
        deal(NVDA, holder, 10e18);
        assertEq(IStockToken(NVDA).balanceOfUI(holder), 10e18 * m / 1e18);
    }

    /// Real ERC-8056 state drives the corporate-action gate: the last NVDA dividend took effect weeks ago, so a one-
    /// day grace passes and a 60-day grace does not.
    function test_fork_corporateActionWindow() public onFork {
        uint256 at = IStockToken(NVDA).effectiveAt();
        assertGt(at, 0);
        (SafeStockFeed.Status s,,) = oracle.status(NVDA);
        assertEq(uint8(s), uint8(SafeStockFeed.Status.Ok));
        vm.prank(admin);
        oracle.setFeed(NVDA, IAggregatorV3(NVDA_FEED), 3 days, 60 days);
        (s,,) = oracle.status(NVDA);
        assertEq(uint8(s), uint8(SafeStockFeed.Status.CorporateActionPending));
    }

    /// Both pause layers exist on mainnet tokens and are off.
    function test_fork_pauseFlagsReadable() public onFork {
        assertFalse(IStockToken(TSLA).paused());
        assertFalse(IStockToken(TSLA).oraclePaused());
        assertEq(IERC20Decimals(USDG).decimals(), 6);
    }

    /// Settlement picks exactly the first real round after the target time.
    function test_fork_settlementRoundSelection() public onFork {
        (uint80 latest,,, uint256 latestAt,) = IAggregatorV3(TSLA_FEED).latestRoundData();
        (,,, uint256 prevAt,) = IAggregatorV3(TSLA_FEED).getRoundData(latest - 1);
        uint64 target = uint64(prevAt + 1);
        assertLe(target, latestAt);
        vm.expectRevert(abi.encodeWithSelector(SafeStockFeed.InvalidSettlementRound.selector, latest - 1));
        oracle.recordSettlementPrice(TSLA, target, latest - 1);
        (, int256 answer,,,) = IAggregatorV3(TSLA_FEED).latestRoundData();
        assertEq(oracle.recordSettlementPrice(TSLA, target, latest), uint256(answer) * 1e10);
    }

    // State for the full-epoch test (kept in storage to stay under the stack limit).
    EpochManager internal manager;
    StrikeVault internal vault;
    uint256 internal agentId;
    address internal agent = makeAddr("agent");
    address internal alice = makeAddr("alice");
    address internal buyer = makeAddr("buyer");

    /// A full covered-call epoch on real TSLA and real USDG. Live reads use the real feed; the post-expiry print is
    /// mocked because a fork cannot produce future rounds.
    function test_fork_fullEpochWithRealTokens() public onFork {
        vm.warp(1_790_607_600); // Monday 2026-09-28 15:00 UTC, market open
        _deployStack();

        deal(TSLA, alice, 10e18);
        vm.startPrank(alice);
        IERC20(TSLA).approve(address(vault), 10e18);
        vault.deposit(10e18, alice);
        vm.stopPrank();

        uint64 expiry = uint64(calendar.weeklyExpiry(block.timestamp));
        uint256 strike = manager.spot(TSLA) * 106 / 100;
        vm.prank(agent);
        manager.openEpoch(address(vault));
        vm.prank(agent);
        (bool ok, uint256 seriesId) = manager.proposeSeries(address(vault), strike, expiry, 10e18, 10_000);
        assertTrue(ok, "proposal rejected on fork");

        (uint256 premium,) = manager.quoteBuy(seriesId, 5e18);
        deal(USDG, buyer, premium);
        vm.startPrank(buyer);
        IERC20(USDG).approve(address(manager), premium);
        manager.buy(seriesId, 5e18, premium, buyer);
        vm.stopPrank();

        _settleAt(strike * 110 / 100, expiry);

        vm.prank(buyer);
        uint256 paid = manager.redeem(seriesId, 5e18, buyer);
        // (S - K) / S of a token per option: 0.1 / 1.1 ≈ 0.0909.
        assertApproxEqRel(paid, uint256(5e18) * 10 / 110, 1e15);
        assertEq(IERC20(TSLA).balanceOf(buyer), paid);
        assertGt(vault.pendingPremium(alice), 0);
    }

    function _deployStack() internal {
        vm.startPrank(admin);
        FeeManager fees = new FeeManager(admin, IERC20(USDG), admin, 1000, 5000);
        OptionToken options = new OptionToken("", admin);
        AgentRegistry registry = new AgentRegistry(admin, IERC20(USDG), IERC721(ERC8004_IDENTITY), 10e6, 5e6, 3, 8 days);
        manager = new EpochManager(admin, IERC20(USDG), options, new BlackScholesRef(), fees, oracle, registry);
        options.setManager(address(manager));
        fees.grantRole(fees.DEPOSITOR_ROLE(), address(manager));
        registry.grantRole(registry.SLASHER_ROLE(), address(manager));
        manager.setUnderlying(TSLA, true);
        manager.setSigmaBounds(TSLA, 0.3e18, 1.5e18, 0.6e18);
        VaultFactory factory = new VaultFactory(admin, address(new StrikeVault()), manager, USDG, 1000e18);
        manager.grantRole(manager.FACTORY_ROLE(), address(factory));
        vm.stopPrank();

        deal(USDG, agent, 100e6);
        vm.startPrank(agent);
        agentId = registry.register(agent, agent, 0);
        IERC20(USDG).approve(address(registry), 100e6);
        registry.postBond(agentId, 100e6);
        vm.stopPrank();

        VaultFactory.CreateParams memory p = VaultFactory.CreateParams({
            underlying: TSLA,
            isCall: true,
            agentId: agentId,
            depositCap: 100e18,
            name: "Strike TSLA Covered Call",
            symbol: "sTSLA-CC",
            mandate: MandateGuard.Mandate(500, 4000, 9500, 5, 10_000, 1 days, 14 days)
        });
        vault = StrikeVault(factory.createVault(p));
    }

    /// Mock the first post-expiry round of the real feed at `priceWad`, then settle.
    function _settleAt(uint256 priceWad, uint64 expiry) internal {
        (uint80 latest,,,,) = IAggregatorV3(TSLA_FEED).latestRoundData();
        uint256 printAt = uint256(expiry) + 30;
        vm.mockCall(
            TSLA_FEED,
            abi.encodeWithSelector(IAggregatorV3.getRoundData.selector, latest + 1),
            abi.encode(latest + 1, int256(priceWad / 1e10), printAt, printAt, latest + 1)
        );
        vm.warp(printAt + 60);
        manager.settle(address(vault), latest + 1);
    }
}

interface IERC20Decimals {
    function decimals() external view returns (uint8);
}
