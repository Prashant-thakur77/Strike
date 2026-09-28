// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title NyseTime
/// @notice Calendar arithmetic for New York Stock Exchange sessions, in UTC.
/// @dev Days are counted since 1970-01-01 (UTC). A regular session runs 09:30–16:00 New York time: 13:30–20:00 UTC
///      under daylight saving (second Sunday of March to first Sunday of November) and 14:30–21:00 UTC otherwise.
///      Sessions never cross midnight UTC, so a session's UTC day equals its New York trading date.
///      Date conversions use Howard Hinnant's civil-calendar algorithms.
library NyseTime {
    uint256 internal constant DAY = 86_400;
    uint256 internal constant OPEN_EDT = 13 hours + 30 minutes;
    uint256 internal constant CLOSE_EDT = 20 hours;
    uint256 internal constant EARLY_CLOSE_EDT = 17 hours; // 13:00 New York

    /// @notice Days since 1970-01-01 for a civil date (year >= 1970).
    function daysFromCivil(uint256 y, uint256 m, uint256 d) internal pure returns (uint256) {
        if (m <= 2) y -= 1;
        uint256 era = y / 400;
        uint256 yoe = y - era * 400;
        uint256 mp = m > 2 ? m - 3 : m + 9;
        uint256 doy = (153 * mp + 2) / 5 + d - 1;
        uint256 doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        return era * 146_097 + doe - 719_468;
    }

    /// @notice Civil date for a day number.
    function civilFromDays(uint256 z) internal pure returns (uint256 y, uint256 m, uint256 d) {
        z += 719_468;
        uint256 era = z / 146_097;
        uint256 doe = z - era * 146_097;
        uint256 yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        y = yoe + era * 400;
        uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        uint256 mp = (5 * doy + 2) / 153;
        d = doy - (153 * mp + 2) / 5 + 1;
        m = mp < 10 ? mp + 3 : mp - 9;
        if (m <= 2) y += 1;
    }

    /// @notice 0 = Sunday … 6 = Saturday (1970-01-01 was a Thursday).
    function weekday(uint256 day) internal pure returns (uint256) {
        return (day + 4) % 7;
    }

    function isWeekend(uint256 day) internal pure returns (bool) {
        uint256 w = weekday(day);
        return w == 0 || w == 6;
    }

    /// @notice True if US daylight saving time applies on this (New York) date.
    function isDst(uint256 day) internal pure returns (bool) {
        (uint256 y,,) = civilFromDays(day);
        uint256 march1 = daysFromCivil(y, 3, 1);
        uint256 secondSundayMarch = march1 + (7 - weekday(march1)) % 7 + 7;
        uint256 nov1 = daysFromCivil(y, 11, 1);
        uint256 firstSundayNov = nov1 + (7 - weekday(nov1)) % 7;
        return day >= secondSundayMarch && day < firstSundayNov;
    }

    /// @notice UTC timestamps of the regular session's open and close on `day`.
    function session(uint256 day, bool earlyClose) internal pure returns (uint256 open, uint256 close) {
        uint256 shift = isDst(day) ? 0 : 1 hours;
        uint256 base = day * DAY + shift;
        open = base + OPEN_EDT;
        close = base + (earlyClose ? EARLY_CLOSE_EDT : CLOSE_EDT);
    }
}
