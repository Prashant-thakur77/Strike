# HackQuest submission answers

Fill in the addresses after deployment (they will also be in the README and `contracts/deployments/`).

## Link to frontend / demo

`<live app URL>`

## Core protocol / smart contract addresses

One per line, `network: address — label`:

```
Robinhood Chain — Robinhood Chain testnet: <EpochManager> — EpochManager (epoch state machine)
Robinhood Chain — Robinhood Chain testnet: <StockOracle> — StockOracle (SafeStockFeed + NYSE calendar)
Robinhood Chain — Robinhood Chain testnet: <AgentRegistry> — AgentRegistry (ERC-8004 link, USDG bonds, slashing)
Robinhood Chain — Robinhood Chain testnet: <FeeManager> — FeeManager
Robinhood Chain — Robinhood Chain testnet: <MarketCalendar> — MarketCalendar
Robinhood Chain — Robinhood Chain testnet: <Stylus pricer> — Stylus Black-Scholes pricer (Rust/WASM)
Arbitrum Sepolia: <EpochManager> — EpochManager
Arbitrum Sepolia: <Stylus pricer> — Stylus Black-Scholes pricer
```

## Factory / pool contracts

```
Robinhood Chain — Robinhood Chain testnet: <VaultFactory> — VaultFactory (EIP-1167 vault clones)
Robinhood Chain — Robinhood Chain testnet: <TSLA covered-call vault> — StrikeVault clone
Robinhood Chain — Robinhood Chain testnet: <TSLA cash-secured-put vault> — StrikeVault clone
Arbitrum Sepolia: <VaultFactory> — VaultFactory
```

## Token contracts

```
Robinhood Chain — Robinhood Chain testnet: <OptionToken> — ERC-1155 option positions
```

## Which parts of the code were produced during the buildathon?

All of it. The repository was started on 2026-09-28 and every line was written during the buildathon; the commit history shows each step (setup, pricer, vault, epoch manager, oracle layer, agents, tests, deploy tooling, SDK, MCP server, app, subgraph).

## Sponsor technologies used

Robinhood Chain, Paxos/USDG, OpenZeppelin.
