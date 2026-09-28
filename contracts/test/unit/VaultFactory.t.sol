// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {EpochManager} from "../../src/core/EpochManager.sol";
import {IStrikeVault} from "../../src/interfaces/IStrikeVault.sol";
import {MandateGuard} from "../../src/libraries/MandateGuard.sol";
import {StrikeVault} from "../../src/vaults/StrikeVault.sol";
import {VaultFactory} from "../../src/vaults/VaultFactory.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockStockToken} from "../mocks/MockStockToken.sol";
import {StrikeBase} from "../utils/StrikeBase.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {Test} from "forge-std/Test.sol";

/// @notice Stands in for the EpochManager: records `registerVault` calls so the factory is tested in isolation.
contract MockVaultRegistry {
    address public lastVault;
    address public lastCurator;
    uint256 public lastAgentId;
    MandateGuard.Mandate public lastMandate;
    /// The vault's underlying as seen during registration (proves the clone is initialized first).
    address public underlyingAtRegistration;
    uint256 public registrations;
    bool public reject;

    error Rejected();

    function setReject(bool r) external {
        reject = r;
    }

    function registerVault(address vault, address curator, uint256 agentId, MandateGuard.Mandate calldata mandate)
        external
    {
        if (reject) revert Rejected();
        lastVault = vault;
        lastCurator = curator;
        lastAgentId = agentId;
        lastMandate = mandate;
        underlyingAtRegistration = IStrikeVault(vault).underlying();
        ++registrations;
    }
}

