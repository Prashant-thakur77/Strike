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
| `proposeByDelta` (0.20 delta; solves the strike on-chain) |       1,908,694 |       586,289 | 3.3× less |
| `buy` 5 options (live Black-Scholes quote)                |         330,423 |       300,739 | 9% less   |

Both runs chose the same strike ($390.51 at a $369 spot, 60% volatility, four-day tenor).

## What this means

- A Stylus call has a fixed entry cost (about 35–40k gas uncached). For a single Black-Scholes quote, where the EVM's native 256-bit arithmetic is cheap, Solidity wins.
- Once a call does real work, WASM wins by a wide margin: `strikeForDelta` runs 48 Black-Scholes evaluations to solve for the strike with a target delta and costs 6.5× less in Stylus.
- Strike uses this in `EpochManager.proposeByDelta`: an agent proposes "a 0.20-delta call" and the contract solves the strike on-chain at execution-time spot. The agent never gets slashed because spot moved between its off-chain math and inclusion. With the Stylus pricer that costs ~0.24M gas instead of ~1.5M.
- Production setting: point `EpochManager.pricer` at the Stylus pricer (both implement `IPricer`).

## The live Stylus pricer is verifiably this source

The pricer on Robinhood Chain testnet ([`0x60e947b8d2c2c34b95d88d02f0a06aefb6ccd04c`](https://explorer.testnet.chain.robinhood.com/address/0x60e947b8d2c2c34b95d88d02f0a06aefb6ccd04c), deployment tx `0x93fccce03198d72320afc7f613b097450ea4fafad3701bae732b81180ba237fe`) was built reproducibly in Docker (cargo-stylus 0.10.9, Rust 1.91.0). `cargo stylus verify --deployment-tx 0x93fc…37fe --endpoint https://rpc.testnet.chain.robinhood.com` rebuilds `stylus/pricer` from this repository and reports **Verification successful** (project metadata hash `5773190b3eed71771269cdaa28bfd562adc3bc8888ddb49e2b901cf4ceca7045`, 15,574 bytes).
