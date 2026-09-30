// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {FeeManager} from "../../src/core/FeeManager.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title FeeManagerFormal
/// @notice Halmos properties for `FeeManager.computeFee` and the loss carry-forward in `chargeFee`.
/// @dev Proven here: no fee without profit, the constructor's rate caps, and the carry-forward bookkeeping (a loss
///      adds to the carry, a gain pays it down first, no fee while a carried loss is being recovered), for every
///      uint16 rate and amount.
///      Not proven here: the bounds on the fee and the agent's cut when there is profit. `computeFee` multiplies the
///      net premium by both rates, and every solver tried (cvc5, bitwuzla, yices) timed out on those products, even
///      with the rates fixed to a grid and amounts below 2^64. Those bounds are covered by the fuzz tests in
///      test/unit/FeeManager.t.sol (`testFuzz_computeFee_boundedByNetPremium`, `testFuzz_chargeFee_cappedWithAnyCarry`,
///      `testFuzz_chargeFee_highWaterMark`) instead.
/// @custom:halmos --solver cvc5-int
contract FeeManagerFormal {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant MAX_PERF_FEE_BPS = 3000;
    address internal constant VAULT = address(0x7A017);

    function _deploy(uint16 perfFeeBps, uint16 agentShareBps) internal returns (FeeManager) {
        // Out-of-range fees make the constructor revert, which discards the path.
        return new FeeManager(address(0xA11CE), IERC20(address(0xDA1)), address(0x7EA), perfFeeBps, agentShareBps);
    }

    /// No fee (and no agent cut) on an epoch that did not make money.
    function check_computeFee_zeroWhenNoProfit(
        uint16 perfFeeBps,
        uint16 agentShareBps,
        uint256 premium,
        uint256 payoutValue
    ) public {
        FeeManager fm = _deploy(perfFeeBps, agentShareBps);
        if (premium > payoutValue) return;
        (uint256 fee, uint256 agentCut) = fm.computeFee(VAULT, premium, payoutValue);
        assert(fee == 0);
        assert(agentCut == 0);
    }

    /// A FeeManager whose admin is this contract, with this contract as the depositor (the EpochManager's role).
    function _deployCharging(uint16 perfFeeBps, uint16 agentShareBps) internal returns (FeeManager fm) {
        fm = new FeeManager(address(this), IERC20(address(0xDA1)), address(0x7EA), perfFeeBps, agentShareBps);
        fm.grantRole(fm.DEPOSITOR_ROLE(), address(this));
    }

    /// First epoch a loss of `loss`, second epoch any result. A loss adds to the carry and pays no fee; a gain up to
    /// the carry pays no fee and lowers the carry by the gain; a gain above it clears the carry.
    function check_chargeFee_carryForward(
        uint16 perfFeeBps,
        uint16 agentShareBps,
        uint128 loss,
        uint128 premium,
        uint128 payoutValue
    ) public {
        FeeManager fm = _deployCharging(perfFeeBps, agentShareBps);
        (uint256 fee1, uint256 cut1) = fm.chargeFee(VAULT, 0, loss);
        assert(fee1 == 0 && cut1 == 0);
        assert(fm.lossCarried(VAULT) == loss);

        (uint256 fee, uint256 agentCut) = fm.chargeFee(VAULT, premium, payoutValue);
        uint256 carried = fm.lossCarried(VAULT);
        if (premium <= payoutValue) {
            assert(fee == 0 && agentCut == 0);
            assert(carried == uint256(loss) + (payoutValue - premium));
        } else if (premium - payoutValue <= loss) {
            assert(fee == 0 && agentCut == 0);
            assert(carried == uint256(loss) - (premium - payoutValue));
        } else {
            assert(carried == 0);
        }
    }

    /// `chargeFee` returns what `computeFee` previews for the same vault state.
    function check_chargeFee_matchesPreview(
        uint16 perfFeeBps,
        uint16 agentShareBps,
        uint128 loss,
        uint128 premium,
        uint128 payoutValue
    ) public {
        FeeManager fm = _deployCharging(perfFeeBps, agentShareBps);
        fm.chargeFee(VAULT, 0, loss);
        (uint256 previewFee, uint256 previewCut) = fm.computeFee(VAULT, premium, payoutValue);
        (uint256 fee, uint256 agentCut) = fm.chargeFee(VAULT, premium, payoutValue);
        assert(fee == previewFee && agentCut == previewCut);
    }

    /// The constructor (and so `setFees`, which shares `_setFees`) only accepts fees inside the caps.
    function check_constructor_enforcesCaps(uint16 perfFeeBps, uint16 agentShareBps) public {
        FeeManager fm = _deploy(perfFeeBps, agentShareBps);
        assert(fm.perfFeeBps() <= MAX_PERF_FEE_BPS);
        assert(fm.agentShareBps() <= BPS);
    }
}
