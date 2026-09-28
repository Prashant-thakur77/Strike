// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {FeeManager} from "../../src/core/FeeManager.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";

contract FeeManagerTest is Test {
    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");
    address internal depositor = makeAddr("depositor");
    address internal agent = makeAddr("agent");
    address internal alice = makeAddr("alice");

    MockERC20 internal usdg;
    FeeManager internal fees;

    function setUp() public {
        usdg = new MockERC20("Global Dollar", "USDG", 6);
        fees = new FeeManager(admin, usdg, treasury, 1000, 5000); // 10% of net premium, half to the agent
        bytes32 role = fees.DEPOSITOR_ROLE();
        vm.prank(admin);
        fees.grantRole(role, depositor);
    }

    /// Transfer the USDG in and credit it, the way the EpochManager does.
    function _fundAndCredit(address agent_, uint256 agentAmount, uint256 treasuryAmount) internal {
        usdg.mint(address(fees), agentAmount + treasuryAmount);
        vm.prank(depositor);
        fees.creditFees(agent_, agentAmount, treasuryAmount);
    }

    // ------------------------------------------------------------------ constructor

    function test_constructor_setsState() public view {
        assertEq(address(fees.usdg()), address(usdg));
        assertEq(fees.treasury(), treasury);
        assertEq(fees.perfFeeBps(), 1000);
        assertEq(fees.agentShareBps(), 5000);
        assertTrue(fees.hasRole(fees.DEFAULT_ADMIN_ROLE(), admin));
        assertEq(fees.DEPOSITOR_ROLE(), keccak256("DEPOSITOR_ROLE"));
        assertEq(fees.BPS(), 10_000);
        assertEq(fees.MAX_PERF_FEE_BPS(), 3000);
        assertEq(fees.totalClaimable(), 0);
    }

    function test_constructor_emitsFeesSet() public {
        vm.expectEmit();
        emit FeeManager.FeesSet(2000, 2500);
        new FeeManager(admin, usdg, treasury, 2000, 2500);
    }

    function test_constructor_revertsOnZeroAdmin() public {
        vm.expectRevert(FeeManager.ZeroAddress.selector);
        new FeeManager(address(0), usdg, treasury, 1000, 5000);
    }

    function test_constructor_revertsOnZeroUsdg() public {
        vm.expectRevert(FeeManager.ZeroAddress.selector);
        new FeeManager(admin, IERC20(address(0)), treasury, 1000, 5000);
    }

    function test_constructor_revertsOnZeroTreasury() public {
        vm.expectRevert(FeeManager.ZeroAddress.selector);
        new FeeManager(admin, usdg, address(0), 1000, 5000);
    }

    function test_constructor_revertsOnPerfFeeAboveCap() public {
        vm.expectRevert(abi.encodeWithSelector(FeeManager.FeeTooHigh.selector, uint256(3001)));
        new FeeManager(admin, usdg, treasury, 3001, 5000);
    }

    function test_constructor_revertsOnAgentShareAboveOne() public {
        vm.expectRevert(abi.encodeWithSelector(FeeManager.FeeTooHigh.selector, uint256(10_001)));
        new FeeManager(admin, usdg, treasury, 1000, 10_001);
    }

    function test_constructor_acceptsBoundaryFees() public {
        FeeManager f = new FeeManager(admin, usdg, treasury, 3000, 10_000);
        assertEq(f.perfFeeBps(), 3000);
        assertEq(f.agentShareBps(), 10_000);
    }

    // ------------------------------------------------------------------ computeFee

    function test_computeFee_chargesShareOfNetPremium() public view {
        (uint256 fee, uint256 agentCut) = fees.computeFee(1000e6, 200e6);
        assertEq(fee, 80e6); // 10% of 800
        assertEq(agentCut, 40e6); // half of it
    }

    function test_computeFee_zeroWhenEpochLostMoney() public view {
        (uint256 fee, uint256 agentCut) = fees.computeFee(100e6, 300e6);
        assertEq(fee, 0);
        assertEq(agentCut, 0);
    }

    function test_computeFee_zeroWhenBreakEven() public view {
        (uint256 fee, uint256 agentCut) = fees.computeFee(100e6, 100e6);
        assertEq(fee, 0);
        assertEq(agentCut, 0);
    }

    function test_computeFee_roundsDown() public view {
        // 10% of 19 wei = 1.9 -> 1; half of 1 -> 0.
        (uint256 fee, uint256 agentCut) = fees.computeFee(19, 0);
        assertEq(fee, 1);
        assertEq(agentCut, 0);
    }

    function test_computeFee_zeroFeeRate() public {
        vm.prank(admin);
        fees.setFees(0, 5000);
        (uint256 fee, uint256 agentCut) = fees.computeFee(1000e6, 0);
        assertEq(fee, 0);
        assertEq(agentCut, 0);
    }

    // ------------------------------------------------------------------ creditFees

    function test_creditFees_creditsAgentAndTreasury() public {
        usdg.mint(address(fees), 100e6);
        vm.expectEmit(address(fees));
        emit FeeManager.FeesCredited(agent, 60e6, 40e6);
        vm.prank(depositor);
        fees.creditFees(agent, 60e6, 40e6);
        assertEq(fees.claimable(agent), 60e6);
        assertEq(fees.claimable(treasury), 40e6);
        assertEq(fees.totalClaimable(), 100e6);
    }

    function test_creditFees_zeroAgentPaysTreasury() public {
        usdg.mint(address(fees), 100e6);
        vm.expectEmit(address(fees));
        emit FeeManager.FeesCredited(treasury, 60e6, 40e6);
        vm.prank(depositor);
        fees.creditFees(address(0), 60e6, 40e6);
        assertEq(fees.claimable(treasury), 100e6);
        assertEq(fees.claimable(address(0)), 0);
        assertEq(fees.totalClaimable(), 100e6);
    }

    function test_creditFees_accumulates() public {
        _fundAndCredit(agent, 10e6, 5e6);
        _fundAndCredit(agent, 1e6, 2e6);
        assertEq(fees.claimable(agent), 11e6);
        assertEq(fees.claimable(treasury), 7e6);
        assertEq(fees.totalClaimable(), 18e6);
    }

    function test_creditFees_revertsForNonDepositor() public {
        usdg.mint(address(fees), 100e6);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, admin, fees.DEPOSITOR_ROLE()
            )
        );
        vm.prank(admin);
        fees.creditFees(agent, 1, 1);
    }

    function test_creditFees_revertsWhenUnfunded() public {
        usdg.mint(address(fees), 99e6);
        vm.expectRevert(abi.encodeWithSelector(FeeManager.InsufficientFunding.selector, 100e6, 99e6));
        vm.prank(depositor);
        fees.creditFees(agent, 60e6, 40e6);
    }

    function test_creditFees_cannotCreditSameFundingTwice() public {
        _fundAndCredit(agent, 60e6, 40e6);
        // The balance is fully owed already: nothing left to credit.
        vm.expectRevert(abi.encodeWithSelector(FeeManager.InsufficientFunding.selector, 1, 0));
        vm.prank(depositor);
        fees.creditFees(agent, 1, 0);
    }

    function test_creditFees_zeroAmountsAllowed() public {
        vm.prank(depositor);
        fees.creditFees(agent, 0, 0);
        assertEq(fees.totalClaimable(), 0);
    }

    // ------------------------------------------------------------------ claim

    function test_claim_paysAndEmits() public {
        _fundAndCredit(agent, 60e6, 40e6);
        vm.expectEmit(address(fees));
        emit FeeManager.Claimed(agent, 60e6);
        vm.prank(agent);
        assertEq(fees.claim(), 60e6);
        assertEq(usdg.balanceOf(agent), 60e6);
        assertEq(fees.claimable(agent), 0);
        assertEq(fees.totalClaimable(), 40e6);
        assertEq(usdg.balanceOf(address(fees)), 40e6);

        vm.prank(treasury);
        assertEq(fees.claim(), 40e6);
        assertEq(fees.totalClaimable(), 0);
        assertEq(usdg.balanceOf(address(fees)), 0);
    }

    function test_claim_returnsZeroWhenNothingOwed() public {
        usdg.mint(address(fees), 5e6); // unrelated balance
        vm.recordLogs();
        vm.prank(alice);
        assertEq(fees.claim(), 0);
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(usdg.balanceOf(alice), 0);
    }

    function test_claim_secondClaimReturnsZero() public {
        _fundAndCredit(agent, 1e6, 0);
        vm.startPrank(agent);
        fees.claim();
        assertEq(fees.claim(), 0);
        vm.stopPrank();
        assertEq(usdg.balanceOf(agent), 1e6);
    }

    function test_claim_freesFundingForNewCredits() public {
        _fundAndCredit(agent, 10e6, 0);
        vm.prank(agent);
        fees.claim();
        usdg.mint(address(fees), 3e6);
        vm.prank(depositor);
        fees.creditFees(agent, 3e6, 0);
        assertEq(fees.claimable(agent), 3e6);
    }

    // ------------------------------------------------------------------ setFees

    function test_setFees_updatesAndEmits() public {
        vm.expectEmit(address(fees));
        emit FeeManager.FeesSet(3000, 10_000);
        vm.prank(admin);
        fees.setFees(3000, 10_000);
        assertEq(fees.perfFeeBps(), 3000);
        assertEq(fees.agentShareBps(), 10_000);
        (uint256 fee, uint256 agentCut) = fees.computeFee(100e6, 0);
        assertEq(fee, 30e6);
        assertEq(agentCut, 30e6);
    }

    function test_setFees_revertsForNonAdmin() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, depositor, fees.DEFAULT_ADMIN_ROLE()
            )
        );
        vm.prank(depositor);
        fees.setFees(0, 0);
    }

    function test_setFees_revertsOnPerfFeeAboveCap() public {
        vm.expectRevert(abi.encodeWithSelector(FeeManager.FeeTooHigh.selector, uint256(3001)));
        vm.prank(admin);
        fees.setFees(3001, 0);
    }

    function test_setFees_revertsOnAgentShareAboveOne() public {
        vm.expectRevert(abi.encodeWithSelector(FeeManager.FeeTooHigh.selector, uint256(10_001)));
        vm.prank(admin);
        fees.setFees(0, 10_001);
    }

    // ------------------------------------------------------------------ setTreasury

    function test_setTreasury_updatesAndEmits() public {
        address newTreasury = makeAddr("newTreasury");
        vm.expectEmit(address(fees));
        emit FeeManager.TreasurySet(newTreasury);
        vm.prank(admin);
        fees.setTreasury(newTreasury);
        assertEq(fees.treasury(), newTreasury);
    }

    function test_setTreasury_oldCreditsStayWithOldTreasury() public {
        _fundAndCredit(agent, 0, 7e6);
        address newTreasury = makeAddr("newTreasury");
        vm.prank(admin);
        fees.setTreasury(newTreasury);
        _fundAndCredit(address(0), 2e6, 3e6);
        assertEq(fees.claimable(treasury), 7e6);
        assertEq(fees.claimable(newTreasury), 5e6);
        vm.prank(treasury);
        assertEq(fees.claim(), 7e6);
    }

    function test_setTreasury_revertsForNonAdmin() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, treasury, fees.DEFAULT_ADMIN_ROLE()
            )
        );
        vm.prank(treasury);
        fees.setTreasury(alice);
    }

    function test_setTreasury_revertsOnZeroAddress() public {
        vm.expectRevert(FeeManager.ZeroAddress.selector);
        vm.prank(admin);
        fees.setTreasury(address(0));
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_computeFee_boundedByNetPremium(
        uint128 premium,
        uint128 payoutValue,
        uint16 perfFeeBps,
        uint16 agentShareBps
    ) public {
        perfFeeBps = uint16(bound(perfFeeBps, 0, 3000));
        agentShareBps = uint16(bound(agentShareBps, 0, 10_000));
        vm.prank(admin);
        fees.setFees(perfFeeBps, agentShareBps);
        (uint256 fee, uint256 agentCut) = fees.computeFee(premium, payoutValue);
        if (premium <= payoutValue) {
            assertEq(fee, 0);
            assertEq(agentCut, 0);
        } else {
            uint256 net = uint256(premium) - payoutValue;
            assertEq(fee, net * perfFeeBps / 10_000);
            assertLe(fee, net * 3000 / 10_000);
        }
        assertLe(agentCut, fee);
    }

    function testFuzz_setFees_revertsAboveCaps(uint16 perfFeeBps, uint16 agentShareBps) public {
        bool ok = perfFeeBps <= 3000 && agentShareBps <= 10_000;
        if (!ok) vm.expectPartialRevert(FeeManager.FeeTooHigh.selector);
        vm.prank(admin);
        fees.setFees(perfFeeBps, agentShareBps);
        if (ok) {
            assertEq(fees.perfFeeBps(), perfFeeBps);
            assertEq(fees.agentShareBps(), agentShareBps);
        }
    }

    /// Credits and claims in any order keep every claimable balance covered by USDG held.
    function testFuzz_creditAndClaim_staySolvent(uint64 a1, uint64 t1, uint64 a2, uint64 t2, bool agentClaimsFirst)
        public
    {
        _fundAndCredit(agent, a1, t1);
        vm.prank(agentClaimsFirst ? agent : treasury);
        fees.claim();
        _fundAndCredit(address(0), a2, t2);
        assertGe(usdg.balanceOf(address(fees)), fees.totalClaimable());
        assertEq(fees.totalClaimable(), fees.claimable(agent) + fees.claimable(treasury));

        vm.prank(agent);
        fees.claim();
        vm.prank(treasury);
        fees.claim();
        assertEq(fees.totalClaimable(), 0);
        assertEq(usdg.balanceOf(address(fees)), 0);
        assertEq(usdg.balanceOf(agent) + usdg.balanceOf(treasury), uint256(a1) + t1 + a2 + t2);
        assertEq(usdg.balanceOf(agent), a1);
    }
}
