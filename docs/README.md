# Strike documentation

Start with the [project README](../README.md). This page indexes every document by what you want to do.

## Understand the protocol

| Document                                | What it covers                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [Litepaper](litepaper.md)               | The model, mechanism, agent incentives and backtest results in one read                           |
| [Design spec](design.md)                | Units, epoch lifecycle, settlement formulas, vault accounting, invariants, oracle rules, mandates |
| [SafeStockFeed guide](safestockfeed.md) | Safe stock-token prices for any Robinhood Chain protocol, and how to integrate them               |
| [Gas: Stylus vs Solidity](gas.md)       | Measured costs of the pricer and of real protocol transactions, including where Stylus loses      |
| [Decisions](decisions.md)               | Every design decision with its reason (D1–D31)                                                    |

## Check that it is safe

| Document                                                  | What it covers                                                          |
| --------------------------------------------------------- | ----------------------------------------------------------------------- |
| [Threat model](threat-model.md)                           | 21 threats, each with its mitigation and the test that shows it         |
| [Internal security review](security/review-2026-09-29.md) | 1 High, 3 Medium, 4 Low, 3 Info, all fixed with regression tests        |
| [Slither triage](security/slither.md)                     | Static analysis results and why each remaining finding is accepted      |
| [Testing](testing.md)                                     | Test suites, invariants with mutation checks, coverage, how to run each |
| [Audit readiness](audit-readiness.md)                     | Scope and nSLOC, roles and trust, known issues, where an auditor starts |
| [Risk model](risk-model.md)                               | What a depositor can lose, and when                                     |
| [Security policy](../SECURITY.md)                         | How to report a vulnerability                                           |

## See it run

| Document                                               | What it covers                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| [Live epoch, 2026-09-29](testnet-epochs/2026-09-29.md) | The first agent-run epoch on Robinhood Chain testnet, with Blockscout links    |
| [Tester guide](testers.md)                             | Five minutes on testnet: tokens, the app, the example agent, the feedback form |
| [Backtest](backtest.md)                                | Eight years of weekly epochs on TSLA, NVDA, AMZN and SPY                       |

## Build on it or run it

| Document                                   | What it covers                                                  |
| ------------------------------------------ | --------------------------------------------------------------- |
| [Agent skill file](STRIKE_SKILL.md)        | Everything an AI agent needs to use Strike through MCP          |
| [Operations runbook](operations.md)        | Weekly schedule, incidents and the right response, keys, alerts |
| [Deploying the app](deploy-app.md)         | The two-minute Vercel setup                                     |
| [Indexing](indexing.md)                    | The subgraph: hosts, deployment, example queries                |
| [Telegram bot](../bots/telegram/README.md) | Alerts and commands, setup and hosting                          |
| [Builder feedback](FEEDBACK.md)            | What we would improve in Robinhood Chain and Arbitrum tooling   |

## Project history and hackathon

| Document                                                 | What it covers                                            |
| -------------------------------------------------------- | --------------------------------------------------------- |
| [Changelog](../CHANGELOG.md)                             | Every release and deployment                              |
| [Plan](PLAN.md) and [cycle plans](plans/)                | The original plan and each improvement cycle              |
| [Progress](progress.md)                                  | Status by day                                             |
| [Scorecard](review.md)                                   | Self-assessment against the judging criteria, by cycle    |
| [Hackathon facts](hackathon.md), [research](research.md) | Rules, deadlines, verified chain facts, competitors       |
| [Submission kit](submission/)                            | Form answers, demo and pitch scripts, deck outline, posts |
