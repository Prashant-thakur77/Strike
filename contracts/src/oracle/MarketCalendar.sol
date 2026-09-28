// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {NyseTime} from "../libraries/NyseTime.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title MarketCalendar
/// @notice On-chain NYSE trading calendar: DST-aware session times computed on-chain, holidays and early closes
///         kept as an admin list. Any Robinhood Chain protocol can use it to gate actions on US market hours.
contract MarketCalendar is AccessControl {
    bytes32 public constant CALENDAR_ROLE = keccak256("CALENDAR_ROLE");

    /// @notice Full-day closures, by day number (days since 1970-01-01).
    mapping(uint256 day => bool) public isHoliday;
    /// @notice 13:00 New York closes (day after Thanksgiving, Christmas Eve, ...).
    mapping(uint256 day => bool) public isEarlyClose;

    event HolidaySet(uint256 indexed day, bool closed);
    event EarlyCloseSet(uint256 indexed day, bool early);

    error ZeroAddress();

    constructor(address admin, uint256[] memory holidays, uint256[] memory earlyCloses) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(CALENDAR_ROLE, admin);
        for (uint256 i; i < holidays.length; ++i) {
            _setHoliday(holidays[i], true);
        }
        for (uint256 i; i < earlyCloses.length; ++i) {
            _setEarlyClose(earlyCloses[i], true);
        }
    }

    function setHolidays(uint256[] calldata days_, bool closed) external onlyRole(CALENDAR_ROLE) {
        for (uint256 i; i < days_.length; ++i) {
            _setHoliday(days_[i], closed);
        }
    }

    function setEarlyCloses(uint256[] calldata days_, bool early) external onlyRole(CALENDAR_ROLE) {
        for (uint256 i; i < days_.length; ++i) {
            _setEarlyClose(days_[i], early);
        }
    }

    /// @notice Weekday that is not a holiday.
    function isTradingDay(uint256 day) public view returns (bool) {
        return !NyseTime.isWeekend(day) && !isHoliday[day];
    }

    /// @notice Regular-session open and close (UTC) for a day number. Meaningful only on trading days.
    function sessionOf(uint256 day) public view returns (uint256 open, uint256 close) {
        return NyseTime.session(day, isEarlyClose[day]);
    }

    /// @notice True during a regular session.
    function isMarketOpen(uint256 timestamp) public view returns (bool) {
        uint256 day = timestamp / NyseTime.DAY;
        if (!isTradingDay(day)) return false;
        (uint256 open, uint256 close) = sessionOf(day);
        return timestamp >= open && timestamp < close;
    }

    /// @notice True if `timestamp` is exactly a session close: a valid option expiry.
    function isSessionClose(uint256 timestamp) public view returns (bool) {
        uint256 day = timestamp / NyseTime.DAY;
        if (!isTradingDay(day)) return false;
        (, uint256 close) = sessionOf(day);
        return timestamp == close;
    }

    /// @notice The first session close at or after `timestamp` (looks ahead up to 14 days; 0 if none).
    function nextSessionClose(uint256 timestamp) external view returns (uint256) {
        uint256 day = timestamp / NyseTime.DAY;
        for (uint256 i; i < 14; ++i) {
            if (isTradingDay(day + i)) {
                (, uint256 close) = sessionOf(day + i);
                if (close >= timestamp) return close;
            }
        }
        return 0;
    }

    /// @notice The Friday close of the week containing `timestamp` (or the Thursday close if Friday is a holiday).
    function weeklyExpiry(uint256 timestamp) external view returns (uint256) {
        uint256 day = timestamp / NyseTime.DAY;
        uint256 friday = day + (5 + 7 - NyseTime.weekday(day)) % 7;
        for (uint256 i; i < 5; ++i) {
            if (isTradingDay(friday - i)) {
                (, uint256 close) = sessionOf(friday - i);
                return close;
            }
        }
        return 0;
    }

    function _setHoliday(uint256 day, bool closed) internal {
        isHoliday[day] = closed;
        emit HolidaySet(day, closed);
    }

    function _setEarlyClose(uint256 day, bool early) internal {
        isEarlyClose[day] = early;
        emit EarlyCloseSet(day, early);
    }
}
