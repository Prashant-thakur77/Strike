// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Decimals} from "../../src/libraries/Decimals.sol";
import {FormalUtils} from "./FormalUtils.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Line-for-line copy of the settlement and redemption arithmetic in `EpochManager`
///         (`_quoteBuy` collateral, `_settleMath`, `redeem`). Keep in sync with src/core/EpochManager.sol.
library SettlementMirror {
    using Math for uint256;

    uint256 internal constant WAD = 1e18;

    /// `_settleMath`, call branch: payout per option in underlying tokens (WAD).
    function callPayoutPerOption(uint256 price, uint256 strike) internal pure returns (uint256) {
        return price > strike ? (price - strike).mulDiv(WAD, price) : 0;
    }

    /// `_settleMath`, call branch: tokens owed to all holders.
    function callPayout(uint256 sold, uint256 ppo) internal pure returns (uint256) {
        return sold.mulDiv(ppo, WAD);
    }

    /// `redeem`, call branch.
    function callRedeem(uint256 amount, uint256 ppo) internal pure returns (uint256) {
        return amount.mulDiv(ppo, WAD);
    }

    /// `_settleMath`, put branch: payout per option in USD (WAD).
    function putPayoutPerOption(uint256 price, uint256 strike) internal pure returns (uint256) {
        return strike > price ? strike - price : 0;
    }

    /// `_settleMath`, put branch: USDG owed to all holders.
    function putPayout(uint256 sold, uint256 ppo, uint8 tokenDecimals, uint8 usdgDecimals)
        internal
        pure
        returns (uint256)
    {
        return Decimals.valueInUsd(sold, ppo, tokenDecimals, usdgDecimals, Math.Rounding.Floor);
    }

    /// `redeem`, put branch.
    function putRedeem(uint256 amount, uint256 ppo, uint8 tokenDecimals, uint8 usdgDecimals)
        internal
        pure
        returns (uint256)
    {
        return Decimals.valueInUsd(amount, ppo, tokenDecimals, usdgDecimals, Math.Rounding.Floor);
    }

    /// `_quoteBuy`, put branch: USDG collateral one buy locks.
    function putCollateral(uint256 amount, uint256 strike, uint8 tokenDecimals, uint8 usdgDecimals)
        internal
        pure
        returns (uint256)
    {
        return Decimals.valueInUsd(amount, strike, tokenDecimals, usdgDecimals, Math.Rounding.Ceil);
    }
}

/// @title SettlementFormal
/// @notice Halmos properties for option settlement: payouts never exceed what was locked, and holders redeeming
///         separately never take more than the escrow.
/// @dev Bounds: prices and strikes < 2^96 (7.9e10 USD per token in WAD); option amounts < 2^96 for puts and < 2^128
///      for calls. The call checks are split at the payout per option (`ppo`): one check bounds it from (price,
///      strike), the others hold for every ppo in that bound.
///      Token decimals 0..18 are enumerated; USDG decimals are 6 (the deployed stablecoin) or 18.
/// @custom:halmos --solver cvc5-int
contract SettlementFormal {
    uint256 internal constant WAD = 1e18;

    /// A call's payout per option is at most one token, and strictly less for any strike above zero (every call
    /// the mandate accepts has strike > spot >= 0).
    /// NOT PROVEN: times out in halmos 0.3.3 (cvc5, 300 s per query). Kept so the property stays written down;
    /// the same behaviour is exercised by the fuzz and invariant suites (docs/testing.md).
    function unproven_call_payoutPerOptionBelowOne(uint256 price, uint256 strike) public pure {
        if (price >= 2 ** 96 || strike == 0 || strike >= 2 ** 96) return;
        assert(SettlementMirror.callPayoutPerOption(price, strike) < WAD);
    }

    /// Even the unreachable strike 0 pays at most one token per option.
    /// NOT PROVEN: times out in halmos 0.3.3 (cvc5, 300 s per query). Kept so the property stays written down;
    /// the same behaviour is exercised by the fuzz and invariant suites (docs/testing.md).
    function unproven_call_payoutPerOptionAtMostOne(uint256 price, uint256 strike) public pure {
        if (price >= 2 ** 96 || strike >= 2 ** 96) return;
        assert(SettlementMirror.callPayoutPerOption(price, strike) <= WAD);
    }

    /// With at most one token per option, the call payout never exceeds the tokens sold (the collateral locked).
    function check_call_payoutWithinSold(uint256 sold, uint256 ppo) public pure {
        if (sold >= 2 ** 128 || ppo > WAD) return;
        assert(SettlementMirror.callPayout(sold, ppo) <= sold);
    }

    /// Two call holders (a1 + a2 = sold) redeeming separately never take more than the escrowed payout.
    /// NOT PROVEN: times out in halmos 0.3.3 (cvc5, 300 s per query). Kept so the property stays written down;
    /// the same behaviour is exercised by the fuzz and invariant suites (docs/testing.md).
    function unproven_call_holdersWithinEscrow(uint256 a1, uint256 a2, uint256 ppo) public pure {
        if (a1 >= 2 ** 128 || a2 >= 2 ** 128 || ppo > WAD) return;
        uint256 escrow = SettlementMirror.callPayout(a1 + a2, ppo);
        assert(SettlementMirror.callRedeem(a1, ppo) + SettlementMirror.callRedeem(a2, ppo) <= escrow);
    }

    /// A put's payout on n = a1 + a2 options never exceeds the collateral the two buys locked (rounded up).
    /// NOT PROVEN: times out in halmos 0.3.3 (cvc5, 300 s per query). Kept so the property stays written down;
    /// the same behaviour is exercised by the fuzz and invariant suites (docs/testing.md).
    function unproven_put_payoutWithinCollateral(
        uint256 a1,
        uint256 a2,
        uint256 price,
        uint256 strike,
        uint8 tokenDec,
        uint8 usdDec
    ) public pure {
        uint8 t = FormalUtils.concreteDecimals(tokenDec);
        uint8 u = FormalUtils.concreteUsdDecimals(usdDec);
        if (a1 >= 2 ** 96 || a2 >= 2 ** 96 || price >= 2 ** 96 || strike >= 2 ** 96) return;
        uint256 ppo = SettlementMirror.putPayoutPerOption(price, strike);
        uint256 payout = SettlementMirror.putPayout(a1 + a2, ppo, t, u);
        uint256 locked =
            SettlementMirror.putCollateral(a1, strike, t, u) + SettlementMirror.putCollateral(a2, strike, t, u);
        assert(payout <= locked);
    }

    /// Two put holders redeeming separately never take more than the escrowed payout.
    /// NOT PROVEN: times out in halmos 0.3.3 (cvc5, 300 s per query). Kept so the property stays written down;
    /// the same behaviour is exercised by the fuzz and invariant suites (docs/testing.md).
    function unproven_put_holdersWithinEscrow(
        uint256 a1,
        uint256 a2,
        uint256 price,
        uint256 strike,
        uint8 tokenDec,
        uint8 usdDec
    ) public pure {
        uint8 t = FormalUtils.concreteDecimals(tokenDec);
        uint8 u = FormalUtils.concreteUsdDecimals(usdDec);
        if (a1 >= 2 ** 96 || a2 >= 2 ** 96 || price >= 2 ** 96 || strike >= 2 ** 96) return;
        uint256 ppo = SettlementMirror.putPayoutPerOption(price, strike);
        uint256 escrow = SettlementMirror.putPayout(a1 + a2, ppo, t, u);
        assert(SettlementMirror.putRedeem(a1, ppo, t, u) + SettlementMirror.putRedeem(a2, ppo, t, u) <= escrow);
    }
}
