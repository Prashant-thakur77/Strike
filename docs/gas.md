# Gas: Stylus vs Solidity pricer and risk engine

The Black-Scholes pricer and its risk engine exist twice: `stylus/pricer` (Rust, compiled to WASM for Arbitrum Stylus) and `contracts/src/pricing/BlackScholesLib.sol` + `RiskLib.sol` (Solidity). They run the same integer algorithm and return **identical** results (differential fuzzing at 5,000 runs per property, 300 pricer and 410 risk vectors, and every on-chain call below).

Measured on a local Arbitrum Nitro dev node (`offchainlabs/nitro-node:v3.7.1`, ArbOS with Stylus) through `PricerGasProbe`, which records `gasleft()` around one external call: the cross-contract call overhead is included, the transaction overhead is not. The Stylus program was not cached in ArbOS (the dev node has no cache manager); caching lowers Stylus entry cost further. Reproduce with `scripts/stylus-gas.sh`, which also checks that both pricers return the same values for every row.

Branch `v3-contracts` (risk engine included), measured 2026-09-30. The Stylus program is 23,530 bytes compressed (limit 24,576).

| Call             | Inputs                                                 | Solidity gas | Stylus gas | Stylus vs Solidity |
| ---------------- | ------------------------------------------------------ | -----------: | ---------: | ------------------ |
| `quote`          | TSLA 250, K 275 call, 7 days, 60% vol                  |       33,922 |     44,778 | 1.32× more         |
| `quote`          | K 235 put, 4.2 days                                    |       37,176 |     45,149 | 1.21× more         |
| `quote`          | at-the-money call, 30 days, 50% vol                    |       24,859 |     43,542 | 1.75× more         |
| `strikeForDelta` | 0.20-delta call, 7 days                                |    1,540,153 |    245,670 | **6.3× less**      |
| `strikeForDelta` | 0.20-delta put, 7 days                                 |    1,526,239 |    241,393 | **6.3× less**      |
| `strikeForDelta` | 0.35-delta call, 30 days                               |    1,403,316 |    227,386 | **6.2× less**      |
| `greeks`         | TSLA 250, K 275 call, 7 days, 60% vol                  |       34,046 |     44,810 | 1.32× more         |
| `greeks`         | K 235 put, 4.2 days                                    |       33,054 |     44,672 | 1.35× more         |
| `greeks`         | at-the-money call, 30 days, 50% vol                    |       20,983 |     43,081 | 2.05× more         |
| `impliedVol`     | TSLA 250, K 275 call, 7 days (premium at 60%)          |      293,403 |     79,077 | **3.7× less**      |
| `impliedVol`     | K 235 put, 4.2 days (premium at 60%)                   |      302,084 |     80,050 | **3.8× less**      |
| `impliedVol`     | at-the-money call, 30 days (premium at 50%)            |      142,287 |     59,532 | **2.4× less**      |
| `scenarioLoss`   | 100 calls K 275, spot 250, 13 shocks (−30%…+30% by 5%) |       20,963 |     44,975 | 2.15× more         |
| `scenarioLoss`   | 100 puts K 235, spot 250, 13 shocks                    |       19,600 |     44,665 | 2.28× more         |
| `scenarioLoss`   | 100 calls K 275, 61 shocks (−30%…+30% by 1%)           |       81,006 |     59,008 | **1.4× less**      |

The same calls on the v2 binary (15,574 bytes, before the risk engine): `quote` 40,624 / 40,993 / 39,038 and `strikeForDelta` 235,880 / 232,166 / 218,066 Stylus gas. An uncached Stylus call pays an entry cost that grows with the program, so the larger v3 binary costs about 4k more per call; the Solidity side did not change.

## Inside the protocol

`scripts/stylus-e2e.sh` deploys the whole protocol and the Stylus pricer to the Nitro dev node, then runs the same epoch twice, once with `EpochManager.pricer` set to the Solidity reference and once to the Stylus contract. Figures are L2 execution gas (receipt `gasUsed` minus Arbitrum's L1 data component `gasUsedForL1`):

| EpochManager transaction                                  | Solidity pricer | Stylus pricer | Saving    |
| --------------------------------------------------------- | --------------: | ------------: | --------- |
| `proposeByDelta` (0.20 delta; solves the strike on-chain) |       1,878,918 |       577,041 | 3.3× less |
| `buy` 5 options (live Black-Scholes quote)                |         329,872 |       301,404 | 9% less   |

Both runs chose the same strike ($387.22 at a $369 spot, 60% volatility, expiring at Friday's close). Measured on 2026-09-29 against the v2 contracts, where `proposeByDelta` solves against the epoch-open snapshot.

## What this means

- A Stylus call has a fixed entry cost (about 40–45k gas uncached). For a single Black-Scholes quote or one set of greeks, where the EVM's native 256-bit arithmetic is cheap, Solidity wins.
- Once a call does real work, WASM wins by a wide margin: `strikeForDelta` runs 48 Black-Scholes evaluations to solve for the strike with a target delta and costs 6.3× less in Stylus.
- `impliedVol` is the second solver. Newton's method from the Manaster–Koehler starting point needs 3–8 premium-and-vega evaluations for ordinary inputs (plus two at the ends of the [5%, 500%] range to reject impossible prices), so it does less work than the 48-round bisection and saves 2.4–3.8×.
- `scenarioLoss` is a few multiplications per shock: about 1,250 gas per shock in Solidity against about 290 in Stylus. Solidity is cheaper for the default 13-point grid; Stylus becomes cheaper from about 38 shocks.
- Strike uses the solver in `EpochManager.proposeByDelta`: an agent proposes "a 0.20-delta call" and the contract solves the strike on-chain from the spot and sigma snapshotted at `openEpoch`, then rounds it to a cent toward the middle of the mandate's delta band. The agent's dry run and the transaction see the same inputs, so a price or volatility update before inclusion cannot get it slashed. With the Stylus pricer that costs ~0.25M gas instead of ~1.5M.
- Production setting: point `EpochManager.pricer` at the Stylus pricer (both implement `IRiskEngine`, which extends `IPricer`).

## The live Stylus pricer is verifiably the v2 source

The pricer on Robinhood Chain testnet ([`0x60e947b8d2c2c34b95d88d02f0a06aefb6ccd04c`](https://explorer.testnet.chain.robinhood.com/address/0x60e947b8d2c2c34b95d88d02f0a06aefb6ccd04c), deployment tx `0x93fccce03198d72320afc7f613b097450ea4fafad3701bae732b81180ba237fe`) was built reproducibly in Docker (cargo-stylus 0.10.9, Rust 1.91.0). `cargo stylus verify --deployment-tx 0x93fc…37fe --endpoint https://rpc.testnet.chain.robinhood.com` rebuilds `stylus/pricer` from this repository and reports **Verification successful** (project metadata hash `5773190b3eed71771269cdaa28bfd562adc3bc8888ddb49e2b901cf4ceca7045`, 15,574 bytes). The risk engine on this branch changes the source, so that check passes on `main` (the v2 source), not on `v3-contracts`; a v3 deployment gets its own verification.
