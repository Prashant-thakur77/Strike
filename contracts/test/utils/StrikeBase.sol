// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AgentRegistry} from "../../src/agents/AgentRegistry.sol";
import {EpochManager} from "../../src/core/EpochManager.sol";
import {FeeManager} from "../../src/core/FeeManager.sol";
import {MandateGuard} from "../../src/libraries/MandateGuard.sol";
import {MarketCalendar} from "../../src/oracle/MarketCalendar.sol";
import {StockOracle} from "../../src/oracle/StockOracle.sol";
import {BlackScholesRef} from "../../src/pricing/BlackScholesRef.sol";
import {OptionToken} from "../../src/tokens/OptionToken.sol";
import {StrikeVault} from "../../src/vaults/StrikeVault.sol";
import {VaultFactory} from "../../src/vaults/VaultFactory.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockStockToken} from "../mocks/MockStockToken.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Test} from "forge-std/Test.sol";

/// @notice Full Strike deployment with mocks: 6-decimal USDG, an 18-decimal TSLA stock token with an 8-decimal
///         Chainlink-style feed, one covered-call vault and one cash-secured-put vault.
abstract contract StrikeBase is Test {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant USDG_UNIT = 1e6;
    uint256 internal constant MIN_BOND = 100e6;
    uint256 internal constant SLASH = 25e6;

    /// Monday 2026-10-05 14:00 UTC (10:00 New York, market open).
    uint256 internal constant MONDAY = 1_791_208_800;
    /// Friday 2026-10-09 20:00 UTC (16:00 New York close).
    uint64 internal constant FRIDAY_CLOSE = 1_791_576_000;
    /// Friday 2026-10-16 20:00 UTC.
    uint64 internal constant NEXT_FRIDAY_CLOSE = 1_792_180_800;

    address internal admin = makeAddr("admin");
    address internal guardian = makeAddr("guardian");
    address internal keeper = makeAddr("keeper");
    address internal agent = makeAddr("agent");
    address internal curator = makeAddr("curator");
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal buyer = makeAddr("buyer");

    MockERC20 internal usdg;
    MockStockToken internal tsla;
    MockAggregator internal feed;
    MarketCalendar internal calendar;
    StockOracle internal oracle;
    BlackScholesRef internal pricer;
    FeeManager internal fees;
    OptionToken internal options;
    AgentRegistry internal registry;
    EpochManager internal manager;
    uint256 internal agentId;
    StrikeVault internal vaultImpl;
    VaultFactory internal factory;
    StrikeVault internal callVault;
    StrikeVault internal putVault;

    function setUp() public virtual {
        vm.warp(MONDAY);
        usdg = new MockERC20("Global Dollar", "USDG", 6);
        tsla = new MockStockToken("Tesla", "TSLA");
        feed = new MockAggregator(8);
        feed.set(250e8);

        vm.startPrank(admin);
        calendar = new MarketCalendar(admin, new uint256[](0), new uint256[](0));
        oracle = new StockOracle(admin, calendar);
        oracle.setFeed(address(tsla), feed, 1 days, 1 days);
        pricer = new BlackScholesRef();
        fees = new FeeManager(admin, usdg, treasury, 1000, 5000); // 10% of net premium, half to the agent
        options = new OptionToken("https://strike.example/api/option/{id}.json", admin);
        registry = new AgentRegistry(admin, usdg, IERC721(address(0)), MIN_BOND, SLASH, 3, 8 days);
        manager = new EpochManager(admin, usdg, options, pricer, fees, oracle, registry);
        registry.grantRole(registry.SLASHER_ROLE(), address(manager));
        options.setManager(address(manager));
        fees.grantRole(fees.DEPOSITOR_ROLE(), address(manager));
        manager.grantRole(manager.GUARDIAN_ROLE(), guardian);
        manager.grantRole(manager.KEEPER_ROLE(), keeper);
        manager.setUnderlying(address(tsla), true);
        manager.setSigmaBounds(address(tsla), 0.2e18, 1.5e18, 0.6e18);

        vm.stopPrank();

        // The agent registers its signer and posts a bond.
        usdg.mint(agent, 1000e6);
        vm.startPrank(agent);
        agentId = registry.register(agent, agent, 0);
        usdg.approve(address(registry), 1000e6);
        registry.postBond(agentId, 1000e6);
        vm.stopPrank();

        vm.startPrank(admin);
        vaultImpl = new StrikeVault();
        factory = new VaultFactory(admin, address(vaultImpl), manager, address(usdg), 10_000_000 * WAD);
        manager.grantRole(manager.FACTORY_ROLE(), address(factory));
        vm.stopPrank();

        vm.startPrank(curator);
        callVault = StrikeVault(factory.createVault(_params(true, 1_000_000 * WAD)));
        putVault = StrikeVault(factory.createVault(_params(false, 10_000_000 * USDG_UNIT)));
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ helpers

    function _mandate() internal pure returns (MandateGuard.Mandate memory) {
        return MandateGuard.Mandate({
            minDeltaBps: 500, // 0.05
            maxDeltaBps: 4000, // 0.40
            minPremiumBps: 9500, // at least 95% of fair value
            minYieldBps: 5, // at least 0.05% of collateral per week
            maxShareSoldBps: 10_000,
            minTenor: 1 days,
            maxTenor: 14 days
        });
    }

    function _params(bool isCall, uint256 cap) internal view returns (VaultFactory.CreateParams memory) {
        return VaultFactory.CreateParams({
            underlying: address(tsla),
            isCall: isCall,
            agentId: agentId,
            depositCap: cap,
            name: isCall ? "Strike TSLA Covered Call" : "Strike TSLA Cash-Secured Put",
            symbol: isCall ? "sTSLA-CC" : "sTSLA-CSP",
            mandate: _mandate()
        });
    }

    function _depositCall(address who, uint256 amount) internal {
        tsla.mint(who, amount);
        vm.startPrank(who);
        tsla.approve(address(callVault), amount);
        callVault.deposit(amount, who);
        vm.stopPrank();
    }

    function _depositPut(address who, uint256 amount) internal {
        usdg.mint(who, amount);
        vm.startPrank(who);
        usdg.approve(address(putVault), amount);
        putVault.deposit(amount, who);
        vm.stopPrank();
    }

    /// Open the epoch and have the agent propose; returns the series id.
    function _openAndPropose(StrikeVault vault, uint256 strike, uint256 size) internal returns (uint256 seriesId) {
        vm.prank(agent);
        manager.openEpoch(address(vault));
        bool accepted;
        vm.prank(agent);
        (accepted, seriesId) = manager.proposeSeries(address(vault), strike, FRIDAY_CLOSE, size, 10_000);
        assertTrue(accepted, "proposal rejected");
    }

    function _buy(uint256 seriesId, uint256 amount) internal returns (uint256 premium) {
        (uint256 quote,) = manager.quoteBuy(seriesId, amount);
        usdg.mint(buyer, quote);
        vm.startPrank(buyer);
        usdg.approve(address(manager), quote);
        premium = manager.buy(seriesId, amount, quote, buyer);
        vm.stopPrank();
    }

    /// Warp past expiry and publish the settlement print; returns its round id.
    function _expireAt(int256 price8) internal returns (uint80 roundId) {
        vm.warp(FRIDAY_CLOSE + 60);
        roundId = feed.set(price8);
    }
}
