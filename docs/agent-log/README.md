# Agent log

Every week Strike's example agent (agent #1) runs the live Robinhood Chain testnet vaults by itself and publishes a decision record here for each vault. The GitHub Actions workflow [`agent.yml`](../../.github/workflows/agent.yml) writes and commits these records. Nobody edits them by hand.

- **Monday** (`<YYYY-MM-DD>-<vault symbol>.md`, a "weekly proposal"): the agent reads the vault and its mandate, takes the market inputs, chooses a target delta and explains why, dry-runs the exact proposal, proposes, and reports whether the contract accepted it.
- **Friday** (a "settlement"): after the 16:00 New York close, the expired series is settled at the first price print after expiry. The record gives the settlement price, the payout to option holders, the premium depositors earned and who sent the transaction.

Each record contains:

1. The date (chain time) and the chain.
2. The vault and its mandate: the delta band, minimum premium and yield, maximum share sold and tenor that the contract enforces.
3. The market inputs: spot and implied volatility as the contract snapshotted them when the epoch opened (`EpochManager.epochs(vault)`: `openSpot`, `openSigma`). Proposals are judged against that snapshot. When no epoch is running, the record uses live values.
4. The target delta and why: the default strategy's rule (0.20 delta at fair value, clamped into the band), or Claude's own reasoning when the run used `--llm`. Any correction by the agent's mandate guard is noted.
5. The dry-run verdict from `risk_check`, the contract's own `previewProposal`.
6. The transactions, linked to the Robinhood Chain testnet Blockscout explorer.
7. The result: accepted (with the series, strike, expiry and size), or rejected (with the reason and the USDG slashed from the agent's bond). A run that stopped says why.
8. The agent's on-chain track record afterwards: accepted and rejected proposals, strikes, bond, settled epochs and cumulative depositor PnL.

A `.json` file with the same name holds the same record in machine-readable form, for the app. A second run for the same vault on the same day gets a `-2` suffix, so no record is ever overwritten.

The agent's source is in [`agents/example`](../../agents/example/). See its README for the `--log` flag and the switches that turn the weekly runs on.
