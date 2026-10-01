# Progress

Resume here. Newest status first.

## 2026-10-01 (day 4)

Cycle 9 ([plan](plans/2026-09-30-cycle9.md)): 9.1 to 9.3 done, and the Arbitrum Sepolia part of 9.5 done early. 9.4 (SDK, MCP, app and subgraph on v3): the SDK, MCP and app use v3 on Arbitrum Sepolia; Robinhood Chain testnet waits for v2's settlement, and the subgraph's network addresses are not filled in yet; the rest of 9.5 is Friday's settlement. `v0.9.0` tagged on 30 September.

- **v3 on both testnets.** Robinhood Chain testnet (46630), next to v2, block 126,713,718 ([log](testnet-epochs/2026-09-30-v3.md)); Arbitrum Sepolia (421614), block 314,350,623, with the real Sepolia USDG and test TSLA and NVDA ([log](testnet-epochs/2026-09-30-arbitrum-sepolia.md)). Contracts verified on Blockscout (and Sourcify for the test tokens), the Stylus pricer and risk engine verified with `cargo stylus verify` on both chains and cached in ArbOS on Arbitrum Sepolia. Addresses in [DEPLOYMENTS.md](DEPLOYMENTS.md); `46630-v3.json` is now on `main` too.
- **Three live epochs**, all expiring Friday 2026-10-02 20:00 UTC, none settled yet: v2 on 46630 (29 Sep, rule-based agent), v3 on 421614 (30 Sep) and v3 on 46630 (1 Oct, [§7](testnet-epochs/2026-09-30-v3.md#7-live-epoch-1-october)). Each has an accepted 0.20-delta call, an at-the-money put rejected with 10 USDG slashed, and a buyer that bought 4 calls. Decision records are anchored in a DecisionLog on all three deployments ([agent log](agent-log/README.md)).
- **Claude planner.** `--llm --planner claude-code` runs Claude (claude-opus-5) through the Claude Code CLI with read-only Strike tools; it planned both accepted v3 proposals (vault state, `risk_check` on each candidate, agent stats, then 0.20 delta at 105% of fair value).
- **Remote MCP and `series_risk`.** Read-only MCP at `https://strike-options.vercel.app/api/mcp` with 8 tools, `series_risk` among them; the full stdio server has 14; `STRIKE_MCP_READ_ONLY=1` for read-only stdio.
- **Risk panel** on the vault page: greeks, a ±30% stress test and the implied volatility of the last buy; v2 series through the v3 Stylus risk engine called directly, v3 series through `RiskLens.seriesRisk`.
- **UI/UX pass.** A 26-term glossary with definitions on hover, focus or tap, a `/app/glossary` page, a "start here" strip, a purpose sentence and a "Next:" link on every app page, a footer that lists every page, layout fixes at tablet and phone widths from an opt-in UI audit spec; screenshots retaken.
- **Videos.** Narrated demo walkthrough 5:13 with chapters ([media/strike-demo.mp4](media/strike-demo.mp4), [silent version](media/strike-demo-silent.mp4)) and the pitch 2:02 ([media/strike-pitch.mp4](media/strike-pitch.mp4)).
- **CI fixes:** the fork test uses next week's expiry late in the week; prettier skips the deck slide copies; the subgraph job pins matchstick 0.6.0.
- **Test counts** re-measured: 962 tests and proofs (477 Foundry with 7 skipped, SDK 120, MCP 51, agents 60, Telegram bot 60, subgraph 10, Playwright 148 per viewport); coverage unchanged at 99.3% lines and 98.8% branches.

### Next

1. Settle all three epochs after Friday 2026-10-02 20:00 UTC: record the settlement price and `settle` on both chains, the buyers redeem, the curators' `abortEpoch` pays the two v3 slashes to the put vaults' depositors; add the transactions to the epoch logs and [DEPLOYMENTS.md](DEPLOYMENTS.md).
2. After v2 settles, `main` merges `v3-contracts` and the SDK, MCP, app and subgraph move 46630 to `46630-v3.json` ([D36](decisions.md)).
3. Final re-score in [review.md](review.md), release, and submit before 2026-10-04 15:59 UTC.

### Blockers (owner)

From [req-you.md](req-you.md): HackQuest registration before 2026-10-02 17:01 UTC and the submission before 2026-10-04 15:59 UTC; uploading the two videos to YouTube; outside testers and agents; the npm scope and token, a Goldsky key for the subgraph, and approval and funds for a capped mainnet vault.

## 2026-09-30 (day 3)

Cycle 3 ([plan](plans/2026-09-29-cycle3.md)) done; cycle 4 ([plan](plans/2026-09-30-cycle4.md)) started.

- **Try without a wallet:** mandate playground (`/app/playground`), stock-token safety monitor on mainnet (`/app/monitor`), proof page with a live on-chain activity feed (`/app/proof`)
- **Telegram bot** (`bots/telegram`, 60 tests): alerts and commands, dry-run verified against the live chain
- **ERC-8004:** agent #1 linked to identity #114 on the official testnet registry
- Judge-facing docs (cycle 8): README sections on what works, what does not yet and what we cut, claims mapped to tests and commands, why only Robinhood Chain and Arbitrum, Tilt Protocol in the competition matrix, the put vault against USDG lending; [MILESTONES.md](MILESTONES.md), [qa-prep.md](submission/qa-prep.md), [research-winners.md](research-winners.md); past-winner rows corrected in [review.md](review.md)
- **Formal verification:** 9 Halmos-proven properties in CI, 16 marked unproven ([formal-verification.md](security/formal-verification.md)); coverage gate in CI (99.3% lines)
- **Test counts** re-measured: 864 tests and proofs, 477 of them Foundry (7 more skipped: the conformance suite's settlement rules on the `StockCollateral` example); 99.3% line and 98.8% branch coverage
- **UI polish:** hero, nav, payoff chart and buy-price breakdown, agents table, faucet balances, mobile folds; all routes checked at 1440 and 390 on live data
- **Repository:** README rewrite, CHANGELOG, SECURITY, CONTRIBUTING, templates, versioned deployments, `v0.6.0` tag
- **Submission kit** refreshed; cycle 3 re-score: quality 9.5, PMF 7.3, innovation 8.6, real problem 8.7 ([review.md](review.md))

### Next

1. Autonomous weekly agent with a published decision log (in progress), and a re-cut demo video (in progress)
2. Settle the live epoch after Friday 2026-10-02 20:00 UTC; the ERC-8004 feedback for #114 goes on-chain
3. Tag `v0.7.0`; re-score cycle 4

## 2026-09-29 (day 2)

### Phase status

| Phase                  | Gate                | Status                                                                                                                   |
| ---------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 0–3                    | see day 1           | Passed                                                                                                                   |
| 4 App + testnet        | Deployed + verified | Passed: v1 deployed on Robinhood Chain testnet (`v0.5.0`); v2 with every review fix deployed and verified (14 contracts) |
| 5 Mainnet + submission | Submitted           | Waiting on owner items (HackQuest registration, Vercel, narrated videos, capped mainnet vault)                           |

### Done today

- Internal adversarial security review: 1 High, 3 Medium, 4 Low, 3 Info, each shown by a failing test. All fixed; the 19 audit tests now run as regression tests (418 Foundry tests). Details in [security/review-2026-09-29.md](security/review-2026-09-29.md), decisions D27–D30.
- Robinhood testnet redeployed as v2 (Stylus pricer reused, verified); 5 TSLA in the covered-call vault, agent bonded 60 USDG; v1 bond unbonding.
- SDK: settlement hints across Chainlink phases and corporate actions (`findSettlementHints`), snapshot-aware strike solver, `roundStrikeToCent`. The keeper falls back to it.
- 8-year weekly backtest and litepaper ([backtest.md](backtest.md), [litepaper.md](litepaper.md)).
- Automated 2:40 demo video ([media/strike-demo.mp4](media/strike-demo.mp4)).
- Docs updated for the new behaviour: design, threat model (T19–T21), SafeStockFeed, operations, audit readiness, skill file, risk model.

### Next

1. Live epoch on v2: done at 17:07 UTC, log with Blockscout links in [testnet-epochs/2026-09-29.md](testnet-epochs/2026-09-29.md)
2. Halmos symbolic proofs for the libraries (in progress), then a `formal` CI job
3. Settle the live epoch after Friday's close (2026-10-02 20:00 UTC)
4. Scorecard cycle 2 in review.md; tag `v0.6.0`

## 2026-09-28 (day 1, evening)

### Phase status

| Phase                  | Gate                           | Status                                                                                                                      |
| ---------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| 0 Setup                | CI green + design doc          | Passed, `v0.1.0`                                                                                                            |
| 1 Core contracts       | Lifecycle tests pass           | Passed, `v0.2.0`                                                                                                            |
| 2 Safety + Stylus      | Invariants + differential pass | Passed, `v0.3.0`                                                                                                            |
| 3 Agents               | Rejected-proposal demo         | Passed: the MCP example agent's reckless proposal is rejected and slashed on-chain (`scripts/demo-local.sh`, also a CI job) |
| 4 App + testnet        | Deployed + verified            | App, SDK, MCP, subgraph and keeper built. **Deploy blocked on testnet funds** (`scripts/deploy-testnet.sh` ready)           |
| 5 Mainnet + submission | Submitted                      | Submission kit drafted; needs deployment, videos, HackQuest form                                                            |

### Done since the morning

- `@strike/sdk` (68 tests), `@strike/mcp` (16 tests, 8 tools + skill resource), example agent (11 tests, default, `--reckless`, `--llm` with Claude)
- Next.js app styled after the owner's reference site: landing, vaults, vault detail with buy/deposit/queue/claims, agents leaderboard and rejection feed, faucet, option metadata API; 20 Playwright checks on desktop and mobile
- Subgraph: 21 entities, 10 matchstick tests, networks for Arbitrum Sepolia and Robinhood Chain; hosting notes in `docs/indexing.md`
- ERC-8004 reputation feedback for settled epochs and rejections (fork-tested against the real registries on 4663)
- `proposeByDelta` with the Stylus strike solver; gas table; Slither 0 High; 99% line coverage; threat model; risk model; FEEDBACK.md; keeper script and workflow
- CI: contracts, Stylus, differential, fork, Slither, TypeScript, subgraph, end-to-end demo

### Next

1. When `0x26b277b434B1670f207Afd8946edA9AF78A613Ff` is funded: `scripts/deploy-testnet.sh robinhood-testnet` and `arbitrum-sepolia`, then README addresses, `hackquest-answers.md`, tag `v0.5.0`
2. Enable the keeper workflow (`KEEPER_ENABLED`, `KEEPER_PRIVATE_KEY`) after deployment
3. Improvement cycle 1: judge simulation, competitor check, top-5 fixes
4. Capped mainnet vault on 4663 (needs owner approval and funds)

### Blockers (owner)

- HackQuest registration before 2026-10-02 17:01 UTC
- Testnet funds for the deployer
- Vercel (live app URL), Goldsky (subgraph), videos
