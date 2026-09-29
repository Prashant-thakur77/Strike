// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice The queue conversions of `StrikeVault` (`settleEpoch`, `_claimDepositIfProcessed`,
///         `_claimRedeemIfProcessed`), copied from src/vaults/StrikeVault.sol. A = snapshot assets, T = snapshot supply.
library VaultShareMirror {
    using Math for uint256;

    function depositShares(uint256 assets, uint256 A, uint256 T) internal pure returns (uint256) {
        return assets.mulDiv(T + 1, A + 1, Math.Rounding.Floor);
    }

    function redeemAssets(uint256 shares, uint256 A, uint256 T) internal pure returns (uint256) {
        return shares.mulDiv(A + 1, T + 1, Math.Rounding.Floor);
    }
}

/// @title VaultShareFormal
/// @notice Halmos properties for the vault's epoch-queue share math at a fixed snapshot (A, T): no round trip and
///         no splitting of requests extracts value, and redemptions stay within the snapshot's assets.
/// @dev Bounds: deposits, shares, A and T < 2^112 (so every product stays below 2^256).
/// @custom:halmos --solver cvc5-int
contract VaultShareFormal {
    uint256 internal constant B = 2 ** 112;

    /// Depositing D and redeeming the shares at the same (A, T) returns at most D.
    /// NOT PROVEN: times out in halmos 0.3.3 (cvc5, 300 s per query). Kept so the property stays written down;
    /// the same behaviour is exercised by the fuzz and invariant suites (docs/testing.md).
    function unproven_depositThenRedeem_noProfit(uint256 D, uint256 A, uint256 T) public pure {
        if (D >= B || A >= B || T >= B) return;
        uint256 shares = VaultShareMirror.depositShares(D, A, T);
        assert(VaultShareMirror.redeemAssets(shares, A, T) <= D);
    }

    /// Redeeming E shares and depositing the assets at the same (A, T) returns at most E shares.
    /// NOT PROVEN: times out in halmos 0.3.3 (cvc5, 300 s per query). Kept so the property stays written down;
    /// the same behaviour is exercised by the fuzz and invariant suites (docs/testing.md).
    function unproven_redeemThenDeposit_noProfit(uint256 E, uint256 A, uint256 T) public pure {
        if (E >= B || A >= B || T >= B) return;
        uint256 assets = VaultShareMirror.redeemAssets(E, A, T);
        assert(VaultShareMirror.depositShares(assets, A, T) <= E);
    }

    /// Splitting a deposit into two requests never mints more shares than one request.
    /// NOT PROVEN: times out in halmos 0.3.3 (cvc5, 300 s per query). Kept so the property stays written down;
    /// the same behaviour is exercised by the fuzz and invariant suites (docs/testing.md).
    function unproven_splitDeposit_noGain(uint256 D1, uint256 D2, uint256 A, uint256 T) public pure {
        if (D1 >= B || D2 >= B || A >= B || T >= B) return;
        assert(
            VaultShareMirror.depositShares(D1, A, T) + VaultShareMirror.depositShares(D2, A, T)
                <= VaultShareMirror.depositShares(D1 + D2, A, T)
        );
    }

    /// Redeemers holding at most the whole supply never receive more than the snapshot's assets.
    /// NOT PROVEN: times out in halmos 0.3.3 (cvc5, 300 s per query). Kept so the property stays written down;
    /// the same behaviour is exercised by the fuzz and invariant suites (docs/testing.md).
    function unproven_redeemAll_withinAssets(uint256 E1, uint256 E2, uint256 A, uint256 T) public pure {
        if (A >= B || T >= B || E1 + E2 > T) return;
        assert(VaultShareMirror.redeemAssets(E1, A, T) + VaultShareMirror.redeemAssets(E2, A, T) <= A);
    }
}
