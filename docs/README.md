# Strike documentation

Start with the [project README](../README.md), or the [judge's tour](JUDGES.md) for a 3-minute and a 15-minute path through the evidence. This page indexes every document by what you want to do.

## Understand the protocol

| Document                                | What it covers                                                                                        |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [Technical note](technical-note.md)     | The problem, the design, the trust model, what is tested and the path to production, in 2 to 4 pages  |
| [Sponsor technology](sponsor-tech.md)   | Each sponsor feature Strike uses: why, what breaks without it, code, transaction or live link, status |
| [Litepaper](litepaper.md)               | The model, mechanism, agent incentives and backtest results in one read                               |
| [Design spec](design.md)                | Units, epoch lifecycle, settlement formulas, vault accounting, invariants, oracle rules, mandates     |
| [SafeStockFeed guide](safestockfeed.md) | Safe stock-token prices for any Robinhood Chain protocol, and how to integrate them                   |
| [Gas: Stylus vs Solidity](gas.md)       | Measured costs of the pricer and of real protocol transactions, including where Stylus loses          |
| [Decisions](decisions.md)               | Every design decision with its reason and the alternative it rejected (D1–D45)                        |

## Check that it is safe

| Document                                                  | What it covers                                                                                                                                                                      |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Trust model](trust-model.md)                             | What is trusted and what is verified, component by component, how to check each, and what breaks if it misbehaves; the price mirror audit (`node scripts/verify-mirror.mjs`)        |
| [Threat model](threat-model.md)                           | 25 threats, each with its mitigation and the test that shows it                                                                                                                     |
| [Internal security review](security/review-2026-09-29.md) | 1 High, 3 Medium, 4 Low, 3 Info, all fixed with regression tests                                                                                                                    |
| [v3 security review](security/review-2026-10-01-v3.md)    | 4 Low, 3 Info, no High or Medium; three fixed on `v3-contracts`, not yet deployed                                                                                                   |
| [Adversarial suite](security/adversarial.md)              | Attacks by category (cheat, replay, double-spend, offline), defence, test, result                                                                                                   |
| [Verify it yourself](verify-yourself.md)                  | Six checks with `cast`, `jq` and `curl` only, no Strike code: a buy, a rejection and its slash, a decision record, a mirrored price, the settlement price, a vault's mandate        |
| [Evidence](evidence/README.md)                            | One proven week per deployment read from the chain, `facts.json` (every count the docs state, checked by `check-numbers.mjs`) and `lessons.json` (what went wrong in the live runs) |
| [Formal verification](security/formal-verification.md)    | 9 properties proven with Halmos, 16 more written down and marked unproven                                                                                                           |
| [Slither triage](security/slither.md)                     | Static analysis results and why each remaining finding is accepted                                                                                                                  |
| [Testing](testing.md)                                     | Test suites, invariants with mutation checks, coverage, how to run each                                                                                                             |
| [Audit readiness](audit-readiness.md)                     | Scope and nSLOC, roles and trust, known issues, where an auditor starts                                                                                                             |
| [Risk model](risk-model.md)                               | What a depositor can lose, and when                                                                                                                                                 |
| [Security policy](../SECURITY.md)                         | How to report a vulnerability                                                                                                                                                       |

## See it run

