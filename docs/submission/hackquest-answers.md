# HackQuest submission answers

Paste-ready answers for the HackQuest form. Every organizer text field takes at most 300 characters ([HackQuest](https://www.hackquest.io/hackathons/Arbitrum-Open-House-Singapore-Online-Buildathon)). The count after each heading is the answer's length in characters (Python `len`, line breaks included). Every answer is within the limit.

Addresses are the v2 deployment on Robinhood Chain testnet (chain 46630, deploy block 125880607), the one with every fix from the [internal security review](../security/review-2026-09-29.md) and the app's default, plus the v3 `EpochManager` on Arbitrum Sepolia (421614). They match the README and [`contracts/deployments/46630.json`](../../contracts/deployments/46630.json) / [`46630-vaults.json`](../../contracts/deployments/46630-vaults.json) / [`421614.json`](../../contracts/deployments/421614.json). v3 on Robinhood Chain testnet ([`46630-v3.json`](../../contracts/deployments/46630-v3.json)) does not fit in the address fields; it is in the README and [DEPLOYMENTS.md](../DEPLOYMENTS.md). The pre-review v1 addresses in `46630-v1*.json` are not submitted.

## Project name (6 characters)

```text
Strike
```

## One-line intro (276 characters)

```text
Weekly options vaults for Robinhood Chain stock tokens, paid in USDG. A bonded AI agent proposes each week's strike. The contract rejects any proposal outside the vault's mandate and slashes the agent's bond to depositors. Live on Robinhood Chain testnet and Arbitrum Sepolia.
```

## Sector (49 characters)

```text
DeFi (options, structured products) and AI agents
```

## Tags (147 characters)

```text
DeFi, Options, AI Agents, RWA, Robinhood Chain, Arbitrum Sepolia, Stock Tokens, USDG, Arbitrum Stylus, MCP, ERC-4626, ERC-8004, Formal Verification
```

## Detailed description (288 characters)

```text
Stock-token options vaults paid in USDG. An AI agent only proposes; the contract checks its immutable mandate, slashes its bond to depositors on a breach, and prices risk in Stylus (Rust). Live on 46630 and 421614: https://github.com/Prashant-thakur77/Strike/blob/main/docs/DEPLOYMENTS.md
```

Aimed at the Promising Products track (AI agents, new financial primitives). The README has the long version: 1,811 tests and proofs (607 Foundry tests, 9 Halmos-proven properties), 99.3% line coverage, three live epochs (Claude planned the accepted proposal in the two v3 ones), and agent #1 linked to ERC-8004 identities #114 (Robinhood Chain testnet) and #253 (Arbitrum Sepolia). Judges can start at [JUDGES.md](../JUDGES.md).

How Strike fits the buildathon's workshop themes, for the long-form fields and for judges who ask:

- Tokenized RWAs: Strike pays weekly income on tokenized stocks, which are real-world assets, and its `SafeStockFeed` handles their traps (the ERC-8056 multiplier, weekend price freezes, two pause flags, corporate actions).
- The wedge: stock-token holders on Robinhood Chain who want income. The options venues on the chain have the holder pick each strike or do not say who does; in Strike a bonded agent picks it and the contract holds it to an on-chain mandate, which is the hard part to copy. No outside users yet.
- Security: an internal review with every finding fixed, Halmos proofs, an adversarial suite with a mutation check, a threat model; no external audit yet ([JUDGES.md](../JUDGES.md#how-strike-maps-to-the-workshop-themes)).
- Governance: today one deployer key holds the testnet admin roles and is trusted; on mainnet the admin is a Safe behind a 73-day timelock ([D43](../decisions.md#d43--on-mainnet-the-admin-is-a-safe-behind-a-73-day-timelock-2026-10-02)), written and tested, not yet run.
- Agentic, on Arbitrum: Stylus (Rust) strike solver and risk engine, a pipeline of specialist agents, an MCP server on npm and hosted.
- Onboarding without test ETH is done: a new wallet gets its first gas from the faucet page's Get started, relayed from the team-funded GasDrip contract on both testnets (D49). After the buildathon: x402 payments for agents and Pendle yield on idle put collateral are being built on their own branches, and Dune queries for the mainnet stock-token market are written and not yet published ([Roadmap after the buildathon](../../README.md#roadmap-after-the-buildathon)).

## Link to frontend / demo (257 characters)

```text
https://strike-options.vercel.app (no wallet needed: start with /app/playground and /app/proof). Code: https://github.com/Prashant-thakur77/Strike. Judge's tour: docs/JUDGES.md. Three live epochs on two chains, with explorer links: README.md#the-live-epochs
```

The app is live on Vercel. The two quickest things for a judge to try need no wallet. `/app/playground` tests a proposal against a live vault's mandate and shows Accepted or the rejection reason. `/app/proof` puts every claim next to its evidence, with a live feed of on-chain activity.

Videos for the form's video fields: the narrated demo ([strike-demo.mp4](../media/strike-demo.mp4), 5:56, chapters and description text in [demo-script.md](demo-script.md#chapters)) and the pitch ([strike-pitch.mp4](../media/strike-pitch.mp4), 2:40: a short hook, then the founder, then the deck; captions in [strike-pitch.srt](../media/strike-pitch.srt)). The founder intro alone is [strike-founder.mp4](../media/strike-founder.mp4) (0:47), with a 9:16 cut for Reels and Shorts, [strike-founder-vertical.mp4](../media/strike-founder-vertical.mp4). Upload both to YouTube (unlisted is fine) and paste those links; the files in the repo are the fallback.

## Core protocol / smart contract addresses (257 characters)

```text
Robinhood Chain testnet: 0x5A3b58DF27e4DD5E0fa6493D90fF653e0E199C99 — EpochManager (v2)
Robinhood Chain testnet: 0x60e947b8d2c2c34b95d88d02f0a06aefb6ccd04c — Stylus pricer (v2)
Arbitrum Sepolia: 0xB8Ed17588AB022d8f84b8305d784Fa01478Cb7F0 — EpochManager (v3)
```

One per line, in the form's `network: address — label` format. The Arbitrum Sepolia line is v3, live since 2026-09-30 with its first epoch ([log](../testnet-epochs/2026-09-30-arbitrum-sepolia.md)). v3 on Robinhood Chain testnet (`EpochManager` `0x256D4546486368dCb23E94758b4cb500c215929F`, first epoch on 1 October, [log §7](../testnet-epochs/2026-09-30-v3.md#7-live-epoch-1-october)) would make a fourth line, so it is left to the README. Every other address (oracle, calendar, fee manager, option token, Solidity reference pricer, MirrorFeeds) is linked from the detailed description.

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

The v2 `EpochManager` on Robinhood Chain testnet (46630), the deployment the app, SDK and MCP read by default.

## Which parts of the code were produced during the buildathon? (283 characters)

```text
All of Strike's own code, from the first commit on 2026-09-28. Git history shows each step: contracts, Stylus pricer, oracle layer, agents, SDK, MCP, app, Telegram bot, subgraph, review fixes, Halmos proofs, deploys. Libraries (forge-std, OpenZeppelin, stylus-sdk, npm) are not ours.
```

## Progress during the hackathon (299 characters)

```text
Sep 28: contracts, Stylus pricer, agents, SDK, MCP, app. Sep 29: testnet, review fixes, live epoch with an on-chain slash. Sep 30: Halmos proofs, v3 with a Rust risk engine on 2 chains, Claude-planned epoch. Oct 1: v3 on Robinhood Chain, agent #2. Oct 2-3: agent pipeline, decision pages, CI keeper.
```

On the HackQuest project page this field is a full text editor, so it takes the longer version as one story (the short one above is for 300-character forms):

```text
Strike is an idea we have wanted to build for a long time: let people earn every week on the stocks they already hold, with an AI agent doing the work and a contract making sure it cannot misuse their money. When Robinhood Chain put stock tokens on-chain and Arbitrum opened this buildathon, we finally had the place and the reason to build it. We wrote all of Strike's code during the buildathon, starting from an empty repository on 28 September.

We began with the contracts: vaults whose rules are fixed at creation, an EpochManager that checks every agent proposal against those rules and slashes the agent's bond when it breaks them, and an oracle layer that handles the traps of stock tokens (the dividend multiplier, weekend price freezes, pauses, splits). The strike solver went into Rust on Arbitrum Stylus, where it costs 6.5 times less gas than in Solidity. Around the contracts we built an SDK, an MCP server so any AI agent can use Strike, an example agent and the web app.

Once it worked end to end, we deployed on Robinhood Chain testnet, ran an internal security review and fixed every finding, and ran the first live epoch: an agent's proposal accepted, a reckless one rejected with its bond slashed to depositors, and a buyer purchasing the options. Formal proofs, a second version with a Rust risk engine, and deployment on Arbitrum Sepolia followed. On both chains Claude itself planned a live proposal, with each decision recorded and hash-anchored on-chain. A second agent joined through the app the way an outsider would.

In the final days we reviewed the new code a second time, rehearsed the settlement on copies of both chains (which caught four bugs before they could matter), added a test-USDG faucet so anyone can try a real transaction, and published the SDK and MCP server to npm. On 2 and 3 October the example agent became a pipeline of specialists (a market analyst, a risk analyst, a strike planner and a critic, before the contract judges), every decision record got its own page showing what the agent chose, what it passed over and why, and the keeper and the weekly agent moved from a laptop to GitHub Actions. Agent #2's first proposal was accepted on 2 October. The three live series expired that evening five minutes after the last stock price print of the day, so they settle at the first print of Monday 5 October. The buildathon was where Strike started as code; we intend to keep building it as a company.
```

## Fundraising status (291 characters)

```text
Not raised yet. We are seeking a milestone grant and a pre-seed round to build Strike as a company on Robinhood Chain and Arbitrum: an external audit first, then a capped mainnet vault. For the chains it means weekly income on stock tokens, USDG demand and bonded agents with public records.
```

The plan behind it, how Strike makes money, the four funded milestones ($30,000 in all) and what Robinhood Chain, Arbitrum and Paxos get are in the README's [Building Strike as a company](../../README.md#building-strike-as-a-company).

## Sponsor technologies used (41 characters)

```text
Robinhood Chain, Paxos/USDG, OpenZeppelin
```

A checkbox field: tick these three. Strike also uses Arbitrum Stylus and Chainlink stock feeds, which are not on the list.
