# Win scorecard

Updated at the end of every phase and every improvement cycle. A score without linked evidence counts as 5.

## Latest: end of Phase 2, Phase 3 contracts done (2026-09-28)

### A. Hard requirements

| Requirement                                                                     | Status                      | Evidence                                                                                                                                                           |
| ------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Deployed and verified on Robinhood Chain 46630 and/or 4663, addresses in README | **YES** (46630, 2026-09-28) | One-command deploy + Blockscout verify ([scripts/deploy-testnet.sh](../scripts/deploy-testnet.sh)) rehearsed on a testnet fork. Waiting for funds on `0x26b2…13Ff` |
| Also deployed on Arbitrum Sepolia or One                                        | NO (ready)                  | Same script, `arbitrum-sepolia`                                                                                                                                    |
| USDG is the premium and settlement asset (real addresses)                       | YES in code                 | Real USDG on 4 networks in [Deploy.s.sol](../contracts/script/Deploy.s.sol); fork test uses real mainnet USDG                                                      |
| Public repo, live demo URL, demo video, pitch video                             | PARTIAL                     | Repo public with CI. App in progress; videos need the owner ([req-you](req-you.md))                                                                                |
| HackQuest submission before the deadline                                        | NO                          | Answers drafted in [submission/hackquest-answers.md](submission/hackquest-answers.md)                                                                              |

### B. Judging scores

