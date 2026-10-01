# Agent log

Strike's example agent (agent #1) writes a decision record here for each vault it runs, with `--log`. Once the owner switches it on, the GitHub Actions workflow [`agent.yml`](../../.github/workflows/agent.yml) runs the agent every week on the live Robinhood Chain testnet vaults and commits the records; it is off for now ([operations.md](../operations.md)). The records here so far come from the live v3 epochs of 30 September (Arbitrum Sepolia) and 1 October (Robinhood Chain testnet), run by hand with `--log --anchor` (Claude planned each covered call with `--llm --planner claude-code`). Nobody edits them by hand.

- **Monday** (`<YYYY-MM-DD>-<vault symbol>.md`, a "weekly proposal"): the agent reads the vault and its mandate, takes the market inputs, chooses a target delta and explains why, dry-runs the exact proposal, proposes, and reports whether the contract accepted it.
- **Friday** (a "settlement"): after the 16:00 New York close, the expired series is settled at the first price print after expiry. The record gives the settlement price, the payout to option holders, the premium depositors earned and who sent the transaction.

Each record contains:

1. The date (chain time) and the chain.
2. The vault and its mandate: the delta band, minimum premium and yield, maximum share sold and tenor that the contract enforces.
3. The market inputs: spot and implied volatility as the contract snapshotted them when the epoch opened (`EpochManager.epochs(vault)`: `openSpot`, `openSigma`). Proposals are judged against that snapshot. When no epoch is running, the record uses live values.
4. The target delta and why: the default strategy's rule (0.20 delta at fair value, clamped into the band), or Claude's own reasoning when the run used `--llm`, with the planner that ran it (`Claude via API` or `Claude via Claude Code CLI`, and the model). Any correction by the agent's mandate guard is noted.
5. The dry-run verdict from `risk_check`, the contract's own `previewProposal`.
6. The transactions, linked to the chain's explorer (Blockscout on Robinhood Chain testnet, Arbiscan on Arbitrum Sepolia).
7. The result: accepted (with the series, strike, expiry and size), or rejected (with the reason and the USDG slashed from the agent's bond). A run that stopped says why.
8. The agent's on-chain track record afterwards: accepted and rejected proposals, strikes, bond, settled epochs and cumulative depositor PnL.

Each record is also anchored on-chain. The agent commits the keccak256 hash of its JSON record and the record's URL to the [DecisionLog](../../contracts/src/agents/DecisionLog.sol) contract (`0xbF94f54fd0258ac59e2f54B70754dFAfFd245D93` on Robinhood Chain testnet), signed by the agent's registered key. A record changed after the fact no longer matches its hash. `verifyAnchoredRecord` in [`agents/example/src/anchor.ts`](../../agents/example/src/anchor.ts) checks a published file, and the app's vault page does the same check in the browser ("Why this strike": it rebuilds the hash from the raw file on GitHub and reads `latestHash` from the vault's chain). The first anchor is the 29 Sep epoch log ([tx](https://explorer.testnet.chain.robinhood.com/tx/0x934ab96ba12a9ad501e20c8366fc338ab35d0550b88cc2d76fc5c39991c524c4)). The `2026-10-01-*` records come from the v3 deployment on the same chain ([log](../testnet-epochs/2026-09-30-v3.md#7-live-epoch-1-october)). They are anchored in v3's own DecisionLog, `0xa98106db53519F8cfE4D7C56B34D4Fe0460403a4`, which reads the v3 AgentRegistry. The records in [`arbitrum-sepolia/`](arbitrum-sepolia/) are from v3 on Arbitrum Sepolia and are anchored in its DecisionLog, `0x60E947b8d2c2C34b95d88d02F0A06AeFb6Ccd04C`.

A `.json` file with the same name holds the same record in machine-readable form, for the app. A second run for the same vault on the same day gets a `-2` suffix, so no record is ever overwritten.

The agent's source is in [`agents/example`](../../agents/example/). See its README for the `--log` and `--anchor` flags and the switches that turn the weekly runs on.
