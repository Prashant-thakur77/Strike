// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title MandateGuard
/// @notice Checks an agent's proposal against a vault's mandate. Pure: returns a reason code instead of reverting,
///         so the caller can record (and punish) a rejected proposal.
library MandateGuard {
    uint256 internal constant BPS = 10_000;
    /// @notice Highest premium an agent may ask, as a share of fair value (3x).
    uint256 internal constant MAX_PREMIUM_BPS = 30_000;

    /// @notice Limits fixed when a vault is created. They never change afterwards.
    struct Mandate {
        uint16 minDeltaBps; // lowest |delta| allowed, in bps of 1 (1000 = 0.10)
        uint16 maxDeltaBps; // highest |delta| allowed
        uint16 minPremiumBps; // lowest price as a share of fair value (9500 = 95%)
        uint16 minYieldBps; // lowest premium per option / collateral per option
        uint16 maxShareSoldBps; // largest size as a share of vault capacity
        uint32 minTenor; // seconds from proposal to expiry
        uint32 maxTenor;
    }

    /// @notice What the contract measured for a proposal.
    struct Proposal {
        bool isCall;
        bool validExpiry; // expiry is an exchange close
        uint16 premiumBps; // asked price as a share of fair value
        uint256 spot; // WAD
        uint256 strike; // WAD
        uint256 tenor; // seconds
        uint256 size; // options
        uint256 capacity; // most options the vault's collateral can back
        uint256 fairValue; // Black-Scholes premium per token, WAD
        int256 delta; // WAD, negative for puts
    }

    enum Reason {
        None,
        ZeroSize,
        TenorOutOfRange,
        InvalidExpiry,
        StrikeWrongSide,
        SizeTooLarge,
        PremiumBelowFair,
        PremiumAboveCap,
        DeltaOutOfBand,
        PremiumTooSmall
    }

    error InvalidMandate();

    /// @notice Reverts unless the mandate is internally consistent.
    function validate(Mandate memory m) internal pure {
        if (m.minDeltaBps > m.maxDeltaBps || m.maxDeltaBps > BPS) revert InvalidMandate();
        if (m.maxShareSoldBps == 0 || m.maxShareSoldBps > BPS) revert InvalidMandate();
        if (m.minPremiumBps == 0 || m.minPremiumBps > MAX_PREMIUM_BPS) revert InvalidMandate();
        if (m.minYieldBps > BPS) revert InvalidMandate();
        if (m.minTenor == 0 || m.minTenor > m.maxTenor) revert InvalidMandate();
    }

    /// @notice `Reason.None` if the proposal is inside the mandate, otherwise the first rule it breaks.
    function check(Mandate memory m, Proposal memory p) internal pure returns (Reason) {
        if (p.size == 0) return Reason.ZeroSize;
        if (p.tenor < m.minTenor || p.tenor > m.maxTenor) return Reason.TenorOutOfRange;
        if (!p.validExpiry) return Reason.InvalidExpiry;
        // Covered calls strike above spot, cash-secured puts below: never sell in the money.
        if (p.isCall ? p.strike <= p.spot : p.strike >= p.spot) return Reason.StrikeWrongSide;
        if (p.size > p.capacity * m.maxShareSoldBps / BPS) return Reason.SizeTooLarge;
        if (p.premiumBps < m.minPremiumBps) return Reason.PremiumBelowFair;
        if (p.premiumBps > MAX_PREMIUM_BPS) return Reason.PremiumAboveCap;

        uint256 absDeltaBps = uint256(p.delta < 0 ? -p.delta : p.delta) * BPS / 1e18;
        if (absDeltaBps < m.minDeltaBps || absDeltaBps > m.maxDeltaBps) return Reason.DeltaOutOfBand;

        // Premium per option relative to the collateral one option locks (a token for calls, the strike for puts):
        // fairValue × premiumBps / BPS ≥ collateral × minYieldBps / BPS, compared without dividing.
        uint256 collateralValue = p.isCall ? p.spot : p.strike;
        if (p.fairValue * p.premiumBps < uint256(m.minYieldBps) * collateralValue) return Reason.PremiumTooSmall;
        return Reason.None;
    }
}
