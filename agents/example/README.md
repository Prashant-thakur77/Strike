# Strike example agent

A strike-picking agent that works entirely through the [Strike MCP server](../../mcp/). It reads the vault, chooses a target delta, dry-runs the exact proposal with `risk_check`, and only then proposes on-chain. The contract checks every proposal against the vault's mandate and slashes the agent's USDG bond when one falls outside it.

```bash
# from the repo root; STRIKE_AGENT_PRIVATE_KEY is the agent signer's key
STRIKE_CHAIN_ID=46630 STRIKE_AGENT_PRIVATE_KEY=0x... pnpm --filter @strike/agent-example start -- --vault sTSLA-CC
```

| Flag                           | What it does                                                                                                                |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| (none)                         | Propose this epoch's option at 0.20 delta (`--target-delta` to change), after a dry run                                     |
| `--llm`                        | Claude chooses the delta and premium factor using read-only tools (needs `ANTHROPIC_API_KEY`); falls back to the default    |
| `--reckless`                   | Force an at-the-money proposal to show the contract rejecting it and slashing the bond                                      |
| `--settle`                     | Settle the vault's expired series                                                                                           |
| `--status`                     | Print the vault and the agent's track record                                                                                |
| `--buy`, `--hedge`, `--redeem` | Buyer side: buy options within `--budget`, hedge a holding, redeem settled options                                          |
| `--log <dir>`                  | Write a decision record for a propose, `--reckless` or `--settle` run to `<dir>/<YYYY-MM-DD>-<vault symbol>.md` and `.json` |

`--help` lists every option. `pnpm --filter @strike/agent-example market-open` prints whether the NYSE session is open at the chain's latest block (`marketOpen()` in the SDK).

## Decision records (`--log`)

With `--log <dir>` the agent keeps its console output and also writes what it did and why: the date and chain, the vault and its mandate, the market inputs (the spot and sigma snapshotted when the epoch opened, or live values when no epoch runs), the target delta with the strategy's rule or Claude's own reasoning, the dry-run verdict, each transaction with a Blockscout link on chain 46630, the result (accepted with its series, or rejected with the reason and the slash) and the agent's track record afterwards. A JSON copy with the same name sits next to the markdown for the app. The directory is relative to where you run the command. A second run on the same day for the same vault gets a `-2` suffix, so no record is ever overwritten. With `--settle --log`, a series the keeper already settled this week is looked up on-chain (`EpochSettled`) and recorded instead of failing.

The records of the live testnet vaults are published in [docs/agent-log](../../docs/agent-log/).

## Running it every week (GitHub Actions)

[`.github/workflows/agent.yml`](../../.github/workflows/agent.yml) runs the agent autonomously as agent #1 on Robinhood Chain testnet (46630) and commits the records to `docs/agent-log`:

- **Monday 15:00 UTC** (11:00 New York in summer, 10:00 in winter): it checks the NYSE session with `marketOpen()` and skips the week cleanly on a holiday. Then it runs the keeper once to refresh prices and proposes on both TSLA vaults with `--log`. It adds `--llm` when `ANTHROPIC_API_KEY` is set.
- **Friday 21:15 UTC** (after the 16:00 New York close all year): the keeper settles the expired series, then the agent runs `--settle --log` on each vault. It records the keeper's settlement, and settles itself only if nothing has yet.
- The job shares a concurrency group with `keeper.yml`, so the two never send from the same key at once. It commits new records as `github-actions[bot]` with the message `agent-log: weekly epoch <date>`, and only when something changed.

Switches the owner flips (repo Settings → Secrets and variables → Actions):

| Kind     | Name                 | Value                                                                                                                                                      |
| -------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Secret   | `KEEPER_PRIVATE_KEY` | The deployer key from `contracts/.env`: agent #1's signer and the keeper key (the same secret `keeper.yml` uses)                                           |
| Variable | `AGENT_ENABLED`      | `true` turns the weekly runs on (anything else, or unset, keeps them off)                                                                                  |
| Secret   | `ANTHROPIC_API_KEY`  | Optional. When set, Claude plans each epoch (`--llm`, model `claude-opus-5`); the mandate guard in the agent code still clamps its plan before the dry run |

`workflow_dispatch` runs it by hand (mode `propose` or `settle`). If `main` is branch-protected, allow GitHub Actions to push, or the commit step fails.

## Tests

```bash
pnpm --filter @strike/agent-example test   # strategy, Claude planning, buyer, MCP client and the decision record
pnpm --filter @strike/agent-example lint
```
