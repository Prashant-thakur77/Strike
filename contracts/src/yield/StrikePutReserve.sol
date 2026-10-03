// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {EpochManager} from "../core/EpochManager.sol";
import {IStrikeVault} from "../interfaces/IStrikeVault.sol";
import {Decimals} from "../libraries/Decimals.sol";
import {ILiquidityReserve} from "./ILiquidityReserve.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title StrikePutReserve
/// @notice The USDG a cash-secured-put vault must keep liquid, read from the deployed EpochManager without changing it:
///         the larger of (a) the most collateral the vault's mandate lets any future series lock
///         (`maxShareSoldBps` of the collateral, fixed when the vault was created) and (b) the live series' worst
///         case, every option it may still sell exercised at a price of zero (`size` × `strike`).
/// @dev A cash-secured put pays at most its strike per option, so (b) bounds the settlement payout. (a) covers the
///      next epoch, which can open and sell as soon as this one settles.
contract StrikePutReserve is ILiquidityReserve {
    using Math for uint256;

    uint256 internal constant BPS = 10_000;

    /// @notice The deployed EpochManager the vault is registered with.
    EpochManager public immutable manager;
    /// @notice The cash-secured-put vault whose collateral this reserve protects.
    address public immutable vault;
    /// @notice The vault mandate's largest series size as a share of capacity, in bps. Mandates never change.
    uint16 public immutable maxShareSoldBps;
    uint8 internal immutable _usdgDecimals;

    error NotAPutVault(address vault);
    error VaultNotRegistered(address vault);
    error WrongAsset(address asset, address usdg);

    constructor(EpochManager manager_, address vault_) {
        if (IStrikeVault(vault_).isCall()) revert NotAPutVault(vault_);
        address usdg = address(manager_.usdg());
        if (IERC4626(vault_).asset() != usdg) revert WrongAsset(IERC4626(vault_).asset(), usdg);
        EpochManager.VaultConfig memory cfg = manager_.vaultConfig(vault_);
        if (!cfg.registered) revert VaultNotRegistered(vault_);
        manager = manager_;
        vault = vault_;
        maxShareSoldBps = cfg.mandate.maxShareSoldBps;
        _usdgDecimals = manager_.usdgDecimals();
    }

    /// @inheritdoc ILiquidityReserve
    function requiredLiquidity(uint256 collateral) external view returns (uint256 need) {
        need = collateral.mulDiv(maxShareSoldBps, BPS, Math.Rounding.Ceil);
        (EpochManager.EpochState state,, uint256 seriesId,,) = manager.epochs(vault);
        if (state != EpochManager.EpochState.Selling) return need;
        EpochManager.Series memory s = manager.getSeries(seriesId);
        (uint8 tokenDecimals,,,,,,) = manager.underlyings(s.underlying);
        uint256 worst = Decimals.valueInUsd(s.size, s.strike, tokenDecimals, _usdgDecimals, Math.Rounding.Ceil);
        // Each buy rounds its collateral up, so the sum can pass size x strike by a unit per buy.
        need = Math.max(need, Math.max(worst, s.collateral));
    }
}
