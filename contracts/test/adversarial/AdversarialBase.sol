// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {EpochManager} from "../../src/core/EpochManager.sol";
import {StrikeVault} from "../../src/vaults/StrikeVault.sol";
import {StrikeBase} from "../utils/StrikeBase.sol";

/// @notice Shared helpers for the adversarial suite (docs/security/adversarial.md). Every test is named
///         `test_ADV_<CATEGORY>_<attack>` and asserts the defence: the revert, the slash, or the balances that did
///         not move.
abstract contract AdversarialBase is StrikeBase {
    /// Monday 2026-10-12 16:00 UTC (12:00 New York): the week after FRIDAY_CLOSE.
    uint256 internal constant NEXT_MONDAY = FRIDAY_CLOSE + 3 days - 4 hours;

    function _hints(uint80 a, uint80 b) internal pure returns (uint80[] memory h) {
        h = new uint80[](2);
        (h[0], h[1]) = (a, b);
    }

    function _state(StrikeVault vault) internal view returns (EpochManager.EpochState state) {
        (state,,,,) = manager.epochs(address(vault));
    }

    function _wrongState(EpochManager.EpochState expected, EpochManager.EpochState actual)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeWithSelector(EpochManager.WrongState.selector, expected, actual);
    }

    /// Buy as `who`, paying exactly the quote.
    function _buyAs(address who, uint256 seriesId, uint256 amount) internal returns (uint256 premium) {
        (uint256 quote,) = manager.quoteBuy(seriesId, amount);
        usdg.mint(who, quote);
        vm.startPrank(who);
        usdg.approve(address(manager), quote);
        premium = manager.buy(seriesId, amount, quote, who);
        vm.stopPrank();
    }

    /// Queue a deposit in the (locked) call vault.
    function _requestDepositCall(address who, uint256 amount) internal {
        tsla.mint(who, amount);
        vm.startPrank(who);
        tsla.approve(address(callVault), amount);
        callVault.requestDeposit(amount, who);
        vm.stopPrank();
    }

    /// Queue a deposit in the (locked) put vault.
    function _requestDepositPut(address who, uint256 amount) internal {
        usdg.mint(who, amount);
        vm.startPrank(who);
        usdg.approve(address(putVault), amount);
        putVault.requestDeposit(amount, who);
        vm.stopPrank();
    }

    function _bond() internal view returns (uint256) {
        return registry.getAgent(agentId).bond;
    }

    function _strikes() internal view returns (uint32) {
        return registry.getAgent(agentId).strikes;
    }
}
