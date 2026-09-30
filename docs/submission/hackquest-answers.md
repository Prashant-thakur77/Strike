# HackQuest submission answers

Paste-ready answers for the HackQuest form. Every organizer text field takes at most 300 characters ([hackathon.md](../hackathon.md)). The count after each heading is the answer's length in characters (Python `len`, line breaks included). Every answer is within the limit.

Addresses are the live v2 deployment on Robinhood Chain testnet (chain 46630, deploy block 125880607), the one with every fix from the [internal security review](../security/review-2026-09-29.md). They match the README and [`contracts/deployments/46630.json`](../../contracts/deployments/46630.json) / [`46630-vaults.json`](../../contracts/deployments/46630-vaults.json). The pre-review v1 addresses in `46630-v1*.json` are not submitted.

## Project name (6 characters)

```text
Strike
```

## One-line intro (255 characters)

```text
Weekly options vaults for Robinhood Chain stock tokens, paid in USDG. A bonded AI agent proposes each week's strike. The contract rejects any proposal outside the vault's mandate and slashes the agent's bond to depositors. Live on Robinhood Chain testnet.
```

## Sector (49 characters)

```text
DeFi (options, structured products) and AI agents
```

## Tags (124 characters)

```text
DeFi, Options, AI Agents, Robinhood Chain, Stock Tokens, USDG, Arbitrum Stylus, MCP, ERC-4626, ERC-8004, Formal Verification
```

## Detailed description (293 characters)

```text
Stock-token options vaults paid in USDG. An AI agent only proposes. The contract checks its immutable mandate, slashes the agent's bond to depositors on a breach and solves strikes in Stylus. Live on 46630: https://github.com/Prashant-thakur77/Strike/blob/main/contracts/deployments/46630.json
```

Aimed at the Promising Products track (AI agents, new financial primitives). The README has the long version: 432 Foundry tests, 9 Halmos-proven properties, 99.1% line coverage, and agent #1 linked to ERC-8004 identity #114. Judges can start at [JUDGES.md](../JUDGES.md).

## Link to frontend / demo (253 characters)

```text
https://strike-options.vercel.app (no wallet needed: start with /app/playground and /app/proof). Code: https://github.com/Prashant-thakur77/Strike. Judge's tour: docs/JUDGES.md. Live testnet epoch with Blockscout links: docs/testnet-epochs/2026-09-29.md
```

The app is not deployed yet. Once it is on Vercel ([deploy-app.md](../deploy-app.md)), replace the repository URL with the app URL and recount. The two quickest things for a judge to try need no wallet. `/app/playground` tests a proposal against a live vault's mandate and shows Accepted or the rejection reason. `/app/proof` puts every claim next to its evidence, with a live feed of on-chain activity.

Videos for the form's video fields: the narrated demo ([strike-demo-narrated.mp4](../media/strike-demo-narrated.mp4), 2:55) and the pitch ([strike-pitch.mp4](../media/strike-pitch.mp4), 1:59, captions in [strike-pitch.srt](../media/strike-pitch.srt)). Upload both to YouTube (unlisted is fine) and paste those links; the files in the repo are the fallback.

## Core protocol / smart contract addresses (250 characters)

```text
Robinhood Chain testnet: 0x5A3b58DF27e4DD5E0fa6493D90fF653e0E199C99 — EpochManager
Robinhood Chain testnet: 0xE5b76249041e59C74Ee317fC2729f26249618D32 — AgentRegistry
Robinhood Chain testnet: 0x60e947b8d2c2c34b95d88d02f0a06aefb6ccd04c — Stylus pricer
```

One per line, in the form's `network: address — label` format. Every other address (oracle, calendar, fee manager, option token, Solidity reference pricer, MirrorFeeds) is linked from the detailed description.

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

## Which parts of the code were produced during the buildathon? (283 characters)

```text
All of Strike's own code, from the first commit on 2026-09-28. Git history shows each step: contracts, Stylus pricer, oracle layer, agents, SDK, MCP, app, Telegram bot, subgraph, review fixes, Halmos proofs, deploys. Libraries (forge-std, OpenZeppelin, stylus-sdk, npm) are not ours.
```

## Progress during the hackathon (289 characters)

```text
Sep 28: contracts, Stylus pricer, tests, agents, SDK, MCP, app, subgraph. Sep 29: testnet deploy, internal review (1 High, 3 Medium, 4 Low) fixed, v2 live epoch with an on-chain slash, agent on ERC-8004 as #114. Then: playground, mainnet monitor, proof page, Telegram bot, 9 Halmos proofs.
```

## Fundraising status (11 characters)

```text
Not raised.
```

## Sponsor technologies used (41 characters)

```text
Robinhood Chain, Paxos/USDG, OpenZeppelin
```

A checkbox field: tick these three. Strike also uses Arbitrum Stylus and Chainlink stock feeds, which are not on the list.
