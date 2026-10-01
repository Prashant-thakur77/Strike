# Strike v3 on Arbitrum Sepolia, 2026-09-30

v3 from the [`v3-contracts`](https://github.com/Prashant-thakur77/Strike/tree/v3-contracts) branch is deployed on Arbitrum Sepolia (chain id 421614), the same contracts that run on Robinhood Chain testnet ([log](2026-09-30-v3.md)). One live epoch ran during NYSE hours on Wednesday: Claude planned the covered call and agent #1 proposed it on-chain, the contract rejected an out-of-mandate put and slashed the bond, and a separate buyer wallet bought the calls. The series expires at the NYSE close on Friday 2026-10-02 (20:00 UTC). Addresses: [`421614.json`](../../contracts/deployments/421614.json) (also on the branch); the table is in [DEPLOYMENTS.md](../DEPLOYMENTS.md#v3-on-arbitrum-sepolia-2026-09-30). Why a second chain: [decisions.md D37](../decisions.md).

Explorer links go to Arbiscan (`sepolia.arbiscan.io`) for transactions and addresses. We have no Arbiscan API key, so the verified source is on Blockscout (`arbitrum-sepolia.blockscout.com`) and Sourcify.

## 1. Contracts

Deployed with `forge script script/Deploy.s.sol --broadcast --slow --skip-simulation --verify --verifier blockscout --verifier-url https://arbitrum-sepolia.blockscout.com/api/` from [`ebe139e`](https://github.com/Prashant-thakur77/Strike/commit/ebe139e), which only adds a deploy option to the script. The contract source is the same as on Robinhood Chain testnet ([`6e43348`](https://github.com/Prashant-thakur77/Strike/commit/6e43348)). The 421614 configuration was already in `Deploy.s.sol`:

- **USDG:** the real Sepolia USDG (Paxos) at [`0xFFC95faa…1892`](https://sepolia.arbiscan.io/address/0xFFC95faa3d63Cde504a05B567C600B78C0b41892), 6 decimals.
- **Stocks:** TSLA and NVDA are `TestStockToken`s with a faucet (10 tokens per address per day), because Robinhood's stock tokens do not exist on Arbitrum Sepolia.
- **Feeds:** one `MirrorFeed` per stock, filled by `scripts/keeper.sh` from the Robinhood Chain mainnet Chainlink feeds.
- **Seed round:** the new `SEED_<SYMBOL>`/`SEED_AT_<SYMBOL>` option seeded each feed with the mainnet round that was current at deploy time: TSLA 350.23 at 1790783341 (16:09:01 UTC, feed `0x4A1166a6…7C38`) and NVDA 230.54857341 at 1790777357. Without it the feed would start at the script's placeholder price, stamped with the deploy time, and the keeper could not push the older real round after it (`StaleUpdate`).
- `DEPLOYMENT_NAME=421614`. This chain has no older version, so the file is `421614.json`, the name `Seed.s.sol`, `keeper.sh` and the SDK read without changes.

The deploy sent 33 transactions in L2 blocks 314,350,623 to 314,351,025 (16:31:41 to 16:33:23 UTC). Every receipt has `status: 1`, and the whole deploy cost 0.000779 ETH. On Arbitrum `block.number` is the L1 block, so the script wrote `"block": 11815871`. The JSON keeps that value as `l1Block`, and `block` holds the L2 deploy block, where event scans start.

**Verification.** Blockscout rate-limited the run ("Too many requests"), so it verified 3 of 14 contracts at first. A slower retry of `forge verify-contract --verifier blockscout --guess-constructor-args` finished the rest. The two `TestStockToken`s kept hitting the limit, so they were verified on Sourcify instead (`--verifier sourcify`, `exact_match`), and Blockscout has since picked them up. All 14 contracts, plus the DecisionLog (section 4), return `is_verified: true` from `https://arbitrum-sepolia.blockscout.com/api/v2/smart-contracts/<address>`, solc 0.8.30. All but the two `MirrorFeed`s are also `is_fully_verified: true`. The MirrorFeeds are a partial match: the bytecode matches and the metadata hash does not.

| Contract                             | Address (Arbiscan)                                                                                                             | Verified source                                                                                                                                                                                                              | Creation tx                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| EpochManager                         | [`0xB8Ed17588AB022d8f84b8305d784Fa01478Cb7F0`](https://sepolia.arbiscan.io/address/0xB8Ed17588AB022d8f84b8305d784Fa01478Cb7F0) | [Blockscout](https://arbitrum-sepolia.blockscout.com/address/0xB8Ed17588AB022d8f84b8305d784Fa01478Cb7F0?tab=contract)                                                                                                        | [`0x4fc7fb01…`](https://sepolia.arbiscan.io/tx/0x4fc7fb012e7b84ad1ca542a1d15724350aa34a61a2a0dc4b74806a91d823782a) |
| VaultFactory                         | [`0x9DbaFfD488FC591947149E2b27189A201C0a74f4`](https://sepolia.arbiscan.io/address/0x9DbaFfD488FC591947149E2b27189A201C0a74f4) | [Blockscout](https://arbitrum-sepolia.blockscout.com/address/0x9DbaFfD488FC591947149E2b27189A201C0a74f4?tab=contract)                                                                                                        | [`0xcb3b7822…`](https://sepolia.arbiscan.io/tx/0xcb3b7822c1f28aaf25cacf258157aab872808cefbbc87dd5052f55abf8e88998) |
| StrikeVault implementation           | [`0x5Fe632C9F6Df4ECb11dfef5a6112154379BCd197`](https://sepolia.arbiscan.io/address/0x5Fe632C9F6Df4ECb11dfef5a6112154379BCd197) | [Blockscout](https://arbitrum-sepolia.blockscout.com/address/0x5Fe632C9F6Df4ECb11dfef5a6112154379BCd197?tab=contract)                                                                                                        | [`0x9a467b16…`](https://sepolia.arbiscan.io/tx/0x9a467b1605c67d7ee481a1261711c382ddd115857529c744bca631dc1087d415) |
| AgentRegistry (EIP-712 consent)      | [`0xAa3CA7847Af10d94CCD3eF09370Aab580A92341E`](https://sepolia.arbiscan.io/address/0xAa3CA7847Af10d94CCD3eF09370Aab580A92341E) | [Blockscout](https://arbitrum-sepolia.blockscout.com/address/0xAa3CA7847Af10d94CCD3eF09370Aab580A92341E?tab=contract)                                                                                                        | [`0x53b97a21…`](https://sepolia.arbiscan.io/tx/0x53b97a2148bce5dad56cd8b0be945839423c54400bc16b0b2601dd9dd215dc66) |
| StockOracle                          | [`0x8B89A4dE3d8E74888e0135CCBeE5eE00Df36bA9F`](https://sepolia.arbiscan.io/address/0x8B89A4dE3d8E74888e0135CCBeE5eE00Df36bA9F) | [Blockscout](https://arbitrum-sepolia.blockscout.com/address/0x8B89A4dE3d8E74888e0135CCBeE5eE00Df36bA9F?tab=contract)                                                                                                        | [`0xf80fd1e1…`](https://sepolia.arbiscan.io/tx/0xf80fd1e1db40677ed1d472ddffb0f99fd2d7f4e25954f491f294c263ecd3c5ad) |
| MarketCalendar                       | [`0xefD1121ef13F1187F9ac9A54076DFa09A586d31D`](https://sepolia.arbiscan.io/address/0xefD1121ef13F1187F9ac9A54076DFa09A586d31D) | [Blockscout](https://arbitrum-sepolia.blockscout.com/address/0xefD1121ef13F1187F9ac9A54076DFa09A586d31D?tab=contract)                                                                                                        | [`0x1f2caf2f…`](https://sepolia.arbiscan.io/tx/0x1f2caf2f3268cdbaaa5facf9f5931adbbf0cbecfd11048459fca20af74f30525) |
| BlackScholesRef (Solidity reference) | [`0x79A4158900579FA0eE5b413B4724D010C8a0A8E2`](https://sepolia.arbiscan.io/address/0x79A4158900579FA0eE5b413B4724D010C8a0A8E2) | [Blockscout](https://arbitrum-sepolia.blockscout.com/address/0x79A4158900579FA0eE5b413B4724D010C8a0A8E2?tab=contract)                                                                                                        | [`0x966ce518…`](https://sepolia.arbiscan.io/tx/0x966ce5189aa0e4f1c044e56eb3d37b3cc37bc40080a171a0d57373c7cef56320) |
| FeeManager (high-water mark)         | [`0xaD2C4aC0db613F2c7e3F060Bfdd1276912154569`](https://sepolia.arbiscan.io/address/0xaD2C4aC0db613F2c7e3F060Bfdd1276912154569) | [Blockscout](https://arbitrum-sepolia.blockscout.com/address/0xaD2C4aC0db613F2c7e3F060Bfdd1276912154569?tab=contract)                                                                                                        | [`0x86b33ea8…`](https://sepolia.arbiscan.io/tx/0x86b33ea8302b12f041ce1f9e4638ae930db61a4c2a6a1c25d952e5810726ee14) |
| OptionToken (ERC-1155)               | [`0x63614FB8594F0C24CfB8F419326eB3BA7C3274A7`](https://sepolia.arbiscan.io/address/0x63614FB8594F0C24CfB8F419326eB3BA7C3274A7) | [Blockscout](https://arbitrum-sepolia.blockscout.com/address/0x63614FB8594F0C24CfB8F419326eB3BA7C3274A7?tab=contract)                                                                                                        | [`0x4e14c5be…`](https://sepolia.arbiscan.io/tx/0x4e14c5bed61aa05d361e00f563f7561de3b072859c5094f0b90f687877057757) |
| RiskLens                             | [`0x94aC10fF1A71ceBfD825079aaf897858a9953ecE`](https://sepolia.arbiscan.io/address/0x94aC10fF1A71ceBfD825079aaf897858a9953ecE) | [Blockscout](https://arbitrum-sepolia.blockscout.com/address/0x94aC10fF1A71ceBfD825079aaf897858a9953ecE?tab=contract)                                                                                                        | [`0x62d9272a…`](https://sepolia.arbiscan.io/tx/0x62d9272aef9d90543a96bff5cf9037fcb62233a1bf513598e03d00b62203fafe) |
| TSLA TestStockToken (faucet)         | [`0x2EbdbAe172d733f96F9742A7e319e311E552BF37`](https://sepolia.arbiscan.io/address/0x2EbdbAe172d733f96F9742A7e319e311E552BF37) | [Sourcify](https://repo.sourcify.dev/421614/0x2EbdbAe172d733f96F9742A7e319e311E552BF37) (exact match), [Blockscout](https://arbitrum-sepolia.blockscout.com/address/0x2EbdbAe172d733f96F9742A7e319e311E552BF37?tab=contract) | [`0xba3caab5…`](https://sepolia.arbiscan.io/tx/0xba3caab56a8ccb9d5982d2cc0dce3bff3671f485080198b8512927deddc5c614) |
| TSLA MirrorFeed                      | [`0x85B92cF975E3cf9Ad44c0664d6aF67f358360FFA`](https://sepolia.arbiscan.io/address/0x85B92cF975E3cf9Ad44c0664d6aF67f358360FFA) | [Blockscout](https://arbitrum-sepolia.blockscout.com/address/0x85B92cF975E3cf9Ad44c0664d6aF67f358360FFA?tab=contract)                                                                                                        | [`0x12db630c…`](https://sepolia.arbiscan.io/tx/0x12db630c319b0cecd1812d90e84a63ab68387095f3ddecd1118164a07f396a08) |
| NVDA TestStockToken (faucet)         | [`0xdF0f069EfF103655312E15C517324d316fD34bc1`](https://sepolia.arbiscan.io/address/0xdF0f069EfF103655312E15C517324d316fD34bc1) | [Sourcify](https://repo.sourcify.dev/421614/0xdF0f069EfF103655312E15C517324d316fD34bc1) (exact match), [Blockscout](https://arbitrum-sepolia.blockscout.com/address/0xdF0f069EfF103655312E15C517324d316fD34bc1?tab=contract) | [`0xc7491857…`](https://sepolia.arbiscan.io/tx/0xc7491857037325e2e1f6c8d37ef3aae059f4cc38cba64de9d85cd9d82f16d458) |
| NVDA MirrorFeed                      | [`0x1B137e5CB2c0153B4B3f1cbBC78DdECBa5569aA1`](https://sepolia.arbiscan.io/address/0x1B137e5CB2c0153B4B3f1cbBC78DdECBa5569aA1) | [Blockscout](https://arbitrum-sepolia.blockscout.com/address/0x1B137e5CB2c0153B4B3f1cbBC78DdECBa5569aA1?tab=contract)                                                                                                        | [`0xe2d019ac…`](https://sepolia.arbiscan.io/tx/0xe2d019acd36d4d74300ce8e715f4f2473e4aafb235be5ad601f604ed822d85e4) |
| DecisionLog (section 4)              | [`0x60E947b8d2c2C34b95d88d02F0A06AeFb6Ccd04C`](https://sepolia.arbiscan.io/address/0x60E947b8d2c2C34b95d88d02F0A06AeFb6Ccd04C) | [Blockscout](https://arbitrum-sepolia.blockscout.com/address/0x60E947b8d2c2C34b95d88d02F0A06AeFb6Ccd04C?tab=contract)                                                                                                        | [`0x8cea8ec3…`](https://sepolia.arbiscan.io/tx/0x8cea8ec3097530fbf188719e6775946bf4d88bf6a19bad73726832316462e8c1) |
| Stylus pricer and risk engine (WASM) | [`0x57cfa61b190c1e80d6e8b1549b8acf1bc505a531`](https://sepolia.arbiscan.io/address/0x57cfa61b190c1e80d6e8b1549b8acf1bc505a531) | `cargo stylus verify` (section 2)                                                                                                                                                                                            | [`0x7ffbd7b9…`](https://sepolia.arbiscan.io/tx/0x7ffbd7b93393569dced980712220ed02ec6c62a66b1c8a0ae3bc5cf690dad3c8) |

Wiring, read back with `cast call`:

- `RiskLens.manager()` is the EpochManager, and `EpochManager.oracle()` is the StockOracle, whose `calendar()` is the new MarketCalendar.
- `StockOracle.latestPrice(TSLA)` returns 350.23 at 1790783341, the seeded mainnet round.
- `AgentRegistry` has `minBond` 50 USDG and `slashAmount` 10 USDG, and points at the official ERC-8004 Identity Registry `0x8004A818…BD9e` and Reputation Registry `0x8004B663…8713`. Both have code on 421614 at the same addresses as on 46630, and the reputation registry's `getIdentityRegistry()` returns `0x8004A818…BD9e`.
- `MarketCalendar.weeklyExpiry(now)` is 1790971200 (Friday 2026-10-02 20:00 UTC).

## 2. Stylus pricer and risk engine

| Step                                                         | Result                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Reproducible Docker build (cargo-stylus 0.10.9, Rust 1.91.0) | 23,562 bytes, project metadata hash `ef5f968b0429b7b240d59acda917a4c8c7232ed1f53215e162e7afda5fbde267`, the same as the program on Robinhood Chain testnet (same source)                                                                                                             |
| `cargo stylus deploy`                                        | [`0x57cfa61b190c1e80d6e8b1549b8acf1bc505a531`](https://sepolia.arbiscan.io/address/0x57cfa61b190c1e80d6e8b1549b8acf1bc505a531), [tx `0x7ffbd7b9…`](https://sepolia.arbiscan.io/tx/0x7ffbd7b93393569dced980712220ed02ec6c62a66b1c8a0ae3bc5cf690dad3c8) (block 314,364,158, 17:28 UTC) |
| Activation                                                   | [tx `0xa68de616…`](https://sepolia.arbiscan.io/tx/0xa68de6166937fc3c22d3cbe30fe2e3d5efda93ffe57e4570b1bf495bf136a287) (block 314,364,181), data fee 0.000114 ETH                                                                                                                     |
| On-chain equality with `BlackScholesRef`                     | Identical return data for all six calls below                                                                                                                                                                                                                                        |
| `EpochManager.setPricer(stylus)`                             | [tx `0x132d5bb3…`](https://sepolia.arbiscan.io/tx/0x132d5bb34afb19ba5a18316250644091c83a051518aca5ece7a3681b3ba82f59) (block 314,364,350); `pricer()` returns `0x57cfa61b…a531`                                                                                                      |
| CacheManager bid                                             | Minimum bid 0 wei (the cache is not full): `cargo stylus cache bid <program> 0`, [tx `0x5b1d2385…`](https://sepolia.arbiscan.io/tx/0x5b1d2385b65c8a9487cb544ac9a187796a7af920950e50e80461fb7857cf596f), 0.000009 ETH of gas; `cache status` says "is cached"                         |
| `cargo stylus verify --deployment-tx 0x7ffbd7b9…`            | **Verification successful** on 2026-10-01, project metadata hash `ef5f968b0429b7b240d59acda917a4c8c7232ed1f53215e162e7afda5fbde267`, 23,562 bytes (details below this table)                                                                                                         |

Two deploy problems cost time. Neither changed the result:

- The public endpoint `sepolia-rollup.arbitrum.io/rpc` refuses the activation fee estimate ("stylus activations not allowed for this request"). The deploy and activation went through `https://arbitrum-sepolia-rpc.publicnode.com` instead.
- The first deploy through that endpoint failed after the 20-minute Docker build, because the base fee rose above the fee cargo-stylus had estimated. The retry ran the identical command in the same reproducible image with its crate cache kept and `--max-fee-per-gas-gwei 0.1`. It built the same 23,562 bytes with the same project hash.

**`cargo stylus verify`.** Run on 2026-10-01 at 15:13 UTC from `stylus/pricer` on the `v3-contracts` branch at `3d864d9`, whose `stylus/pricer` is identical to `6e43348`, the source the program was built from (no commit touches it after that). It is read-only: no key and no transaction.

```bash
cd stylus/pricer && cargo stylus verify \
  --deployment-tx 0x7ffbd7b93393569dced980712220ed02ec6c62a66b1c8a0ae3bc5cf690dad3c8 \
  --endpoint https://sepolia-rollup.arbitrum.io/rpc
```

cargo-stylus 0.10.9 rebuilt the crate in the same reproducible Docker image (Rust 1.91.0) and printed `project metadata hash computed on deployment: "ef5f968b0429b7b240d59acda917a4c8c7232ed1f53215e162e7afda5fbde267"`, `contract size: 23.6 KB (23562 bytes)` and **`Verification successful`**. The hash is the same as the verified program on Robinhood Chain testnet. A first attempt on the evening of 30 September stopped before the build, because crates.io downloads inside the container timed out (`failed to download from https://static.crates.io/crates/portable-atomic/1.15.0/download`); it never reached the comparison.

The equality check sent the same calldata to both addresses (WAD; a TSLA put at spot 352, strike 330, 2 days and 60% volatility unless stated). The values match the Robinhood Chain testnet check exactly:

| Call                                                           | Both return                                                                                                             |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `quote(250, 275, 7 days, 0.60, call)`                          | premium 1.360283237652236375, delta 0.134468746012801532                                                                |
| `quote(352, 330, 2 days, 0.60, put)`                           | premium 0.493160978043023158, delta −0.070063353906536426                                                               |
| `strikeForDelta(352, 0.20, 2 days, 0.60, put)`                 | 339.419809631238825882                                                                                                  |
| `greeks(352, 330, 2 days, 0.60, put)`                          | delta −0.070063353906536426, gamma 0.008594330098652436, vega 3.500948635211281397, theta −0.525142295281692269 per day |
| `impliedVol(1.5, 352, 330, 2 days, put)`                       | 0.815553713492181818                                                                                                    |
| `scenarioLoss(put, 330, 0.1 sold, 352, [−30%, −10%, 0, +10%])` | worst 8.36, losses [8.36, 1.32, 0, 0]                                                                                   |

**Cached vs uncached.** The table shows L2 execution gas from `NodeInterface.gasEstimateComponents` (the total minus the L1 data component), measured just before and just after the cache bid, on the same state:

| Call                                                                           | Uncached |  Cached | Saved          |
| ------------------------------------------------------------------------------ | -------: | ------: | -------------- |
| `EpochManager.proposeByDelta` (put vault, 0.20 delta, Friday, 0.05 TSLA)       |  601,515 | 581,749 | 19,766 (3.3%)  |
| Stylus `strikeForDelta` called directly                                        |  266,212 | 246,457 | 19,755 (7.4%)  |
| Stylus `quote` called directly                                                 |   66,689 |  46,787 | 19,902 (29.8%) |
| `RiskLens.seriesRisk` (greeks and the 13-shock scenario, one Stylus call each) |  184,363 | 164,607 | 19,756 (10.7%) |

Caching removes a fixed cost of about 19,800 gas from each call into the program, the program's initialisation. The accepted `proposeByDelta` below ran before the bid, uncached: 595,760 L2 gas.

## 3. Agent #1: EIP-712 signer consent and ERC-8004 #253

`Seed.s.sol` with `BOND=60e6` registered agent #1 and then bonded it. The owner is the deployer and the signer is `0x4fd9565bf8C0Bda9bBdF2Add233d19c64e50AC6f` (`AGENT_SIGNER_KEY`, the same signer as on 46630). The script computed `registerDigest(signer, owner, owner, 0, deadline)`, the signer key signed the EIP-712 `Register` message, and the owner sent `register`:

| Step                                                                      | Transaction                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `register(signer, payout, 0, deadline, signature)`: agent **#1**          | [`0xb1d1d505…`](https://sepolia.arbiscan.io/tx/0xb1d1d505b5312d63e2f044b73838412774674d9e2e90d29a51217ad24897a5ae)                                                                                                                     |
| `approve` + `postBond(1, 60 USDG)`                                        | [`0x9a98a979…`](https://sepolia.arbiscan.io/tx/0x9a98a9792ddffb76de4ac38493a44bf56b31ce4732a05a209deacad9a0f47881), [`0x81fcc534…`](https://sepolia.arbiscan.io/tx/0x81fcc53457ed9d6ac539783b37b0f157606f4a65d1bef7bcc90e5f030a0fe03d) |
| ERC-8004 `register(tokenURI)` on the official Identity Registry: **#253** | [`0x2f99add1…`](https://sepolia.arbiscan.io/tx/0x2f99add127c63313b1277df97680387dcf4e1f26e0487618e826a12df6b4d435)                                                                                                                     |
| `setIdentity(1, 253)`                                                     | [`0x62b8c7bb…`](https://sepolia.arbiscan.io/tx/0x62b8c7bb68b0ff6f18227a95f0f51e619dd28f365250d7e43c67f867bf2960b8)                                                                                                                     |

The token URI is the same registration file as for #114 on 46630, [`docs/agents/strike-agent-1.json`](../agents/strike-agent-1.json), which now lists both registrations (`eip155:46630:…` #114 and `eip155:421614:…` #253). After these steps the signer's EIP-712 nonce is 1, `isActive(1)` is true, and the example agent shows `ERC-8004 id 253`.

`InvalidMandate(reason)` is checked when a vault is created. An `eth_call` of `VaultFactory.createVault` for a put vault with an inverted delta band (0.35 to 0.10) reverts with `0x0510db17…0001`, which is `InvalidMandate(1)` (`DeltaBandInverted`).

## 4. DecisionLog

The DecisionLog is the same source as on 46630 ([`contracts/src/agents/DecisionLog.sol`](../../contracts/src/agents/DecisionLog.sol) on `main`, `9ed81b4`), deployed with the 421614 AgentRegistry as its constructor argument: [`0x60E947b8…d04C`](https://sepolia.arbiscan.io/address/0x60E947b8d2c2C34b95d88d02F0A06AeFb6Ccd04C) ([tx `0x8cea8ec3…`](https://sepolia.arbiscan.io/tx/0x8cea8ec3097530fbf188719e6775946bf4d88bf6a19bad73726832316462e8c1), verified on Blockscout). It happens to have the same address as v1/v2's Stylus pricer on 46630, because the deployer's nonce was the same.

## 5. Vaults

`Seed.s.sol` created both vaults with the v2/v3 mandate: |delta| 0.10 to 0.35, premium at least 95% of fair value, yield at least 0.05%, at most 80% of the vault sold, tenor 1 to 8 days.

| Vault                                    | Address                                                                                                                        | Created                                                                                                            | Collateral                                                                                                                                                                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| sTSLA-CC (Strike TSLA Covered Call)      | [`0x5655659E18bf54ee0EF8f6A816E2e18D000F7311`](https://sepolia.arbiscan.io/address/0x5655659E18bf54ee0EF8f6A816E2e18D000F7311) | [`0x23f5f179…`](https://sepolia.arbiscan.io/tx/0x23f5f179d0d93b7e1b04c495300d559c91196a16eca51d9a57d44d9e0d5e1a46) | 5 TSLA from the `TestStockToken` faucet ([faucet](https://sepolia.arbiscan.io/tx/0xdf87c3fa07f36f99848fb2140282b28752d08392c812bfe36459213a875b1fbb), [deposit](https://sepolia.arbiscan.io/tx/0x1730a065cea2a517e5e8ca5393657e5e0105cdd68b4be5f55b9746073a0400d4)) |
| sTSLA-CSP (Strike TSLA Cash-Secured Put) | [`0x02B701210aA006CEAbd389dBc32af0047B1B9bbe`](https://sepolia.arbiscan.io/address/0x02B701210aA006CEAbd389dBc32af0047B1B9bbe) | [`0x3fe2cdc5…`](https://sepolia.arbiscan.io/tx/0x3fe2cdc564124f073d45280536a4fad61739dbc417b45d47c39f7dac6aee5edf) | 30 USDG ([deposit](https://sepolia.arbiscan.io/tx/0x1b05c10e4e081ff9a76ca42805f91caa7c73223e29e3b38d363d42f5ae086577))                                                                                                                                              |

Both are EIP-1167 clones of the verified StrikeVault implementation.

## 6. The epoch (17:29 to 17:34 UTC, NYSE open)

The example agent and the MCP server from `main` ran against 421614 with `STRIKE_CHAIN_ID=421614`, after `421614.json` was added to the SDK's deployment map. v2 and v3 have the same ABI for every call in this flow. v3 only adds the `SeriesRisk` event, `InvalidMandate(uint8)` and the consent-based `register`, which `Seed.s.sol` used above.

**Keeper.** `CHAIN_ID=421614 RPC_URL=https://sepolia-rollup.arbitrum.io/rpc scripts/keeper.sh --once` reads `deployments/421614.json` unchanged. It pushed nothing, because the TSLA MirrorFeed already held the latest mainnet round (350.23 at 16:09 UTC, 1 h 20 min old against a 25 h `maxPriceAge`). Mainnet had not printed a new round, since Chainlink stock feeds print on a 0.5% move.

**Seller agent, planned by Claude through the Claude Code CLI.** First a `--dry-run` (nothing sent), then the real run:

```
STRIKE_CHAIN_ID=421614 STRIKE_AGENT_PRIVATE_KEY=<signer> pnpm --filter @strike/agent-example start -- \
  --vault sTSLA-CC --llm --planner claude-code --log docs/agent-log/arbitrum-sepolia --anchor
```

```
Strike example agent (Claude mode)
Connected to the Strike MCP server: chain 421614, agent mode as 0x4fd9565bf8C0Bda9bBdF2Add233d19c64e50AC6f.

[1] Read the vault
    sTSLA-CC (Strike TSLA Covered Call), covered-call: epoch Idle, 5 TSLA of collateral
    Spot TSLA $350.23 (oracle Ok), market open, chain time 2026-09-30T17:30:03.000Z
    Mandate: |delta| 0.10-0.35, premium >= 95% of fair value, yield >= 0.05% of collateral, size <= 80% of capacity, tenor 1-8 days
    Agent #1: active, bond 60 USDG, 0 strike(s)

[2] Ask Claude for this epoch's plan (via the Claude Code CLI)
    Claude Code 2.1.263 started (model claude-opus-5); Strike MCP server connected.
    Claude calls vault_state, then risk_check at 0.15/100%, 0.20/100%, 0.25/105%, 0.20/105%, 0.22/105%, then agent_stats
    Claude's plan: 0.20 delta at 105% of fair value (Claude via Claude Code CLI, model claude-opus-5)
    Why: We sell 4 TSLA covered calls (80% of capacity) at a 0.20 target delta, which the on-chain pricer solves to a
    364.29 strike — about 4.0% above the 350.23 spot — expiring Oct 2, and prices them at 105% of Black-Scholes fair
    value (1.74 USDG fair per option). [...] Delta 0.20 sits comfortably mid-band (mandate allows 0.10-0.35), leaving
    margin on both sides so a spot or sigma drift cannot push the proposal out of the mandate and slash the agent bond,
    which currently sits only one slash above the minimum. [...]

[3] Compute the strike (risk_check suggestion)
    At spot $350.23, a 0.20-delta call expiring 2026-10-02T20:00:00.000Z strikes at $364.29.
    Fair value $1.7439 per option (0.52% of collateral); offer 4 of 5 options.

[4] Dry run the exact proposal
    Verdict: None. Inside the mandate: the contract would accept this proposal.

[5] Propose on-chain (proposeByDelta)
    Opened the epoch (tx 0x9865efd7…de59); the vault is locked.
    Accepted: series 8200340887102394470889505950118944065123972136398888610989328404594772867353 is on sale (strike $364.29, |delta| 0.2001, expiry 2026-10-02T20:00:00.000Z).
    tx 0xf26315b33df93548bfa31d68b7d9964792ef88184cb154796180e19b9365b5f4

Anchored the record on-chain: DecisionLog.record tx 0x1f9f7eaf…3538 (epoch 1)
```

The `proposeByDelta` receipt (block 314,364,888) carries the v3 **`SeriesRisk`** event, computed by the Stylus risk engine at the epoch's opening snapshot (spot 350.23, sigma 0.60): delta 0.200055303265635246, gamma 0.017553886128730868 per $1, vega 7.444195616831681130 per 1.00 of volatility, theta −1.061841281935972599 per day. The strike the pricer solved was 364.29 (`getSeries`: premium factor 10500, 4 options).

**Reckless agent (scripted `--reckless`).** It forced an at-the-money put on the put vault:

```
[3] Dry run (risk_check)
    Verdict: DeltaOutOfBand (|delta| 0.4907). [...] Proposing it anyway would be rejected on-chain and slash the agent's bond.
[4] Force the proposal on-chain (proposeSeries)
    Opened the epoch (tx 0xf92fba5d…1605).
    The contract REJECTED it: DeltaOutOfBand. Slashed 10 USDG from the agent's bond (tx 0x4813b108…756d).
    Agent now: bond 50 USDG, strikes 1/3, still active.
Anchored the record on-chain: DecisionLog.record tx 0x6ee65ef8…8c6e (epoch 1)
```

`ProposalRejected` came with reason 8 (`DeltaOutOfBand`). The 10 USDG went into `compensation(putVault)`, which reads 10,000,000, and the put epoch stays `Open`. The same transaction posted a −10 feedback with tag `strike.mandate.rejection` for ERC-8004 identity #253 to the official Reputation Registry `0x8004B663056A597Dffe9eCcC1965A193B7388713`. Its `NewFeedback` log (topic0 `0x6a4a6174…febc`, log index 36) decodes to agentId 253, client `0xAa3CA784…341E` (the AgentRegistry), feedbackIndex 1, value −10,000,000 with valueDecimals 6 (−10 USDG), tag1 `strike.mandate.rejection`, and empty tag2, endpoint, feedbackURI and a zero feedbackHash. The AgentRegistry's own log is `ReputationFeedback(1, 253, −10e6, "strike.mandate.rejection", posted = true)`. Because the bond was 60 USDG, the agent is still active at the 50 USDG minimum.

**Buyer agent (separate wallet `0x85f0A3A3cb02253e578ec3BE2feDE1F1a1dC33E1`).** The wallet was generated for this run and funded with 0.002 ETH and 10 USDG. Its key lives only in a local file outside the repository. It bought with a 10 USDG budget:

```
[1] Find a live series
    sTSLA-CC sells series 820034…7353: TSLA call, strike $364.29, expiry 2026-10-02T20:00:00.000Z, 4 of 4 options left.
[2] Quote sTSLA-CC (quote)
    One option costs 2.226628 USDG now: Black-Scholes fair value × 105% at the oracle spot moved 0.5% against the buyer, never below intrinsic value.
[4] Buy (buy_options)
    Bought 4 TSLA calls of series 820034…7353 (sTSLA-CC) for 8.905435 USDG, 2.226358 per option (tx 0x82e2d5b4…65f4).
    Breakeven at expiry: TSLA at $366.5163 (strike $364.29 + 2.226358 per option).
```

**`RiskLens.seriesRisk(series)`** at 17:34 UTC (chain time 1790789657), after the buy, priced by the Stylus program:

| Field                       | Value                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| spot, sigma, tenor          | 350.23, 0.60, 181,541 s (2.10 days)                                                                    |
| delta, gamma, vega, theta   | 0.199935649910237585, 0.017556028518540581, 7.437934212360852998, −1.061970875914495023                |
| sold, collateral            | 4 options, 4 TSLA locked                                                                               |
| worst shock                 | +30%: payout value 364.036 USD, 0.799553699876344992 TSLA at settlement                                |
| losses on the 13-shock grid | 0 from −30% to 0%; +5% 13.806, +10% 83.852, +15% 153.898, +20% 223.944, +25% 293.990, +30% 364.036 USD |

**Decision records** are in [`docs/agent-log/arbitrum-sepolia`](../agent-log/arbitrum-sepolia/). The call record names the planner, "Claude via Claude Code CLI, model claude-opus-5". Both are anchored in the 421614 DecisionLog, and `latestHash(1, vault, 1)` returns the record hash for each:

| Record                                                                         | `recordHash` on-chain                                                | Anchor tx                                                                                                          |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [sTSLA-CC, accepted](../agent-log/arbitrum-sepolia/2026-09-30-sTSLA-CC.json)   | `0x7ca1bd76f2bc2f658221e776b0a2bf15f3f1eb07f05961f216ab4a69c124e0f9` | [`0x1f9f7eaf…`](https://sepolia.arbiscan.io/tx/0x1f9f7eafdf448c205df43e81d75e94f5282dd3b2bb465473330012c04cac3538) |
| [sTSLA-CSP, rejected](../agent-log/arbitrum-sepolia/2026-09-30-sTSLA-CSP.json) | `0x6d478786600403f8d8fb1645909db1cbe6e8f0cd464d5bbbff45d60edacc43f4` | [`0x6ee65ef8…`](https://sepolia.arbiscan.io/tx/0x6ee65ef8a6fa002f4388f7cf279f6fd098c0a45ab2bff118c0fc0ab0ed266c8e) |

### Transactions

| Step                                                                                             | Transaction                                                                                                            |  L2 gas |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ------: |
| Signer opens the covered-call epoch                                                              | [`0x9865efd7…de59`](https://sepolia.arbiscan.io/tx/0x9865efd793e63ee8386e4a670eeb0bc65f5d45f1c3070126bc295f261a98de59) | 157,917 |
| `proposeByDelta` accepted, 0.20-delta call at $364.29, `SeriesRisk`                              | [`0xf26315b3…b5f4`](https://sepolia.arbiscan.io/tx/0xf26315b33df93548bfa31d68b7d9964792ef88184cb154796180e19b9365b5f4) | 595,760 |
| Decision record anchored (call)                                                                  | [`0x1f9f7eaf…3538`](https://sepolia.arbiscan.io/tx/0x1f9f7eafdf448c205df43e81d75e94f5282dd3b2bb465473330012c04cac3538) |  79,328 |
| Signer opens the put epoch                                                                       | [`0xf92fba5d…1605`](https://sepolia.arbiscan.io/tx/0xf92fba5da7558aeccd5c5270adf46b6f218e6024a42000922c09cc8e8fdb1605) | 157,929 |
| At-the-money put **rejected** (`DeltaOutOfBand`), 10 USDG slashed, −10 ERC-8004 feedback to #253 | [`0x4813b108…756d`](https://sepolia.arbiscan.io/tx/0x4813b1089c8e6a3f3e728c74b9b6bb2d79ec73fb36ab0b5142abc72aa333756d) | 468,684 |
| Decision record anchored (put)                                                                   | [`0x6ee65ef8…8c6e`](https://sepolia.arbiscan.io/tx/0x6ee65ef8a6fa002f4388f7cf279f6fd098c0a45ab2bff118c0fc0ab0ed266c8e) |  62,252 |
| Buyer buys 4 calls for 8.905435 USDG                                                             | [`0x82e2d5b4…65f4`](https://sepolia.arbiscan.io/tx/0x82e2d5b4e476edec205c80daca431a8becdd5fbdb1f84e3ca0dea8d7d49265f4) | 336,946 |

## 7. Funds

| Wallet                      | Before (16:28 UTC) | After (17:35 UTC)                                   |
| --------------------------- | ------------------ | --------------------------------------------------- |
| Deployer `0x26b2…13Ff`, ETH | 0.049              | 0.042731                                            |
| Deployer, USDG              | 100                | 0 (60 bonded, 30 in the put vault, 10 to the buyer) |
| Deployer, TSLA (test)       | 0                  | 5 (faucet 10, 5 deposited)                          |
| Signer `0x4fd9…AC6f`, ETH   | 0                  | 0.002952 (0.003 sent)                               |
| Buyer `0x85f0…33E1`         | 0                  | 0.001988 ETH, 1.094565 USDG, 4 calls                |

The deployer spent 0.001269 ETH, besides the 0.005 ETH it sent to the signer and the buyer. That covers the deploy (0.000779 ETH), the Stylus deploy and activation with its 0.000114 ETH data fee, the cache bid, `setPricer`, the agent, the vaults and the funding transfers. The signer spent 0.000048 ETH on its six transactions and the buyer 0.000012 ETH. The deployer keeps 0.0427 ETH for Friday's settlement and the keeper.

## 8. Friday

After 20:00 UTC on Friday 2026-10-02:

- Run the keeper: `CHAIN_ID=421614 RPC_URL=https://sepolia-rollup.arbitrum.io/rpc scripts/keeper.sh --once` from the `v3-contracts` worktree. It mirrors the first mainnet TSLA round at or after the close, then settles expired epochs; `settle` is permissionless.
- The buyer redeems with `--redeem`.
- The put vault's epoch is still `Open` after the rejection. The curator's `abortEpoch` pays the 10 USDG slash to its depositors, as on v2 ([log](2026-09-29.md#the-slashed-bond-reaches-depositors-added-2026-09-29-2130-utc)).
