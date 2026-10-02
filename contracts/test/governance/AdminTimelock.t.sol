// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AdminTimelock} from "../../script/AdminTimelock.sol";
import {EpochManager} from "../../src/core/EpochManager.sol";
import {IPricer} from "../../src/interfaces/IPricer.sol";
import {IStockOracle} from "../../src/interfaces/IStockOracle.sol";
import {MandateGuard} from "../../src/libraries/MandateGuard.sol";
import {StockOracle} from "../../src/oracle/StockOracle.sol";
import {StrikeVault} from "../../src/vaults/StrikeVault.sol";
import {VaultFactory} from "../../src/vaults/VaultFactory.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";
import {StrikeBase} from "../utils/StrikeBase.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @notice What a compromised admin would install through `setPricer`: the honest quote divided by 1000, so an
///         accomplice buys options for almost nothing.
contract CheapPricer is IPricer {
    IPricer internal immutable honest;

    constructor(IPricer honest_) {
        honest = honest_;
    }

    function quote(uint256 spot, uint256 strike, uint256 timeToExpiry, uint256 sigma, bool isCall)
        external
        view
        returns (uint256 price, int256 delta)
    {
        (price, delta) = honest.quote(spot, strike, timeToExpiry, sigma, isCall);
        price /= 1000;
    }

    function strikeForDelta(uint256 spot, uint256 targetDelta, uint256 timeToExpiry, uint256 sigma, bool isCall)
        external
        view
        returns (uint256)
    {
        return honest.strikeForDelta(spot, targetDelta, timeToExpiry, sigma, isCall);
    }
}

