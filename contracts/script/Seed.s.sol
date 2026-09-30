// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AgentRegistry} from "../src/agents/AgentRegistry.sol";
import {MandateGuard} from "../src/libraries/MandateGuard.sol";
import {StrikeVault} from "../src/vaults/StrikeVault.sol";
import {VaultFactory} from "../src/vaults/VaultFactory.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Script, console2} from "forge-std/Script.sol";

interface IFaucet {
    function faucet() external;
    function faucet(uint256 amount) external;
}

/// @notice After Deploy: registers the demo agent, bonds it, and creates a covered-call and a cash-secured-put vault
///         on the first listed stock. Writes deployments/<chainId>-vaults.json.
///
/// Env: PRIVATE_KEY (curator and agent owner); AGENT_SIGNER_KEY (the agent's signer key, default: PRIVATE_KEY; a
///      separate signer consents to the registration with an EIP-712 signature);
///      BOND (USDG base units, default 100e6: one slash still leaves the agent above the 50 USDG minimum); STOCK (symbol, default TSLA).
contract Seed is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(pk);
        uint256 signerPk = vm.envOr("AGENT_SIGNER_KEY", pk);
        address signer = vm.addr(signerPk);
        uint256 bond = vm.envOr("BOND", uint256(100e6));
        string memory symbol = vm.envOr("STOCK", string("TSLA"));

        string memory json =
            vm.readFile(string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json"));
        AgentRegistry registry = AgentRegistry(vm.parseJsonAddress(json, ".agentRegistry"));
        VaultFactory factory = VaultFactory(vm.parseJsonAddress(json, ".vaultFactory"));
        IERC20 usdg = IERC20(vm.parseJsonAddress(json, ".usdg"));
        address stock = vm.parseJsonAddress(json, string.concat(".stocks.", symbol, ".token"));

        vm.startBroadcast(pk);
        // Local devnets (anvil, Nitro dev node) use TestUSDG with an open faucet.
        if (block.chainid == 31_337 || block.chainid == 412_346) IFaucet(address(usdg)).faucet(1_000_000e6);

        uint256 agentId = registry.agentOfSigner(signer);
        if (agentId == 0) agentId = _register(registry, signerPk, me);
        if (registry.getAgent(agentId).bond < bond) {
            usdg.approve(address(registry), bond);
            registry.postBond(agentId, bond);
        }

        address callVault = factory.createVault(_params(stock, symbol, true, agentId));
        address putVault = factory.createVault(_params(stock, symbol, false, agentId));
        vm.stopBroadcast();

        string memory k = "vaults";
        vm.serializeUint(k, "agentId", agentId);
        vm.serializeAddress(k, "agentSigner", signer);
        vm.serializeAddress(k, string.concat(symbol, "_covered_call"), callVault);
        string memory out = vm.serializeAddress(k, string.concat(symbol, "_cash_secured_put"), putVault);
        vm.writeJson(out, string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), "-vaults.json"));
        console2.log("agent", agentId);
        console2.log("call vault", callVault);
        console2.log("put vault", putVault);
    }

    /// Register an agent owned by `me`. A signer other than `me` consents with an EIP-712 signature.
    function _register(AgentRegistry registry, uint256 signerPk, address me) internal returns (uint256) {
        address signer = vm.addr(signerPk);
        if (signer == me) return registry.register(signer, me, 0, 0, "");
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, registry.registerDigest(signer, me, me, 0, deadline));
        return registry.register(signer, me, 0, deadline, abi.encodePacked(r, s, v));
    }

    /// Weekly 0.10–0.35 delta, at least 95% of fair value, at least 0.05% weekly yield, sell up to 80% of the vault.
    function _params(address stock, string memory symbol, bool isCall, uint256 agentId)
        internal
        view
        returns (VaultFactory.CreateParams memory)
    {
        bool mainnet = block.chainid == 4663;
        return VaultFactory.CreateParams({
            underlying: stock,
            isCall: isCall,
            agentId: agentId,
            depositCap: isCall ? (mainnet ? 1e18 : 10_000e18) : (mainnet ? 500e6 : 5_000_000e6),
            name: string.concat("Strike ", symbol, isCall ? " Covered Call" : " Cash-Secured Put"),
            symbol: string.concat("s", symbol, isCall ? "-CC" : "-CSP"),
            mandate: MandateGuard.Mandate({
                minDeltaBps: 1000,
                maxDeltaBps: 3500,
                minPremiumBps: 9500,
                minYieldBps: 5,
                maxShareSoldBps: 8000,
                minTenor: 1 days,
                maxTenor: 8 days
            })
        });
    }
}
