# Win scorecard

Updated at the end of every phase and every improvement cycle. A score without linked evidence counts as 5.

## Latest: end of Phase 2, Phase 3 contracts done (2026-09-28)

### A. Hard requirements

| Requirement                                                                     | Status      | Evidence                                                                                                                                                           |
| ------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Deployed and verified on Robinhood Chain 46630 and/or 4663, addresses in README | NO (ready)  | One-command deploy + Blockscout verify ([scripts/deploy-testnet.sh](../scripts/deploy-testnet.sh)) rehearsed on a testnet fork. Waiting for funds on `0x26b2…13Ff` |
| Also deployed on Arbitrum Sepolia or One                                        | NO (ready)  | Same script, `arbitrum-sepolia`                                                                                                                                    |
| USDG is the premium and settlement asset (real addresses)                       | YES in code | Real USDG on 4 networks in [Deploy.s.sol](../contracts/script/Deploy.s.sol); fork test uses real mainnet USDG                                                      |
| Public repo, live demo URL, demo video, pitch video                             | PARTIAL     | Repo public with CI. App in progress; videos need the owner ([req-you](req-you.md))                                                                                |
| HackQuest submission before the deadline                                        | NO          | Answers drafted in [submission/hackquest-answers.md](submission/hackquest-answers.md)                                                                              |

### B. Judging scores

| Criterion                     | Weight | Score | Evidence                                                                                                                                                                                                                                           | Gap to 10                                                                                    |
| ----------------------------- | ------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Smart contract quality        | 30%    | 8.5   | 373 tests, 9 invariants × 2 vaults with mutation checks ([testing.md](testing.md)), fork tests on 4663, exact Rust/Solidity differential, Slither 0 High ([triage](security/slither.md)), [threat model](threat-model.md), [gas table](gas.md), CI | Live deployment + verification; coverage report; CI green on the latest commit               |
| Real problem solving          | 20%    | 7     | Gap table with sources in the [README](../README.md#why); each fix has a test                                                                                                                                                                      | Demo on testnet showing each fix (paused oracle, weekend settlement, multiplier)             |
| Product-market fit            | 20%    | 5     | Users and fee model in [PLAN](PLAN.md#who-uses-it); fee code in [FeeManager](../contracts/src/core/FeeManager.sol)                                                                                                                                 | SDK/MCP shipped, live app, 10+ testnet users with feedback                                   |
| Innovation                    | 15%    | 7.5   | Contract-enforced mandates with slashing to depositors; on-chain strike solving by delta with Stylus (6.5× cheaper); oracle-anchored premiums                                                                                                      | Working agent demo; "first options" claim is not available (a daily-options product is live) |
| Robinhood + USDG + agents fit | 15%    | 6     | Built only for ERC-8056 stock tokens, real feeds, USDG everywhere, ERC-8004 link                                                                                                                                                                   | Deployed on 46630 (and 4663), MCP agent demo with a rejected proposal                        |

**Weighted score: 6.9 / 10.** Done condition not met: no deployment yet, app and agent demo still being built.

### C. Judge simulation

Starts with the first improvement cycle (after Phase 5).

### D. Competitor check (early notes)

From [research.md §8](research.md): no other HackQuest entry in this edition is an options vault. The closest overlaps are HarvestBot (agent mandate, slashable bond and Stylus, applied to tax-loss harvesting) and StockGuard (stock-token oracle safety for lending). Outside the hackathon, a daily-options product is live on Robinhood mainnet and a testnet options order book exists. Strike's answer: the only entry combining a yield product, contract-enforced agents and a stock-token safety layer, with the deepest test evidence. The full comparison runs in cycle 1.
