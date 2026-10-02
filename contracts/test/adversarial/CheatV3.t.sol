// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AgentRegistry} from "../../src/agents/AgentRegistry.sol";
import {EpochManager} from "../../src/core/EpochManager.sol";
import {AdversarialBase} from "./AdversarialBase.sol";

/// @notice CHEAT, v3 only: the active-agent rule (`registerVault`, `setVaultAgent`, `openEpoch` on this branch, and
///         `_propose`). The single-call checks are in `core/EpochManager.t.sol` (`test_createVault_revertsFor*`,
///         `test_setVaultAgent_revertsForInactiveAgent`) and `test_AUDIT3_inactiveAgentSignerLocksVault`.
///         Map: docs/security/adversarial.md#cheat (on main).
contract AdversarialCheatV3Test is AdversarialBase {
    /// The agent opens an epoch and then unbonds below `minBond`, so it is inactive while the vault is locked. It
    /// cannot propose (by strike or delta, inside or outside the mandate); its unbonding bond stays slashable; the
    /// curator aborts at once and depositors are free. Its key and the keeper cannot lock the vault again, and the
    /// curator cannot attach an inactive or unknown agent or create a vault for one. The residual is one lock of at
    /// most `proposalTimeout`, which the curator ends at once.
    function test_ADV_CHEAT_agentDeactivatesAfterOpening() public {
        _depositCall(alice, 100 * WAD);
        _depositPut(alice, 30_000 * USDG_UNIT);
        vm.prank(agent);
        manager.openEpoch(address(callVault));
        vm.prank(agent);
        registry.requestUnbond(agentId, 1000e6 - MIN_BOND + 1);
        assertFalse(registry.isActive(agentId));

        bytes memory inactive = abi.encodeWithSelector(EpochManager.AgentNotActive.selector, agentId);
        vm.startPrank(agent);
        vm.expectRevert(inactive);
        manager.proposeSeries(address(callVault), 275 * WAD, FRIDAY_CLOSE, 50 * WAD, 10_000);
        vm.expectRevert(inactive);
        manager.proposeSeries(address(callVault), 252 * WAD, FRIDAY_CLOSE, 50 * WAD, 10_000);
        vm.expectRevert(inactive);
        manager.proposeByDelta(address(callVault), 2000, FRIDAY_CLOSE, 50 * WAD, 10_000);
        vm.stopPrank();
        AgentRegistry.Agent memory a = registry.getAgent(agentId);
        assertEq(a.bond + a.unbonding, 1000e6, "nothing left the registry");
        assertGt(a.unbondAt, block.timestamp + 7 days, "still slashable for the unbonding delay");

        vm.prank(curator);
        manager.abortEpoch(address(callVault));
        vm.prank(alice);
        callVault.redeem(100 * WAD, alice, alice);
        assertEq(tsla.balanceOf(alice), 100 * WAD);

        vm.prank(agent);
        vm.expectRevert(inactive);
        manager.openEpoch(address(putVault));
        vm.prank(keeper);
        vm.expectRevert(inactive);
        manager.openEpoch(address(putVault));
        assertFalse(putVault.locked());

        vm.startPrank(curator);
        vm.expectRevert(abi.encodeWithSelector(EpochManager.AgentNotActive.selector, 999));
        manager.setVaultAgent(address(putVault), 999);
        vm.expectRevert(inactive);
        manager.setVaultAgent(address(putVault), agentId);
        vm.expectRevert(inactive);
        factory.createVault(_params(true, 1000 * WAD));
        vm.stopPrank();
        assertEq(manager.vaultCount(), 2);
        assertEq(_strikes(), 0);
    }
}