/// @title The admin gap, closed by a timelock (D43)
/// @notice The adversarial suite's first "Not defended in code" item: a compromised admin can pick a settlement or
///         sale price before it is recorded, through `StockOracle.setFeed`, `EpochManager.setOracle` or
///         `EpochManager.setPricer`. With an OpenZeppelin TimelockController as the only admin (Deploy.s.sol's
///         mainnet path, `AdminTimelock`), and a delay longer than the longest epoch plus the settlement grace, none
///         of these calls can land inside a running epoch: each is public (`CallScheduled`) for the whole delay, a
///         depositor can leave before it runs, and the epoch settles on the honest feed first. The control fuzz test
///         shows the same swap landing first with any delay shorter than the epoch's settlement window.
///         docs/trust-model.md, "Staged path for the admin keys".
contract AdminTimelockTest is StrikeBase {
    bytes32 internal constant ADMIN_ROLE = 0x00;
    int256 internal constant HONEST_PRINT = 260e8;
    int256 internal constant ATTACKER_PRINT = 1000e8;

    address internal safe = makeAddr("safe");
    address internal attacker = makeAddr("attacker");
    TimelockController internal timelock;
    /// @notice A covered-call vault whose mandate allows the longest tenor any mandate may (`MAX_TENOR_CAP`).
    StrikeVault internal longVault;
    /// @notice The attacker's feed: it copies every honest print until expiry, then prints its own price.
    MockAggregator internal evilFeed;

    struct Epoch {
        uint256 seriesId;
        uint64 expiry;
        uint80 honestRound;
        uint80 evilRound;
        uint256 readyAt; // when the scheduled call can first run
    }

    function setUp() public override {
        super.setUp();
        VaultFactory.CreateParams memory p = _params(true, 1_000_000 * WAD);
        p.mandate.maxTenor = uint32(MandateGuard.MAX_TENOR_CAP);
        p.symbol = "sTSLA-CC35";
        vm.prank(curator);
        longVault = StrikeVault(factory.createVault(p));
        evilFeed = new MockAggregator(8);
    }

    // ------------------------------------------------------------------ the delay

    /// @notice The delay comes from the contracts' own limits, probed here against the code: `setTimings` refuses a
    ///         proposalTimeout above 7 days and a settlementGrace above 30 days, and a mandate's tenor cannot exceed
    ///         `MAX_TENOR_CAP` (35 days). Longest epoch 42 days, plus the grace: 72 days; the delay is 73.
    function test_delayIsLongerThanTheLongestEpochPlusTheGrace() public {
        vm.startPrank(admin);
        vm.expectRevert(EpochManager.InvalidTimings.selector);
        manager.setTimings(uint32(AdminTimelock.MAX_PROPOSAL_TIMEOUT + 1), 1 hours, 7 days);
        vm.expectRevert(EpochManager.InvalidTimings.selector);
        manager.setTimings(1 days, 1 hours, uint32(AdminTimelock.MAX_SETTLEMENT_GRACE + 1));
        manager.setTimings(
            uint32(AdminTimelock.MAX_PROPOSAL_TIMEOUT), 1 hours, uint32(AdminTimelock.MAX_SETTLEMENT_GRACE)
        );
        vm.stopPrank();

        VaultFactory.CreateParams memory p = _params(true, WAD);
        p.mandate.maxTenor = uint32(MandateGuard.MAX_TENOR_CAP + 1);
        vm.prank(curator);
        vm.expectRevert(MandateGuard.InvalidMandate.selector);
        factory.createVault(p);
        assertEq(uint256(manager.vaultConfig(address(longVault)).mandate.maxTenor), MandateGuard.MAX_TENOR_CAP);

        assertEq(AdminTimelock.LONGEST_EPOCH, 42 days);
        assertEq(AdminTimelock.SETTLEMENT_BOUND, 72 days);
        assertEq(AdminTimelock.MIN_DELAY, 73 days);
        _install(AdminTimelock.MIN_DELAY, false);
        assertEq(timelock.getMinDelay(), AdminTimelock.MIN_DELAY);
        assertGt(
            timelock.getMinDelay(),
            AdminTimelock.MAX_PROPOSAL_TIMEOUT + MandateGuard.MAX_TENOR_CAP + AdminTimelock.MAX_SETTLEMENT_GRACE
        );

        // The deploy path refuses a shorter delay, and a timelock without a Safe.
        vm.expectRevert(abi.encodeWithSelector(AdminTimelock.DelayTooShort.selector, 72 days, AdminTimelock.MIN_DELAY));
        this.deployTimelock(safe, 72 days);
        vm.expectRevert(AdminTimelock.ZeroAddress.selector);
        this.deployTimelock(address(0), AdminTimelock.MIN_DELAY);
    }

    /// @notice After the hand-over nobody calls an admin setter directly, not the old admin, the Safe or the
    ///         guardian; only the Safe can schedule; and the timelock's delay changes only through the timelock.
    function test_nobodyBypassesTheTimelock() public {
        _install(AdminTimelock.MIN_DELAY, false);
        address[3] memory callers = [admin, safe, guardian];
        for (uint256 i; i < callers.length; ++i) {
            vm.startPrank(callers[i]);
            _expectUnauthorized(callers[i], ADMIN_ROLE);
            oracle.setFeed(address(tsla), evilFeed, 1 days, 1 days);
            _expectUnauthorized(callers[i], ADMIN_ROLE);
            manager.setOracle(IStockOracle(address(oracle)));
            _expectUnauthorized(callers[i], ADMIN_ROLE);
            manager.setPricer(pricer);
            _expectUnauthorized(callers[i], ADMIN_ROLE);
            manager.setTimings(1 days, 1 hours, 7 days);
            _expectUnauthorized(callers[i], ADMIN_ROLE);
            manager.grantRole(ADMIN_ROLE, callers[i]);
            vm.stopPrank();
        }

        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(TimelockController.TimelockUnauthorizedCaller.selector, safe));
        timelock.updateDelay(1 days);

        (address target, bytes memory data) = _setFeedCall();
        bytes32 proposer = timelock.PROPOSER_ROLE();
        uint256 delay = AdminTimelock.MIN_DELAY;
        vm.prank(attacker);
        _expectUnauthorized(attacker, proposer);
        timelock.schedule(target, 0, data, bytes32(0), bytes32(0), delay);

        address[] memory admins = _admins();
        for (uint256 i; i < admins.length; ++i) {
            assertFalse(IAccessControl(admins[i]).hasRole(ADMIN_ROLE, admin), "deployer keeps no admin role");
            assertTrue(IAccessControl(admins[i]).hasRole(ADMIN_ROLE, address(timelock)), "the timelock is admin");
        }
        assertFalse(calendar.hasRole(calendar.CALENDAR_ROLE(), admin));
        assertTrue(calendar.hasRole(calendar.CALENDAR_ROLE(), address(timelock)));
        assertFalse(manager.hasRole(manager.GUARDIAN_ROLE(), admin));
        assertTrue(manager.hasRole(manager.GUARDIAN_ROLE(), guardian), "the guardian can still pause");
    }

    /// @notice Each of the three calls is public from the moment it is scheduled (`CallScheduled` carries the target,
    ///         the calldata and the delay), a shorter delay is refused, and none runs a second before the delay ends.
    function test_eachCallIsPublicAndWaitsTheFullDelay() public {
        _install(AdminTimelock.MIN_DELAY, false);
        (address[3] memory targets, bytes[3] memory data) = _attackCalls();
        bytes32[3] memory ids;
        for (uint256 i; i < 3; ++i) {
            ids[i] = _schedule(targets[i], data[i]);
            assertEq(timelock.getTimestamp(ids[i]), block.timestamp + AdminTimelock.MIN_DELAY);
        }
        vm.prank(safe);
        vm.expectRevert(
            abi.encodeWithSelector(
                TimelockController.TimelockInsufficientDelay.selector,
                AdminTimelock.MIN_DELAY - 1,
                AdminTimelock.MIN_DELAY
            )
        );
        timelock.schedule(targets[0], 0, data[0], bytes32(0), bytes32("again"), AdminTimelock.MIN_DELAY - 1);

        vm.warp(block.timestamp + AdminTimelock.MIN_DELAY - 1);
        for (uint256 i; i < 3; ++i) {
            vm.prank(safe);
            vm.expectRevert(
                abi.encodeWithSelector(TimelockController.TimelockUnexpectedOperationState.selector, ids[i], _ready())
            );
            timelock.execute(targets[i], 0, data[i], bytes32(0), bytes32(0));
        }

        vm.warp(block.timestamp + 1);
        for (uint256 i; i < 3; ++i) {
            _execute(targets[i], data[i]);
            assertTrue(timelock.isOperationDone(ids[i]));
        }
        assertEq(address(oracle.feedConfig(address(tsla)).feed), address(evilFeed));
        assertTrue(address(manager.oracle()) != address(oracle));
        assertTrue(address(manager.pricer()) != address(pricer));
    }

    // ------------------------------------------------------------------ the worst case, per call

    /// @notice `setFeed` scheduled the moment the longest possible epoch opens lands only after its honest price is
    ///         final; the attacker's feed cannot replace it afterwards.
    function test_setFeedScheduledAtOpenLandsAfterTheHonestSettlement() public {
        (address target, bytes memory data) = _setFeedCall();
        Epoch memory e = _worstCase(target, data);
        assertEq(address(oracle.feedConfig(address(tsla)).feed), address(evilFeed), "the swap landed, afterwards");
        assertEq(oracle.recordSettlementPrice(address(tsla), e.expiry, e.evilRound), 260e18, "recorded once, final");
    }

    /// @notice The same for `setOracle`: the new oracle arrives after the series is settled and the vault is idle.
    function test_setOracleScheduledAtOpenLandsAfterTheHonestSettlement() public {
        (address target, bytes memory data) = _setOracleCall();
        Epoch memory e = _worstCase(target, data);
        assertTrue(address(manager.oracle()) != address(oracle), "the swap landed, afterwards");
        assertEq(manager.getSeries(e.seriesId).settlementPrice, 260e18);
        vm.expectRevert(_wrongState(EpochManager.EpochState.Selling, EpochManager.EpochState.Idle));
        manager.settle(address(longVault), e.evilRound);
    }

    /// @notice The same for `setPricer`: every sale of the epoch, up to the sale cutoff, is priced by the honest pricer.
    function test_setPricerScheduledAtOpenLandsAfterTheEpochsLastSale() public {
        (address target, bytes memory data) = _setPricerCall();
        Epoch memory e = _worstCase(target, data);
        assertLt(uint256(e.expiry) - manager.saleCutoff(), e.readyAt, "the last sale came long before the swap");
        assertTrue(address(manager.pricer()) != address(pricer), "the swap landed, afterwards");
    }

    // ------------------------------------------------------------------ depositors

    /// @notice A depositor who sees `CallScheduled` leaves before the call can run: straight out of an idle vault, or
    ///         queued out of a running epoch (processed when it settles), even in the longest epoch with the honest
    ///         price recorded at the last moment of the grace.
    function test_depositorsLeaveBeforeTheCallCanRun() public {
        _install(AdminTimelock.MIN_DELAY, true);
        _depositLong(alice, 100 * WAD);
        _depositCall(bob, 40 * WAD);
        _toMarketOpen();
        uint256 openedAt = _open(longVault);
        (address target, bytes memory data) = _setFeedCall();
        bytes32 id = _schedule(target, data);

        // Idle vault: out at once.
        vm.prank(bob);
        callVault.redeem(40 * WAD, bob, bob);
        assertEq(tsla.balanceOf(bob), 40 * WAD, "bob is out");

        // Running epoch: queue every share; the queue is processed at settlement.
        uint256 shares = longVault.balanceOf(alice);
        vm.prank(alice);
        longVault.requestRedeem(shares);
        Epoch memory e = _proposeBuyExpire(longVault, openedAt, manager.proposalTimeout(), MandateGuard.MAX_TENOR_CAP);
        vm.warp(e.expiry + manager.settlementGrace() - 1);
        manager.settle(address(longVault), e.honestRound);
        longVault.claimRedeem(alice);
        assertEq(tsla.balanceOf(alice), 100 * WAD, "alice has all her collateral back");
        assertEq(longVault.balanceOf(alice), 0);
        vm.prank(alice);
        assertGt(longVault.claimPremium(), 0, "and the premium her shares earned");

        assertLt(block.timestamp, timelock.getTimestamp(id), "both left before the call can run");
        assertFalse(timelock.isOperationReady(id));
    }

    /// @notice If the agent never proposes, anyone may abort once `proposalTimeout` has passed, which processes the
    ///         queue: a stalled epoch cannot hold a depositor past the call either.
    function test_depositorLeavesAStalledEpochBeforeTheCallCanRun() public {
        _install(AdminTimelock.MIN_DELAY, true);
        _depositLong(alice, 100 * WAD);
        _toMarketOpen();
        uint256 openedAt = _open(longVault);
        (address target, bytes memory data) = _setFeedCall();
        bytes32 id = _schedule(target, data);
        uint256 shares = longVault.balanceOf(alice);
        vm.prank(alice);
        longVault.requestRedeem(shares);

        vm.warp(openedAt + manager.proposalTimeout());
        vm.prank(alice);
        manager.abortEpoch(address(longVault));
        longVault.claimRedeem(alice);
        assertEq(tsla.balanceOf(alice), 100 * WAD);
        assertFalse(timelock.isOperationReady(id));
    }

    // ------------------------------------------------------------------ epochs that open after the schedule

    /// @notice An epoch that opens after the call is scheduled still settles on the honest feed: next week's epoch
    ///         opens, sells, expires on Friday and settles at the first print, long before the call can run.
    function test_epochOpenedAfterTheScheduleSettlesOnTheHonestFeed() public {
        _install(AdminTimelock.MIN_DELAY, false);
        _depositCall(alice, 100 * WAD);
        (address target, bytes memory data) = _setFeedCall();
        bytes32 id = _schedule(target, data);
        uint256 readyAt = timelock.getTimestamp(id);

        vm.warp(MONDAY + 7 days);
        _print(250e8);
        uint256 openedAt = _open(callVault);
        Epoch memory e = _proposeBuyExpire(callVault, openedAt, 0, 5 days);
        assertEq(e.expiry, NEXT_FRIDAY_CLOSE);
        manager.settle(address(callVault), e.honestRound);
        assertLt(block.timestamp, readyAt);

        vm.warp(readyAt);
        _execute(target, data);
        _assertSettledHonestly(e, callVault);
        assertEq(oracle.recordSettlementPrice(address(tsla), e.expiry, e.evilRound), 260e18, "final");
    }

    /// @notice Whenever the epoch opens (from the schedule up to a day later), however late the agent proposes, however
    ///         long the tenor and however late in the grace the honest price is recorded, the call cannot run yet.
    function testFuzz_noEpochRunningAtTheScheduleOutlastsTheDelay(
        uint256 openAfter,
        uint256 proposeAfter,
        uint256 tenor,
        uint256 settleAfter
    ) public {
        _install(AdminTimelock.MIN_DELAY, true);
        _depositLong(alice, 100 * WAD);
        (address target, bytes memory data) = _setFeedCall();
        bytes32 id = _schedule(target, data);

        vm.warp(block.timestamp + bound(openAfter, 0, 1 days));
        _toMarketOpen();
        uint256 openedAt = _open(longVault);
        assertLe(openedAt, MONDAY + 1 days);
        Epoch memory e = _proposeBuyExpire(
            longVault,
            openedAt,
            bound(proposeAfter, 0, manager.proposalTimeout()),
            bound(tenor, 5 days, MandateGuard.MAX_TENOR_CAP)
        );
        vm.warp(e.expiry + bound(settleAfter, 60, manager.settlementGrace() - 1));

        assertFalse(timelock.isOperationReady(id), "the call is still waiting");
        manager.settle(address(longVault), e.honestRound);
        _assertSettledHonestly(e, longVault);
    }

    // ------------------------------------------------------------------ stage 2: renouncing

    /// @notice Stage 2 of the staged path: once the timelock renounces the admin role of the StockOracle and the
    ///         EpochManager (itself a scheduled call), nobody can swap the feed, the oracle or the pricer, not even
    ///         through the timelock, and there is no admin left to grant the role back. The guardian still pauses, and
    ///         an epoch still opens, sells and settles.
    function test_stage2_renouncingTheOracleAndManagerAdminEndsTheGap() public {
        _install(AdminTimelock.MIN_DELAY, false);
        bytes memory renounce = abi.encodeCall(IAccessControl.renounceRole, (ADMIN_ROLE, address(timelock)));
        _schedule(address(oracle), renounce);
        _schedule(address(manager), renounce);
        vm.warp(block.timestamp + AdminTimelock.MIN_DELAY);
        _execute(address(oracle), renounce);
        _execute(address(manager), renounce);
        assertFalse(oracle.hasRole(ADMIN_ROLE, address(timelock)));
        assertFalse(manager.hasRole(ADMIN_ROLE, address(timelock)));

        (address[3] memory targets, bytes[3] memory data) = _attackCalls();
        for (uint256 i; i < 3; ++i) {
            _schedule(targets[i], data[i]);
        }
        vm.warp(block.timestamp + AdminTimelock.MIN_DELAY);
        for (uint256 i; i < 3; ++i) {
            vm.prank(safe);
            _expectUnauthorized(address(timelock), ADMIN_ROLE);
            timelock.execute(targets[i], 0, data[i], bytes32(0), bytes32(0));
        }

        vm.prank(guardian);
        manager.pause();
        vm.prank(guardian);
        manager.unpause();
        _depositCall(alice, 100 * WAD);
        _toMarketOpen();
        Epoch memory e = _proposeBuyExpire(callVault, _open(callVault), 0, 5 days);
        manager.settle(address(callVault), e.honestRound);
        _assertSettledHonestly(e, callVault);
    }

    // ------------------------------------------------------------------ control

    /// @notice Control: with any delay shorter than this epoch's settlement window (the longest epoch, opened at the
    ///         schedule, settled at the last moment of the grace), the same feed swap lands first and the vault
    ///         settles at the attacker's price. The length of the delay is what makes the timelock a safeguard.
    function testFuzz_control_aShorterDelayLetsTheFeedSwapLandFirst(uint256 delay) public {
        uint64 expiry = _lastCloseAtOrBefore(MONDAY + AdminTimelock.LONGEST_EPOCH);
        uint256 lastHonestSettle = expiry + AdminTimelock.MAX_SETTLEMENT_GRACE - 1;
        delay = bound(delay, 1 hours, lastHonestSettle - MONDAY);
        _install(delay, true);
        _depositLong(alice, 100 * WAD);
        _print(250e8);
        uint256 openedAt = _open(longVault);
        (address target, bytes memory data) = _setFeedCall();
        bytes32 id = _schedule(target, data);
        Epoch memory e = _proposeBuyExpire(longVault, openedAt, manager.proposalTimeout(), MandateGuard.MAX_TENOR_CAP);
        assertEq(e.expiry, expiry);

        // Once the swap is ready and the series has expired, the attacker runs it and settles on its own print, while
        // an honest keeper could still be inside the grace.
        uint256 readyAt = timelock.getTimestamp(id);
        if (readyAt > block.timestamp) vm.warp(readyAt);
        assertLe(block.timestamp, lastHonestSettle);
        _execute(target, data);
        manager.settle(address(longVault), e.evilRound);
        assertEq(manager.getSeries(e.seriesId).settlementPrice, 1000e18, "settled at the attacker's price");
        assertLt(longVault.totalAssets(), 100 * WAD, "collateral left the vault");
    }

    // ------------------------------------------------------------------ helpers

    function deployTimelock(address safe_, uint256 delay) external returns (TimelockController) {
        return AdminTimelock.deploy(safe_, delay);
    }

    /// @dev Deploy.s.sol's mainnet path: the admin hands every role to a timelock the Safe proposes to. A delay below
    ///      `MIN_DELAY` (the control) builds the TimelockController directly, as the deploy script would refuse it.
    function _install(uint256 delay, bool timingsAtCaps) internal {
        vm.startPrank(admin);
        if (timingsAtCaps) {
            manager.setTimings(
                uint32(AdminTimelock.MAX_PROPOSAL_TIMEOUT), 1 hours, uint32(AdminTimelock.MAX_SETTLEMENT_GRACE)
            );
        }
        if (delay >= AdminTimelock.MIN_DELAY) {
            timelock = AdminTimelock.deploy(safe, delay);
        } else {
            address[] memory safeOnly = new address[](1);
            safeOnly[0] = safe;
            timelock = new TimelockController(delay, safeOnly, safeOnly, address(0));
        }
        AdminTimelock.handOver(timelock, admin, calendar, manager, guardian, _admins());
        vm.stopPrank();
    }

    function _admins() internal view returns (address[] memory a) {
        a = new address[](7);
        (a[0], a[1], a[2], a[3]) = (address(calendar), address(oracle), address(fees), address(options));
        (a[4], a[5], a[6]) = (address(registry), address(manager), address(factory));
    }

    /// @dev The worst case the contracts allow: timings raised to their caps through the timelock, the call scheduled
    ///      the moment an epoch opens, the agent proposing at the last moment with the longest tenor, and the honest
    ///      price recorded at the last second before the guardian could cancel. The call still cannot run then.
    function _worstCase(address target, bytes memory data) internal returns (Epoch memory e) {
        _install(AdminTimelock.MIN_DELAY, false);
        _raiseTimingsThroughTheTimelock();
        _depositLong(alice, 100 * WAD);
        _toMarketOpen();
        uint256 openedAt = _open(longVault);
        bytes32 id = _schedule(target, data);
        uint256 readyAt = timelock.getTimestamp(id);
        assertEq(readyAt, openedAt + AdminTimelock.MIN_DELAY);

        e = _proposeBuyExpire(longVault, openedAt, manager.proposalTimeout(), MandateGuard.MAX_TENOR_CAP);
        e.readyAt = readyAt;
        vm.warp(e.expiry + manager.settlementGrace() - 1);
        assertFalse(timelock.isOperationReady(id), "still waiting at the end of the grace");
        vm.prank(safe);
        vm.expectRevert(
            abi.encodeWithSelector(TimelockController.TimelockUnexpectedOperationState.selector, id, _ready())
        );
        timelock.execute(target, 0, data, bytes32(0), bytes32(0));
        manager.settle(address(longVault), e.honestRound);

        vm.warp(readyAt);
        _execute(target, data);
        assertTrue(timelock.isOperationDone(id));
        _assertSettledHonestly(e, longVault);
    }

    function _raiseTimingsThroughTheTimelock() internal {
        bytes memory data = abi.encodeCall(
            EpochManager.setTimings,
            (uint32(AdminTimelock.MAX_PROPOSAL_TIMEOUT), 1 hours, uint32(AdminTimelock.MAX_SETTLEMENT_GRACE))
        );
        _schedule(address(manager), data);
        vm.warp(block.timestamp + AdminTimelock.MIN_DELAY);
        _execute(address(manager), data);
        assertEq(manager.proposalTimeout(), AdminTimelock.MAX_PROPOSAL_TIMEOUT);
        assertEq(manager.settlementGrace(), AdminTimelock.MAX_SETTLEMENT_GRACE);
    }

    /// @dev The agent proposes `proposeAfter` after the open: a 0.20-delta call expiring at the last session close
    ///      within `tenor`. A buyer buys 10 at the next session. After expiry the attacker's feed prints 1000 (30 s)
    ///      and the honest feed 260 (60 s), out of the money.
    function _proposeBuyExpire(StrikeVault vault, uint256 openedAt, uint256 proposeAfter, uint256 tenor)
        internal
        returns (Epoch memory e)
    {
        vm.warp(openedAt + proposeAfter);
        _print(250e8);
        e.expiry = _lastCloseAtOrBefore(block.timestamp + tenor);
        bool accepted;
        vm.prank(agent);
        (accepted, e.seriesId,) = manager.proposeByDelta(address(vault), 2000, e.expiry, 50 * WAD, 10_000);
        assertTrue(accepted, "proposal rejected");
        _toMarketOpen();
        _buy(e.seriesId, 10 * WAD);
        vm.warp(e.expiry + 30);
        e.evilRound = evilFeed.set(ATTACKER_PRINT);
        vm.warp(e.expiry + 60);
        e.honestRound = feed.set(HONEST_PRINT);
    }

    function _assertSettledHonestly(Epoch memory e, StrikeVault vault) internal view {
        EpochManager.Series memory s = manager.getSeries(e.seriesId);
        assertTrue(s.settled);
        assertEq(s.settlementPrice, 260e18, "settled on the honest print");
        assertEq(oracle.settlementPrice(address(tsla), e.expiry), 260e18, "recorded in the honest oracle");
        assertEq(s.payoutPerOption, 0, "out of the money at the honest price");
        assertEq(vault.totalAssets(), 100 * WAD, "no collateral left the vault");
    }

    function _setFeedCall() internal view returns (address, bytes memory) {
        return (address(oracle), abi.encodeCall(StockOracle.setFeed, (address(tsla), evilFeed, 1 days, 1 days)));
    }

    function _setOracleCall() internal returns (address, bytes memory) {
        StockOracle evil = new StockOracle(attacker, calendar);
        vm.prank(attacker);
        evil.setFeed(address(tsla), evilFeed, 1 days, 1 days);
        return (address(manager), abi.encodeCall(EpochManager.setOracle, (IStockOracle(address(evil)))));
    }

    function _setPricerCall() internal returns (address, bytes memory) {
        return (address(manager), abi.encodeCall(EpochManager.setPricer, (IPricer(new CheapPricer(pricer)))));
    }

    function _attackCalls() internal returns (address[3] memory targets, bytes[3] memory data) {
        (targets[0], data[0]) = _setFeedCall();
        (targets[1], data[1]) = _setOracleCall();
        (targets[2], data[2]) = _setPricerCall();
    }

    /// @dev Schedule as the Safe, with the timelock's delay, and check the public event.
    function _schedule(address target, bytes memory data) internal returns (bytes32 id) {
        id = timelock.hashOperation(target, 0, data, bytes32(0), bytes32(0));
        uint256 delay = timelock.getMinDelay();
        vm.expectEmit(address(timelock));
        emit TimelockController.CallScheduled(id, 0, target, 0, data, bytes32(0), delay);
        vm.prank(safe);
        timelock.schedule(target, 0, data, bytes32(0), bytes32(0), delay);
    }

    function _execute(address target, bytes memory data) internal {
        vm.prank(safe);
        timelock.execute(target, 0, data, bytes32(0), bytes32(0));
    }

    function _ready() internal pure returns (bytes32) {
        return bytes32(1 << uint8(TimelockController.OperationState.Ready));
    }

    function _expectUnauthorized(address account, bytes32 role) internal {
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, account, role));
    }

    function _wrongState(EpochManager.EpochState expected, EpochManager.EpochState actual)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeWithSelector(EpochManager.WrongState.selector, expected, actual);
    }

    function _open(StrikeVault vault) internal returns (uint256) {
        vm.prank(agent);
        manager.openEpoch(address(vault));
        return block.timestamp;
    }

    function _depositLong(address who, uint256 amount) internal {
        tsla.mint(who, amount);
        vm.startPrank(who);
        tsla.approve(address(longVault), amount);
        longVault.deposit(amount, who);
        vm.stopPrank();
    }

    /// @dev A print on both feeds: the attacker's copies the honest one until expiry.
    function _print(int256 price8) internal {
        feed.set(price8);
        evilFeed.set(price8);
    }

    /// @dev Move to the next moment the NYSE regular session is open, with a fresh print.
    function _toMarketOpen() internal {
        uint256 t = block.timestamp;
        while (!calendar.isMarketOpen(t)) {
            t += 15 minutes;
        }
        vm.warp(t);
        _print(250e8);
    }

    function _lastCloseAtOrBefore(uint256 t) internal view returns (uint64) {
        uint256 day = t / 1 days;
        for (uint256 i; i < 7; ++i) {
            if (calendar.isTradingDay(day - i)) {
                (, uint256 close) = calendar.sessionOf(day - i);
                if (close <= t) return uint64(close);
            }
        }
        revert("no session close in the week before");
    }
}
