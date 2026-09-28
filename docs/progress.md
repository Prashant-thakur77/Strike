# Progress

Resume here. Newest status first.

## 2026-09-28 (day 1)

### Phase status

| Phase                  | Gate                           | Status                                                                                                                    |
| ---------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| 0 Setup                | CI green + design doc          | Passed, tagged `v0.1.0`                                                                                                   |
| 1 Core contracts       | Lifecycle tests pass           | Passed (13 lifecycle tests), tagged in `v0.2.0`                                                                           |
| 2 Safety + Stylus      | Invariants + differential pass | Passed: 9 invariants × 2 vaults, exact Rust/Solidity differential, fork tests on 4663, Slither 0 High, gas table          |
| 3 Agents               | Rejected-proposal demo         | Contract side done (AgentRegistry, slashing, proposeByDelta, `AgentMandate.t.sol`). SDK + MCP + example agent in progress |
| 4 App + testnet        | Deployed + verified            | App and subgraph in progress; deploy script rehearsed on anvil and on a testnet fork; **waiting for testnet funds**       |
| 5 Mainnet + submission | Submitted                      | Not started                                                                                                               |

### Done today

- Contracts: EpochManager, StrikeVault, VaultFactory, OptionToken, FeeManager, MandateGuard, AgentRegistry, SafeStockFeed, StockOracle, MarketCalendar, BlackScholesLib/Ref, testnet MirrorFeed/TestStockToken
- Stylus pricer (quote, price, delta, strikeForDelta), `cargo stylus check` passes, deployed and measured on a Nitro dev node
- 373 Foundry tests + 15 Rust tests; invariants with mutation checks; fork tests on Robinhood mainnet; Slither triage; threat model; gas table; README
- Deploy and seed scripts for 4663 / 46630 / 421614 / anvil; testnet deployer key generated (address in [req-you.md](req-you.md))

### Next

1. Merge the SDK/MCP/agent, app and subgraph work (three parallel builders)
2. As soon as the deployer is funded: deploy to Robinhood testnet and Arbitrum Sepolia, deploy the Stylus pricer, verify on Blockscout/Arbiscan, seed vaults, run the agent demo on-chain, put addresses in the README
3. Keeper script for MirrorFeeds (mirror mainnet Chainlink rounds)
4. Submission kit: demo and pitch scripts, deck outline, HackQuest answers
5. Improvement cycles (judge simulation, competitor check)

### Blockers

- Testnet funds for `0x26b277b434B1670f207Afd8946edA9AF78A613Ff` ([req-you.md](req-you.md))
- HackQuest registration closes 2026-10-02 17:01 UTC (owner)
