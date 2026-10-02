// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AgentRegistry} from "../src/agents/AgentRegistry.sol";
import {EpochManager} from "../src/core/EpochManager.sol";
import {FeeManager} from "../src/core/FeeManager.sol";
import {IAggregatorV3} from "../src/interfaces/IAggregatorV3.sol";
import {IERC8004Reputation} from "../src/interfaces/IERC8004Reputation.sol";
import {MarketCalendar} from "../src/oracle/MarketCalendar.sol";
import {StockOracle} from "../src/oracle/StockOracle.sol";
import {BlackScholesRef} from "../src/pricing/BlackScholesRef.sol";
import {MirrorFeed} from "../src/testnet/MirrorFeed.sol";
import {TestStockToken} from "../src/testnet/TestStockToken.sol";
import {TestUSDG} from "../src/testnet/TestUSDG.sol";
import {OptionToken} from "../src/tokens/OptionToken.sol";
import {StrikeVault} from "../src/vaults/StrikeVault.sol";
import {VaultFactory} from "../src/vaults/VaultFactory.sol";
import {AdminTimelock} from "./AdminTimelock.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Script, console2} from "forge-std/Script.sol";

/// @notice Deploys the full Strike protocol and writes deployments/<chainId>.json.
///
///   forge script script/Deploy.s.sol --rpc-url robinhood_testnet --broadcast --verify \
///     --verifier blockscout --verifier-url https://explorer.testnet.chain.robinhood.com/api/
///
/// Env: PRIVATE_KEY (deployer = admin); optional GUARDIAN, KEEPER, TREASURY (default: deployer).
///
/// Admin timelock (D43, docs/trust-model.md "Staged path for the admin keys"): ADMIN_TIMELOCK=true|false, default true
/// on 4663 (mainnet) and false elsewhere. When on, the deployer ends with no admin role: every DEFAULT_ADMIN_ROLE (and
/// the calendar's CALENDAR_ROLE) goes to an OpenZeppelin TimelockController that only ADMIN_SAFE (required, a Safe)
/// can schedule, cancel and execute calls on. Its delay, TIMELOCK_DELAY, defaults to AdminTimelock.MIN_DELAY (73 days:
/// longer than the longest epoch plus the settlement grace) and cannot be set lower. GUARDIAN defaults to ADMIN_SAFE.
/// Anything the deployer must still change as admin (for example the Stylus pricer) goes through the timelock after.
///
/// Chains:
///   4663   Robinhood Chain mainnet: real USDG, real stock tokens, real Chainlink feeds, small deposit cap
///   46630  Robinhood Chain testnet: real testnet USDG and stock tokens; MirrorFeeds (no Chainlink on testnet)
///   421614 Arbitrum Sepolia: real Sepolia USDG; TestStockTokens with a faucet; MirrorFeeds
///   31337  Local anvil: everything mocked
contract Deploy is Script {
    struct Stock {
        string symbol;
        address token; // zero: deploy a TestStockToken
        address feed; // zero: deploy a MirrorFeed
        int256 seedPrice8; // first MirrorFeed round (testnets)
        uint64 sigma;
    }

    struct Config {
        address usdg; // zero: deploy TestUSDG
        address identityRegistry; // ERC-8004
        address reputationRegistry; // ERC-8004
        uint32 maxPriceAge;
        uint256 maxVaultCap;
        string optionUri;
    }

    struct Deployed {
        address calendar;
        address oracle;
        address pricer;
        address fees;
        address options;
        address registry;
        address manager;
        address vaultImpl;
        address factory;
        address usdg;
        address timelock; // zero unless ADMIN_TIMELOCK
    }

    address internal deployer;
    Deployed internal d;
    Stock[] internal stocks;
    /// MirrorFeeds this run deployed (testnets): their admin moves to the timelock too.
    address[] internal mirrorFeeds;
    address internal adminSafe;
    uint256 internal timelockDelay;

    function run() external returns (Deployed memory) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        deployer = vm.addr(pk);
        bool timelocked = vm.envOr("ADMIN_TIMELOCK", block.chainid == 4663);
        if (timelocked) adminSafe = vm.envAddress("ADMIN_SAFE");
        address guardian = vm.envOr("GUARDIAN", timelocked ? adminSafe : deployer);
        address keeper = vm.envOr("KEEPER", deployer);
        address treasury = vm.envOr("TREASURY", deployer);
        Config memory cfg = _config();

        vm.startBroadcast(pk);
        d.usdg = cfg.usdg == address(0) ? address(new TestUSDG()) : cfg.usdg;
        d.calendar = address(new MarketCalendar(deployer, _holidays(), _earlyCloses()));
        d.oracle = address(new StockOracle(deployer, MarketCalendar(d.calendar)));
        d.pricer = address(new BlackScholesRef());
        d.fees = address(new FeeManager(deployer, IERC20(d.usdg), treasury, 1000, 5000));
        d.options = address(new OptionToken(cfg.optionUri, deployer));
        d.registry =
            address(new AgentRegistry(deployer, IERC20(d.usdg), IERC721(cfg.identityRegistry), 50e6, 10e6, 3, 8 days));
        d.manager = address(
            new EpochManager(
                deployer,
                IERC20(d.usdg),
                OptionToken(d.options),
                BlackScholesRef(d.pricer),
                FeeManager(d.fees),
                StockOracle(d.oracle),
                AgentRegistry(d.registry)
            )
        );
        d.vaultImpl = address(new StrikeVault());
        d.factory = address(new VaultFactory(deployer, d.vaultImpl, EpochManager(d.manager), d.usdg, cfg.maxVaultCap));

        if (cfg.reputationRegistry != address(0)) {
            AgentRegistry(d.registry).setReputationRegistry(IERC8004Reputation(cfg.reputationRegistry));
        }
        EpochManager m = EpochManager(d.manager);
        OptionToken(d.options).setManager(d.manager);
        FeeManager(d.fees).grantRole(FeeManager(d.fees).DEPOSITOR_ROLE(), d.manager);
        AgentRegistry(d.registry).grantRole(AgentRegistry(d.registry).SLASHER_ROLE(), d.manager);
        m.grantRole(m.FACTORY_ROLE(), d.factory);
        m.grantRole(m.GUARDIAN_ROLE(), guardian);
        m.grantRole(m.KEEPER_ROLE(), keeper);

        for (uint256 i; i < stocks.length; ++i) {
            _listStock(stocks[i], cfg.maxPriceAge, keeper);
        }
        if (timelocked) _handOverToTimelock(guardian);
        vm.stopBroadcast();

        _write();
        return d;
    }

    function _listStock(Stock storage s, uint32 maxPriceAge, address keeper) internal {
        if (s.token == address(0)) {
            s.token = address(new TestStockToken(deployer, string.concat(s.symbol, " (Strike test stock)"), s.symbol));
        }
        if (s.feed == address(0)) {
            MirrorFeed f = new MirrorFeed(deployer, 8, string.concat(s.symbol, " / USD (mirror of mainnet Chainlink)"));
            f.grantRole(f.KEEPER_ROLE(), keeper);
            f.push(s.seedPrice8, uint64(block.timestamp));
            s.feed = address(f);
            mirrorFeeds.push(address(f));
        }
        StockOracle(d.oracle).setFeed(s.token, IAggregatorV3(s.feed), maxPriceAge, 1 days);
        EpochManager(d.manager).setUnderlying(s.token, true);
        EpochManager(d.manager).setSigmaBounds(s.token, 0.2e18, 2e18, s.sigma);
        // Chainlink stock feeds print on a 0.5% move: price buys that far against the buyer (audit M-03).
        EpochManager(d.manager).setSpotBuffer(s.token, 50);
    }

    /// @dev D43: every admin role moves to a TimelockController that only the Safe proposes to; the guardian keeps
    ///      its pause directly. `AdminTimelock.handOver` reverts if the deployer is left with any admin role.
    function _handOverToTimelock(address guardian) internal {
        timelockDelay = vm.envOr("TIMELOCK_DELAY", AdminTimelock.MIN_DELAY);
        TimelockController timelock = AdminTimelock.deploy(adminSafe, timelockDelay);
        d.timelock = address(timelock);
        address[] memory admins = new address[](7 + mirrorFeeds.length);
        (admins[0], admins[1], admins[2], admins[3]) = (d.calendar, d.oracle, d.fees, d.options);
        (admins[4], admins[5], admins[6]) = (d.registry, d.manager, d.factory);
        for (uint256 i; i < mirrorFeeds.length; ++i) {
            admins[7 + i] = mirrorFeeds[i];
        }
        AdminTimelock.handOver(
            timelock, deployer, MarketCalendar(d.calendar), EpochManager(d.manager), guardian, admins
        );
        console2.log("Admin: TimelockController", d.timelock);
        console2.log("  proposer, canceller and executor", adminSafe);
        console2.log("  delay (seconds)", timelockDelay);
    }

    // ------------------------------------------------------------------ chain configs (docs/research.md)

    function _config() internal returns (Config memory c) {
        c.optionUri = "https://strike-options.vercel.app/api/option/{id}.json";
        if (block.chainid == 4663) {
            c.usdg = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
            c.identityRegistry = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
            c.reputationRegistry = 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63;
            c.maxPriceAge = 25 hours; // Chainlink heartbeat 24h, deviation 0.5%
            c.maxVaultCap = 5000e18; // hard ceiling; curators set far lower on mainnet
            stocks.push(
                Stock(
                    "TSLA",
                    0x322F0929c4625eD5bAd873c95208D54E1c003b2d,
                    0x4A1166a659A55625345e9515b32adECea5547C38,
                    0,
                    0.6e18
                )
            );
            stocks.push(
                Stock(
                    "NVDA",
                    0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC,
                    0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15,
                    0,
                    0.5e18
                )
            );
            stocks.push(
                Stock(
                    "SPY",
                    0x117cc2133c37B721F49dE2A7a74833232B3B4C0C,
                    0x319724394D3A0e3669269846abE664Cd621f9f6A,
                    0,
                    0.2e18
                )
            );
        } else if (block.chainid == 46_630) {
            c.usdg = 0x7E955252E15c84f5768B83c41a71F9eba181802F;
            c.identityRegistry = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
            c.reputationRegistry = 0x8004B663056A597Dffe9eCcC1965A193B7388713;
            c.maxPriceAge = 25 hours;
            c.maxVaultCap = 1_000_000e18;
            stocks.push(Stock("TSLA", 0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E, address(0), 369e8, 0.6e18));
            stocks.push(Stock("AMZN", 0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02, address(0), 225e8, 0.35e18));
            stocks.push(Stock("PLTR", 0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0, address(0), 180e8, 0.7e18));
            stocks.push(Stock("NFLX", 0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93, address(0), 1200e8, 0.4e18));
            stocks.push(Stock("AMD", 0x71178BAc73cBeb415514eB542a8995b82669778d, address(0), 160e8, 0.55e18));
        } else if (block.chainid == 421_614) {
            c.usdg = 0xFFC95faa3d63Cde504a05B567C600B78C0b41892;
            c.identityRegistry = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
            c.reputationRegistry = 0x8004B663056A597Dffe9eCcC1965A193B7388713;
            c.maxPriceAge = 25 hours;
            c.maxVaultCap = 1_000_000e18;
            stocks.push(Stock("TSLA", address(0), address(0), 369e8, 0.6e18));
            stocks.push(Stock("NVDA", address(0), address(0), 224e8, 0.5e18));
        } else {
            c.maxPriceAge = 25 hours;
            c.maxVaultCap = type(uint128).max;
            stocks.push(Stock("TSLA", address(0), address(0), 369e8, 0.6e18));
            stocks.push(Stock("NVDA", address(0), address(0), 224e8, 0.5e18));
        }
    }

    /// NYSE full-day closures 2026–2027 (day numbers since 1970-01-01).
    function _holidays() internal pure returns (uint256[] memory h) {
        uint256[20] memory list = [
            uint256(20_454),
            20_472,
            20_500,
            20_546,
            20_598,
            20_623,
            20_637,
            20_703,
            20_783,
            20_812,
            20_819,
            20_836,
            20_864,
            20_903,
            20_969,
            20_987,
            21_004,
            21_067,
            21_147,
            21_176
        ];
        h = new uint256[](20);
        for (uint256 i; i < 20; ++i) {
            h[i] = list[i];
        }
    }

    /// 13:00 closes: 2026-11-27, 2026-12-24, 2027-11-26.
    function _earlyCloses() internal pure returns (uint256[] memory e) {
        e = new uint256[](3);
        (e[0], e[1], e[2]) = (20_784, 20_811, 21_148);
    }

    function _write() internal {
        string memory k = "deployment";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "block", block.number);
        vm.serializeAddress(k, "deployer", deployer);
        vm.serializeAddress(k, "usdg", d.usdg);
        vm.serializeAddress(k, "marketCalendar", d.calendar);
        vm.serializeAddress(k, "stockOracle", d.oracle);
        vm.serializeAddress(k, "pricer", d.pricer);
        vm.serializeAddress(k, "feeManager", d.fees);
        vm.serializeAddress(k, "optionToken", d.options);
        vm.serializeAddress(k, "agentRegistry", d.registry);
        vm.serializeAddress(k, "epochManager", d.manager);
        vm.serializeAddress(k, "vaultImplementation", d.vaultImpl);
        vm.serializeAddress(k, "vaultFactory", d.factory);
        if (d.timelock != address(0)) {
            vm.serializeAddress(k, "timelock", d.timelock);
            vm.serializeAddress(k, "adminSafe", adminSafe);
            vm.serializeUint(k, "timelockDelay", timelockDelay);
        }

        string memory sk = "stocks";
        string memory stocksJson;
        for (uint256 i; i < stocks.length; ++i) {
            string memory one = stocks[i].symbol;
            vm.serializeAddress(one, "token", stocks[i].token);
            string memory entry = vm.serializeAddress(one, "feed", stocks[i].feed);
            stocksJson = vm.serializeString(sk, stocks[i].symbol, entry);
        }
        string memory json = vm.serializeString(k, "stocks", stocksJson);
        vm.createDir(string.concat(vm.projectRoot(), "/deployments"), true);
        string memory path = string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
        console2.log("Strike deployed; addresses written to", path);
    }
}
