// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AgentRegistry} from "../../src/agents/AgentRegistry.sol";
import {EpochManager} from "../../src/core/EpochManager.sol";
import {IPricer} from "../../src/interfaces/IPricer.sol";
import {IRiskEngine} from "../../src/interfaces/IRiskEngine.sol";
import {BlackScholesLib} from "../../src/pricing/BlackScholesLib.sol";
import {StrikeBase} from "../utils/StrikeBase.sol";

/// @dev A pricer without the risk engine: the v2 Stylus program's interface.
contract QuoteOnlyPricer is IPricer {
    function quote(uint256 spot, uint256 strike, uint256 timeToExpiry, uint256 sigma, bool isCall)
        external
        pure
        returns (uint256 price, int256 delta)
    {
        return BlackScholesLib.quote(spot, strike, timeToExpiry, sigma, isCall);
    }

    function strikeForDelta(uint256 spot, uint256 targetDelta, uint256 timeToExpiry, uint256 sigma, bool isCall)
        external
        pure
        returns (uint256)
    {
        return BlackScholesLib.strikeForDelta(spot, targetDelta, timeToExpiry, sigma, isCall);
    }
}

/// @notice Audit 2026-10-01 (v3): the active-agent rule, the `SeriesRisk` call at proposal and the pricer typing.
contract AuditV3EpochTest is StrikeBase {
    function setUp() public override {
        super.setUp();
        _depositCall(alice, 100 * WAD);
    }

    function _expectInactive() internal {
        vm.expectRevert(abi.encodeWithSelector(EpochManager.AgentNotActive.selector, agentId));
    }

    // ================================================================== L-03
    /// FIXED (L-03): `openEpoch` requires an active agent, like `registerVault`, `setVaultAgent` and `_propose`.
    /// Before the fix the signer of a suspended, retired or under-bonded agent could still open an epoch. Nobody
    /// could propose in it, so the vault stayed locked (deposits and redemptions queued) until the curator aborted
    /// it or `proposalTimeout` (a day) passed, and the same key could do it again the next day. The live agents sit
    /// exactly at `minBond`, so one more rejection would have put their vaults in this state.
    function test_AUDIT3_inactiveAgentSignerLocksVault() public {
        vm.prank(admin);
        registry.setStatus(agentId, AgentRegistry.Status.Suspended);
        assertFalse(registry.isActive(agentId));
        _expectInactive();
        vm.prank(agent);
        manager.openEpoch(address(callVault));
        assertFalse(callVault.locked(), "AUDIT L-03: an inactive agent's key locked the vault");
        // The vault stays open for business.
        _depositCall(bob, 1 * WAD);
        vm.prank(alice);
        callVault.redeem(10 * WAD, alice, alice);

        // A bond that fell below the minimum (one more slash on a bond at the minimum) is the same case.
        vm.startPrank(admin);
        registry.setStatus(agentId, AgentRegistry.Status.Active);
        vm.stopPrank();
        vm.prank(agent);
        registry.requestUnbond(agentId, 1000e6 - MIN_BOND + 1);
        assertFalse(registry.isActive(agentId));
        _expectInactive();
        vm.prank(agent);
        manager.openEpoch(address(callVault));
        // The keeper cannot open an epoch nobody can propose in either.
        _expectInactive();
        vm.prank(keeper);
        manager.openEpoch(address(callVault));

        // Bonded again: the epoch opens.
        usdg.mint(agent, 1e6);
        vm.startPrank(agent);
        usdg.approve(address(registry), 1e6);
        registry.postBond(agentId, 1e6);
        manager.openEpoch(address(callVault));
        vm.stopPrank();
        assertTrue(callVault.locked());
    }

    // ================================================================== I-01
    /// I-01 (Info, no fix): a pricer without the risk engine (the v2 Stylus program) makes every accepted proposal
    /// revert in the `SeriesRisk` call; rejected proposals are still slashed, because the call comes after the
    /// verdict. Only the admin can cause it (`setPricer`), nothing is lost, and the deploy script checks the risk
    /// engine on-chain before switching. The curator aborts the epoch (anyone can after the timeout) and the next
    /// one works once a risk engine is set.
    function test_AUDIT3_info_pricerWithoutRiskEngineBlocksAcceptedProposals() public {
        IRiskEngine quoteOnly = IRiskEngine(address(new QuoteOnlyPricer()));
        vm.prank(admin);
        manager.setPricer(quoteOnly);
        vm.prank(agent);
        manager.openEpoch(address(callVault));
        vm.prank(agent);
        (bool ok,) = manager.proposeSeries(address(callVault), 252 * WAD, FRIDAY_CLOSE, 50 * WAD, 10_000);
        assertFalse(ok);
        assertEq(registry.getAgent(agentId).strikes, 1);

        vm.expectRevert();
        vm.prank(agent);
        manager.proposeSeries(address(callVault), 275 * WAD, FRIDAY_CLOSE, 50 * WAD, 10_000);

        vm.prank(curator);
        manager.abortEpoch(address(callVault));
        vm.prank(admin);
        manager.setPricer(pricer);
        _openAndPropose(callVault, 275 * WAD, 50 * WAD);
    }

    // ================================================================== held
    /// The `SeriesRisk` call cannot make an accepted proposal revert: wherever `quote` succeeds, `greeks` succeeds
    /// on the same inputs, with the same delta, and wherever `quote` rejects, `greeks` rejects with the same code.
    /// The differential suite holds the Rust engine to the same equality.
    function testFuzz_AUDIT3_safe_greeksSucceedWhereverQuoteDoes(
        uint256 s,
        uint256 k,
        uint256 t,
        uint256 v,
        bool isCall
    ) public {
        // Around the pricer's documented range, inside and just outside it.
        s = bound(s, 1e5, 2e30);
        k = bound(k, 1e5, 2e30);
        t = bound(t, 0, 3 * 365 days);
        v = bound(v, 0, 6e18);
        try pricer.quote(s, k, t, v, isCall) returns (uint256, int256 quoteDelta) {
            (int256 delta, uint256 gamma, uint256 vega, int256 theta) = pricer.greeks(s, k, t, v, isCall);
            assertEq(delta, quoteDelta, "delta");
            assertLe(delta, 1e18);
            assertGe(delta, -1e18);
            assertLe(theta, 0, "theta is never positive at r = 0");
            // vega = S phi(d1) sqrt(T) with phi <= 0.4 and T <= 2 years.
            assertLe(vega, s * 6 / 10, "vega bound");
            gamma;
        } catch (bytes memory err) {
            try pricer.greeks(s, k, t, v, isCall) {
                fail();
            } catch (bytes memory err2) {
                assertEq(err2, err, "same rejection");
            }
        }
    }
}
