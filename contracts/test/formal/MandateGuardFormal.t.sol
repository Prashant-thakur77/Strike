// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {MandateGuard} from "../../src/libraries/MandateGuard.sol";

/// @notice Puts `MandateGuard.validate` behind an external call so a revert can be observed.
contract MandateGuardHarness {
    function validate(MandateGuard.Mandate memory m) external pure {
        MandateGuard.validate(m);
    }
}

/// @title MandateGuardFormal
/// @notice Halmos properties for `MandateGuard`. Each mandate rule is restated independently (without the library's
///         rounding) and proven to hold whenever `check` returns `Reason.None`.
/// @dev Bounds: size, capacity, spot, strike, fairValue < 2^128 (so the restated products cannot overflow); the
///      mandate and the remaining proposal fields are fully symbolic.
/// @custom:halmos --solver cvc5-int
contract MandateGuardFormal {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant MAX_PREMIUM_BPS = 30_000;
    /// Protocol floor on a mandate's premium factor and cap on its tenor (restated from MandateGuard).
    uint256 internal constant MIN_PREMIUM_FLOOR_BPS = 9000;
    uint256 internal constant MAX_TENOR_CAP = 35 days;

    function _bounded(MandateGuard.Proposal memory p) internal pure returns (bool) {
        return p.size < 2 ** 128 && p.capacity < 2 ** 128 && p.spot < 2 ** 128 && p.strike < 2 ** 128
            && p.fairValue < 2 ** 128;
    }

    function _accepted(MandateGuard.Mandate memory m, MandateGuard.Proposal memory p) internal pure returns (bool) {
        return _bounded(p) && MandateGuard.check(m, p) == MandateGuard.Reason.None;
    }

    /// Accepted => non-zero size, tenor in range, expiry at an exchange close, premium factor in
    /// [minPremiumBps, 3x], and the strike out of the money (calls above spot, puts below).
    function check_none_impliesBasicRules(MandateGuard.Mandate memory m, MandateGuard.Proposal memory p) public pure {
        if (!_accepted(m, p)) return;
        assert(
            p.size > 0 && p.tenor >= m.minTenor && p.tenor <= m.maxTenor && p.validExpiry
                && p.premiumBps >= m.minPremiumBps && p.premiumBps <= MAX_PREMIUM_BPS
                && (p.isCall ? p.strike > p.spot : p.strike < p.spot)
        );
    }

    /// Accepted => size <= capacity × maxShareSoldBps / BPS, stated without rounding:
    /// size × BPS <= capacity × maxShareSoldBps.
    function check_none_impliesSizeWithinShareCap(MandateGuard.Mandate memory m, MandateGuard.Proposal memory p)
        public
        pure
    {
        if (!_accepted(m, p)) return;
        unchecked {
            assert(p.size * BPS <= p.capacity * m.maxShareSoldBps);
        }
    }

    /// Accepted => |delta| in [minDeltaBps, maxDeltaBps] after truncation to bps:
    /// minDeltaBps × 1e18 <= |delta| × BPS < (maxDeltaBps + 1) × 1e18.
    /// NOT PROVEN: times out in halmos 0.3.3 (cvc5, 300 s per query). Kept so the property stays written down;
    /// the same behaviour is exercised by the fuzz and invariant suites (docs/testing.md).
    function unproven_none_impliesDeltaInBand(MandateGuard.Mandate memory m, MandateGuard.Proposal memory p)
        public
        pure
    {
        if (!_accepted(m, p)) return;
        uint256 absDelta = p.delta < 0 ? uint256(-p.delta) : uint256(p.delta);
        assert(absDelta * BPS >= uint256(m.minDeltaBps) * 1e18);
        assert(absDelta * BPS < (uint256(m.maxDeltaBps) + 1) * 1e18);
    }

    /// Accepted => premium per option >= minYieldBps of the collateral one option locks (spot for calls, strike
    /// for puts).
    function check_none_impliesYieldFloor(MandateGuard.Mandate memory m, MandateGuard.Proposal memory p) public pure {
        if (!_accepted(m, p)) return;
        uint256 collateral = p.isCall ? p.spot : p.strike;
        unchecked {
            assert(p.fairValue * p.premiumBps >= uint256(m.minYieldBps) * collateral);
        }
    }

    /// Under a mandate `validate` accepts, an accepted proposal never sells more options than the vault can back.
    function check_none_withValidMandate_sizeWithinCapacity(
        MandateGuard.Mandate memory m,
        MandateGuard.Proposal memory p
    ) public {
        if (!_bounded(p)) return;
        MandateGuardHarness h = new MandateGuardHarness();
        try h.validate(m) {}
        catch {
            return;
        }
        if (MandateGuard.check(m, p) != MandateGuard.Reason.None) return;
        assert(p.size <= p.capacity);
    }

    /// `validate` accepts a mandate exactly when it is internally consistent.
    function check_validate_acceptsOnlyConsistent(MandateGuard.Mandate memory m) public {
        MandateGuardHarness h = new MandateGuardHarness();
        bool consistent = m.minDeltaBps <= m.maxDeltaBps && m.maxDeltaBps <= BPS && m.maxShareSoldBps > 0
            && m.maxShareSoldBps <= BPS && m.minPremiumBps >= MIN_PREMIUM_FLOOR_BPS
            && m.minPremiumBps <= MAX_PREMIUM_BPS && m.minYieldBps <= BPS && m.minTenor > 0 && m.minTenor <= m.maxTenor
            && m.maxTenor <= MAX_TENOR_CAP;
        bool accepted;
        try h.validate(m) {
            accepted = true;
        } catch {
            accepted = false;
        }
        assert(accepted == consistent);
    }

    /// A refused mandate reverts with the first broken rule, in the documented order, as `InvalidMandate(reason)`.
    function check_validate_reasonIsFirstBrokenRule(MandateGuard.Mandate memory m) public {
        uint8 expected;
        if (m.minDeltaBps > m.maxDeltaBps) expected = 1;
        else if (m.maxDeltaBps > BPS) expected = 2;
        else if (m.maxShareSoldBps == 0) expected = 3;
        else if (m.maxShareSoldBps > BPS) expected = 4;
        else if (m.minPremiumBps < MIN_PREMIUM_FLOOR_BPS) expected = 5;
        else if (m.minPremiumBps > MAX_PREMIUM_BPS) expected = 6;
        else if (m.minYieldBps > BPS) expected = 7;
        else if (m.minTenor == 0) expected = 8;
        else if (m.minTenor > m.maxTenor) expected = 9;
        else if (m.maxTenor > MAX_TENOR_CAP) expected = 10;

        MandateGuardHarness h = new MandateGuardHarness();
        try h.validate(m) {
            assert(expected == 0);
        } catch (bytes memory err) {
            assert(expected != 0);
            assert(keccak256(err) == keccak256(abi.encodeWithSelector(MandateGuard.InvalidMandate.selector, expected)));
        }
    }
}
