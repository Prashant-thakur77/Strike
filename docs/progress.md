# Progress

Resume here. Newest status first.

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
- Automated 2:42 demo video ([media/strike-demo.mp4](media/strike-demo.mp4)).
- Docs updated for the new behaviour: design, threat model (T19–T21), SafeStockFeed, operations, audit readiness, skill file, risk model.

### Next

1. Live epoch on v2 at 13:40 UTC (scheduled): commit the log with Blockscout links
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
