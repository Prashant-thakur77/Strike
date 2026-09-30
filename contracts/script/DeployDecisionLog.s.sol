// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {DecisionLog} from "../src/agents/DecisionLog.sol";
import {IAgentRegistry} from "../src/interfaces/IAgentRegistry.sol";
import {Script, console2} from "forge-std/Script.sol";

/// @notice Deploys DecisionLog against the chain's live AgentRegistry (read from deployments/<chainId>.json).
///         Additive: nothing in the deployed protocol changes. Add the printed address to that file as `decisionLog`,
///         then run `node scripts/export-abis.mjs`.
///
/// Env: PRIVATE_KEY (any funded key; DecisionLog has no owner).
contract DeployDecisionLog is Script {
    function run() external returns (DecisionLog log) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        string memory path = string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
        IAgentRegistry registry = IAgentRegistry(vm.parseJsonAddress(vm.readFile(path), ".agentRegistry"));

        vm.startBroadcast(pk);
        log = new DecisionLog(registry);
        vm.stopBroadcast();

        console2.log("DecisionLog", address(log));
        console2.log("AgentRegistry", address(registry));
    }
}
