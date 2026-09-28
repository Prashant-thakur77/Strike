// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AgentRegistry} from "../../src/agents/AgentRegistry.sol";
import {EpochManager} from "../../src/core/EpochManager.sol";
import {MandateGuard} from "../../src/libraries/MandateGuard.sol";
import {StrikeVault} from "../../src/vaults/StrikeVault.sol";
import {VaultFactory} from "../../src/vaults/VaultFactory.sol";
import {StrikeBase} from "../utils/StrikeBase.sol";

/// @notice Agents act only inside the vault mandate. A reckless proposal is rejected and costs the agent its bond,
///         which goes to the vault's depositors.
contract AgentMandateTest is StrikeBase {
    function setUp() public override {
        super.setUp();
        _depositCall(alice, 100 * WAD);
        vm.prank(agent);
        manager.openEpoch(address(callVault));
    }

    function _propose(uint256 strike, uint64 expiry, uint256 size, uint16 bps) internal returns (bool ok) {
        vm.prank(agent);
        (ok,) = manager.proposeSeries(address(callVault), strike, expiry, size, bps);
    }

    function _reason(uint256 strike, uint64 expiry, uint256 size, uint16 bps)
        internal
        view
        returns (MandateGuard.Reason r)
    {
        (r,,,) = manager.previewProposal(address(callVault), strike, expiry, size, bps);
    }

    /// The demo scenario: an at-the-money call (delta ~0.5) breaks the 0.05–0.40 delta band.
    function test_recklessProposal_rejectedSlashedAndPaidToDepositors() public {
        assertEq(uint8(_reason(252 * WAD, FRIDAY_CLOSE, 50 * WAD, 10_000)), uint8(MandateGuard.Reason.DeltaOutOfBand));

        vm.expectEmit(true, true, true, false, address(manager));
        emit EpochManager.ProposalRejected(
            address(callVault), 1, agentId, MandateGuard.Reason.DeltaOutOfBand, SLASH, 0, 0, 0, 0
        );
        assertFalse(_propose(252 * WAD, FRIDAY_CLOSE, 50 * WAD, 10_000));
        assertEq(manager.compensation(address(callVault)), SLASH);
        assertEq(registry.getAgent(agentId).strikes, 1);

        // The agent then proposes inside the mandate; buyers pay; nothing expires in the money.
        assertTrue(_propose(275 * WAD, FRIDAY_CLOSE, 50 * WAD, 10_000));
        (EpochManager.EpochState state,, uint256 seriesId) = manager.epochs(address(callVault));
        assertEq(uint8(state), uint8(EpochManager.EpochState.Selling));
        uint256 premium = _buy(seriesId, 50 * WAD);
        manager.settle(address(callVault), _expireAt(260e8));

        // Depositors receive the net premium plus the slashed bond.
        assertApproxEqAbs(callVault.pendingPremium(alice), premium - premium / 10 + SLASH, 2);
        assertEq(manager.compensation(address(callVault)), 0);
        assertEq(registry.getAgent(agentId).accepted, 1);
    }

    /// Propose by delta: the contract solves the strike at execution-time spot, so the series has the intended delta.
    function test_proposeByDelta_hitsTargetDelta() public {
        vm.prank(agent);
        (bool ok, uint256 seriesId, uint256 strike) =
            manager.proposeByDelta(address(callVault), 2000, FRIDAY_CLOSE, 50 * WAD, 10_000);
        assertTrue(ok);
        assertEq(strike % 1e16, 0, "strike rounded to a cent");
        assertGt(strike, 250 * WAD);
        (, int256 delta) = pricer.quote(250 * WAD, strike, FRIDAY_CLOSE - block.timestamp, 0.6e18, true);
        assertApproxEqAbs(delta, 0.2e18, 0.001e18);
        assertEq(manager.getSeries(seriesId).strike, strike);
    }

    /// Spot jumps 5% before the transaction lands: a precomputed strike would now break the delta band and be
    /// slashed; proposing by delta still lands inside the mandate.
    function test_proposeByDelta_survivesSpotMove() public {
        uint256 precomputed = pricer.strikeForDelta(250 * WAD, 0.06e18, FRIDAY_CLOSE - block.timestamp, 0.6e18, true);
        feed.set(237.5e8);
        (MandateGuard.Reason r,,,) = manager.previewProposal(address(callVault), precomputed, FRIDAY_CLOSE, 1, 10_000);
        assertEq(uint8(r), uint8(MandateGuard.Reason.DeltaOutOfBand));
        vm.prank(agent);
        (bool ok,,) = manager.proposeByDelta(address(callVault), 600, FRIDAY_CLOSE, 1, 10_000);
        assertTrue(ok);
    }

    function test_proposeByDelta_outsideBandIsRejected() public {
        vm.prank(agent);
        (bool ok,,) = manager.proposeByDelta(address(callVault), 4500, FRIDAY_CLOSE, 1, 10_000);
        assertFalse(ok);
        assertEq(registry.getAgent(agentId).strikes, 1);
    }

    function test_previewDoesNotSlash() public view {
        _reason(200 * WAD, FRIDAY_CLOSE, 50 * WAD, 10_000);
        assertEq(registry.getAgent(agentId).strikes, 0);
    }

    function test_everyRejectionReason() public view {
        uint64 f = FRIDAY_CLOSE;
        assertEq(uint8(_reason(275 * WAD, f, 0, 10_000)), uint8(MandateGuard.Reason.ZeroSize));
        assertEq(
            uint8(_reason(275 * WAD, NEXT_FRIDAY_CLOSE + 7 days, 1, 10_000)), uint8(MandateGuard.Reason.TenorOutOfRange)
        );
        assertEq(uint8(_reason(275 * WAD, f - 1 hours, 1, 10_000)), uint8(MandateGuard.Reason.InvalidExpiry));
        assertEq(uint8(_reason(240 * WAD, f, 1, 10_000)), uint8(MandateGuard.Reason.StrikeWrongSide));
        assertEq(uint8(_reason(275 * WAD, f, 101 * WAD, 10_000)), uint8(MandateGuard.Reason.SizeTooLarge));
        assertEq(uint8(_reason(275 * WAD, f, 1, 9000)), uint8(MandateGuard.Reason.PremiumBelowFair));
        assertEq(uint8(_reason(275 * WAD, f, 1, 30_001)), uint8(MandateGuard.Reason.PremiumAboveCap));
        assertEq(uint8(_reason(252 * WAD, f, 1, 10_000)), uint8(MandateGuard.Reason.DeltaOutOfBand));
        assertEq(uint8(_reason(275 * WAD, f, 1, 10_000)), uint8(MandateGuard.Reason.None));
    }

    function test_premiumTooSmall() public {
        // A mandate demanding 2% of collateral per week rejects a ~0.08-delta call worth ~0.25%.
        VaultFactory.CreateParams memory p = _params(true, 1_000_000 * WAD);
        p.mandate.minYieldBps = 200;
        vm.prank(curator);
        address v = factory.createVault(p);
        tsla.mint(alice, 10 * WAD);
        vm.startPrank(alice);
        tsla.approve(v, 10 * WAD);
        StrikeVault(v).deposit(10 * WAD, alice);
        vm.stopPrank();
        (MandateGuard.Reason r,,,) = manager.previewProposal(v, 275 * WAD, FRIDAY_CLOSE, 1, 10_000);
        assertEq(uint8(r), uint8(MandateGuard.Reason.PremiumTooSmall));
    }

    function test_threeStrikesSuspendsAgent() public {
        _propose(252 * WAD, FRIDAY_CLOSE, 1, 10_000);
        _propose(252 * WAD, FRIDAY_CLOSE, 1, 10_000);
        _propose(252 * WAD, FRIDAY_CLOSE, 1, 10_000);
        assertEq(uint8(registry.getAgent(agentId).status), uint8(AgentRegistry.Status.Suspended));
        vm.expectRevert(abi.encodeWithSelector(EpochManager.AgentNotActive.selector, agentId));
        _propose(275 * WAD, FRIDAY_CLOSE, 1, 10_000);
    }

    function test_retiredAgentCannotPropose() public {
        vm.prank(agent);
        registry.retire(agentId);
        vm.expectRevert(abi.encodeWithSelector(EpochManager.AgentNotActive.selector, agentId));
        _propose(275 * WAD, FRIDAY_CLOSE, 1, 10_000);
    }

    /// Key compromise: the owner rotates the signer; the old key can no longer propose.
    function test_rotatedSignerLocksOutOldKey() public {
        address fresh = makeAddr("fresh");
        vm.prank(agent);
        registry.setSigner(agentId, fresh);
        vm.expectRevert(abi.encodeWithSelector(EpochManager.NotAgent.selector, agent));
        _propose(275 * WAD, FRIDAY_CLOSE, 1, 10_000);
        vm.prank(fresh);
        (bool ok,) = manager.proposeSeries(address(callVault), 275 * WAD, FRIDAY_CLOSE, 1, 10_000);
        assertTrue(ok);
    }

    function test_curatorSwitchesAgent() public {
        address other = makeAddr("other");
        vm.prank(other);
        uint256 otherId = registry.register(other, other, 0);
        vm.expectRevert(abi.encodeWithSelector(EpochManager.NotCurator.selector, address(this)));
        manager.setVaultAgent(address(callVault), otherId);
        vm.prank(curator);
        manager.setVaultAgent(address(callVault), otherId);
        vm.expectRevert(abi.encodeWithSelector(EpochManager.NotAgent.selector, agent));
        _propose(275 * WAD, FRIDAY_CLOSE, 1, 10_000);
    }

    function test_abortPaysCompensation() public {
        _propose(252 * WAD, FRIDAY_CLOSE, 1, 10_000);
        vm.prank(curator);
        manager.abortEpoch(address(callVault));
        assertApproxEqAbs(callVault.pendingPremium(alice), SLASH, 1);
    }
}
