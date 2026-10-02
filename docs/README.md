# Strike documentation

Start with the [project README](../README.md), or the [judge's tour](JUDGES.md) for a 3-minute and a 15-minute path through the evidence. This page indexes every document by what you want to do.

## Understand the protocol

| Document                                | What it covers                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [Litepaper](litepaper.md)               | The model, mechanism, agent incentives and backtest results in one read                           |
| [Design spec](design.md)                | Units, epoch lifecycle, settlement formulas, vault accounting, invariants, oracle rules, mandates |
| [SafeStockFeed guide](safestockfeed.md) | Safe stock-token prices for any Robinhood Chain protocol, and how to integrate them               |
| [Gas: Stylus vs Solidity](gas.md)       | Measured costs of the pricer and of real protocol transactions, including where Stylus loses      |
| [Decisions](decisions.md)               | Every design decision with its reason (D1–D38)                                                    |

## Check that it is safe

| Document                                                  | What it covers                                                                    |
| --------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [Threat model](threat-model.md)                           | 25 threats, each with its mitigation and the test that shows it                   |
| [Internal security review](security/review-2026-09-29.md) | 1 High, 3 Medium, 4 Low, 3 Info, all fixed with regression tests                  |
| [v3 security review](security/review-2026-10-01-v3.md)    | 4 Low, 3 Info, no High or Medium; three fixed on `v3-contracts`, not yet deployed |
| [Formal verification](security/formal-verification.md)    | 9 properties proven with Halmos, 16 more written down and marked unproven         |
| [Slither triage](security/slither.md)                     | Static analysis results and why each remaining finding is accepted                |
| [Testing](testing.md)                                     | Test suites, invariants with mutation checks, coverage, how to run each           |
| [Audit readiness](audit-readiness.md)                     | Scope and nSLOC, roles and trust, known issues, where an auditor starts           |
| [Risk model](risk-model.md)                               | What a depositor can lose, and when                                               |
| [Security policy](../SECURITY.md)                         | How to report a vulnerability                                                     |

## See it run

| Document                                                                            | What it covers                                                                                                                                                       |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Judge's tour](JUDGES.md)                                                           | The demo video, the no-wallet playground and the live transactions in 3 minutes, then a clone and the tests in 15                                                    |
| [Live epoch, 2026-09-29](testnet-epochs/2026-09-29.md)                              | The first agent-run epoch, v2 on Robinhood Chain testnet, with Blockscout links                                                                                      |
| [v3 on Arbitrum Sepolia, 2026-09-30](testnet-epochs/2026-09-30-arbitrum-sepolia.md) | v3 deployed and verified on Arbitrum Sepolia, and its live epoch on 30 September, planned by Claude                                                                  |
| [v3 on Robinhood Chain testnet](testnet-epochs/2026-09-30-v3.md)                    | v3 deployed next to v2 on 30 September, and its live epoch on 1 October ([§7](testnet-epochs/2026-09-30-v3.md#7-live-epoch-1-october)), planned by Claude            |
| [Agent log](agent-log/README.md)                                                    | The agent's decision records for each vault and epoch, anchored on-chain in the DecisionLog                                                                          |
| [Deployments and versions](DEPLOYMENTS.md)                                          | Every deployment (v1, v2, v3 on Robinhood Chain testnet and Arbitrum Sepolia): commits, blocks, addresses, verification, live transactions, and how to re-check each |
| [Tester guide](testers.md)                                                          | Five minutes: the no-wallet playground, then testnet tokens, the app, the example agent and the feedback form                                                        |
| [Backtest](backtest.md)                                                             | Eight years of weekly epochs on TSLA, NVDA, AMZN and SPY                                                                                                             |

## Build on it or run it

| Document                                              | What it covers                                                                                        |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [Agent skill file](STRIKE_SKILL.md)                   | Everything an AI agent needs to use Strike through MCP                                                |
| [Agent registration file](agents/strike-agent-1.json) | Agent #1's ERC-8004 registration (identity #114 on Robinhood Chain testnet, #253 on Arbitrum Sepolia) |
| [Operations runbook](operations.md)                   | Weekly schedule, incidents and the right response, keys, alerts                                       |
| [Deploying the app](deploy-app.md)                    | The two-minute Vercel setup                                                                           |
| [Indexing](indexing.md)                               | The subgraph: hosts, deployment, example queries                                                      |
| [Telegram bot](../bots/telegram/README.md)            | Alerts and commands, setup and hosting                                                                |
| [Builder feedback](FEEDBACK.md)                       | What we would improve in Robinhood Chain and Arbitrum tooling                                         |

## Project history and hackathon

| Document                              | What it covers                                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [Changelog](../CHANGELOG.md)          | Every release and deployment                                                                       |
| [Charts](../scripts/charts/README.md) | How the README charts are built from data, the palette and its validation                          |
| [Research](research.md)               | Verified chain facts, the buildathon's rules and deadlines, competitors                            |
| [Milestones](MILESTONES.md)           | Milestone plan for the grant: deliverables, acceptance criteria, timeline and budget               |
| [Submission kit](submission/)         | Form answers, demo and pitch scripts, deck outline, posts, [hard questions](submission/qa-prep.md) |
| [Media credits](media/CREDITS.md)     | Footage, music and voice credits for the demo and pitch videos                                     |
