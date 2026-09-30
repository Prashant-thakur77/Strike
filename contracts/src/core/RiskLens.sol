// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IRiskEngine} from "../interfaces/IRiskEngine.sol";
import {Decimals} from "../libraries/Decimals.sol";
import {RiskLib} from "../pricing/RiskLib.sol";
import {EpochManager} from "./EpochManager.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title RiskLens
/// @notice Read-only risk view of a series: live greeks and the vault's worst-case payout under spot shocks,
///         computed by the `EpochManager`'s pricer (Solidity or Stylus). Holds no state and no roles; it lives
///         outside the `EpochManager` to keep that contract under the 24 KB code size limit.
contract RiskLens {
    using Math for uint256;

    uint256 internal constant WAD = 1e18;

    EpochManager public immutable manager;

    /// @notice Risk of one series. Greeks are per option (WAD) and describe the option holder's side; the vault is
    ///         short, so its exposure is minus the greeks times the options sold.
    struct SeriesRisk {
        uint256 spot; // WAD per raw token, the price the risk is computed at
        uint256 sigma; // annualised volatility, WAD
        uint256 tenor; // seconds to expiry; 0 once expired, and the greeks are then 0
        int256 delta;
        uint256 gamma; // per $1 of spot
        uint256 vega; // per 1.00 of volatility
        int256 theta; // per day
        uint256 sold; // options sold, underlying base units
        uint256 collateral; // locked: underlying base units (calls) or USDG base units (puts)
        int256 worstShock; // the first shock with the largest payout, WAD
        uint256 worstLoss; // payout value at `worstShock`, USD WAD
        uint256 worstPayout; // payout at `worstShock` in collateral units, rounded as `settle` rounds it
        int256[] shocks; // WAD, -0.3e18 = -30%
        uint256[] losses; // payout value at each shock, USD WAD
    }

    error ZeroAddress();
    error SeriesUnknown(uint256 seriesId);

    constructor(EpochManager manager_) {
        if (address(manager_) == address(0)) revert ZeroAddress();
        manager = manager_;
    }

    /// @notice The default stress grid: spot moves from -30% to +30% in 5% steps (13 points).
    function defaultShocks() public pure returns (int256[] memory shocks) {
        shocks = new int256[](13);
        for (uint256 i; i < 13; ++i) {
            // i <= 12, so the cast is exact.
            // forge-lint: disable-next-line(unsafe-typecast)
            shocks[i] = (int256(i) - 6) * 0.05e18;
        }
    }

    /// @notice Live risk: the current SafeStockFeed spot (reverts while the feed is unsafe), the underlying's
    ///         current sigma, the time left to expiry, and the default ±30% grid.
    function seriesRisk(uint256 seriesId) external view returns (SeriesRisk memory) {
        EpochManager.Series memory s = _series(seriesId);
        (,, uint64 sigma,,,,) = manager.underlyings(s.underlying);
        return _risk(s, manager.spot(s.underlying), sigma, defaultShocks());
    }

    /// @notice Risk at a given spot and sigma over any shock grid (what-if analysis, or a spot the feed has not
    ///         printed yet). Shocks are relative to `spot`, WAD, each in (-100%, +1000%].
    function seriesRiskAt(uint256 seriesId, uint256 spot, uint256 sigma, int256[] calldata shocks)
        external
        view
        returns (SeriesRisk memory)
    {
        return _risk(_series(seriesId), spot, sigma, shocks);
    }

    function _series(uint256 seriesId) internal view returns (EpochManager.Series memory s) {
        s = manager.getSeries(seriesId);
        if (s.vault == address(0)) revert SeriesUnknown(seriesId);
    }

    function _risk(EpochManager.Series memory s, uint256 spot, uint256 sigma, int256[] memory shocks)
        internal
        view
        returns (SeriesRisk memory r)
    {
        IRiskEngine engine = manager.pricer();
        (uint8 tokenDecimals,,,,,,) = manager.underlyings(s.underlying);
        (r.spot, r.sigma, r.sold, r.collateral, r.shocks) = (spot, sigma, s.sold, s.collateral, shocks);
        r.tenor = s.expiry > block.timestamp ? s.expiry - block.timestamp : 0;
        if (r.tenor != 0) {
            (r.delta, r.gamma, r.vega, r.theta) = engine.greeks(spot, s.strike, r.tenor, sigma, s.isCall);
        }

        uint256 soldWad = s.sold.mulDiv(WAD, 10 ** tokenDecimals);
        (r.worstLoss, r.losses) = engine.scenarioLoss(s.isCall, s.strike, soldWad, spot, shocks);
        for (uint256 i; i < shocks.length; ++i) {
            if (r.losses[i] == r.worstLoss) {
                r.worstShock = shocks[i];
                r.worstPayout = _settlementPayout(s, RiskLib.shockedSpot(spot, shocks[i]), tokenDecimals);
                break;
            }
        }
    }

    /// @dev The payout `EpochManager.settle` would compute at `price`: tokens for a call, USDG for a put.
    function _settlementPayout(EpochManager.Series memory s, uint256 price, uint8 tokenDecimals)
        internal
        view
        returns (uint256)
    {
        if (s.isCall) {
            uint256 perOption = price > s.strike ? (price - s.strike).mulDiv(WAD, price) : 0;
            return s.sold.mulDiv(perOption, WAD);
        }
        uint256 perPut = s.strike > price ? s.strike - price : 0;
        return Decimals.valueInUsd(s.sold, perPut, tokenDecimals, manager.usdgDecimals(), Math.Rounding.Floor);
    }
}
