# Gas: Stylus vs Solidity pricer

The Black-Scholes pricer exists twice: `stylus/pricer` (Rust, compiled to WASM for Arbitrum Stylus) and `contracts/src/pricing/BlackScholesLib.sol` (Solidity). They run the same integer algorithm and return **identical** results (10,000+ differential fuzz runs, 300 vectors, and the on-chain calls below).

Measured on a local Arbitrum Nitro dev node (`offchainlabs/nitro-node:v3.7.1`, ArbOS with Stylus) through `PricerGasProbe`, which records `gasleft()` around one external call: the cross-contract call overhead is included, the transaction overhead is not. The Stylus program was not cached in ArbOS (the dev node has no cache manager); caching lowers Stylus entry cost further. Reproduce with `scripts/stylus-gas.sh`.

| Call             | Inputs                                | Solidity gas | Stylus gas | Stylus vs Solidity |
| ---------------- | ------------------------------------- | -----------: | ---------: | ------------------ |
| `quote`          | TSLA 250, K 275 call, 7 days, 60% vol |       33,969 |     40,624 | 1.20× more         |
| `quote`          | K 235 put, 4.2 days                   |       37,216 |     40,993 | 1.10× more         |
| `quote`          | at-the-money call, 30 days, 50% vol   |       24,793 |     39,038 | 1.57× more         |
| `strikeForDelta` | 0.20-delta call, 7 days               |    1,546,443 |    235,880 | **6.6× less**      |
| `strikeForDelta` | 0.20-delta put, 7 days                |    1,530,713 |    232,166 | **6.6× less**      |
| `strikeForDelta` | 0.35-delta call, 30 days              |    1,408,482 |    218,066 | **6.5× less**      |

## Inside the protocol