| Criterion                     | Weight | Score | Evidence                                                                                                                                                                                                                                           | Gap to 10                                                                                    |
| ----------------------------- | ------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Smart contract quality        | 30%    | 8.5   | 373 tests, 9 invariants × 2 vaults with mutation checks ([testing.md](testing.md)), fork tests on 4663, exact Rust/Solidity differential, Slither 0 High ([triage](security/slither.md)), [threat model](threat-model.md), [gas table](gas.md), CI | Live deployment + verification; coverage report; CI green on the latest commit               |
| Real problem solving          | 20%    | 7     | Gap table with sources in the [README](../README.md#why); each fix has a test                                                                                                                                                                      | Demo on testnet showing each fix (paused oracle, weekend settlement, multiplier)             |
| Product-market fit            | 20%    | 5     | Users and fee model in [PLAN](PLAN.md#who-uses-it); fee code in [FeeManager](../contracts/src/core/FeeManager.sol)                                                                                                                                 | SDK/MCP shipped, live app, 10+ testnet users with feedback                                   |
| Innovation                    | 15%    | 7.5   | Contract-enforced mandates with slashing to depositors; on-chain strike solving by delta with Stylus (6.5× cheaper); oracle-anchored premiums                                                                                                      | Working agent demo; "first options" claim is not available (a daily-options product is live) |
| Robinhood + USDG + agents fit | 15%    | 6     | Built only for ERC-8056 stock tokens, real feeds, USDG everywhere, ERC-8004 link                                                                                                                                                                   | Deployed on 46630 (and 4663), MCP agent demo with a rejected proposal                        |

**Weighted score: 6.9 / 10.** Done condition not met: no deployment yet, app and agent demo still being built.

### C. Judge simulation (cycle 1, 2026-09-28)

**Arbitrum DevRel engineer.** "Serious engineering: exact Rust/Solidity differential tests, a published gas table that admits where Stylus loses, invariants with mutation checks, fork tests on 4663. But:"

1. Nothing is deployed on an Arbitrum chain yet. **Serious** (disqualifying if unresolved). Task: deploy on 46630 and 421614 the moment funds land; `scripts/deploy-testnet.sh` is ready.
2. No live URL for the app. **Serious** for the submission form. Task: Vercel deployment (owner account).
3. Is the Stylus pricer the one production uses, and is it verified? Medium. Task: deploy script switches the EpochManager to Stylus after an on-chain equality check; reproducible build for `cargo stylus verify` (done).

**Robinhood Chain PM.** "Built around our tokens' real quirks, which almost nobody handles. But:"

1. Prices and strikes are per raw token; users think in shares. Medium. Task: per-share display using `uiMultiplier` (in progress).
2. Stock tokens are non-US only; the app should say so before use. Medium. Task: US-person acknowledgement gate (in progress).
3. Testnet uses mirrored feeds; show us mainnet. Medium. Task: one capped vault on 4663 after testnet (owner approval).

**DeFi VC.** "Clear fee model and an agent angle that is more than a buzzword. But:"

1. Who buys the options? A vault that sells into no demand earns nothing. **Serious.** Task: agents and integrators as buyers: MCP `buy_options` / `hedge_plan` tools and a buyer mode in the example agent (in progress); pitch hedging for stock-token holders and leveraged upside for traders.
2. No users yet. **Serious** for product-market fit. Task: testnet feedback form (in progress) and 10+ testers (owner).
3. The market is small ($14M of stock tokens). Medium. Answer in the pitch: the same vaults work for any ERC-20 stock token with a Chainlink feed; Robinhood Chain is the beachhead, SDK integrations are the distribution.

### D. Competitor check (cycle 1)

| Project                                                           | What it is                                                                                                      | Why a judge would pick Strike                                                                                                                         | Where Strike could lose                                                                                  |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| HarvestBot                                                        | Tax-loss harvesting agent with an on-chain mandate, Stylus ledger and slashable bond, live on Robinhood testnet | Strike's mandate protects third-party depositors' money, and slashed bonds pay them; it creates a yield product, not a tax tool; deeper test evidence | They are deployed and live; similar agent-mandate idea. Fix: deploy                                      |
| StockGuard                                                        | Morpho oracle guard against wrong/stale stock prices                                                            | `SafeStockFeed` covers the same checks (multiplier, staleness, pauses) plus market hours and settlement round selection, inside a working product     | Focused single tool, easy to audit. Answer: Strike's oracle layer is reusable on its own (`StockOracle`) |
| Lexifi                                                            | Compliance rules for Uniswap v4 pools, live on 4663                                                             | Different problem; Strike creates income for holders                                                                                                  | Mainnet presence. Fix: capped mainnet vault                                                              |
| Manda                                                             | Human-owned payment identity with bounded agent authority (ERC-4337)                                            | Strike's agents move markets inside a financial mandate with economic penalties                                                                       | Account-abstraction UX. Roadmap: USDG paymaster                                                          |
| Regen Bazaar                                                      | Tokenized real-world impact marketplace                                                                         | Strike targets the chain's core asset class (stock tokens)                                                                                            | None on fit                                                                                              |
| ProtoRWA                                                          | Hardware manufacturing escrow in USDG, Stylus Merkle verifier                                                   | Clearer demand (stock holders want yield), heavier Stylus workload measured against Solidity                                                          | Live demo URL. Fix: Vercel                                                                               |
| Latheon                                                           | Privacy protocol across Ethereum, Arbitrum and Robinhood Chain                                                  | Chain-specific depth (ERC-8056, pauses, calendar)                                                                                                     | Multi-chain story. Answer: the same vaults deploy on Arbitrum One for other tokenized stocks             |
| Amen Protocol                                                     | Could not be identified                                                                                         | n/a                                                                                                                                                   | n/a                                                                                                      |
| Past winner: vault-as-a-fund agent protocol (NYC 1st)             | Agent-managed funds on USDG                                                                                     | Strike's agents cannot touch funds at all; options add a new primitive                                                                                | Seed funding and traction                                                                                |
| Past winner: agent prop-trading vaults                            | Agent registry + vaults + MCP                                                                                   | Strike adds real price safety, invariants, fork tests on real tokens and slashing                                                                     | Mainnet deployment                                                                                       |
| Past winner: test-heavy DeFi protocol (NYC 3rd)                   | Invariant and fuzz discipline                                                                                   | Comparable discipline plus fork tests on real stock tokens and exact cross-language differential tests                                                | Breadth of product                                                                                       |
| Past winner: gasless stablecoin UX (London 1st)                   | Paymaster UX                                                                                                    | Different category                                                                                                                                    | Onboarding UX. Roadmap: USDG paymaster                                                                   |
| Past winner: Stylus perps (London 3rd)                            | Hybrid Stylus + Solidity with differential tests                                                                | Strike's differential tests demand exact equality and publish both gas outcomes                                                                       | Performance claims                                                                                       |
| Past winner: agent settlement accountability (London agentic 1st) | Agents post collateral                                                                                          | Strike's slash goes to the harmed depositors and feeds ERC-8004 reputation                                                                            | None on fit                                                                                              |
| Live product outside the hackathon                                | Daily stock-token options on Robinhood mainnet                                                                  | Strike is the agent-run, mandate-bound version with depositor protection and reusable safety tooling                                                  | They are live with users. Do not claim "first options"                                                   |

### Weighted score (cycle 1, before deployment)

| Criterion                     | Weight | Score | Why                                                                                                                                                                                |
| ----------------------------- | ------ | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Smart contract quality        | 30%    | 9.0   | 397 tests, 9 invariants with mutation checks, 99% coverage, fork tests incl. real ERC-8004, exact differential, Slither 0 High, threat model, gas table; not yet deployed/verified |
| Real problem solving          | 20%    | 7.5   | Every gap has a fix and a test; the full story runs in CI; testnet demo pending                                                                                                    |
| Product-market fit            | 20%    | 6.0   | SDK, MCP, fee model, app; no users or buyer-side yet                                                                                                                               |
| Innovation                    | 15%    | 8.0   | Mandate + slashing to depositors + ERC-8004 reputation + on-chain strike solving in Stylus                                                                                         |
| Robinhood + USDG + agents fit | 15%    | 7.0   | Everything is built for 4663/46630 and USDG; not deployed yet                                                                                                                      |

**Weighted: 7.6 / 10.** Done condition not met (hard requirements A1, A2, A4, A5 open; serious weaknesses open).

### Cycle 1 results

| Improvement                | Status                               | Evidence                                                                                  |
| -------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------- |
| Deploy on 46630 and 421614 | Blocked on testnet funds             | `scripts/deploy-testnet.sh` (rehearsed on a testnet fork)                                 |
| Buyer side                 | Done                                 | MCP `buy_options`, `redeem_options`, `hedge_plan`; buyer agent; demo buys through it (CI) |
| Live URL + feedback        | Feedback form done; URL needs Vercel | `.github/ISSUE_TEMPLATE/testnet-feedback.yml`, footer link                                |
| Robinhood UX               | Done                                 | Per-share display from `uiMultiplier`; non-US acknowledgement gate                        |
| Stylus in production       | Done in tooling                      | Reproducible Stylus deploy, on-chain equality check before switching the pricer           |

Re-score after cycle 1: contract quality 9.0, real problem 7.5, product-market fit 7.0 (two-sided agent market, SDK, feedback channel; no users yet), innovation 8.0, Robinhood fit 7.5. **Weighted: 7.9 / 10.** The remaining gap is almost entirely deployment, the live URL and users.
