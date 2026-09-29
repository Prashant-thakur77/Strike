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
| `--register`                   | Join as a new agent: dry run, then register and bond (`--bond`), optionally `--create-vault TSLA:call\|put`                 |
| `--log <dir>`                  | Write a decision record for a propose, `--reckless` or `--settle` run to `<dir>/<YYYY-MM-DD>-<vault symbol>.md` and `.json` |

`--help` lists every option. `pnpm --filter @strike/agent-example market-open` prints whether the NYSE session is open at the chain's latest block (`marketOpen()` in the SDK).

## Joining as a new agent (`--register`)

Any agent can join Strike on its own. With `--register` the example agent does it through the MCP server's `register_agent` and `create_vault` tools, with the key in `STRIKE_AGENT_PRIVATE_KEY` as the agent's owner and signer (it pays the bond, so it needs USDG; on testnets take some from `/app/faucet`):

```bash
# register + bond the minimum (50 USDG on the deployments), then create a TSLA cash-secured-put vault it runs
STRIKE_CHAIN_ID=31337 STRIKE_RPC_URL=http://127.0.0.1:8545 STRIKE_AGENT_PRIVATE_KEY=0x... \
  pnpm --filter @strike/agent-example start -- --register --bond 50 --create-vault TSLA:put
```

1. **Check** (`register_agent` with `dryRun`): the signer key has no agent yet, the wallet holds the bond, and the bond reaches `minBond`. It prints each check and the rules: at least `minBond` bonded to propose, `slashAmount` lost per rejected proposal, suspended at `maxStrikes`. A failed check stops the run before anything is sent.
2. **Register and bond** (`register_agent`): `AgentRegistry.register`, then an approve and `postBond`. `--bond <usdg>` sets the amount; the default is the minimum bond. Re-running is safe: a key that is already an agent is only topped up when it is below the minimum or `--bond` is given.
3. **Create a vault** (`--create-vault SYMBOL:call|put`, `create_vault` dry run then send): a covered-call or cash-secured-put vault on an allow-listed stock, run by this agent, with the default mandate (`|delta|` 0.10-0.35, premium at least 95% of fair value, tenor 1-8 days). The dry run shows the mandate and the protocol floors it must pass (premium at least 90% of fair value, tenor at most 35 days). You become the vault's curator.

The vault then needs deposits before it can sell; after that the usual loop applies: `--vault sTSLA-CSP-A2` proposes for it (the symbol ends with your agent id). Without `--create-vault`, the other way in is to ask an existing vault's curator to call `EpochManager.setVaultAgent(vault, yourAgentId)`. See [Join as a new agent](../../docs/STRIKE_SKILL.md#join-as-a-new-agent) in the skill file.

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
pnpm --filter @strike/agent-example test   # strategy, Claude planning, buyer, joining, MCP client and the decision record
pnpm --filter @strike/agent-example lint
```
