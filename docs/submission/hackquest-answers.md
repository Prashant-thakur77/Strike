# HackQuest submission answers

Addresses below are the live Robinhood Chain testnet deployment (also in the README and `contracts/deployments/46630.json`).

## Link to frontend / demo

`<live app URL>`

## Core protocol / smart contract addresses

One per line, `network: address — label`:

```
Robinhood Chain — Robinhood Chain testnet: 0xB8Ed17588AB022d8f84b8305d784Fa01478Cb7F0 — EpochManager (epoch state machine)
Robinhood Chain — Robinhood Chain testnet: 0x8B89A4dE3d8E74888e0135CCBeE5eE00Df36bA9F — StockOracle (SafeStockFeed + NYSE calendar)
Robinhood Chain — Robinhood Chain testnet: 0xAa3CA7847Af10d94CCD3eF09370Aab580A92341E — AgentRegistry (ERC-8004 link, USDG bonds, slashing)
Robinhood Chain — Robinhood Chain testnet: 0xaD2C4aC0db613F2c7e3F060Bfdd1276912154569 — FeeManager
Robinhood Chain — Robinhood Chain testnet: 0xefD1121ef13F1187F9ac9A54076DFa09A586d31D — MarketCalendar
Robinhood Chain — Robinhood Chain testnet: 0x60e947b8d2c2c34b95d88d02f0a06aefb6ccd04c — Stylus Black-Scholes pricer (Rust/WASM, active pricer)
Robinhood Chain — Robinhood Chain testnet: 0x79A4158900579FA0eE5b413B4724D010C8a0A8E2 — BlackScholesRef (Solidity reference pricer)
```

## Factory / pool contracts

```
Robinhood Chain — Robinhood Chain testnet: 0x9DbaFfD488FC591947149E2b27189A201C0a74f4 — VaultFactory (EIP-1167 vault clones)
Robinhood Chain — Robinhood Chain testnet: 0x5655659E18bf54ee0EF8f6A816E2e18D000F7311 — StrikeVault clone (TSLA covered call)
Robinhood Chain — Robinhood Chain testnet: 0x02B701210aA006CEAbd389dBc32af0047B1B9bbe — StrikeVault clone (TSLA cash-secured put)
Robinhood Chain — Robinhood Chain testnet: 0x5Fe632C9F6Df4ECb11dfef5a6112154379BCd197 — StrikeVault implementation
```

## Token contracts

```
Robinhood Chain — Robinhood Chain testnet: 0x63614FB8594F0C24CfB8F419326eB3BA7C3274A7 — ERC-1155 option positions
```

## Which parts of the code were produced during the buildathon?

All of it. The repository was started on 2026-09-28 and every line was written during the buildathon; the commit history shows each step (setup, pricer, vault, epoch manager, oracle layer, agents, tests, deploy tooling, SDK, MCP server, app, subgraph).

## Sponsor technologies used

Robinhood Chain, Paxos/USDG, OpenZeppelin.