contract VaultFactoryTest is Test {
    uint256 internal constant MAX_CAP = 10_000_000e18;

    address internal admin = makeAddr("admin");
    address internal curator = makeAddr("curator");
    uint256 internal constant AGENT_ID = 7;

    MockERC20 internal usdg;
    MockStockToken internal tsla;
    MockVaultRegistry internal registry;
    StrikeVault internal impl;
    VaultFactory internal factory;

    function setUp() public {
        usdg = new MockERC20("Global Dollar", "USDG", 6);
        tsla = new MockStockToken("Tesla", "TSLA");
        registry = new MockVaultRegistry();
        impl = new StrikeVault();
        factory = new VaultFactory(admin, address(impl), _mgr(), address(usdg), MAX_CAP);
    }

    function _mgr() internal view returns (EpochManager) {
        return EpochManager(address(registry));
    }

    function _mandate() internal pure returns (MandateGuard.Mandate memory) {
        return MandateGuard.Mandate({
            minDeltaBps: 500,
            maxDeltaBps: 4000,
            minPremiumBps: 9500,
            minYieldBps: 5,
            maxShareSoldBps: 10_000,
            minTenor: 1 days,
            maxTenor: 14 days
        });
    }

    function _params(bool isCall, uint256 cap) internal view returns (VaultFactory.CreateParams memory) {
        return VaultFactory.CreateParams({
            underlying: address(tsla),
            isCall: isCall,
            agentId: AGENT_ID,
            depositCap: cap,
            name: isCall ? "Strike TSLA Covered Call" : "Strike TSLA Cash-Secured Put",
            symbol: isCall ? "sTSLA-CC" : "sTSLA-CSP",
            mandate: _mandate()
        });
    }

    function _create(bool isCall, uint256 cap) internal returns (StrikeVault) {
        vm.prank(curator);
        return StrikeVault(factory.createVault(_params(isCall, cap)));
    }

    // ------------------------------------------------------------------ constructor

    function test_constructor_setsState() public view {
        assertEq(factory.implementation(), address(impl));
        assertEq(address(factory.manager()), address(registry));
        assertEq(factory.usdg(), address(usdg));
        assertEq(factory.maxDepositCap(), MAX_CAP);
        assertTrue(factory.hasRole(factory.DEFAULT_ADMIN_ROLE(), admin));
    }

    function test_constructor_revertsOnZeroAdmin() public {
        vm.expectRevert(VaultFactory.ZeroAddress.selector);
        new VaultFactory(address(0), address(impl), _mgr(), address(usdg), MAX_CAP);
    }

    function test_constructor_revertsOnZeroImplementation() public {
        vm.expectRevert(VaultFactory.ZeroAddress.selector);
        new VaultFactory(admin, address(0), _mgr(), address(usdg), MAX_CAP);
    }

    function test_constructor_revertsOnZeroManager() public {
        vm.expectRevert(VaultFactory.ZeroAddress.selector);
        new VaultFactory(admin, address(impl), EpochManager(address(0)), address(usdg), MAX_CAP);
    }

    function test_constructor_revertsOnZeroUsdg() public {
        vm.expectRevert(VaultFactory.ZeroAddress.selector);
        new VaultFactory(admin, address(impl), _mgr(), address(0), MAX_CAP);
    }

    // ------------------------------------------------------------------ setMaxDepositCap

    function test_setMaxDepositCap_updatesAndEmits() public {
        vm.expectEmit(address(factory));
        emit VaultFactory.MaxDepositCapSet(5e18);
        vm.prank(admin);
        factory.setMaxDepositCap(5e18);
        assertEq(factory.maxDepositCap(), 5e18);
    }

    function test_setMaxDepositCap_revertsForNonAdmin() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, curator, factory.DEFAULT_ADMIN_ROLE()
            )
        );
        vm.prank(curator);
        factory.setMaxDepositCap(1);
    }

    function test_setMaxDepositCap_appliesToNewVaults() public {
        vm.prank(admin);
        factory.setMaxDepositCap(100e18);
        vm.expectRevert(abi.encodeWithSelector(VaultFactory.DepositCapTooHigh.selector, 101e18, 100e18));
        vm.prank(curator);
        factory.createVault(_params(true, 101e18));
        assertEq(_create(true, 100e18).depositCap(), 100e18);
    }

    // ------------------------------------------------------------------ createVault

    function test_createVault_callVaultHoldsStock() public {
        StrikeVault v = _create(true, 1_000_000e18);
        assertEq(v.asset(), address(tsla));
        assertEq(v.premiumToken(), address(usdg));
        assertEq(v.underlying(), address(tsla));
        assertTrue(v.isCall());
        assertEq(v.manager(), address(registry));
        assertEq(v.depositCap(), 1_000_000e18);
        assertEq(v.name(), "Strike TSLA Covered Call");
        assertEq(v.symbol(), "sTSLA-CC");
        assertEq(v.decimals(), 18);
        assertFalse(v.locked());
    }

    function test_createVault_putVaultHoldsUsdg() public {
        StrikeVault v = _create(false, 5_000_000e6);
        assertEq(v.asset(), address(usdg));
        assertEq(v.premiumToken(), address(usdg));
        assertEq(v.underlying(), address(tsla));
        assertFalse(v.isCall());
        assertEq(v.manager(), address(registry));
        assertEq(v.depositCap(), 5_000_000e6);
        assertEq(v.symbol(), "sTSLA-CSP");
        assertEq(v.decimals(), 6);
    }

    function test_createVault_registersWithManager() public {
        StrikeVault v = _create(true, 1e18);
        assertEq(registry.registrations(), 1);
        assertEq(registry.lastVault(), address(v));
        assertEq(registry.lastCurator(), curator);
        assertEq(registry.lastAgentId(), AGENT_ID);
        assertEq(registry.underlyingAtRegistration(), address(tsla));
        (
            uint16 minDeltaBps,
            uint16 maxDeltaBps,
            uint16 minPremiumBps,
            uint16 minYieldBps,
            uint16 maxShareSoldBps,
            uint32 minTenor,
            uint32 maxTenor
        ) = registry.lastMandate();
        assertEq(minDeltaBps, 500);
        assertEq(maxDeltaBps, 4000);
        assertEq(minPremiumBps, 9500);
        assertEq(minYieldBps, 5);
        assertEq(maxShareSoldBps, 10_000);
        assertEq(minTenor, 1 days);
        assertEq(maxTenor, 14 days);
    }

    function test_createVault_emitsVaultCreated() public {
        address predicted = vm.computeCreateAddress(address(factory), vm.getNonce(address(factory)));
        vm.expectEmit(address(factory));
        emit VaultFactory.VaultCreated(predicted, curator, address(tsla), true, AGENT_ID);
        StrikeVault v = _create(true, 1e18);
        assertEq(address(v), predicted);
    }

    function test_createVault_deploysMinimalProxyToImplementation() public {
        StrikeVault v = _create(true, 1e18);
        bytes memory expected =
            abi.encodePacked(hex"363d3d373d3d3d363d73", address(impl), hex"5af43d82803e903d91602b57fd5bf3");
        assertEq(address(v).code, expected);
    }

    function test_createVault_eachCallDeploysANewVault() public {
        StrikeVault a = _create(true, 1e18);
        StrikeVault b = _create(true, 1e18);
        assertTrue(address(a) != address(b));
        assertEq(registry.registrations(), 2);
    }

    function test_createVault_cloneCannotBeReinitialized() public {
        StrikeVault v = _create(true, 1e18);
        IStrikeVault.InitParams memory p = IStrikeVault.InitParams({
            asset: address(usdg),
            premiumToken: address(usdg),
            underlying: address(usdg),
            isCall: false,
            manager: address(this),
            depositCap: 1,
            name: "x",
            symbol: "x"
        });
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        v.initialize(p);
    }

    function test_createVault_anyoneCanCreate() public {
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        factory.createVault(_params(true, 1e18));
        assertEq(registry.lastCurator(), stranger);
    }

    function test_createVault_passesAgentIdThrough() public {
        VaultFactory.CreateParams memory p = _params(true, 1e18);
        p.agentId = 0;
        vm.prank(curator);
        factory.createVault(p);
        assertEq(registry.lastAgentId(), 0);
    }

    function test_createVault_capAtMaximumAllowed() public {
        assertEq(_create(true, MAX_CAP).depositCap(), MAX_CAP);
    }

    function test_createVault_revertsOnZeroUnderlying() public {
        VaultFactory.CreateParams memory p = _params(true, 1e18);
        p.underlying = address(0);
        vm.expectRevert(VaultFactory.ZeroAddress.selector);
        vm.prank(curator);
        factory.createVault(p);
    }

    function test_createVault_revertsOnCapAboveMaximum() public {
        vm.expectRevert(abi.encodeWithSelector(VaultFactory.DepositCapTooHigh.selector, MAX_CAP + 1, MAX_CAP));
        vm.prank(curator);
        factory.createVault(_params(true, MAX_CAP + 1));
    }

    function test_createVault_revertsWhenRegistrationFails() public {
        registry.setReject(true);
        uint256 nonce = vm.getNonce(address(factory));
        vm.expectRevert(MockVaultRegistry.Rejected.selector);
        vm.prank(curator);
        factory.createVault(_params(true, 1e18));
        // Atomic: no clone survives the failed registration.
        assertEq(vm.getNonce(address(factory)), nonce);
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_createVault_respectsCap(uint256 cap) public {
        if (cap > MAX_CAP) {
            vm.expectRevert(abi.encodeWithSelector(VaultFactory.DepositCapTooHigh.selector, cap, MAX_CAP));
            vm.prank(curator);
            factory.createVault(_params(true, cap));
        } else {
            assertEq(_create(true, cap).depositCap(), cap);
        }
    }
}

/// @notice The factory wired to the real EpochManager (deployed by StrikeBase).
contract VaultFactoryWiringTest is StrikeBase {
    function test_baseVaults_areInitializedClonesOfTheImplementation() public view {
        assertEq(factory.implementation(), address(vaultImpl));
        assertEq(address(factory.manager()), address(manager));
        assertEq(factory.usdg(), address(usdg));

        assertEq(callVault.manager(), address(manager));
        assertEq(callVault.asset(), address(tsla));
        assertTrue(callVault.isCall());
        assertEq(putVault.manager(), address(manager));
        assertEq(putVault.asset(), address(usdg));
        assertFalse(putVault.isCall());

        bytes memory expected =
            abi.encodePacked(hex"363d3d373d3d3d363d73", address(vaultImpl), hex"5af43d82803e903d91602b57fd5bf3");
        assertEq(address(callVault).code, expected);
        assertEq(address(putVault).code, expected);
    }
}