`scripts/stylus-e2e.sh` deploys the whole protocol and the Stylus pricer to the Nitro dev node, then runs the same epoch twice, once with `EpochManager.pricer` set to the Solidity reference and once to the Stylus contract. Figures are L2 execution gas (receipt `gasUsed` minus Arbitrum's L1 data component `gasUsedForL1`):

| EpochManager transaction                                  | Solidity pricer | Stylus pricer | Saving    |
| --------------------------------------------------------- | --------------: | ------------: | --------- |
| `proposeByDelta` (0.20 delta; solves the strike on-chain) |       1,878,918 |       577,041 | 3.3× less |
| `buy` 5 options (live Black-Scholes quote)                |         329,872 |       301,404 | 9% less   |

Both runs chose the same strike ($387.22 at a $369 spot, 60% volatility, expiring at Friday's close). Measured on 2026-09-29 against the v2 contracts, where `proposeByDelta` solves against the epoch-open snapshot.

## Measured on the live chain

The same two transactions from the first live epoch on Robinhood Chain testnet (2026-09-29, v2 contracts, `EpochManager.pricer` = the Stylus pricer), read from the raw receipts with `cast rpc eth_getTransactionReceipt <tx> --rpc-url https://rpc.testnet.chain.robinhood.com`. L2 execution gas is `gasUsed − gasUsedForL1`, the same definition as the dev-node table:

| EpochManager transaction                                                                                                                                                   | Block       | `gasUsed` | `gasUsedForL1` | L2 execution gas |    Dev node, Stylus | Dev node, Solidity |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | --------: | -------------: | ---------------: | ------------------: | -----------------: |
| `proposeByDelta` 0.20-delta call ([`0x92169eac…a9d4`](https://explorer.testnet.chain.robinhood.com/tx/0x92169eac7bd2491d1f22f394e15643d5d54309c1e980683cf82a13088021a9d4)) | 126,302,301 |   576,471 |          2,443 |      **574,028** |             577,041 |          1,878,918 |
| `buy` 4 options ([`0x425e5b63…e9f9`](https://explorer.testnet.chain.robinhood.com/tx/0x425e5b63ddeb1fcff5d63aa9f5a9fd11f4d3c0f52facd05e0fb44096f2ede9f9))                  | 126,302,569 |   348,135 |          2,267 |      **345,868** | 301,404 (5 options) |            329,872 |

- `proposeByDelta` on the live chain is within 0.6% of the dev-node figure (574,028 vs 577,041): solving the strike in Stylus costs the same on Robinhood Chain as on a stock Nitro node, and 3.3× less than the Solidity pricer on the dev node.
- The live `buy` used 15% more L2 gas than the dev-node run. The two runs start from different state (different accounts, balances, series and size), so treat the `buy` row as a sanity check, not a like-for-like comparison.
- Both paid `effectiveGasPrice` 0.01 gwei: 0.0000058 ETH for `proposeByDelta` and 0.0000035 ETH for `buy`. The L1 data component is under 1% of each.

### v3 on Arbitrum Sepolia, uncached and cached

The v3 Stylus pricer and risk engine on Arbitrum Sepolia ([`0x57cfa61b…a531`](https://sepolia.arbiscan.io/address/0x57cfa61b190c1e80d6e8b1549b8acf1bc505a531)) is cached in ArbOS through the CacheManager (bid 0 wei, [tx `0x5b1d2385…`](https://sepolia.arbiscan.io/tx/0x5b1d2385b65c8a9487cb544ac9a187796a7af920950e50e80461fb7857cf596f)). L2 execution gas from `NodeInterface.gasEstimateComponents` (the total minus the L1 data component), measured just before and just after the bid on the same state ([log §2](testnet-epochs/2026-09-30-arbitrum-sepolia.md#2-stylus-pricer-and-risk-engine)):

| Call                                                                           | Uncached |  Cached | Saved          |
| ------------------------------------------------------------------------------ | -------: | ------: | -------------- |
| `EpochManager.proposeByDelta` (put vault, 0.20 delta, Friday, 0.05 TSLA)       |  601,515 | 581,749 | 19,766 (3.3%)  |
| Stylus `strikeForDelta` called directly                                        |  266,212 | 246,457 | 19,755 (7.4%)  |
| Stylus `quote` called directly                                                 |   66,689 |  46,787 | 19,902 (29.8%) |
| `RiskLens.seriesRisk` (greeks and the 13-shock scenario, one Stylus call each) |  184,363 | 164,607 | 19,756 (10.7%) |

Caching removes a fixed cost of about 19,800 gas from each call into the program, its initialisation, so it matters most for small calls. The accepted `proposeByDelta` of the 30 September epoch ran before the bid, uncached: 595,760 L2 gas ([transactions](testnet-epochs/2026-09-30-arbitrum-sepolia.md#transactions)). These are v3 figures: v3's `proposeByDelta` also has the risk engine compute the series' greeks for the `SeriesRisk` event, so they are not a like-for-like comparison with the v2 rows above.

On Robinhood Chain testnet, the v3 `proposeByDelta` of 1 October (uncached) had a receipt `gasUsed` of 616,952 and the `buy` of 4 calls 361,789, both including the L1 data component ([log §7](testnet-epochs/2026-09-30-v3.md#7-live-epoch-1-october)).

### Stylus caching on Robinhood Chain testnet

Arbitrum chains can cache Stylus programs through a CacheManager contract registered with the `ArbWasmCache` precompile (`0x…72`); a cached program pays a lower initialisation cost on every call, which cuts into the fixed Stylus entry cost described above. Robinhood Chain testnet has no CacheManager yet (checked 2026-09-30):

- `cast call 0x0000000000000000000000000000000000000072 "allCacheManagers()(address[])"` returns `[]`;
- `cargo stylus cache status --address 0x60e947b8d2c2c34b95d88d02f0a06aefb6ccd04c --endpoint https://rpc.testnet.chain.robinhood.com` (cargo-stylus 0.10.9) stops with "no cache managers found in ArbWasmCache, perhaps the Stylus cache is not yet enabled on this chain";
- `ArbWasmCache.codehashIsCached(0x28a0a4a06c9a99cb0d21e2e30bfaabd003f7a1d73f14d1c0a3d6fccdf3f4a724)` (the pricer's code hash) returns `false`.

So no bid was placed and nothing was spent. Every Stylus figure on this page outside the Arbitrum Sepolia "Cached" column is **uncached**, on the dev node and on Robinhood Chain testnet alike. Once Robinhood Chain enables the cache, `cargo stylus cache bid 0x60e947b8d2c2c34b95d88d02f0a06aefb6ccd04c 0` (or `suggest-bid` first) caches the pricer, and every Stylus call gets cheaper than the figures here.

## What this means

- A Stylus call has a fixed entry cost (about 35–40k gas uncached; caching took about 19,800 gas off each call on Arbitrum Sepolia). For a single Black-Scholes quote, where the EVM's native 256-bit arithmetic is cheap, Solidity wins.
- Once a call does real work, WASM wins by a wide margin: `strikeForDelta` runs 48 Black-Scholes evaluations to solve for the strike with a target delta and costs 6.5× less in Stylus.
- Strike uses this in `EpochManager.proposeByDelta`: an agent proposes "a 0.20-delta call" and the contract solves the strike on-chain from the spot and sigma snapshotted at `openEpoch`, then rounds it to a cent toward the middle of the mandate's delta band. The agent's dry run and the transaction see the same inputs, so a price or volatility update before inclusion cannot get it slashed. With the Stylus pricer that costs ~0.24M gas instead of ~1.5M.
- Production setting: point `EpochManager.pricer` at the Stylus pricer (both implement `IPricer`).

## The live Stylus pricer is verifiably this source

The v2 pricer on Robinhood Chain testnet ([`0x60e947b8d2c2c34b95d88d02f0a06aefb6ccd04c`](https://explorer.testnet.chain.robinhood.com/address/0x60e947b8d2c2c34b95d88d02f0a06aefb6ccd04c), deployment tx `0x93fccce03198d72320afc7f613b097450ea4fafad3701bae732b81180ba237fe`) was built reproducibly in Docker (cargo-stylus 0.10.9, Rust 1.91.0). `cargo stylus verify --deployment-tx 0x93fc…37fe --endpoint https://rpc.testnet.chain.robinhood.com` rebuilds `stylus/pricer` from this repository and reports **Verification successful** (project metadata hash `5773190b3eed71771269cdaa28bfd562adc3bc8888ddb49e2b901cf4ceca7045`, 15,574 bytes).

The v3 Stylus pricer and risk engine, built from `stylus/pricer` on the `v3-contracts` branch, is verified the same way on both chains where it runs: `0x61158d98…a4ec` on Robinhood Chain testnet and `0x57cfa61b…a531` on Arbitrum Sepolia both report **Verification successful** with project metadata hash `ef5f968b0429b7b240d59acda917a4c8c7232ed1f53215e162e7afda5fbde267`, 23,562 bytes ([DEPLOYMENTS.md](DEPLOYMENTS.md#stylus-pricer-verification)).
