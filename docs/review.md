# Win scorecard

Updated at the end of every phase and every improvement cycle. A score without linked evidence counts as 5.

## Latest: end of Phase 0 (2026-09-28)

### A. Hard requirements

| Requirement                                                                     | Status   | Evidence                                                                |
| ------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------- |
| Deployed and verified on Robinhood Chain 46630 and/or 4663, addresses in README | NO       | Phase 4/5; needs a funded deployer ([req-you](req-you.md))              |
| Also deployed on Arbitrum Sepolia or One                                        | NO       | Phase 4                                                                 |
| USDG is the premium and settlement asset (real addresses)                       | DESIGNED | [design.md §2, §4](design.md)                                           |
| Public repo, live demo URL, demo video, pitch video                             | PARTIAL  | Repo: github.com/Prashant-thakur77/Strike. The rest comes in Phases 4–5 |
| HackQuest submission before the deadline                                        | NO       | [req-you](req-you.md)                                                   |

### B. Judging scores

| Criterion                     | Weight | Score | Evidence                                                                                                                         | Gap to 10                                                                                       |
| ----------------------------- | ------ | ----- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Smart contract quality        | 30%    | 3     | [Stylus pricer tests](../stylus/pricer/src/math.rs) (proptest vs closed form, parity, bounds); [CI](../.github/workflows/ci.yml) | Core contracts, unit/fuzz/invariant/fork tests, Slither, threat model, differential + gas table |
| Real problem solving          | 20%    | 4     | [PLAN gap table](PLAN.md#the-real-need-on-the-platform), [design §7](design.md)                                                  | README "Why" with sources; a demo of each fix                                                   |
| Product-market fit            | 20%    | 3     | [PLAN users table](PLAN.md#who-uses-it)                                                                                          | Fee model live, SDK/MCP, 10+ testnet users with feedback                                        |
| Innovation                    | 15%    | 4     | [design.md](design.md) (mandates with slashing, oracle-anchored premiums)                                                        | Working first stock-token options on Robinhood Chain; Stylus pricer deployed                    |
| Robinhood + USDG + agents fit | 15%    | 3     | [design §2](design.md)                                                                                                           | Deploy on 46630/4663; MCP agent demo with a rejected proposal                                   |

**Weighted score: 3.4 / 10.** Done condition not met.

### C. Judge simulation

Starts after Phase 5 (each improvement cycle).

### D. Competitor check

Starts after Phase 5 (each improvement cycle).
