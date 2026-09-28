# Strike

[![CI](https://github.com/Prashant-thakur77/Strike/actions/workflows/ci.yml/badge.svg)](https://github.com/Prashant-thakur77/Strike/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) ![Solidity 0.8.30](https://img.shields.io/badge/Solidity-0.8.30-363636) ![Arbitrum Stylus](https://img.shields.io/badge/Arbitrum-Stylus-28a0f0)

Weekly options vaults for Robinhood Chain stock tokens. Depositors earn premium in USDG. An AI agent picks each week's strike, and the contract rejects any proposal outside the vault's mandate and slashes the agent's bond.

Built for the Arbitrum Open House Singapore buildathon. Unaudited: testnet first, and any mainnet vault is capped.

|                  |                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Live app         | pending Vercel setup ([docs/deploy-app.md](docs/deploy-app.md)); contracts are [live on Robinhood Chain testnet](#deployed-contracts) |
| Demo video       | pending                                                                                                                               |
| Agent skill file | [docs/STRIKE_SKILL.md](docs/STRIKE_SKILL.md)                                                                                          |
| Design spec      | [docs/design.md](docs/design.md)                                                                                                      |
| Threat model     | [docs/threat-model.md](docs/threat-model.md)                                                                                          |

<p>
  <img src="docs/screenshots/desktop-landing-00-hero.png" alt="Strike landing page" width="66%">
  <img src="docs/screenshots/mobile-landing-00-hero.png" alt="Strike on mobile" width="22%">
</p>

## Why

Robinhood Chain has tokenized TSLA, NVDA, SPY and others, but holding them earns nothing. There are perps on the chain and no options (CertiK, Aug 2026). Stock-token market cap is about $14M while roughly $400M of stablecoins sit idle.

Building anything on these tokens also means handling their quirks correctly:

| Problem                        | What goes wrong                                                                                                                                   | What Strike does                                                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No yield, no hedging           | Holders can only hold or sell                                                                                                                     | Covered-call and cash-secured-put vaults paying weekly premium in USDG                                                                                                    |
| ERC-8056 `uiMultiplier`        | Chainlink stock prices already include the dividend/split multiplier. Multiplying again overprices the token (NVDA's live multiplier is 1.000775) | Strikes, spot and payouts all stay in the feed's own per-raw-token unit. The multiplier is never applied ([fork test](contracts/test/fork/RobinhoodFork.t.sol))           |
| Weekend and holiday prices     | Tokens trade 24/7 but the equity feed freezes when NYSE is closed                                                                                 | Opening and selling need an open NYSE session. Settlement uses the first print after expiry, so a Friday expiry settles on Monday's open if there was no print in between |
| Two pause layers               | Both the token and its oracle can be paused. `oraclePaused()` does not even exist on the testnet tokens                                           | Every read checks both, defensively. Settlement waits instead of using a bad price                                                                                        |
| Splits and dividends mid-epoch | Feed and multiplier can be briefly inconsistent around `effectiveAt`                                                                              | Sales stop from announcement until `effectiveAt` plus a grace period. A settlement print inside that window is refused                                                    |
| Agents with keys               | An agent that can trade a vault can drain it                                                                                                      | Agents only propose. The contract checks the mandate and punishes violations                                                                                              |

## How it works

```mermaid
sequenceDiagram
    participant D as Depositor
    participant V as StrikeVault
    participant A as Agent (MCP)
    participant E as EpochManager
    participant B as Buyer
    D->>V: deposit TSLA (or USDG)
    A->>E: openEpoch (NYSE open, feed fresh) → vault locks
    A->>E: proposeByDelta(0.20 delta, Friday close, size, premium factor)
    E->>E: MandateGuard: delta band, premium vs Black-Scholes, yield, size, tenor
    alt outside the mandate
        E-->>A: ProposalRejected(reason), bond slashed to depositors
    else inside
        E-->>A: SeriesProposed
        B->>E: buy options (premium = fair value at live spot × factor, in USDG)
        Note over E: Friday 16:00 New York: expiry
        E->>E: settle on the first Chainlink round after expiry
        E->>V: payout to option holders, net premium to depositors, queue processed
    end
```

A covered call pays the buyer `(S − K) / S` stock tokens per option when it expires in the money. A put pays `(K − S)` USDG. Collateral is locked per option sold, so the vault can never owe more than it holds. The full lifecycle, formulas and invariants are in [docs/design.md](docs/design.md).

### Contracts

| Contract                                                                                                             | Role                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`EpochManager`](contracts/src/core/EpochManager.sol)                                                                | Epoch state machine: open, propose, buy, settle, redeem. The only contract that can lock a vault or move its collateral                                                                         |
| [`StrikeVault`](contracts/src/vaults/StrikeVault.sol)                                                                | ERC-4626 vault (EIP-1167 clone). Queues deposits and redemptions during an epoch. Pays premium through a per-share USDG accumulator                                                             |
| [`VaultFactory`](contracts/src/vaults/VaultFactory.sol)                                                              | Anyone can create a vault on an allow-listed stock token with an immutable mandate                                                                                                              |
| [`MandateGuard`](contracts/src/libraries/MandateGuard.sol)                                                           | Pure check of a proposal against the mandate. Returns one of nine named reasons                                                                                                                 |
| [`AgentRegistry`](contracts/src/agents/AgentRegistry.sol)                                                            | Agents, signer keys, payout addresses, ERC-8004 identity link, USDG bond, slashing                                                                                                              |
| [`SafeStockFeed`](contracts/src/libraries/SafeStockFeed.sol) + [`StockOracle`](contracts/src/oracle/StockOracle.sol) | Every price read: staleness, both pauses, corporate actions, sequencer uptime, settlement round selection. Reusable by any Robinhood Chain protocol: [integration guide](docs/safestockfeed.md) |
| [`MarketCalendar`](contracts/src/oracle/MarketCalendar.sol)                                                          | NYSE hours on-chain, DST-aware, with holidays and early closes                                                                                                                                  |
| [`BlackScholesLib`](contracts/src/pricing/BlackScholesLib.sol) and the [Stylus pricer](stylus/pricer/src/math.rs)    | The same fixed-point Black-Scholes algorithm in Solidity and in Rust                                                                                                                            |
| [`FeeManager`](contracts/src/core/FeeManager.sol)                                                                    | 10% performance fee on positive epoch PnL, half to the proposing agent, capped at 30%                                                                                                           |
| [`OptionToken`](contracts/src/tokens/OptionToken.sol)                                                                | ERC-1155 options, one id per series                                                                                                                                                             |

## How Strike uses the stack

| Technology                              | Where                                                                                                                                                                                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Robinhood Chain stock tokens (ERC-8056) | [`IStockToken`](contracts/src/interfaces/IStockToken.sol), the corporate-action gate in [`SafeStockFeed.corporateAction`](contracts/src/libraries/SafeStockFeed.sol#L105), real-token [fork tests](contracts/test/fork/RobinhoodFork.t.sol) |
| Chainlink stock feeds                   | [`SafeStockFeed.latest`](contracts/src/libraries/SafeStockFeed.sol#L39) and first-round-after-expiry [`settlementPrice`](contracts/src/libraries/SafeStockFeed.sol#L70)                                                                     |
| Paxos USDG                              | Premium, put collateral, fees and agent bonds. Real addresses on all four networks in [`Deploy.s.sol`](contracts/script/Deploy.s.sol#L135)                                                                                                  |
| Arbitrum Stylus                         | [`strike_for_delta`](stylus/pricer/src/math.rs#L258), used on-chain by [`proposeByDelta`](contracts/src/core/EpochManager.sol#L337). 6.5× cheaper than Solidity for this call ([gas table](docs/gas.md))                                    |
| ERC-8004 agent identity                 | [`AgentRegistry._checkIdentity`](contracts/src/agents/AgentRegistry.sol#L261) verifies `ownerOf` on the official identity registry                                                                                                          |
| MCP                                     | [`mcp/`](mcp/) server and [`agents/example`](agents/example/)                                                                                                                                                                               |

## Safety evidence

397 Foundry tests, 15 Rust tests, 95 TypeScript tests (SDK, MCP, agent) and 10 subgraph tests run in CI; 20 Playwright checks cover the app on desktop and mobile.

| Check           | Result                                                                                                                                             |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit tests      | Every function and custom error, [`contracts/test/unit`](contracts/test/unit) and neighbours                                                       |
| Coverage        | 99.2% of lines, 98.8% of statements, 95.8% of branches, 100% of functions across `src/` (`make coverage`)                                          |
| Integration     | Full epochs for calls and puts, in and out of the money, a crash to zero, the queue across epochs, rejection and slashing, abort, emergency cancel |
| Invariants      | 9 properties on a call vault and a put vault, 32,768 random calls each in the CI profile ([list](docs/testing.md#invariants))                      |
| Mutation checks | Three injected bugs, all caught by the invariants ([details](docs/testing.md#mutation-checks))                                                     |
| Differential    | Stylus (Rust) and Solidity pricers return identical results on 10,000 fuzz inputs, 300 vectors and on-chain on a Nitro dev node                    |
| Fork tests      | Robinhood Chain mainnet: real TSLA, NVDA, SPY feeds and multipliers, real USDG, real ERC-8004 registries, a full epoch                             |
| Calendar        | Session times match Python `zoneinfo` for every day from 2026 to 2030                                                                              |
| Static analysis | Slither: 0 High, every other finding justified in [docs/security/slither.md](docs/security/slither.md)                                             |
| Threat model    | 18 threats with mitigation and the test that covers each: [docs/threat-model.md](docs/threat-model.md)                                             |

The unit suite found two real bugs in the vault before deployment (claims of zero-value processed requests). Both are fixed, with regression tests ([commit](https://github.com/Prashant-thakur77/Strike/commit/9d677d5)).

## Gas: Stylus vs Solidity

Measured on an Arbitrum Nitro dev node, L2 execution gas:

| Call                                             |  Solidity |  Stylus |
| ------------------------------------------------ | --------: | ------: |
| `quote` (one Black-Scholes evaluation)           |    33,969 |  40,624 |
| `strikeForDelta` (48 evaluations)                | 1,546,443 | 235,880 |
| `EpochManager.proposeByDelta` (full transaction) | 1,908,694 | 586,289 |
| `EpochManager.buy` (full transaction)            |   330,423 | 300,739 |

The deployed Stylus pricer is reproducibly verified against this source with `cargo stylus verify` ([details](docs/gas.md#the-live-stylus-pricer-is-verifiably-this-source)). A Stylus call pays a fixed entry cost, so a single quote is cheaper in Solidity. Real work is 6.5× cheaper in Stylus, and a full proposal transaction 3.3× cheaper, with the same strike chosen. Method and scripts in [docs/gas.md](docs/gas.md).

## Deployed contracts

Robinhood Chain testnet (46630), deployed and verified on Blockscout (deploy block 125866639). The `EpochManager` prices with the Stylus pricer after an on-chain check that it returns exactly what the Solidity reference returns. Agent #1 is registered and bonded with 100 USDG; the TSLA covered-call vault holds real testnet TSLA from the Robinhood faucet. Robinhood testnet has no Chainlink stock feeds, so `MirrorFeed`s copy the mainnet Chainlink rounds ([keeper](scripts/keeper.sh)).

| Contract                                    | Address                                                                                                                                         |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| EpochManager                                | [`0xB8Ed17588AB022d8f84b8305d784Fa01478Cb7F0`](https://explorer.testnet.chain.robinhood.com/address/0xB8Ed17588AB022d8f84b8305d784Fa01478Cb7F0) |
| VaultFactory                                | [`0x9DbaFfD488FC591947149E2b27189A201C0a74f4`](https://explorer.testnet.chain.robinhood.com/address/0x9DbaFfD488FC591947149E2b27189A201C0a74f4) |
| StrikeVault implementation                  | [`0x5Fe632C9F6Df4ECb11dfef5a6112154379BCd197`](https://explorer.testnet.chain.robinhood.com/address/0x5Fe632C9F6Df4ECb11dfef5a6112154379BCd197) |
| TSLA covered-call vault                     | [`0x5655659E18bf54ee0EF8f6A816E2e18D000F7311`](https://explorer.testnet.chain.robinhood.com/address/0x5655659E18bf54ee0EF8f6A816E2e18D000F7311) |
| TSLA cash-secured-put vault                 | [`0x02B701210aA006CEAbd389dBc32af0047B1B9bbe`](https://explorer.testnet.chain.robinhood.com/address/0x02B701210aA006CEAbd389dBc32af0047B1B9bbe) |
| Stylus pricer (Rust/WASM, active pricer)    | [`0x60e947b8d2c2c34b95d88d02f0a06aefb6ccd04c`](https://explorer.testnet.chain.robinhood.com/address/0x60e947b8d2c2c34b95d88d02f0a06aefb6ccd04c) |
| BlackScholesRef (Solidity reference pricer) | [`0x79A4158900579FA0eE5b413B4724D010C8a0A8E2`](https://explorer.testnet.chain.robinhood.com/address/0x79A4158900579FA0eE5b413B4724D010C8a0A8E2) |
| StockOracle (SafeStockFeed)                 | [`0x8B89A4dE3d8E74888e0135CCBeE5eE00Df36bA9F`](https://explorer.testnet.chain.robinhood.com/address/0x8B89A4dE3d8E74888e0135CCBeE5eE00Df36bA9F) |
| MarketCalendar                              | [`0xefD1121ef13F1187F9ac9A54076DFa09A586d31D`](https://explorer.testnet.chain.robinhood.com/address/0xefD1121ef13F1187F9ac9A54076DFa09A586d31D) |
| AgentRegistry                               | [`0xAa3CA7847Af10d94CCD3eF09370Aab580A92341E`](https://explorer.testnet.chain.robinhood.com/address/0xAa3CA7847Af10d94CCD3eF09370Aab580A92341E) |
| FeeManager                                  | [`0xaD2C4aC0db613F2c7e3F060Bfdd1276912154569`](https://explorer.testnet.chain.robinhood.com/address/0xaD2C4aC0db613F2c7e3F060Bfdd1276912154569) |
| OptionToken (ERC-1155)                      | [`0x63614FB8594F0C24CfB8F419326eB3BA7C3274A7`](https://explorer.testnet.chain.robinhood.com/address/0x63614FB8594F0C24CfB8F419326eB3BA7C3274A7) |
| USDG (Paxos)                                | [`0x7E955252E15c84f5768B83c41a71F9eba181802F`](https://explorer.testnet.chain.robinhood.com/address/0x7E955252E15c84f5768B83c41a71F9eba181802F) |
| TSLA MirrorFeed (testnet)                   | [`0x8401bcb990005fCEB1390C0b10dA5bE283d6cC0F`](https://explorer.testnet.chain.robinhood.com/address/0x8401bcb990005fCEB1390C0b10dA5bE283d6cC0F) |

Stock tokens are Robinhood's own testnet tokens (TSLA `0xC9f9…Bd4E`, AMZN, PLTR, NFLX, AMD). All addresses: [`contracts/deployments/46630.json`](contracts/deployments/46630.json).

| Network                         | Status                                         |
| ------------------------------- | ---------------------------------------------- |
| Robinhood Chain testnet (46630) | Live, verified                                 |
| Arbitrum Sepolia (421614)       | Script ready, waiting for Arbitrum Sepolia ETH |
| Robinhood Chain mainnet (4663)  | Planned: one capped vault                      |

## Try it

The whole story runs locally in one command (anvil, about 15 seconds once contracts are compiled): deploy, seed, a seller agent proposes a 0.20-delta call through the MCP server, a reckless at-the-money proposal is rejected and slashed, a buyer agent pays USDG for options within its budget, time passes expiry, the keeper publishes a price, the seller settles, the buyer redeems and depositors collect. CI runs it on every push, out of the money and in the money.

```bash
scripts/demo-local.sh
```

| Vault page                                        | Agents: leaderboard and rejection feed            |
| ------------------------------------------------- | ------------------------------------------------- |
| ![Vault](docs/screenshots/desktop-vault-1-01.png) | ![Agents](docs/screenshots/desktop-agents-01.png) |

For agents: [`STRIKE_SKILL.md`](docs/STRIKE_SKILL.md) and the MCP server (`pnpm --filter @strike/mcp dev`). Agents work both sides of the market: sellers use `vault_state`, `risk_check`, `propose_epoch` and `settle_epoch`; buyers use `quote`, `hedge_plan`, `buy_options` and `redeem_options` (the example agent has `--buy --budget 10` and `--hedge 10`). For integrators: [`@strike/sdk`](sdk/src/client.ts).

## Quickstart

```bash
git clone --recursive https://github.com/Prashant-thakur77/Strike && cd Strike
make test                                  # Foundry: unit, integration, fuzz, invariants
make stylus-test                           # Rust pricer
pnpm install && pnpm -r test               # SDK, MCP server, agent
ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com forge test --root contracts --match-path "test/fork/*"
```

Deploy (writes `contracts/deployments/<chainId>.json`):

```bash
cd contracts
forge script script/Deploy.s.sol --rpc-url robinhood_testnet --broadcast
forge script script/Seed.s.sol --rpc-url robinhood_testnet --broadcast
```

## Prior art

Options vaults exist on other chains (Ribbon, now Aevo; Lyra, now Derive; Thetanuts), and a daily-options product has recently launched on Robinhood Chain. What Strike adds is the agent layer (immutable mandates, bonded agents, slashing paid to depositors, on-chain strike solving) and a price-safety layer written for ERC-8056 stock tokens that any Robinhood Chain protocol can reuse.

## Repository

| Folder            | Contents                                            |
| ----------------- | --------------------------------------------------- |
| `contracts/`      | Solidity (Foundry)                                  |
| `stylus/pricer/`  | Rust Stylus pricer                                  |
| `sdk/`            | `@strike/sdk` TypeScript client                     |
| `mcp/`            | MCP server for agents                               |
| `agents/example/` | Example strike-picking agent                        |
| `app/`            | Next.js app                                         |
| `subgraph/`       | Indexer                                             |
| `docs/`           | Plan, design, threat model, testing, gas, decisions |

## AI usage

This project was built with AI coding assistants (Claude) working under the author's direction, including code generation, tests and documentation. Every contract change is covered by the test suites above, and the design decisions are logged in [docs/decisions.md](docs/decisions.md).

## License

[MIT](LICENSE)
