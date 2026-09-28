// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {MandateGuard} from "../../src/libraries/MandateGuard.sol";
import {Test} from "forge-std/Test.sol";

/// @notice Exposes the internal library functions so reverts cross a call boundary.
contract MandateGuardHarness {
    function validate(MandateGuard.Mandate memory m) external pure {
        MandateGuard.validate(m);
    }

    function check(MandateGuard.Mandate memory m, MandateGuard.Proposal memory p)
        external
        pure
        returns (MandateGuard.Reason)
    {
        return MandateGuard.check(m, p);
    }
}

contract MandateGuardTest is Test {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant MAX_PREMIUM_BPS = 30_000;

    MandateGuardHarness internal h;

    function setUp() public {
        h = new MandateGuardHarness();
    }

    // ------------------------------------------------------------------ fixtures

    function _mandate() internal pure returns (MandateGuard.Mandate memory) {
        return MandateGuard.Mandate({
            minDeltaBps: 500, // 0.05
            maxDeltaBps: 4000, // 0.40
            minPremiumBps: 9500, // 95% of fair value
            minYieldBps: 5, // 0.05% of collateral
            maxShareSoldBps: 5000, // half the capacity
            minTenor: 1 days,
            maxTenor: 14 days
        });
    }

    /// A covered call inside every limit: spot 250, strike 275, delta 0.25, fair value 5.
    function _call() internal pure returns (MandateGuard.Proposal memory) {
        return MandateGuard.Proposal({
            isCall: true,
            validExpiry: true,
            premiumBps: 10_000,
            spot: 250e18,
            strike: 275e18,
            tenor: 4 days,
            size: 50e18,
            capacity: 100e18,
            fairValue: 5e18,
            delta: 0.25e18
        });
    }

    /// A cash-secured put inside every limit: spot 250, strike 225, delta -0.25, fair value 5.
    function _put() internal pure returns (MandateGuard.Proposal memory p) {
        p = _call();
        p.isCall = false;
        p.strike = 225e18;
        p.delta = -0.25e18;
    }

    function _assertReason(MandateGuard.Proposal memory p, MandateGuard.Reason expected) internal view {
        assertEq(uint8(h.check(_mandate(), p)), uint8(expected));
    }

    // ------------------------------------------------------------------ validate

    function test_validate_acceptsConsistentMandate() public view {
        h.validate(_mandate());
    }

    function test_validate_acceptsBoundaryValues() public view {
        MandateGuard.Mandate memory m = MandateGuard.Mandate({
            minDeltaBps: 10_000,
            maxDeltaBps: 10_000,
            minPremiumBps: uint16(MAX_PREMIUM_BPS),
            minYieldBps: 10_000,
            maxShareSoldBps: 10_000,
            minTenor: 1,
            maxTenor: 1
        });
        h.validate(m);
        m.minDeltaBps = 0;
        m.minPremiumBps = 1;
        m.minYieldBps = 0;
        m.maxShareSoldBps = 1;
        m.maxTenor = type(uint32).max;
        h.validate(m);
    }

    function test_validate_revertsWhenMinDeltaAboveMaxDelta() public {
        MandateGuard.Mandate memory m = _mandate();
        m.minDeltaBps = m.maxDeltaBps + 1;
        vm.expectRevert(MandateGuard.InvalidMandate.selector);
        h.validate(m);
    }

    function test_validate_revertsWhenMaxDeltaAboveOne() public {
        MandateGuard.Mandate memory m = _mandate();
        m.maxDeltaBps = uint16(BPS + 1);
        vm.expectRevert(MandateGuard.InvalidMandate.selector);
        h.validate(m);
    }

    function test_validate_revertsWhenMaxShareSoldZero() public {
        MandateGuard.Mandate memory m = _mandate();
        m.maxShareSoldBps = 0;
        vm.expectRevert(MandateGuard.InvalidMandate.selector);
        h.validate(m);
    }

    function test_validate_revertsWhenMaxShareSoldAboveOne() public {
        MandateGuard.Mandate memory m = _mandate();
        m.maxShareSoldBps = uint16(BPS + 1);
        vm.expectRevert(MandateGuard.InvalidMandate.selector);
        h.validate(m);
    }

    function test_validate_revertsWhenMinPremiumZero() public {
        MandateGuard.Mandate memory m = _mandate();
        m.minPremiumBps = 0;
        vm.expectRevert(MandateGuard.InvalidMandate.selector);
        h.validate(m);
    }

    function test_validate_revertsWhenMinPremiumAboveCap() public {
        MandateGuard.Mandate memory m = _mandate();
        m.minPremiumBps = uint16(MAX_PREMIUM_BPS + 1);
        vm.expectRevert(MandateGuard.InvalidMandate.selector);
        h.validate(m);
    }

    function test_validate_revertsWhenMinYieldAboveOne() public {
        MandateGuard.Mandate memory m = _mandate();
        m.minYieldBps = uint16(BPS + 1);
        vm.expectRevert(MandateGuard.InvalidMandate.selector);
        h.validate(m);
    }

    function test_validate_revertsWhenMinTenorZero() public {
        MandateGuard.Mandate memory m = _mandate();
        m.minTenor = 0;
        vm.expectRevert(MandateGuard.InvalidMandate.selector);
        h.validate(m);
    }

    function test_validate_revertsWhenMinTenorAboveMaxTenor() public {
        MandateGuard.Mandate memory m = _mandate();
        m.minTenor = m.maxTenor + 1;
        vm.expectRevert(MandateGuard.InvalidMandate.selector);
        h.validate(m);
    }

    // ------------------------------------------------------------------ check: every reason

    function test_check_none_call() public view {
        _assertReason(_call(), MandateGuard.Reason.None);
    }

    function test_check_none_put() public view {
        _assertReason(_put(), MandateGuard.Reason.None);
    }

    function test_check_zeroSize() public view {
        MandateGuard.Proposal memory p = _call();
        p.size = 0;
        _assertReason(p, MandateGuard.Reason.ZeroSize);
    }

    function test_check_tenorTooShort() public view {
        MandateGuard.Proposal memory p = _call();
        p.tenor = 1 days - 1;
        _assertReason(p, MandateGuard.Reason.TenorOutOfRange);
    }

    function test_check_tenorTooLong() public view {
        MandateGuard.Proposal memory p = _call();
        p.tenor = 14 days + 1;
        _assertReason(p, MandateGuard.Reason.TenorOutOfRange);
    }

    function test_check_tenorBoundsAreInclusive() public view {
        MandateGuard.Proposal memory p = _call();
        p.tenor = 1 days;
        _assertReason(p, MandateGuard.Reason.None);
        p.tenor = 14 days;
        _assertReason(p, MandateGuard.Reason.None);
    }

    function test_check_invalidExpiry() public view {
        MandateGuard.Proposal memory p = _call();
        p.validExpiry = false;
        _assertReason(p, MandateGuard.Reason.InvalidExpiry);
    }

    function test_check_callStrikeAtSpotIsWrongSide() public view {
        MandateGuard.Proposal memory p = _call();
        p.strike = p.spot;
        _assertReason(p, MandateGuard.Reason.StrikeWrongSide);
    }

    function test_check_callStrikeBelowSpotIsWrongSide() public view {
        MandateGuard.Proposal memory p = _call();
        p.strike = p.spot - 1;
        _assertReason(p, MandateGuard.Reason.StrikeWrongSide);
    }

    function test_check_putStrikeAtSpotIsWrongSide() public view {
        MandateGuard.Proposal memory p = _put();
        p.strike = p.spot;
        _assertReason(p, MandateGuard.Reason.StrikeWrongSide);
    }

    function test_check_putStrikeAboveSpotIsWrongSide() public view {
        MandateGuard.Proposal memory p = _put();
        p.strike = p.spot + 1;
        _assertReason(p, MandateGuard.Reason.StrikeWrongSide);
    }

    function test_check_sizeTooLarge() public view {
        MandateGuard.Proposal memory p = _call();
        p.size = p.capacity * 5000 / BPS + 1;
        _assertReason(p, MandateGuard.Reason.SizeTooLarge);
    }

    function test_check_sizeAtLimitAccepted() public view {
        MandateGuard.Proposal memory p = _call();
        p.size = p.capacity * 5000 / BPS;
        _assertReason(p, MandateGuard.Reason.None);
    }

    function test_check_premiumBelowFair() public view {
        MandateGuard.Proposal memory p = _call();
        p.premiumBps = 9499;
        _assertReason(p, MandateGuard.Reason.PremiumBelowFair);
    }

    function test_check_premiumAtMinimumAccepted() public view {
        MandateGuard.Proposal memory p = _call();
        p.premiumBps = 9500;
        _assertReason(p, MandateGuard.Reason.None);
    }

    function test_check_premiumAboveCap() public view {
        MandateGuard.Proposal memory p = _call();
        p.premiumBps = uint16(MAX_PREMIUM_BPS + 1);
        _assertReason(p, MandateGuard.Reason.PremiumAboveCap);
    }

    function test_check_premiumAtCapAccepted() public view {
        MandateGuard.Proposal memory p = _call();
        p.premiumBps = uint16(MAX_PREMIUM_BPS);
        _assertReason(p, MandateGuard.Reason.None);
    }

    function test_check_deltaBelowBand() public view {
        MandateGuard.Proposal memory p = _call();
        p.delta = 0.05e18 - 1; // 499.99 bps floors to 499
        _assertReason(p, MandateGuard.Reason.DeltaOutOfBand);
    }

    function test_check_deltaAboveBand() public view {
        MandateGuard.Proposal memory p = _call();
        p.delta = 0.4001e18;
        _assertReason(p, MandateGuard.Reason.DeltaOutOfBand);
    }

    function test_check_putDeltaUsesAbsoluteValue() public view {
        MandateGuard.Proposal memory p = _put();
        p.delta = -0.5e18;
        _assertReason(p, MandateGuard.Reason.DeltaOutOfBand);
        p.delta = -0.04e18;
        _assertReason(p, MandateGuard.Reason.DeltaOutOfBand);
        p.delta = -0.4e18;
        _assertReason(p, MandateGuard.Reason.None);
    }

    function test_check_deltaBandIsInclusive() public view {
        MandateGuard.Proposal memory p = _call();
        p.delta = 0.05e18;
        _assertReason(p, MandateGuard.Reason.None);
        p.delta = 0.4e18;
        _assertReason(p, MandateGuard.Reason.None);
        // 4000.9 bps floors to 4000 and is still inside.
        p.delta = 0.40009e18;
        _assertReason(p, MandateGuard.Reason.None);
    }

    function test_check_premiumTooSmall() public view {
        MandateGuard.Proposal memory p = _call();
        // Needs premium * 1e4 >= 5 * 250e18, i.e. premium >= 0.125e18.
        p.fairValue = 0.125e18 - 1;
        _assertReason(p, MandateGuard.Reason.PremiumTooSmall);
        p.fairValue = 0.125e18;
        _assertReason(p, MandateGuard.Reason.None);
    }

    function test_check_premiumTooSmallUsesAskedPriceNotFairValue() public view {
        MandateGuard.Proposal memory p = _call();
        p.fairValue = 0.125e18;
        p.premiumBps = 9500; // asks 95% of fair: 0.11875e18 < 0.125e18
        _assertReason(p, MandateGuard.Reason.PremiumTooSmall);
    }

    function test_check_putYieldMeasuredAgainstStrike() public view {
        // Put collateral is the strike (200), call collateral is the spot (250).
        MandateGuard.Proposal memory p = _put();
        p.strike = 200e18;
        p.fairValue = 0.1e18; // exactly 5 bps of 200
        _assertReason(p, MandateGuard.Reason.None);
        p.fairValue = 0.1e18 - 1;
        _assertReason(p, MandateGuard.Reason.PremiumTooSmall);

        MandateGuard.Proposal memory c = _call();
        c.fairValue = 0.1e18; // below 5 bps of 250
        _assertReason(c, MandateGuard.Reason.PremiumTooSmall);
    }

    function test_check_returnsFirstBrokenRule() public view {
        MandateGuard.Proposal memory p = _call();
        p.validExpiry = false;
        p.strike = 1;
        p.premiumBps = 0;
        _assertReason(p, MandateGuard.Reason.InvalidExpiry);
        p.tenor = 0;
        _assertReason(p, MandateGuard.Reason.TenorOutOfRange);
        p.size = 0;
        _assertReason(p, MandateGuard.Reason.ZeroSize);
    }

    function test_check_everyReasonIsReachable() public view {
        uint256 seen;
        MandateGuard.Proposal memory p;

        p = _call();
        seen |= _bit(p);
        p.size = 0;
        seen |= _bit(p);
        p = _call();
        p.tenor = 0;
        seen |= _bit(p);
        p = _call();
        p.validExpiry = false;
        seen |= _bit(p);
        p = _call();
        p.strike = p.spot;
        seen |= _bit(p);
        p = _call();
        p.size = p.capacity;
        seen |= _bit(p);
        p = _call();
        p.premiumBps = 1;
        seen |= _bit(p);
        p = _call();
        p.premiumBps = type(uint16).max;
        seen |= _bit(p);
        p = _call();
        p.delta = 0.99e18;
        seen |= _bit(p);
        p = _call();
        p.fairValue = 1;
        seen |= _bit(p);

        uint256 all = (uint256(1) << (uint256(type(MandateGuard.Reason).max) + 1)) - 1;
        assertEq(uint256(type(MandateGuard.Reason).max), 9, "reason count changed");
        assertEq(seen, all, "a reason was not reached");
    }

    function _bit(MandateGuard.Proposal memory p) internal view returns (uint256) {
        return uint256(1) << uint8(h.check(_mandate(), p));
    }

    // ------------------------------------------------------------------ fuzz

    /// Any proposal inside every limit of any consistent mandate is accepted.
    function testFuzz_check_insideEveryLimitReturnsNone(MandateGuard.Mandate memory m, MandateGuard.Proposal memory p)
        public
        view
    {
        m = _boundMandate(m);
        h.validate(m);

        p.validExpiry = true;
        p.tenor = bound(p.tenor, m.minTenor, m.maxTenor);
        p.spot = bound(p.spot, 2, 1e30);
        p.strike = p.isCall ? bound(p.strike, p.spot + 1, 2e30) : bound(p.strike, 1, p.spot - 1);
        p.capacity = bound(p.capacity, BPS, 1e36);
        p.size = bound(p.size, 1, p.capacity * m.maxShareSoldBps / BPS);
        p.premiumBps = uint16(bound(p.premiumBps, m.minPremiumBps, MAX_PREMIUM_BPS));
        int256 deltaWad = int256(bound(uint256(p.delta), m.minDeltaBps, m.maxDeltaBps) * 1e14);
        p.delta = p.isCall ? deltaWad : -deltaWad;

        // Smallest fair value whose asked premium meets the yield floor.
        uint256 collateral = p.isCall ? p.spot : p.strike;
        uint256 need = (uint256(m.minYieldBps) * collateral + BPS - 1) / BPS;
        uint256 minFair = (need * BPS + p.premiumBps - 1) / p.premiumBps;
        p.fairValue = bound(p.fairValue, minFair, minFair + 1e30);

        assertEq(uint8(h.check(m, p)), uint8(MandateGuard.Reason.None));
    }

    /// validate() reverts exactly when one of its consistency rules is broken.
    function testFuzz_validate_matchesSpec(MandateGuard.Mandate memory m) public {
        bool valid = m.minDeltaBps <= m.maxDeltaBps && m.maxDeltaBps <= BPS && m.maxShareSoldBps != 0
            && m.maxShareSoldBps <= BPS && m.minPremiumBps != 0 && m.minPremiumBps <= MAX_PREMIUM_BPS
            && m.minYieldBps <= BPS && m.minTenor != 0 && m.minTenor <= m.maxTenor;
        if (!valid) vm.expectRevert(MandateGuard.InvalidMandate.selector);
        h.validate(m);
    }

    /// Any valid mandate still rejects an empty proposal first.
    function testFuzz_check_zeroSizeAlwaysRejectedFirst(MandateGuard.Mandate memory m, MandateGuard.Proposal memory p)
        public
        view
    {
        m = _boundMandate(m);
        p.size = 0;
        assertEq(uint8(h.check(m, p)), uint8(MandateGuard.Reason.ZeroSize));
    }

    function _boundMandate(MandateGuard.Mandate memory m) internal pure returns (MandateGuard.Mandate memory) {
        m.maxDeltaBps = uint16(bound(m.maxDeltaBps, 0, BPS));
        m.minDeltaBps = uint16(bound(m.minDeltaBps, 0, m.maxDeltaBps));
        m.maxShareSoldBps = uint16(bound(m.maxShareSoldBps, 1, BPS));
        m.minPremiumBps = uint16(bound(m.minPremiumBps, 1, MAX_PREMIUM_BPS));
        m.minYieldBps = uint16(bound(m.minYieldBps, 0, BPS));
        m.minTenor = uint32(bound(m.minTenor, 1, type(uint32).max));
        m.maxTenor = uint32(bound(m.maxTenor, m.minTenor, type(uint32).max));
        return m;
    }
}
