// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {NyseTime} from "../../src/libraries/NyseTime.sol";

/// @title NyseTimeFormal
/// @notice Halmos properties for the civil-calendar and session arithmetic in `NyseTime`.
/// @dev Bounds: years 1970..2200 (day numbers 0..84_005). `daysInMonth` below is an independent Gregorian
///      definition, not taken from the library.
/// @custom:halmos --solver cvc5-int
contract NyseTimeFormal {
    /// Last day number covered: 2200-12-31.
    uint256 internal constant MAX_DAY = 84_005;

    function _isLeap(uint256 y) internal pure returns (bool) {
        return (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    }

    function _daysInMonth(uint256 y, uint256 m) internal pure returns (uint256) {
        if (m == 2) return _isLeap(y) ? 29 : 28;
        if (m == 4 || m == 6 || m == 9 || m == 11) return 30;
        return 31;
    }

    function _concreteMonth(uint256 m) internal pure returns (uint256) {
        if (m == 1) return 1;
        if (m == 2) return 2;
        if (m == 3) return 3;
        if (m == 4) return 4;
        if (m == 5) return 5;
        if (m == 6) return 6;
        if (m == 7) return 7;
        if (m == 8) return 8;
        if (m == 9) return 9;
        if (m == 10) return 10;
        if (m == 11) return 11;
        if (m == 12) return 12;
        revert("month out of range");
    }

    /// civilFromDays(daysFromCivil(y, m, d)) == (y, m, d) for every valid date in 1970..2200.
    /// The month is enumerated (one path per month) so the month-dependent terms are concrete.
    /// NOT PROVEN: times out in halmos 0.3.3 (cvc5, 300 s per query). Kept so the property stays written down;
    /// the same behaviour is exercised by the fuzz and invariant suites (docs/testing.md).
    function unproven_civil_roundTrip(uint256 y, uint256 month, uint256 d) public pure {
        uint256 m = _concreteMonth(month);
        if (y < 1970 || y > 2200 || d < 1 || d > _daysInMonth(y, m)) return;
        (uint256 y2, uint256 m2, uint256 d2) = NyseTime.civilFromDays(NyseTime.daysFromCivil(y, m, d));
        assert(y2 == y && m2 == m && d2 == d);
    }

    /// The other direction: every day number in range maps to a valid date that maps back to it.
    /// NOT PROVEN: times out in halmos 0.3.3 (cvc5, 300 s per query). Kept so the property stays written down;
    /// the same behaviour is exercised by the fuzz and invariant suites (docs/testing.md).
    function unproven_days_roundTrip(uint256 day) public pure {
        if (day > MAX_DAY) return;
        (uint256 y, uint256 m, uint256 d) = NyseTime.civilFromDays(day);
        assert(y >= 1970 && y <= 2200);
        assert(m >= 1 && m <= 12);
        assert(d >= 1 && d <= _daysInMonth(y, m));
        assert(NyseTime.daysFromCivil(y, m, d) == day);
    }

    /// A session opens before it closes and lasts 6.5 hours (3.5 on an early close), inside its own UTC day.
    function check_session_openBeforeClose(uint256 day, bool earlyClose) public pure {
        if (day > MAX_DAY) return;
        (uint256 open, uint256 close) = NyseTime.session(day, earlyClose);
        assert(open < close);
        assert(close - open == (earlyClose ? 3.5 hours : 6.5 hours));
        assert(open >= day * 1 days && close < (day + 1) * 1 days);
    }
}
