// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {FeeManager} from "../../src/core/FeeManager.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title FeeManagerFormal
/// @notice Halmos properties for `FeeManager.computeFee`.
/// @dev Proven here: no fee without profit, and the constructor's rate caps, for every uint16 rate and amount.
///      Not proven here: the bounds on the fee and the agent's cut when there is profit. `computeFee` multiplies the
///      net premium by both rates, and every solver tried (cvc5, bitwuzla, yices) timed out on those products, even
///      with the rates fixed to a grid and amounts below 2^64. Those bounds are covered by the fuzz tests in
///      test/unit/FeeManager.t.sol (`testFuzz_computeFee_boundedByNetPremium`) instead.
/// @custom:halmos --solver cvc5-int
contract FeeManagerFormal {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant MAX_PERF_FEE_BPS = 3000;

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
        (uint256 fee, uint256 agentCut) = fm.computeFee(premium, payoutValue);
        assert(fee == 0);
        assert(agentCut == 0);
    }

    /// The constructor (and so `setFees`, which shares `_setFees`) only accepts fees inside the caps.
    function check_constructor_enforcesCaps(uint16 perfFeeBps, uint16 agentShareBps) public {
        FeeManager fm = _deploy(perfFeeBps, agentShareBps);
        assert(fm.perfFeeBps() <= MAX_PERF_FEE_BPS);
        assert(fm.agentShareBps() <= BPS);
    }
}
