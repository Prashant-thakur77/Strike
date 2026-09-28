// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {NyseTime} from "../../src/libraries/NyseTime.sol";
import {MarketCalendar} from "../../src/oracle/MarketCalendar.sol";
import {Test} from "forge-std/Test.sol";

contract NyseTimeHarness {
    function daysFromCivil(uint256 y, uint256 m, uint256 d) external pure returns (uint256) {
        return NyseTime.daysFromCivil(y, m, d);
    }

    function civilFromDays(uint256 z) external pure returns (uint256, uint256, uint256) {
        return NyseTime.civilFromDays(z);
    }

    function isDst(uint256 day) external pure returns (bool) {
        return NyseTime.isDst(day);
    }

    function weekday(uint256 day) external pure returns (uint256) {
        return NyseTime.weekday(day);
    }

    function session(uint256 day, bool early) external pure returns (uint256, uint256) {
        return NyseTime.session(day, early);
    }
}

contract MarketCalendarTest is Test {
    MarketCalendar internal calendar;
    NyseTimeHarness internal lib;
    address internal admin = makeAddr("admin");

    // 2026 NYSE holidays and early closes (day numbers), from the exchange calendar.
    uint256 internal constant THANKSGIVING_2026 = 20_783;
    uint256 internal constant DAY_AFTER_THANKSGIVING_2026 = 20_784;
    uint256 internal constant GOOD_FRIDAY_2026 = 20_546;
    /// Monday 2026-10-05 and Friday 2026-10-09 (EDT).
    uint256 internal constant MON_OCT_5 = 20_731;
    uint256 internal constant FRIDAY_CLOSE = 1_791_576_000;

    function setUp() public {
        uint256[] memory holidays = new uint256[](3);
        holidays[0] = THANKSGIVING_2026;
        holidays[1] = GOOD_FRIDAY_2026;
        holidays[2] = 20_812; // Christmas 2026
        uint256[] memory early = new uint256[](1);
        early[0] = DAY_AFTER_THANKSGIVING_2026;
        calendar = new MarketCalendar(admin, holidays, early);
        lib = new NyseTimeHarness();
    }

    /// Every day 2026–2030: regular session times match Python's zoneinfo (America/New_York) exactly.
    function test_sessionsMatchZoneinfo() public view {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/nyse.json"));
        uint256[] memory day = vm.parseJsonUintArray(json, ".day");
        uint256[] memory open = vm.parseJsonUintArray(json, ".open");
        uint256[] memory close = vm.parseJsonUintArray(json, ".close");
        bool[] memory dst = vm.parseJsonBoolArray(json, ".dst");
        assertEq(day.length, 1826);
        for (uint256 i; i < day.length; ++i) {
            (uint256 o, uint256 c) = lib.session(day[i], false);
            assertEq(o, open[i], "open");
            assertEq(c, close[i], "close");
            assertEq(lib.isDst(day[i]), dst[i], "dst");
        }
    }

    function test_dstTransitions2026() public view {
        uint256 mar8 = lib.daysFromCivil(2026, 3, 8); // second Sunday of March
        assertFalse(lib.isDst(mar8 - 1));
        assertTrue(lib.isDst(mar8));
        uint256 nov1 = lib.daysFromCivil(2026, 11, 1); // first Sunday of November
        assertTrue(lib.isDst(nov1 - 1));
        assertFalse(lib.isDst(nov1));
    }

    function test_isMarketOpen() public view {
        (uint256 open, uint256 close) = calendar.sessionOf(MON_OCT_5);
        assertEq(open, MON_OCT_5 * 1 days + 13 hours + 30 minutes);
        assertFalse(calendar.isMarketOpen(open - 1));
        assertTrue(calendar.isMarketOpen(open));
        assertTrue(calendar.isMarketOpen(close - 1));
        assertFalse(calendar.isMarketOpen(close));
        // Saturday and Sunday.
        assertFalse(calendar.isMarketOpen(open + 5 days));
        assertFalse(calendar.isMarketOpen(open + 6 days));
        // Thanksgiving.
        assertFalse(calendar.isMarketOpen(THANKSGIVING_2026 * 1 days + 16 hours));
    }

    function test_winterSessionIsOneHourLaterInUtc() public view {
        uint256 dec7 = lib.daysFromCivil(2026, 12, 7);
        (uint256 open, uint256 close) = calendar.sessionOf(dec7);
        assertEq(open, dec7 * 1 days + 14 hours + 30 minutes);
        assertEq(close, dec7 * 1 days + 21 hours);
    }

    function test_earlyClose() public view {
        (, uint256 close) = calendar.sessionOf(DAY_AFTER_THANKSGIVING_2026);
        assertEq(close, DAY_AFTER_THANKSGIVING_2026 * 1 days + 18 hours); // 13:00 EST
        assertTrue(calendar.isSessionClose(close));
        assertFalse(calendar.isMarketOpen(close + 1));
    }

    function test_isSessionClose() public view {
        assertTrue(calendar.isSessionClose(FRIDAY_CLOSE));
        assertFalse(calendar.isSessionClose(FRIDAY_CLOSE + 1));
        assertFalse(calendar.isSessionClose(FRIDAY_CLOSE - 1 hours));
        assertFalse(calendar.isSessionClose(FRIDAY_CLOSE + 1 days)); // Saturday 20:00
        assertFalse(calendar.isSessionClose(THANKSGIVING_2026 * 1 days + 21 hours));
    }

    function test_weeklyExpiry() public view {
        assertEq(calendar.weeklyExpiry(MON_OCT_5 * 1 days + 15 hours), FRIDAY_CLOSE);
        // Good Friday 2026 (April 3) is closed: the weekly expiry moves to Thursday April 2.
        uint256 apr2 = GOOD_FRIDAY_2026 - 1;
        (, uint256 thuClose) = calendar.sessionOf(apr2);
        assertEq(calendar.weeklyExpiry((GOOD_FRIDAY_2026 - 3) * 1 days), thuClose);
    }

    function test_nextSessionClose() public view {
        assertEq(calendar.nextSessionClose(FRIDAY_CLOSE - 1), FRIDAY_CLOSE);
        assertEq(calendar.nextSessionClose(FRIDAY_CLOSE), FRIDAY_CLOSE);
        (, uint256 mondayClose) = calendar.sessionOf(MON_OCT_5 + 7);
        assertEq(calendar.nextSessionClose(FRIDAY_CLOSE + 1), mondayClose);
    }

    function test_setHolidaysAndEarlyCloses() public {
        uint256[] memory d = new uint256[](1);
        d[0] = MON_OCT_5;
        vm.expectEmit(true, false, false, true, address(calendar));
        emit MarketCalendar.HolidaySet(MON_OCT_5, true);
        vm.prank(admin);
        calendar.setHolidays(d, true);
        assertFalse(calendar.isTradingDay(MON_OCT_5));
        vm.prank(admin);
        calendar.setEarlyCloses(d, true);
        assertTrue(calendar.isEarlyClose(MON_OCT_5));
    }

    function test_revert_setHolidaysNotCalendarRole() public {
        uint256[] memory d = new uint256[](1);
        vm.expectRevert();
        calendar.setHolidays(d, true);
        vm.expectRevert();
        calendar.setEarlyCloses(d, true);
    }

    function test_revert_zeroAdmin() public {
        vm.expectRevert(MarketCalendar.ZeroAddress.selector);
        new MarketCalendar(address(0), new uint256[](0), new uint256[](0));
    }

    function testFuzz_civilRoundTrip(uint256 day) public view {
        day = bound(day, 0, 200_000); // through year 2517
        (uint256 y, uint256 m, uint256 d) = lib.civilFromDays(day);
        assertEq(lib.daysFromCivil(y, m, d), day);
        assertGe(m, 1);
        assertLe(m, 12);
        assertGe(d, 1);
        assertLe(d, 31);
    }

    function testFuzz_sessionIsOpenInside(uint256 day, uint256 offset) public view {
        day = bound(day, 20_454, 22_280); // 2026–2030
        vm.assume(calendar.isTradingDay(day) && !calendar.isEarlyClose(day));
        (uint256 open, uint256 close) = calendar.sessionOf(day);
        uint256 t = bound(offset, open, close - 1);
        assertTrue(calendar.isMarketOpen(t));
        assertEq(close - open, 6 hours + 30 minutes);
    }
}
