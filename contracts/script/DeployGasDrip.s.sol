// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {GasDrip} from "../src/testnet/GasDrip.sol";
import {Script, console2} from "forge-std/Script.sol";

/// @notice Deploys the team's starter gas drip (GasDrip), names the relayer and funds both. Testnets only. Additive:
///         nothing in the deployed protocol changes. On local devnets it writes `gasDrip` into
///         deployments/<chainId>.json; elsewhere add the printed address to that file as `gasDrip`, then run
///         `node scripts/export-abis.mjs --skip-abis`.
///
/// Env: PRIVATE_KEY (deployer, becomes the owner); RELAYER (the address `/api/gas-drip` sends from, required);
///      AMOUNT (wei per drip, default 0.0001 ether); DAILY_CAP (drips per UTC day, default 20); FUND (wei sent to the
///      drip, default 0.002 ether); RELAYER_FUND (wei sent to the relayer for its own gas, default 0.0003 ether).
contract DeployGasDrip is Script {
    function run() external returns (GasDrip drip) {
        require(block.chainid != 4663 && block.chainid != 42_161, "testnets only");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address relayer = vm.envAddress("RELAYER");
        uint256 amount = vm.envOr("AMOUNT", uint256(0.0001 ether));
        uint256 cap = vm.envOr("DAILY_CAP", uint256(20));
        uint256 fund = vm.envOr("FUND", uint256(0.002 ether));
        uint256 relayerFund = vm.envOr("RELAYER_FUND", uint256(0.0003 ether));

        vm.startBroadcast(pk);
        drip = new GasDrip(vm.addr(pk), relayer, amount, cap);
        if (fund > 0) {
            (bool ok,) = address(drip).call{value: fund}("");
            require(ok, "fund");
        }
        if (relayerFund > 0 && relayer.balance < relayerFund) {
            (bool ok,) = payable(relayer).call{value: relayerFund - relayer.balance}("");
            require(ok, "relayer fund");
        }
        vm.stopBroadcast();

        if (block.chainid == 31_337 || block.chainid == 412_346) {
            string memory path = string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
            vm.serializeJson("dep", vm.readFile(path));
            vm.writeJson(vm.serializeAddress("dep", "gasDrip", address(drip)), path);
        }
        console2.log("GasDrip", address(drip));
        console2.log("relayer", relayer);
        console2.log("amount", amount);
        console2.log("dailyCap", cap);
        console2.log("funded", fund);
    }
}
