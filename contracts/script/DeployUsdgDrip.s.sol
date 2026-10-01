// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {UsdgDrip} from "../src/testnet/UsdgDrip.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Script, console2} from "forge-std/Script.sol";

interface ITestUsdg {
    function faucet(uint256 amount) external;
}

/// @notice Deploys the team's test-USDG faucet (UsdgDrip) for the chain's USDG (read from deployments/<chainId>.json)
///         and funds it with FUND. Testnets only. Additive: nothing in the deployed protocol changes. On local devnets
///         it mints TestUSDG first and writes `usdgDrip` into deployments/<chainId>.json; elsewhere add the printed
///         address to that file as `usdgDrip`, then run `node scripts/export-abis.mjs`.
///
/// Env: PRIVATE_KEY (deployer, becomes the owner); FUND (USDG base units sent to the faucet, default 100e6; 1,000,000e6
///      minted and sent on local devnets).
contract DeployUsdgDrip is Script {
    function run() external returns (UsdgDrip drip) {
        require(block.chainid != 4663, "testnets only");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        bool local = block.chainid == 31_337 || block.chainid == 412_346;
        uint256 fund = vm.envOr("FUND", local ? uint256(1_000_000e6) : uint256(100e6));
        string memory path = string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
        string memory json = vm.readFile(path);
        IERC20 usdg = IERC20(vm.parseJsonAddress(json, ".usdg"));

        vm.startBroadcast(pk);
        drip = new UsdgDrip(usdg, vm.addr(pk));
        if (local) ITestUsdg(address(usdg)).faucet(fund);
        if (fund > 0) require(usdg.transfer(address(drip), fund), "fund");
        vm.stopBroadcast();

        if (local) {
            vm.serializeJson("dep", json);
            vm.writeJson(vm.serializeAddress("dep", "usdgDrip", address(drip)), path);
        }
        console2.log("UsdgDrip", address(drip));
        console2.log("USDG", address(usdg));
        console2.log("funded", fund);
    }
}
