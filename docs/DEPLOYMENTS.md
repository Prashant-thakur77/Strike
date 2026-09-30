# Deployments and versions

Every Strike deployment, with the commit it was built from, the block it was deployed at, every address, what Blockscout says about each one, and a checklist to re-verify all of it yourself. Deployed contracts are immutable: a contract change means a new deployment and a new row here.

Checked on 2026-09-30 against Robinhood Chain testnet (chain id 46630): Blockscout API `https://explorer.testnet.chain.robinhood.com/api/v2/smart-contracts/<address>` and `/api/v2/addresses/<address>`, and `cast` against `https://rpc.testnet.chain.robinhood.com`.

## Summary

| Version | Network                 | Status                    | Source commit                                                                         | Deploy commit                                                           | Deploy block                       | Addresses                                                                                                                          |
| ------- | ----------------------- | ------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| v3      | none                    | Branch only, not deployed | [`52e01d8`](https://github.com/Prashant-thakur77/Strike/commit/52e01d8) (branch head) | none                                                                    | none                               | [`v3-contracts`](https://github.com/Prashant-thakur77/Strike/tree/v3-contracts)                                                    |
| **v2**  | Robinhood Chain testnet | **Current**; live epoch   | [`1ff5382`](https://github.com/Prashant-thakur77/Strike/commit/1ff5382)               | [`beb4281`](https://github.com/Prashant-thakur77/Strike/commit/beb4281) | 125,880,607 (2026-09-28 21:11 UTC) | [`46630.json`](../contracts/deployments/46630.json), [`46630-vaults.json`](../contracts/deployments/46630-vaults.json)             |
| v1      | Robinhood Chain testnet | Superseded by v2          | [`bb654ad`](https://github.com/Prashant-thakur77/Strike/commit/bb654ad)               | [`fc21316`](https://github.com/Prashant-thakur77/Strike/commit/fc21316) | 125,866,639 (2026-09-28 20:14 UTC) | [`46630-v1.json`](../contracts/deployments/46630-v1.json), [`46630-v1-vaults.json`](../contracts/deployments/46630-v1-vaults.json) |

The source and deploy commits are the `sourceCommit` and `deployCommit` fields of each JSON file. Block times are `cast block <n> --field timestamp`. Arbitrum Sepolia (421614) and Robinhood Chain mainnet (4663) have deploy scripts ([`Deploy.s.sol`](../contracts/script/Deploy.s.sol)) but no deployment.

## Release timeline

| Tag                                                                             | Date       | What changed                                                                                 | On-chain                                 |
| ------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------- | ---------------------------------------- |
| [v0.1.0](https://github.com/Prashant-thakur77/Strike/tree/v0.1.0)               | 2026-09-28 | Skeleton: Foundry, Stylus crate, pnpm workspace, CI                                          |                                          |
| [v0.2.0](https://github.com/Prashant-thakur77/Strike/tree/v0.2.0)               | 2026-09-28 | Core contracts, oracle layer, unit, integration, invariant, fork and differential tests      |                                          |
| [v0.3.0](https://github.com/Prashant-thakur77/Strike/tree/v0.3.0)               | 2026-09-28 | `proposeByDelta` in Stylus and Solidity, ERC-8004 reputation, threat model                   |                                          |
| [v0.4.0](https://github.com/Prashant-thakur77/Strike/tree/v0.4.0)               | 2026-09-28 | SDK, MCP server, example agent, app, subgraph, local demo                                    |                                          |
| [v0.5.0](https://github.com/Prashant-thakur77/Strike/tree/v0.5.0)               | 2026-09-29 | Buyer side, Stylus in the production path, `cargo stylus verify`                             | **v1** deployed (block 125,866,639)      |
| [v0.6.0](https://github.com/Prashant-thakur77/Strike/tree/v0.6.0)               | 2026-09-29 | Internal security review: 11 findings fixed                                                  | **v2** deployed (block 125,880,607)      |
| [v0.7.0](https://github.com/Prashant-thakur77/Strike/tree/v0.7.0)               | 2026-09-30 | Playground, monitor, proof page, Halmos proofs, ERC-8004 identity #114, the first live epoch | Live epoch on v2 (blocks 126,302,119 on) |
| [v0.8.0](https://github.com/Prashant-thakur77/Strike/tree/v0.8.0)               | 2026-09-30 | Self-serve agent onboarding, `SafeStockFeed` as a library for other projects                 |                                          |
| [`v3-contracts`](https://github.com/Prashant-thakur77/Strike/tree/v3-contracts) | 2026-09-30 | Fixes for the known issues (below)                                                           | Not deployed                             |

Dates and contents come from [CHANGELOG.md](../CHANGELOG.md); release dates are the author's local dates, so v1 and v2 show 2026-09-29 while their deploy blocks are timestamped 2026-09-28 UTC. The tag list is `https://api.github.com/repos/Prashant-thakur77/Strike/tags` (v0.1.0 `2c1da5d` to v0.8.0 `11a919b`).

## v2 (current)

Deployed with every fix from the [2026-09-29 internal review](security/review-2026-09-29.md). 14 contracts of our own are verified on Blockscout (the 9 protocol contracts plus 5 testnet `MirrorFeed`s); the two vaults are EIP-1167 clones of the verified implementation; the Stylus pricer is verified with `cargo stylus verify`.

| Contract                             | Address                                                                                                                                         | Blockscout `/api/v2/smart-contracts` says                                                 | Creation tx                                                                                                                         |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| EpochManager                         | [`0x5A3b58DF27e4DD5E0fa6493D90fF653e0E199C99`](https://explorer.testnet.chain.robinhood.com/address/0x5A3b58DF27e4DD5E0fa6493D90fF653e0E199C99) | Verified, `EpochManager`, solc 0.8.30, fully verified 2026-09-28                          | [`0x57b8f66f…`](https://explorer.testnet.chain.robinhood.com/tx/0x57b8f66f10280a007716824b52750ebde1191433203fa7de24ec803ca5ac624d) |
| VaultFactory                         | [`0x5665E02878fA592513C1633af2F07b08cF606beC`](https://explorer.testnet.chain.robinhood.com/address/0x5665E02878fA592513C1633af2F07b08cF606beC) | Verified, `VaultFactory`, solc 0.8.30, fully verified 2026-09-28                          | [`0x5ccacbb6…`](https://explorer.testnet.chain.robinhood.com/tx/0x5ccacbb6f771cb67b078b0e8740003070af7f1588ca0e3cab48952a61bc01a71) |
| StrikeVault implementation           | [`0x900e7C78598C3AbC38FDD411756c38CF7931797D`](https://explorer.testnet.chain.robinhood.com/address/0x900e7C78598C3AbC38FDD411756c38CF7931797D) | Verified, `StrikeVault`, solc 0.8.30, fully verified 2026-09-28                           | [`0x3af8285d…`](https://explorer.testnet.chain.robinhood.com/tx/0x3af8285df9b0c919918fb56f53867ea444ecc6fb9dcf3f730a390f7acc487ad9) |
| TSLA covered-call vault              | [`0xADFF7900dbe01E8170a750AB88e1f4eA8D9D1D4e`](https://explorer.testnet.chain.robinhood.com/address/0xADFF7900dbe01E8170a750AB88e1f4eA8D9D1D4e) | EIP-1167 clone of the implementation above; `/addresses` reports `is_verified: true`      | [`0x8a5da294…`](https://explorer.testnet.chain.robinhood.com/tx/0x8a5da2942eab409d05492427a0b6f2fe85cbdb32cd551dc5df628b43487e8b99) |
| TSLA cash-secured-put vault          | [`0xE33EAD75Df1aF35cBA330f1fc7636926e31c67d7`](https://explorer.testnet.chain.robinhood.com/address/0xE33EAD75Df1aF35cBA330f1fc7636926e31c67d7) | EIP-1167 clone of the implementation above; `/addresses` reports `is_verified: true`      | [`0xd34bbd2d…`](https://explorer.testnet.chain.robinhood.com/tx/0xd34bbd2dd763d6b3a5c90a54f41f020b1270585600507cc472f0544c1509c4d1) |
| Stylus pricer (Rust/WASM)            | [`0x60e947b8d2c2c34b95d88d02f0a06aefb6ccd04c`](https://explorer.testnet.chain.robinhood.com/address/0x60e947b8d2c2c34b95d88d02f0a06aefb6ccd04c) | Not verified on Blockscout (WASM). Verified with `cargo stylus verify` instead, see below | [`0x93fccce0…`](https://explorer.testnet.chain.robinhood.com/tx/0x93fccce03198d72320afc7f613b097450ea4fafad3701bae732b81180ba237fe) |
| BlackScholesRef (Solidity reference) | [`0x4261d47E6487e2533EdB9D5F91242F28121d5A1A`](https://explorer.testnet.chain.robinhood.com/address/0x4261d47E6487e2533EdB9D5F91242F28121d5A1A) | Verified, `BlackScholesRef`, solc 0.8.30, fully verified 2026-09-28                       | [`0x324633ce…`](https://explorer.testnet.chain.robinhood.com/tx/0x324633cebda8d32b398e177653f47cf3e762dd2857864622c7b801e7a1a9a03a) |
| StockOracle                          | [`0x7bb3cAb211E7Ce51e37693E0155C77f477F8aB89`](https://explorer.testnet.chain.robinhood.com/address/0x7bb3cAb211E7Ce51e37693E0155C77f477F8aB89) | Verified, `StockOracle`, solc 0.8.30, fully verified 2026-09-28                           | [`0x5fb075a4…`](https://explorer.testnet.chain.robinhood.com/tx/0x5fb075a43f093b42154bd749de178f3b887c3e7b0acce4221193641c68fb5614) |
| MarketCalendar                       | [`0x214d21F4fCA2226091AF009B9F1BF1D3C63f95F4`](https://explorer.testnet.chain.robinhood.com/address/0x214d21F4fCA2226091AF009B9F1BF1D3C63f95F4) | Verified, `MarketCalendar`, solc 0.8.30, fully verified 2026-09-28                        | [`0x882c7cdd…`](https://explorer.testnet.chain.robinhood.com/tx/0x882c7cddaa5842017fb30a4a0bd0d00b8bd7719961586026b48bdea665c30b6c) |
| AgentRegistry                        | [`0xE5b76249041e59C74Ee317fC2729f26249618D32`](https://explorer.testnet.chain.robinhood.com/address/0xE5b76249041e59C74Ee317fC2729f26249618D32) | Verified, `AgentRegistry`, solc 0.8.30, fully verified 2026-09-28                         | [`0x16ce2f7f…`](https://explorer.testnet.chain.robinhood.com/tx/0x16ce2f7f4e86150af13457576559848725e9693c9f27ccfdf8dc083890a7f041) |
| FeeManager                           | [`0x6b23819bC44EEbE1BD004208c0F00f2ed002B621`](https://explorer.testnet.chain.robinhood.com/address/0x6b23819bC44EEbE1BD004208c0F00f2ed002B621) | Verified, `FeeManager`, solc 0.8.30, fully verified 2026-09-28                            | [`0xe718748c…`](https://explorer.testnet.chain.robinhood.com/tx/0xe718748c7b979d29f4345dfb3caad354dc230a82aa84ea4ad93bb25fb324b689) |
| OptionToken (ERC-1155)               | [`0x557060266F4aE09ae723541AC8E7E27A99B0c9DB`](https://explorer.testnet.chain.robinhood.com/address/0x557060266F4aE09ae723541AC8E7E27A99B0c9DB) | Verified, `OptionToken`, solc 0.8.30, fully verified 2026-09-28                           | [`0x0ba72ba8…`](https://explorer.testnet.chain.robinhood.com/tx/0x0ba72ba893a067c755621c4c7269d1a0bece482744b1630b0876099cbe1fb3a4) |
| AMD MirrorFeed                       | [`0xf7f60670f8D45a648b2844aF1d25c2C6C02ffA4E`](https://explorer.testnet.chain.robinhood.com/address/0xf7f60670f8D45a648b2844aF1d25c2C6C02ffA4E) | Verified, `MirrorFeed`, solc 0.8.30, fully verified 2026-09-28                            | [`0x709c12d3…`](https://explorer.testnet.chain.robinhood.com/tx/0x709c12d31f52d6c25bc325ea43b622c719be9753043afe4d9ec8fe6fd3275c97) |
| AMZN MirrorFeed                      | [`0x698a624940DdAfA8380dbF933AbC1c2908796877`](https://explorer.testnet.chain.robinhood.com/address/0x698a624940DdAfA8380dbF933AbC1c2908796877) | Verified, `MirrorFeed`, solc 0.8.30, fully verified 2026-09-28                            | [`0x4e7968f0…`](https://explorer.testnet.chain.robinhood.com/tx/0x4e7968f040646f19848d277c4beaff4cdc0d46c18c930c11699afec49974921e) |
| NFLX MirrorFeed                      | [`0xc7e34AC0E39663b580Fe044c04F2b7aa7949b30D`](https://explorer.testnet.chain.robinhood.com/address/0xc7e34AC0E39663b580Fe044c04F2b7aa7949b30D) | Verified, `MirrorFeed`, solc 0.8.30, fully verified 2026-09-28                            | [`0x6c6acfda…`](https://explorer.testnet.chain.robinhood.com/tx/0x6c6acfda1130f605519b21c7262ffcc27b4355a8184eed4f06635dd148a2b0e0) |
| PLTR MirrorFeed                      | [`0x2992a2661f4eb802EFF63a985914a80D262c5291`](https://explorer.testnet.chain.robinhood.com/address/0x2992a2661f4eb802EFF63a985914a80D262c5291) | Verified, `MirrorFeed`, solc 0.8.30, fully verified 2026-09-28                            | [`0xacb1fe60…`](https://explorer.testnet.chain.robinhood.com/tx/0xacb1fe6088811472fc0008d2affad4600223b2d966679942ef9eccb5beccb4b3) |
| TSLA MirrorFeed                      | [`0x5476cb08769f406dE95F6171AcC1F5FE88431230`](https://explorer.testnet.chain.robinhood.com/address/0x5476cb08769f406dE95F6171AcC1F5FE88431230) | Verified, `MirrorFeed`, solc 0.8.30, fully verified 2026-09-28                            | [`0xf3f48b3d…`](https://explorer.testnet.chain.robinhood.com/tx/0xf3f48b3da8a86ee6ba5d71743738418ba00bdaeda67975daac9197ab520975f8) |

### Active pricer

`cast call 0x5A3b58DF27e4DD5E0fa6493D90fF653e0E199C99 "pricer()(address)"` returns `0x60E947b8d2c2C34b95d88d02F0A06AeFb6Ccd04C`, the Stylus pricer. The `pricer` field of `46630.json` is the Solidity `BlackScholesRef`, kept for the on-chain equality check before the switch (`activePricerNote` in the JSON).

### Stylus pricer verification

The pricer was deployed in tx [`0x93fccce0…37fe`](https://explorer.testnet.chain.robinhood.com/tx/0x93fccce03198d72320afc7f613b097450ea4fafad3701bae732b81180ba237fe) (block 125,868,911, 2026-09-28 20:23 UTC) from a reproducible Docker build (cargo-stylus 0.10.9, Rust 1.91.0). `cargo stylus verify` rebuilds `stylus/pricer` from this repository and reports **Verification successful**, project metadata hash `5773190b3eed71771269cdaa28bfd562adc3bc8888ddb49e2b901cf4ceca7045`, 15,574 bytes ([docs/gas.md](gas.md#the-live-stylus-pricer-is-verifiably-this-source)). `cast codesize` on the address returns 15574 today. Blockscout lists the address as a contract without verified source, because it verifies Solidity and Vyper, not WASM.

### Live transactions

The first agent-run epoch ([log](testnet-epochs/2026-09-29.md)). Block numbers and times from `cast receipt` and `cast block`; every receipt has `status: 1`.

| Time (UTC)       | Block       | Step                                                                   | Transaction                                                                                                                             |
| ---------------- | ----------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-29 17:08 | 126,302,119 | Put vault collateral, 20 USDG                                          | [`0x001cbf63…6498`](https://explorer.testnet.chain.robinhood.com/tx/0x001cbf637009addbe13bb20e7c6ad5bdaf10f149cb1fc66a99a7afe599696498) |
| 2026-09-29 17:08 | 126,302,279 | Seller agent opens the covered-call epoch                              | [`0x475be822…c5a5`](https://explorer.testnet.chain.robinhood.com/tx/0x475be822c2a68c194999148e2c52d2ab134d74bb19fc235fe0b509a5333fc5a5) |
| 2026-09-29 17:09 | 126,302,301 | `proposeByDelta` accepted: 0.20-delta TSLA call, strike $369.86        | [`0x92169eac…a9d4`](https://explorer.testnet.chain.robinhood.com/tx/0x92169eac7bd2491d1f22f394e15643d5d54309c1e980683cf82a13088021a9d4) |
| 2026-09-29 17:09 | 126,302,426 | Reckless agent opens the put epoch                                     | [`0x5aea0d20…518f`](https://explorer.testnet.chain.robinhood.com/tx/0x5aea0d2022f0a83d480c64014273a21d8e47c932ed0aaff46227a2f8f13e518f) |
| 2026-09-29 17:09 | 126,302,448 | At-the-money put rejected (`DeltaOutOfBand`), 10 USDG slashed          | [`0x3df523aa…c6a0`](https://explorer.testnet.chain.robinhood.com/tx/0x3df523aae815e10cba8f5f99076f9cb348745e7657dd1f1338820af0469dc6a0) |
| 2026-09-29 17:09 | 126,302,569 | Buyer agent buys 4 calls for 10.005944 USDG                            | [`0x425e5b63…e9f9`](https://explorer.testnet.chain.robinhood.com/tx/0x425e5b63ddeb1fcff5d63aa9f5a9fd11f4d3c0f52facd05e0fb44096f2ede9f9) |
| 2026-09-29 19:51 | 126,358,479 | Agent #1 registered on the ERC-8004 Identity Registry as #114          | [`0x3bb9cad3…7e53`](https://explorer.testnet.chain.robinhood.com/tx/0x3bb9cad397322da84adbf78fda288dcce9a19318798b63178467899cdf9c7e53) |
| 2026-09-29 19:51 | 126,358,500 | `AgentRegistry.setIdentity`: agent #1 linked to #114                   | [`0x324e0886…5125`](https://explorer.testnet.chain.robinhood.com/tx/0x324e08868492d51986b3da6142031e39ffbb67dcda5a4dbc2613205f35a87125) |
| 2026-09-29 21:24 | 126,385,117 | `abortEpoch` pays the slashed 10 USDG to the put vault (20 to 30 USDG) | [`0x62442f37…29a7`](https://explorer.testnet.chain.robinhood.com/tx/0x62442f37b3601aa5b56d5e991d3199464ba2e60373f70e00892746c053b629a7) |

The covered-call series expires at the NYSE close on Friday 2026-10-02 (20:00 UTC); its settlement will be added here.

### ERC-8004 identity #114

| Check                                                                                | Result on 2026-09-30                                                                                           |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `ownerOf(114)` on the Identity Registry `0x8004A818BFB912233c491871b3d84c89A494BD9e` | `0x26b277b434B1670f207Afd8946edA9AF78A613Ff` (the deployer and agent #1's owner)                               |
| `AgentRegistry.getAgent(1)` on v2                                                    | owner and signer `0x26b2…13Ff`, status Active, 1 strike, 1 accepted, 1 rejected, `erc8004Id` 114, bond 50 USDG |
| Registration file                                                                    | [docs/agents/strike-agent-1.json](agents/strike-agent-1.json)                                                  |
| Reputation Registry                                                                  | `0x8004B663056A597Dffe9eCcC1965A193B7388713`                                                                   |

### State after the live epoch

| Read                                 | Result                                          |
| ------------------------------------ | ----------------------------------------------- |
| USDG `balanceOf(put vault)`          | 30,000,000 (30 USDG: 20 deposited + 10 slashed) |
| TSLA `balanceOf(covered-call vault)` | 5 × 10¹⁸ (5 TSLA)                               |

### Tokens and feeds we use but did not deploy

| Contract         | Address                                                                                                                                         | Blockscout says                         |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| USDG (Paxos)     | [`0x7E955252E15c84f5768B83c41a71F9eba181802F`](https://explorer.testnet.chain.robinhood.com/address/0x7E955252E15c84f5768B83c41a71F9eba181802F) | Verified `ERC1967Proxy` (eip1967 proxy) |
| AMD stock token  | [`0x71178BAc73cBeb415514eB542a8995b82669778d`](https://explorer.testnet.chain.robinhood.com/address/0x71178BAc73cBeb415514eB542a8995b82669778d) | Verified `BeaconProxy` (eip1967_beacon) |
| AMZN stock token | [`0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02`](https://explorer.testnet.chain.robinhood.com/address/0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02) | Verified `BeaconProxy` (eip1967_beacon) |
| NFLX stock token | [`0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93`](https://explorer.testnet.chain.robinhood.com/address/0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93) | Verified `BeaconProxy` (eip1967_beacon) |
| PLTR stock token | [`0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0`](https://explorer.testnet.chain.robinhood.com/address/0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0) | Verified `BeaconProxy` (eip1967_beacon) |
| TSLA stock token | [`0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E`](https://explorer.testnet.chain.robinhood.com/address/0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E) | Verified `BeaconProxy` (eip1967_beacon) |

### DecisionLog (additive, deployed 2026-09-30)

A separate contract next to v2 that anchors agents' decision records on-chain: `record(agentId, vault, epoch, recordHash, uri)`, callable only by `AgentRegistry.signerOf(agentId)` of the live v2 registry, emitting `DecisionRecorded` and keeping the latest hash per (agent, vault, epoch). It changes nothing in v2: no v2 contract knows about it ([decisions.md D35](decisions.md)). Source [`contracts/src/agents/DecisionLog.sol`](../contracts/src/agents/DecisionLog.sol), deploy script [`DeployDecisionLog.s.sol`](../contracts/script/DeployDecisionLog.s.sol); the address is `decisionLog` in [`46630.json`](../contracts/deployments/46630.json).

| Contract    | Address                                                                                                                                         | Blockscout `/api/v2/smart-contracts` says                       | Creation tx                                                                                                                         |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| DecisionLog | [`0xbF94f54fd0258ac59e2f54B70754dFAfFd245D93`](https://explorer.testnet.chain.robinhood.com/address/0xbF94f54fd0258ac59e2f54B70754dFAfFd245D93) | Verified, `DecisionLog`, solc 0.8.30, fully verified 2026-09-30 | [`0x9b2e902c…`](https://explorer.testnet.chain.robinhood.com/tx/0x9b2e902c16ef74f8f1180ecc5514cbcda3c1c5076a086e3a60e2da06a568665d) |

Deployed in block 126,698,227 (2026-09-30 12:51 UTC); `registry()` returns the v2 AgentRegistry `0xE5b76249041e59C74Ee317fC2729f26249618D32`.

The first anchor is the live epoch's own log: agent #1's signer recorded keccak256 of [docs/testnet-epochs/2026-09-29.md](testnet-epochs/2026-09-29.md) (the file's first 8,549 bytes, everything before its "Anchored on-chain" section) for the covered-call vault, epoch 1, with its GitHub URL.

| Time (UTC)       | Block       | Step                                                                                                 | Transaction                                                                                                                             |
| ---------------- | ----------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-30 12:54 | 126,699,329 | `DecisionLog.record(1, covered-call vault, 1, 0xffd051c8…bc5a, …/docs/testnet-epochs/2026-09-29.md)` | [`0x934ab96b…24c4`](https://explorer.testnet.chain.robinhood.com/tx/0x934ab96ba12a9ad501e20c8366fc338ab35d0550b88cc2d76fc5c39991c524c4) |

From here on the weekly agent workflow anchors each record it writes to `docs/agent-log` (`--anchor`); the record's JSON carries the anchor and its transaction.

## v1 (superseded)

Deployed before the internal review. Kept for its history; its `EpochManager.pricer()` also returns the Stylus pricer. Do not use it.

| Contract                             | Address                                                                                                                                         | Blockscout `/api/v2/smart-contracts` says                                                 | Creation tx                                                                                                                         |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| EpochManager                         | [`0xB8Ed17588AB022d8f84b8305d784Fa01478Cb7F0`](https://explorer.testnet.chain.robinhood.com/address/0xB8Ed17588AB022d8f84b8305d784Fa01478Cb7F0) | Verified, `EpochManager`, solc 0.8.30, fully verified 2026-09-28                          | [`0x545472aa…`](https://explorer.testnet.chain.robinhood.com/tx/0x545472aa120fc9c70d4215e77718c64bc6115aae03143f3972015ae297201731) |
| VaultFactory                         | [`0x9DbaFfD488FC591947149E2b27189A201C0a74f4`](https://explorer.testnet.chain.robinhood.com/address/0x9DbaFfD488FC591947149E2b27189A201C0a74f4) | Verified, `VaultFactory`, solc 0.8.30, fully verified 2026-09-28                          | [`0x41769e8f…`](https://explorer.testnet.chain.robinhood.com/tx/0x41769e8f6c01bd78b7c7b8e6a0aa41722744c8f36fe895dfc4362fa2e467b1fa) |
| StrikeVault implementation           | [`0x5Fe632C9F6Df4ECb11dfef5a6112154379BCd197`](https://explorer.testnet.chain.robinhood.com/address/0x5Fe632C9F6Df4ECb11dfef5a6112154379BCd197) | Verified, `StrikeVault`, solc 0.8.30, fully verified 2026-09-28                           | [`0x38efaad9…`](https://explorer.testnet.chain.robinhood.com/tx/0x38efaad97f9a759264361baed7c6bf06035f372bcd80890560661add1446220a) |
| TSLA covered-call vault              | [`0x5655659E18bf54ee0EF8f6A816E2e18D000F7311`](https://explorer.testnet.chain.robinhood.com/address/0x5655659E18bf54ee0EF8f6A816E2e18D000F7311) | EIP-1167 clone of the implementation above; `/addresses` reports `is_verified: true`      | [`0x5a7f449f…`](https://explorer.testnet.chain.robinhood.com/tx/0x5a7f449fb5286ff832967f12891c0820465adf00ad8d2de8516d82625ed456f2) |
| TSLA cash-secured-put vault          | [`0x02B701210aA006CEAbd389dBc32af0047B1B9bbe`](https://explorer.testnet.chain.robinhood.com/address/0x02B701210aA006CEAbd389dBc32af0047B1B9bbe) | EIP-1167 clone of the implementation above; `/addresses` reports `is_verified: true`      | [`0xf9ba9a10…`](https://explorer.testnet.chain.robinhood.com/tx/0xf9ba9a10aca23e395c9fe9b5f3ad90cf3f40d896090d819afb781f1ae32b31a0) |
| Stylus pricer (Rust/WASM)            | [`0x60e947b8d2c2c34b95d88d02f0a06aefb6ccd04c`](https://explorer.testnet.chain.robinhood.com/address/0x60e947b8d2c2c34b95d88d02f0a06aefb6ccd04c) | Not verified on Blockscout (WASM). Verified with `cargo stylus verify` instead, see below | [`0x93fccce0…`](https://explorer.testnet.chain.robinhood.com/tx/0x93fccce03198d72320afc7f613b097450ea4fafad3701bae732b81180ba237fe) |
| BlackScholesRef (Solidity reference) | [`0x79A4158900579FA0eE5b413B4724D010C8a0A8E2`](https://explorer.testnet.chain.robinhood.com/address/0x79A4158900579FA0eE5b413B4724D010C8a0A8E2) | Verified, `BlackScholesRef`, solc 0.8.30, fully verified 2026-09-28                       | [`0xbfbba8b4…`](https://explorer.testnet.chain.robinhood.com/tx/0xbfbba8b40f170d8fe0b8473595dccd01c796ff2e2b3cdfb64b47c851e82b84ed) |
| StockOracle                          | [`0x8B89A4dE3d8E74888e0135CCBeE5eE00Df36bA9F`](https://explorer.testnet.chain.robinhood.com/address/0x8B89A4dE3d8E74888e0135CCBeE5eE00Df36bA9F) | Verified, `StockOracle`, solc 0.8.30, fully verified 2026-09-28                           | [`0xd46213fe…`](https://explorer.testnet.chain.robinhood.com/tx/0xd46213feab680bf54ccac33ba77623636ee86432cf75020724254cbbcfebc909) |
| MarketCalendar                       | [`0xefD1121ef13F1187F9ac9A54076DFa09A586d31D`](https://explorer.testnet.chain.robinhood.com/address/0xefD1121ef13F1187F9ac9A54076DFa09A586d31D) | Verified, `MarketCalendar`, solc 0.8.30, fully verified 2026-09-28                        | [`0xcd6f061b…`](https://explorer.testnet.chain.robinhood.com/tx/0xcd6f061b585dd71bd194ec0854f84006014b08956436e90ea75b93f5bef022dd) |
| AgentRegistry                        | [`0xAa3CA7847Af10d94CCD3eF09370Aab580A92341E`](https://explorer.testnet.chain.robinhood.com/address/0xAa3CA7847Af10d94CCD3eF09370Aab580A92341E) | Verified, `AgentRegistry`, solc 0.8.30, fully verified 2026-09-28                         | [`0x6865ddee…`](https://explorer.testnet.chain.robinhood.com/tx/0x6865ddeef4829efe8672b42331f8480a3b03b6f479c887af547453c18850a7b7) |
| FeeManager                           | [`0xaD2C4aC0db613F2c7e3F060Bfdd1276912154569`](https://explorer.testnet.chain.robinhood.com/address/0xaD2C4aC0db613F2c7e3F060Bfdd1276912154569) | Verified, `FeeManager`, solc 0.8.30, fully verified 2026-09-28                            | [`0x774a72b5…`](https://explorer.testnet.chain.robinhood.com/tx/0x774a72b5d2471b07208d9b4e9da84f921eb1d9ef61948ff86d3f1290306bb2f1) |
| OptionToken (ERC-1155)               | [`0x63614FB8594F0C24CfB8F419326eB3BA7C3274A7`](https://explorer.testnet.chain.robinhood.com/address/0x63614FB8594F0C24CfB8F419326eB3BA7C3274A7) | Verified, `OptionToken`, solc 0.8.30, fully verified 2026-09-28                           | [`0xdf62b72a…`](https://explorer.testnet.chain.robinhood.com/tx/0xdf62b72a5ad294b46549801920791b504c58c8ae7a264b8347bbd938aa73902b) |
| AMD MirrorFeed                       | [`0x726a9c2a36Eb8511CB067A4FB06B49efB279eE1b`](https://explorer.testnet.chain.robinhood.com/address/0x726a9c2a36Eb8511CB067A4FB06B49efB279eE1b) | Verified, `MirrorFeed`, solc 0.8.30, fully verified 2026-09-28                            | [`0x0eb43dd3…`](https://explorer.testnet.chain.robinhood.com/tx/0x0eb43dd300678cf1f45d5a4c412dc7508195f7f3ce710eda901998d8125b51e2) |
| AMZN MirrorFeed                      | [`0x1bE23389861F38FAdf8120134b967f7a991Daa82`](https://explorer.testnet.chain.robinhood.com/address/0x1bE23389861F38FAdf8120134b967f7a991Daa82) | Verified, `MirrorFeed`, solc 0.8.30, fully verified 2026-09-28                            | [`0x9d1d7851…`](https://explorer.testnet.chain.robinhood.com/tx/0x9d1d7851a1fa26ae659ec18a1935b98e8c7a8924eeb1679031fe8386e22a4a3a) |
| NFLX MirrorFeed                      | [`0xaA6D2cfE7ad546499dddedFb0c96F88bA75439A5`](https://explorer.testnet.chain.robinhood.com/address/0xaA6D2cfE7ad546499dddedFb0c96F88bA75439A5) | Verified, `MirrorFeed`, solc 0.8.30, fully verified 2026-09-28                            | [`0xb13cdadc…`](https://explorer.testnet.chain.robinhood.com/tx/0xb13cdadca76570bb8f2c609f9d880f755c9295fc5c76c3efa1d9220013c7b3cf) |
| PLTR MirrorFeed                      | [`0x7C6A9F05D52d8D10624522973258B28D87756Ff9`](https://explorer.testnet.chain.robinhood.com/address/0x7C6A9F05D52d8D10624522973258B28D87756Ff9) | Verified, `MirrorFeed`, solc 0.8.30, fully verified 2026-09-28                            | [`0xf2de94b1…`](https://explorer.testnet.chain.robinhood.com/tx/0xf2de94b14942ad78e9cfaecedf19b518676817c95dbd3e6815007339f8fb390f) |
| TSLA MirrorFeed                      | [`0x8401bcb990005fCEB1390C0b10dA5bE283d6cC0F`](https://explorer.testnet.chain.robinhood.com/address/0x8401bcb990005fCEB1390C0b10dA5bE283d6cC0F) | Verified, `MirrorFeed`, solc 0.8.30, fully verified 2026-09-28                            | [`0xb27d82dc…`](https://explorer.testnet.chain.robinhood.com/tx/0xb27d82dc4e6e8c59dc5dfdcd6074390d8310324dfc3f3e218049add8e6ba50c5) |

v1 vault owner and agent signer: `0x26b277b434B1670f207Afd8946edA9AF78A613Ff`, agent id 1 ([`46630-v1-vaults.json`](../contracts/deployments/46630-v1-vaults.json)).

## v3 (branch, not deployed)

The [`v3-contracts`](https://github.com/Prashant-thakur77/Strike/tree/v3-contracts) branch (head `52e01d8`, 2026-09-30 04:43 UTC, from the GitHub API) holds the fixes for the known issues: a per-vault fee high-water mark, EIP-712 signer consent for `register` and `setSigner`, an active-agent check on vault registration, and `InvalidMandate(reason)`. The branch's own description reports 475 Foundry tests, a fee high-water-mark invariant and 3 more Halmos-proven properties ([design notes](https://github.com/Prashant-thakur77/Strike/blob/v3-contracts/docs/design.md)); those counts were not re-run for this page. It stays undeployed until the v2 testnet run ends, so the live epoch history stays on one set of contracts.

## Reviewer's checklist

Each claim above, with the command that checks it. No keys needed.

```bash
RPC=https://rpc.testnet.chain.robinhood.com
API=https://explorer.testnet.chain.robinhood.com/api/v2

# 1. The deploy blocks and their times
cast block 125880607 --field timestamp --rpc-url $RPC   # v2: 1790629879 = 2026-09-28 21:11:19 UTC
cast block 125866639 --field timestamp --rpc-url $RPC   # v1: 1790626477 = 2026-09-28 20:14:37 UTC

# 2. Verification status of any address (repeat for each row above)
curl -s $API/smart-contracts/0x5A3b58DF27e4DD5E0fa6493D90fF653e0E199C99 | jq '{name, is_verified, is_fully_verified, compiler_version}'
curl -s $API/addresses/0xADFF7900dbe01E8170a750AB88e1f4eA8D9D1D4e | jq '{proxy_type, is_verified, implementations}'

# 3. The active pricer is the Stylus program
cast call 0x5A3b58DF27e4DD5E0fa6493D90fF653e0E199C99 "pricer()(address)" --rpc-url $RPC
cast codesize 0x60e947b8d2c2c34b95d88d02f0a06aefb6ccd04c --rpc-url $RPC          # 15574

# 4. The Stylus program is this repository's source (needs Docker)
cd stylus/pricer && cargo stylus verify \
  --deployment-tx 0x93fccce03198d72320afc7f613b097450ea4fafad3701bae732b81180ba237fe \
  --endpoint $RPC

# 5. Each live transaction succeeded, and in which block
cast receipt 0x3df523aae815e10cba8f5f99076f9cb348745e7657dd1f1338820af0469dc6a0 status --rpc-url $RPC   # the slash
cast receipt 0x62442f37b3601aa5b56d5e991d3199464ba2e60373f70e00892746c053b629a7 status --rpc-url $RPC   # paid to depositors

# 6. ERC-8004 identity #114 and its link
cast call 0x8004A818BFB912233c491871b3d84c89A494BD9e "ownerOf(uint256)(address)" 114 --rpc-url $RPC
cast call 0xE5b76249041e59C74Ee317fC2729f26249618D32 \
  "getAgent(uint256)((address,address,address,uint8,uint32,uint32,uint32,uint64,uint256,uint256,uint256))" 1 --rpc-url $RPC

# 7. The slash reached the depositors: 30 USDG in the put vault
cast call 0x7E955252E15c84f5768B83c41a71F9eba181802F "balanceOf(address)(uint256)" 0xE33EAD75Df1aF35cBA330f1fc7636926e31c67d7 --rpc-url $RPC

# 8. The source and deploy commits
jq '{version, sourceCommit, deployCommit, block, activePricer}' contracts/deployments/46630.json contracts/deployments/46630-v1.json

# 9. DecisionLog: verified, wired to the v2 registry, and the first anchor matches the epoch log
curl -s $API/smart-contracts/0xbF94f54fd0258ac59e2f54B70754dFAfFd245D93 | jq '{name, is_verified, compiler_version}'
cast call 0xbF94f54fd0258ac59e2f54B70754dFAfFd245D93 "registry()(address)" --rpc-url $RPC
cast call 0xbF94f54fd0258ac59e2f54B70754dFAfFd245D93 "latestHash(uint256,address,uint64)(bytes32)" \
  1 0xADFF7900dbe01E8170a750AB88e1f4eA8D9D1D4e 1 --rpc-url $RPC
head -c 8549 docs/testnet-epochs/2026-09-29.md | cast keccak   # the same hash: 0xffd051c8…bc5a
```

Or open the [proof page](../app/src/components/app/proof/ProofPage.tsx) (`/app/proof`), which reads the active pricer and the activity feed from the chain when it loads.