| Document                                                                              | What it covers                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Judge's tour](JUDGES.md)                                                             | The demo video, the no-wallet playground and the live transactions in 3 minutes, then a clone and the tests in 15                                                                                     |
| [Live epoch, 2026-09-29](testnet-epochs/2026-09-29.md)                                | The first agent-run epoch, v2 on Robinhood Chain testnet, with Blockscout links                                                                                                                       |
| [Price mirror audit, 2026-10-02](testnet-epochs/2026-10-02-mirror-audit.md)           | The first runs of `verify-mirror.mjs` on both testnets: every keeper round against mainnet Chainlink, the deploy seeds, a fabricated round caught on a fork, the settlement dry run                   |
| [v3 on Arbitrum Sepolia, 2026-09-30](testnet-epochs/2026-09-30-arbitrum-sepolia.md)   | v3 deployed and verified on Arbitrum Sepolia, and its live epoch on 30 September, planned by Claude                                                                                                   |
| [v3 on Robinhood Chain testnet](testnet-epochs/2026-09-30-v3.md)                      | v3 deployed next to v2 on 30 September, and its live epoch on 1 October ([§7](testnet-epochs/2026-09-30-v3.md#7-live-epoch-1-october)), planned by Claude                                             |
| [Agent #2 joins, 2026-10-01](testnet-epochs/2026-10-01-agent2.md)                     | A second agent registered from a fresh wallet through the app, with its own ERC-8004 identity, bond and conservative put vault                                                                        |
| [Settlement rehearsal, 2026-10-01](testnet-epochs/2026-10-02-settlement-rehearsal.md) | The 2 October settlement run on anvil forks of both chains, in and out of the money, and the four keeper bugs it found                                                                                |
| [End-to-end QA, 2026-10-03](testnet-epochs/2026-10-03-end-to-end-qa.md)               | The live app walked through as a newcomer with three team QA wallets on both testnets, every flow's result and transaction, seven bugs fixed with their commits, and the mobile pass at 360 to 768 px |
| [Agent log](agent-log/README.md)                                                      | The agents' decision records for each vault and epoch, anchored on-chain in the DecisionLog, and the specialist pipeline's [dry runs](agent-log/dry-runs)                                             |
| [Deployments and versions](DEPLOYMENTS.md)                                            | Every deployment (v1, v2, v3 on Robinhood Chain testnet and Arbitrum Sepolia): commits, blocks, addresses, verification, live transactions, and how to re-check each                                  |
| [Tester guide](testers.md)                                                            | Five minutes: the no-wallet playground, then testnet tokens, the app, the example agent and the feedback form                                                                                         |
| [Backtest](backtest.md)                                                               | Eight years of weekly epochs on TSLA, NVDA, AMZN and SPY                                                                                                                                              |

## Build on it or run it

| Document                                               | What it covers                                                                                                                                            |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Endpoints](ENDPOINTS.md)                              | Every HTTP route, `/skill.md` and `/llms.txt`, the remote and stdio MCP tools, the indexer, the Telegram bot and the SDK                                  |
| [Event indexer](../services/indexer/README.md)         | The Postgres indexer: endpoints, schema, reorg handling, tests, the live check                                                                            |
| [Agent skill file](STRIKE_SKILL.md)                    | Everything an AI agent needs to use Strike through MCP                                                                                                    |
| [Agent registration files](agents/strike-agent-1.json) | Agent #1's ERC-8004 registration (identity #114 on Robinhood Chain testnet, #253 on Arbitrum Sepolia) and [agent #2's](agents/strike-agent-2.json) (#116) |
| [Operations runbook](operations.md)                    | What runs where during judging, the weekly schedule, incidents and the right response, keys, the live smoke test, alerts                                  |
| [Configuration](configuration.md)                      | `strike.config.json`: each field, who reads it, how secrets are provided                                                                                  |
| [Deploying the app](deploy-app.md)                     | The two-minute Vercel setup                                                                                                                               |
| [Indexing](indexing.md)                                | The subgraph: hosts, deployment, example queries                                                                                                          |
| [Telegram bot](../bots/telegram/README.md)             | Alerts and commands, setup and hosting                                                                                                                    |
| [Builder feedback](FEEDBACK.md)                        | What we would improve in Robinhood Chain and Arbitrum tooling                                                                                             |

## Project history and hackathon

| Document                              | What it covers                                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [Changelog](../CHANGELOG.md)          | Every release and deployment                                                                       |
| [Charts](../scripts/charts/README.md) | How the README charts are built from data, the palette and its validation                          |
| [Research](research.md)               | Verified chain facts, the buildathon's rules and deadlines, competitors                            |
| [Milestones](MILESTONES.md)           | Milestone plan for the grant: deliverables, acceptance criteria, timeline and budget               |
| [Submission kit](submission/)         | Form answers, demo and pitch scripts, deck outline, posts, [hard questions](submission/qa-prep.md) |
| [Media credits](media/CREDITS.md)     | Footage, music and voice credits for the demo and pitch videos                                     |
