// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IPendleMarket, IPendlePYLpOracle, IStandardizedYield} from "../../src/yield/IPendle.sol";
import {PendleCollateralAdapter} from "../../src/yield/PendleCollateralAdapter.sol";
import {MockReserve} from "../mocks/MockPendle.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Test, console} from "forge-std/Test.sol";

/// @notice PendleCollateralAdapter against Pendle V2's real PT-USDG market on Robinhood Chain mainnet (4663): the real
///         Router V4, the real PT/YT/LP oracle and the real USDG. Skipped unless ROBINHOOD_RPC_URL is set, and skipped
///         (not failed) when that RPC cannot be reached:
///         ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com forge test --match-path "test/fork/PendleCollateral*"
/// @dev Addresses from the Pendle API (api-v2.pendle.finance/core/v1/4663/markets/active) and Pendle's
///      deployments/4663-core.json; the market's tokens and expiry are re-read from chain in the first test.
///      The market keeps one rate observation (cardinality 1), too few for a 900 s TWAP. `_prepareOracle` raises its
///      `observationCardinalityNext` to 901 in storage, which is what Pendle's permissionless
///      `increaseObservationsCardinalityNext(901)` does apart from pre-paying 900 empty slots (about 900 RPC round
///      trips on a fork, five minutes). `test_fork_realCardinalityCall` makes the real call, opt-in with
///      PENDLE_FORK_SLOW=1.
contract PendleCollateralForkTest is Test {
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant ROUTER = 0x888888888889758F76e7103c6CbF23ABbF58F946;
    address internal constant ORACLE = 0x5542be50420E88dd7D5B4a3D488FA6ED82F6DAc2;
    address internal constant MARKET = 0xC2B89e6EcA583e2c232201ac557E9bE58AF55f4c;
    address internal constant PT = 0x6982e39521A070a3C40782548bfBED6Dc8F566ef;
    address internal constant YT = 0xF35Ee6bd9A93fE42BC7e628BFC4DDbdc6DE1f615;
    address internal constant SY = 0x8d3127aAbf76F95fE2970A0480B8662B4ad4C286;
    uint256 internal constant EXPIRY = 1_805_932_800; // 2027-03-25 00:00 UTC
    uint32 internal constant TWAP = 900;
    uint256 internal constant UNIT = 1e6;

    address internal vault = makeAddr("vault");
    address internal curator = makeAddr("curator");
    address internal agent = makeAddr("agent");

    MockReserve internal reserve;
    PendleCollateralAdapter internal adapter;
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
        if (!enabled) return;

        // The vault's mandate lets a series lock 60% of the collateral; the curator keeps 5% more liquid.
        reserve = new MockReserve();
        reserve.set(6000, 0);
        adapter = new PendleCollateralAdapter(
            PendleCollateralAdapter.Config({
                usdg: USDG,
                router: ROUTER,
                oracle: ORACLE,
                market: MARKET,
                owner: vault,
                curator: curator,
                allocator: agent,
                reserve: address(reserve),
                twapDuration: TWAP,
                maxTimeToMaturity: 200 days,
                hardCap: 100_000 * UNIT
            })
        );
        vm.startPrank(curator);
        adapter.setLimits(10_000 * UNIT, 500, 100); // cap 10k, 5% buffer, 1% slippage
        adapter.setEnabled(true);
        vm.stopPrank();
        deal(USDG, vault, 20_000 * UNIT);
        vm.startPrank(vault);
        IERC20(USDG).approve(address(adapter), 20_000 * UNIT);
        adapter.deposit(20_000 * UNIT);
        vm.stopPrank();
    }

    modifier onFork() {
        vm.skip(!enabled);
        _;
    }

    /// The trading tests need the market open for a couple of days; after 2027-03-23 they skip.
    modifier onLiveMarket() {
        vm.skip(!enabled || block.timestamp + 2 days >= EXPIRY);
        _;
    }

    // ------------------------------------------------------------------ helpers

    /// Raise the market's observationCardinalityNext to 901 (see the contract notes), then let the oldest
    /// observation age past the TWAP window.
    function _prepareOracle() internal {
        (,, uint96 lnRate, uint16 index, uint16 cardinality, uint16 next) = IMarketStorage(MARKET)._storage();
        (bool increase, uint16 required,) = IPendlePYLpOracle(ORACLE).getOracleState(MARKET, TWAP);
        if (increase) {
            uint256 slot = _storageSlot(lnRate, index, cardinality, next);
            uint256 word = uint256(vm.load(MARKET, bytes32(slot)));
            word = (word & ~(uint256(0xffff) << 128)) | (uint256(required) << 128);
            vm.store(MARKET, bytes32(slot), bytes32(word));
        }
        _wait(TWAP + 1);
        assertTrue(adapter.oracleReady(), "oracle not ready");
    }

    /// The storage slot holding (lastLnImpliedRate, observationIndex, observationCardinality, ...Next).
    function _storageSlot(uint96 lnRate, uint16 index, uint16 cardinality, uint16 next)
        internal
        view
        returns (uint256)
    {
        for (uint256 i; i < 128; ++i) {
            uint256 w = uint256(vm.load(MARKET, bytes32(i)));
            if (
                uint96(w) == lnRate && uint16(w >> 96) == index && uint16(w >> 112) == cardinality
                    && uint16(w >> 128) == next
            ) return i;
        }
        revert("market storage slot not found");
    }

    function _wait(uint256 secs) internal {
        vm.warp(block.timestamp + secs);
        vm.roll(block.number + secs * 4); // about four blocks a second
    }

    function _minPt(uint256 usdgIn) internal view returns (uint256) {
        return usdgIn * 1e18 / adapter.ptRate() * (10_000 - adapter.maxSlippageBps()) / 10_000;
    }

    function _allocate(uint256 usdgIn) internal returns (uint256) {
        uint256 minOut = _minPt(usdgIn);
        vm.prank(agent);
        return adapter.allocate(usdgIn, minOut);
    }

    /// Implied APY from a PT price and the time to maturity, in bps: (1 / rate) ^ (1 year / ttm) - 1, linearised
    /// through ln for the log line only.
    function _impliedApyBps(uint256 rate) internal view returns (uint256) {
        uint256 ttm = EXPIRY - block.timestamp;
        return (1e18 * 1e18 / rate - 1e18) * 365 days / ttm / 1e14;
    }

    // ------------------------------------------------------------------ tests

    /// The addresses are Pendle's PT-USDG market: its tokens, expiry and SY asset read back from chain.
    function test_fork_marketIsPtUsdg() public onFork {
        (address sy, address pt, address yt) = IPendleMarket(MARKET).readTokens();
        assertEq(sy, SY);
        assertEq(pt, PT);
        assertEq(yt, YT);
        assertEq(IPendleMarket(MARKET).expiry(), EXPIRY);
        (, address asset, uint8 decimals) = IStandardizedYield(SY).assetInfo();
        assertEq(asset, USDG);
        assertEq(decimals, 6);
        assertEq(IERC20Metadata(PT).decimals(), 6);
        assertEq(adapter.maturity(), EXPIRY);
        assertEq(address(adapter.pt()), PT);
        assertEq(adapter.yt(), YT);
        if (block.timestamp < EXPIRY) {
            uint256 rate = IPendlePYLpOracle(ORACLE).getPtToAssetRate(MARKET, TWAP);
            assertLt(rate, 1e18, "PT trades at a discount");
            assertGt(rate, 0.9e18, "a USD PT within a year of maturity");
            console.log("PT-USDG oracle rate (1e18 = par):", rate);
            console.log("simple implied APY (bps):", _impliedApyBps(rate));
        }
    }

    /// On the live market the TWAP is not usable as is: the adapter sees that and refuses to buy.
    function test_fork_refusesToBuyUntilTheOracleIsReady() public onLiveMarket {
        (bool increase,,) = IPendlePYLpOracle(ORACLE).getOracleState(MARKET, TWAP);
        if (!increase) return; // someone has raised the cardinality on mainnet since this was written
        assertFalse(adapter.oracleReady());
        vm.prank(agent);
        vm.expectRevert(PendleCollateralAdapter.OracleNotReady.selector);
        adapter.allocate(1000 * UNIT, 0);
        _prepareOracle();
        _allocate(1000 * UNIT);
    }

    /// Buy PT with idle USDG, value it at the TWAP, hold to maturity, redeem at par.
    function test_fork_buyValueAndRedeemAtMaturity() public onLiveMarket {
        _prepareOracle();
        uint256 rateBefore = adapter.ptRate();
        uint256 ptOut = _allocate(5000 * UNIT);
        assertEq(adapter.ptBalance(), ptOut);
        assertGt(ptOut, 5000 * UNIT, "PT bought below par");
        assertEq(adapter.liquidAssets(), 15_000 * UNIT);
        // The TWAP barely moves on our own trade: the mark is the pre-trade price, not the post-trade one.
        assertApproxEqRel(adapter.ptRate(), rateBefore, 0.0005e18);
        assertApproxEqRel(adapter.totalAssets(), 20_000 * UNIT, 0.005e18);
        assertGe(adapter.liquidAssets(), adapter.requiredLiquidity());

        vm.warp(EXPIRY + 1);
        assertEq(adapter.ptRate(), 1e18);
        assertEq(adapter.totalAssets(), 15_000 * UNIT + ptOut);
        uint256 got = adapter.redeemMatured();
        assertEq(got, ptOut, "one USDG per PT at maturity");
        assertEq(adapter.ptBalance(), 0);
        assertGt(adapter.liquidAssets(), 20_000 * UNIT, "the fixed yield, net of the entry cost");
        console.log("USDG earned on 5,000 held to maturity:", adapter.liquidAssets() - 20_000 * UNIT);
    }

    /// Sell before maturity: the allocator's floor is the TWAP value less 1%, and Pendle enforces it.
    function test_fork_earlyExitWithASlippageBound() public onLiveMarket {
        _prepareOracle();
        uint256 ptOut = _allocate(5000 * UNIT);
        _wait(1 days);
        uint256 rate = adapter.ptRate();
        uint256 fair = ptOut * rate / 1e18;
        uint256 floor = fair * 9900 / 10_000;

        // Asking for the full TWAP value (no slippage) fails inside Pendle's router.
        vm.prank(agent);
        vm.expectRevert();
        adapter.deallocate(ptOut, fair + fair / 100);

        // A floor looser than 1% is refused by the adapter.
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(PendleCollateralAdapter.SlippageBoundTooLoose.selector, floor - 1, floor)
        );
        adapter.deallocate(ptOut, floor - 1);

        vm.prank(agent);
        uint256 got = adapter.deallocate(ptOut, floor);
        assertGe(got, floor);
        assertEq(adapter.ptBalance(), 0);
        // Round trip in a day: the two trades' price impact and fees, less a day of accrual.
        assertApproxEqRel(adapter.liquidAssets(), 20_000 * UNIT, 0.01e18);
        console.log("round-trip cost on 5,000 (USDG units):", 20_000 * UNIT - adapter.liquidAssets());
    }

    /// The reserve holds on the real market: 60% share plus 5% buffer leaves about 35% to allocate, never more.
    function test_fork_liquidityReserveHolds() public onLiveMarket {
        _prepareOracle();
        uint256 free = adapter.allocatable();
        assertApproxEqAbs(free, 7000 * UNIT, 1 * UNIT);
        uint256 minOut = _minPt(free + 100 * UNIT);
        vm.prank(agent);
        vm.expectPartialRevert(PendleCollateralAdapter.ReserveBreached.selector);
        adapter.allocate(free + 100 * UNIT, minOut);

        _allocate(free * 99 / 100);
        assertGe(adapter.liquidAssets(), adapter.requiredLiquidity());

        // A live series now needs 15,000: the agent cannot add, the shortfall says what to sell, the vault sells.
        reserve.set(0, 15_000 * UNIT);
        assertEq(adapter.allocatable(), 0);
        uint256 gap = adapter.shortfall();
        assertGt(gap, 0);
        uint256 bal = adapter.ptBalance();
        vm.prank(vault);
        adapter.deallocate(bal, 0);
        assertEq(adapter.shortfall(), 0);
        vm.prank(vault);
        adapter.withdraw(15_000 * UNIT, vault); // the settlement payout, paid in full
    }

    /// Any size from 10 to 5,000 USDG: buying keeps the reserve and selling back loses under 1%.
    /// forge-config: default.fuzz.runs = 8
    /// forge-config: ci.fuzz.runs = 8
    function testFuzz_fork_allocateAndExit(uint256 usdgIn) public onLiveMarket {
        _prepareOracle();
        usdgIn = bound(usdgIn, 10 * UNIT, 5000 * UNIT);
        uint256 ptOut = _allocate(usdgIn);
        assertGe(adapter.liquidAssets(), adapter.requiredLiquidity());
        uint256 floor = ptOut * adapter.ptRate() / 1e18 * 9900 / 10_000;
        vm.prank(agent);
        adapter.deallocate(ptOut, floor);
        assertGe(adapter.liquidAssets(), 20_000 * UNIT - usdgIn / 100);
    }

    /// The real permissionless call that makes the TWAP usable (900 slots: slow on a fork, opt-in).
    function test_fork_realCardinalityCall() public onLiveMarket {
        vm.skip(!vm.envOr("PENDLE_FORK_SLOW", false));
        (bool increase, uint16 required,) = IPendlePYLpOracle(ORACLE).getOracleState(MARKET, TWAP);
        if (increase) IPendleMarket(MARKET).increaseObservationsCardinalityNext(required);
        _wait(TWAP + 1);
        assertTrue(adapter.oracleReady());
        _allocate(1000 * UNIT);
        _wait(TWAP + 1);
        assertTrue(adapter.oracleReady());
        assertGt(adapter.ptValue(), 1000 * UNIT * 99 / 100);
    }
}

interface IMarketStorage {
    function _storage()
        external
        view
        returns (
            int128 totalPt,
            int128 totalSy,
            uint96 lastLnImpliedRate,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext
        );
}
