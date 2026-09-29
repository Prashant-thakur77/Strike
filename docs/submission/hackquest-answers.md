# HackQuest submission answers

Paste-ready answers for the HackQuest form. Every organizer text field takes at most 300 characters ([hackathon.md](../hackathon.md)); the count after each heading is the answer's length in characters (Python `len`, line breaks included), and every answer is within the limit.

Addresses are the live v2 deployment on Robinhood Chain testnet (chain 46630, deploy block 125880607), the one with every fix from the [internal security review](../security/review-2026-09-29.md). They match the README and [`contracts/deployments/46630.json`](../../contracts/deployments/46630.json) / [`46630-vaults.json`](../../contracts/deployments/46630-vaults.json). The pre-review v1 addresses in `46630-v1*.json` are not submitted.

## Project name (6 characters)

```text
Strike
```

## One-line intro (212 characters)

```text
Weekly options vaults for Robinhood Chain stock tokens, paid in USDG. A bonded AI agent picks each strike; the contract rejects any proposal outside the vault's mandate and slashes the agent's bond to depositors.
```

## Sector (49 characters)

```text
DeFi (options, structured products) and AI agents
```

## Tags (103 characters)

```text
DeFi, Options, AI Agents, Robinhood Chain, Stock Tokens, USDG, Arbitrum Stylus, MCP, ERC-4626, ERC-8004
```

## Detailed description (298 characters)

```text
Stock-token options vaults paid in USDG. An AI agent only proposes strikes; the contract enforces an immutable mandate, slashes bad proposals to depositors and solves strikes in Stylus. Live on 46630. Addresses: https://github.com/Prashant-thakur77/Strike/blob/main/contracts/deployments/46630.json
```

Aimed at the Promising Products track (AI agents, new financial primitives). The README carries the long version.

## Link to frontend / demo (190 characters)

```text
https://github.com/Prashant-thakur77/Strike (live app URL pending Vercel). Demo video: docs/media/strike-demo.mp4. Live testnet epoch with Blockscout links: docs/testnet-epochs/2026-09-29.md
```

Replace the repository URL with the Vercel URL once the app is deployed ([deploy-app.md](../deploy-app.md)).

## Core protocol / smart contract addresses (250 characters)

```text
Robinhood Chain testnet: 0x5A3b58DF27e4DD5E0fa6493D90fF653e0E199C99 — EpochManager
Robinhood Chain testnet: 0xE5b76249041e59C74Ee317fC2729f26249618D32 — AgentRegistry
Robinhood Chain testnet: 0x60e947b8d2c2c34b95d88d02f0a06aefb6ccd04c — Stylus pricer
```

One per line, `network: address — label`. Every other address (oracle, calendar, fee manager, option token, Solidity reference pricer, MirrorFeeds) is linked from the detailed description.

## Factory / pool contracts (261 characters)

```text
Robinhood Chain testnet: 0x5665E02878fA592513C1633af2F07b08cF606beC — VaultFactory
Robinhood Chain testnet: 0xADFF7900dbe01E8170a750AB88e1f4eA8D9D1D4e — TSLA covered-call vault
Robinhood Chain testnet: 0xE33EAD75Df1aF35cBA330f1fc7636926e31c67d7 — TSLA put vault
```

## Token contracts (100 characters)

```text
Robinhood Chain testnet: 0x557060266F4aE09ae723541AC8E7E27A99B0c9DB — OptionToken (ERC-1155 options)
```

The two vaults above are also their ERC-4626 share tokens (`sTSLA-CC`, `sTSLA-CSP`). TSLA and USDG are Robinhood's and Paxos's own testnet tokens, not deployed by Strike.

## Contract address (42 characters)

```text
0x5A3b58DF27e4DD5E0fa6493D90fF653e0E199C99
```

The `EpochManager` on Robinhood Chain testnet (46630).

## Which parts of the code were produced during the buildathon? (297 characters)

```text
All of Strike's own code. The repo's first commit is 2026-09-28, during the buildathon, and the history shows each step: contracts, Stylus pricer, oracle layer, agents, SDK, MCP server, app, subgraph, review fixes, deploys. Pinned libraries (forge-std, OpenZeppelin, stylus-sdk, npm) are not ours.
```

## Progress during the hackathon (274 characters)

```text
Sep 28: contracts, Stylus pricer, invariant/fork/differential tests, agents, SDK, MCP, app, subgraph. Sep 29: deployed to Robinhood Chain testnet, internal review (1 High, 3 Medium, 4 Low, 3 Info) fixed, v2 redeployed, live epoch with an on-chain slash, backtest, litepaper.
```

## Fundraising status (11 characters)

```text
Not raised.
```

## Sponsor technologies used (41 characters)

```text
Robinhood Chain, Paxos/USDG, OpenZeppelin
```

A checkbox field; tick these three. Also used, not on the list: Arbitrum Stylus and Chainlink stock feeds.
