// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {EpochManager} from "../src/core/EpochManager.sol";
import {MandateGuard} from "../src/libraries/MandateGuard.sol";
import {MarketCalendar} from "../src/oracle/MarketCalendar.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @title AdminTimelock
/// @notice The mainnet admin (D43; docs/trust-model.md, "Staged path for the admin keys"): a Safe proposes to an
///         OpenZeppelin TimelockController, and the timelock is the only holder of every admin role. Its delay is
///         longer than the longest epoch plus the settlement grace, so a `StockOracle.setFeed`,
///         `EpochManager.setOracle` or `EpochManager.setPricer` scheduled while an epoch runs cannot land before that
///         epoch's settlement price is recorded, and depositors see it coming (`CallScheduled`) with time to leave.
///         Used by Deploy.s.sol and test/governance/AdminTimelock.t.sol.
library AdminTimelock {
    /// @notice `EpochManager.setTimings` reverts above these: proposalTimeout <= 7 days, settlementGrace <= 30 days.
    uint256 internal constant MAX_PROPOSAL_TIMEOUT = 7 days;
    uint256 internal constant MAX_SETTLEMENT_GRACE = 30 days;
    /// @notice The longest epoch: the agent proposes at most `proposalTimeout` after the open (after that anyone may
    ///         abort), and the expiry is at most `MandateGuard.MAX_TENOR_CAP` after the proposal. 42 days.
    uint256 internal constant LONGEST_EPOCH = MAX_PROPOSAL_TIMEOUT + MandateGuard.MAX_TENOR_CAP;
    /// @notice How long after an epoch opens its settlement price can still be unrecorded: after expiry +
    ///         `settlementGrace` the guardian may cancel the series instead. 72 days.
    uint256 internal constant SETTLEMENT_BOUND = LONGEST_EPOCH + MAX_SETTLEMENT_GRACE;
    /// @notice The shortest delay Deploy.s.sol accepts, and its default: the bound plus one day, so an epoch that
    ///         opens up to a day after a call is scheduled is covered too. 73 days.
    uint256 internal constant MIN_DELAY = SETTLEMENT_BOUND + 1 days;

    bytes32 internal constant DEFAULT_ADMIN_ROLE = 0x00;

    error ZeroAddress();
    error DelayTooShort(uint256 delay, uint256 minDelay);
    error AdminLeft(address target);

    /// @notice Deploy the timelock. `safe` proposes, cancels and executes. The timelock has no admin, so its own roles
    ///         and its delay change only through a scheduled call that waits the delay.
    function deploy(address safe, uint256 delay) internal returns (TimelockController timelock) {
        if (safe == address(0)) revert ZeroAddress();
        if (delay < MIN_DELAY) revert DelayTooShort(delay, MIN_DELAY);
        address[] memory safeOnly = new address[](1);
        safeOnly[0] = safe;
        timelock = new TimelockController(delay, safeOnly, safeOnly, address(0));
    }

    /// @notice Move every admin power `deployer` holds to `timelock`, called by `deployer`. `admins` lists each
    ///         AccessControl contract the deployer administers; for each, the timelock is granted
    ///         `DEFAULT_ADMIN_ROLE` and the deployer renounces it. The calendar's `CALENDAR_ROLE` moves too (an
    ///         unscheduled exchange closure is covered by the guardian's pause instead). The deployer's
    ///         `GUARDIAN_ROLE` is dropped unless it is the configured guardian. Reverts if any admin role is left.
    function handOver(
        TimelockController timelock,
        address deployer,
        MarketCalendar calendar,
        EpochManager manager,
        address guardian,
        address[] memory admins
    ) internal {
        bytes32 calendarRole = calendar.CALENDAR_ROLE();
        if (calendar.hasRole(calendarRole, deployer)) {
            calendar.grantRole(calendarRole, address(timelock));
            calendar.renounceRole(calendarRole, deployer);
        }
        if (guardian != deployer) manager.renounceRole(manager.GUARDIAN_ROLE(), deployer);
        for (uint256 i; i < admins.length; ++i) {
            IAccessControl target = IAccessControl(admins[i]);
            target.grantRole(DEFAULT_ADMIN_ROLE, address(timelock));
            target.renounceRole(DEFAULT_ADMIN_ROLE, deployer);
            if (target.hasRole(DEFAULT_ADMIN_ROLE, deployer) || !target.hasRole(DEFAULT_ADMIN_ROLE, address(timelock)))
            {
                revert AdminLeft(admins[i]);
            }
        }
    }
}
