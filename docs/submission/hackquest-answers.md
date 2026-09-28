# HackQuest submission answers

Addresses below are the live Robinhood Chain testnet deployment (also in the README and `contracts/deployments/46630.json`).

## Link to frontend / demo

`<live app URL>`

## Core protocol / smart contract addresses

One per line, `network: address — label`:

```
Robinhood Chain — Robinhood Chain testnet: 0x5A3b58DF27e4DD5E0fa6493D90fF653e0E199C99 — EpochManager (epoch state machine)
Robinhood Chain — Robinhood Chain testnet: 0x7bb3cAb211E7Ce51e37693E0155C77f477F8aB89 — StockOracle (SafeStockFeed + NYSE calendar)
Robinhood Chain — Robinhood Chain testnet: 0xE5b76249041e59C74Ee317fC2729f26249618D32 — AgentRegistry (ERC-8004 link, USDG bonds, slashing)
Robinhood Chain — Robinhood Chain testnet: 0x6b23819bC44EEbE1BD004208c0F00f2ed002B621 — FeeManager
Robinhood Chain — Robinhood Chain testnet: 0x214d21F4fCA2226091AF009B9F1BF1D3C63f95F4 — MarketCalendar
Robinhood Chain — Robinhood Chain testnet: 0x60e947b8d2c2c34b95d88d02f0a06aefb6ccd04c — Stylus Black-Scholes pricer (Rust/WASM, active pricer)
Robinhood Chain — Robinhood Chain testnet: 0x4261d47E6487e2533EdB9D5F91242F28121d5A1A — BlackScholesRef (Solidity reference pricer)
```

## Factory / pool contracts

```
Robinhood Chain — Robinhood Chain testnet: 0x5665E02878fA592513C1633af2F07b08cF606beC — VaultFactory (EIP-1167 vault clones)
Robinhood Chain — Robinhood Chain testnet: 0xADFF7900dbe01E8170a750AB88e1f4eA8D9D1D4e — StrikeVault clone (TSLA covered call)
Robinhood Chain — Robinhood Chain testnet: 0xE33EAD75Df1aF35cBA330f1fc7636926e31c67d7 — StrikeVault clone (TSLA cash-secured put)
Robinhood Chain — Robinhood Chain testnet: 0x900e7C78598C3AbC38FDD411756c38CF7931797D — StrikeVault implementation
```

## Token contracts

```
Robinhood Chain — Robinhood Chain testnet: 0x557060266F4aE09ae723541AC8E7E27A99B0c9DB — ERC-1155 option positions
```

## Which parts of the code were produced during the buildathon?

All of it. The repository was started on 2026-09-28 and every line was written during the buildathon; the commit history shows each step (setup, pricer, vault, epoch manager, oracle layer, agents, tests, deploy tooling, SDK, MCP server, app, subgraph).

## Sponsor technologies used

Robinhood Chain, Paxos/USDG, OpenZeppelin.
