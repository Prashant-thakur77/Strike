# Strike subgraph

Indexes Strike vaults, epochs, option series, purchases and settlements, the deposit/redemption queue, agents (bond, strikes, PnL track record, ERC-8004 feedback), mandate rejections and fees. Hosting, network names, deploy commands and example queries: [docs/indexing.md](../docs/indexing.md).

| Path                      | What                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| `schema.graphql`          | Entities, with units in the field descriptions                                                          |
| `subgraph.yaml`           | Data sources: EpochManager, VaultFactory, AgentRegistry, StockOracle, FeeManager + StrikeVault template |
| `networks.json`           | Addresses and start blocks per graph network name (placeholders until deployed)                         |
| `src/`                    | AssemblyScript mappings, one file per contract, shared code in `helpers.ts`                             |
| `tests/`                  | matchstick unit tests                                                                                   |
| `abis/`                   | ABIs copied from `contracts/out` (committed so codegen works without a Foundry build)                   |
| `scripts/copy-abis.mjs`   | `pnpm abis`: refresh `abis/` after `forge build` (`--check` fails if they are stale)                    |
| `scripts/set-network.mjs` | `pnpm run set-network <chainId>`: fill `networks.json` from `contracts/deployments/<chainId>.json`      |
| `scripts/matchstick.mjs`  | `pnpm graph:test:binary`: run matchstick where `graph test` rejects the OS                              |

```bash
pnpm --filter @strike/subgraph abis
pnpm --filter @strike/subgraph set-network 46630
pnpm --filter @strike/subgraph graph:codegen
pnpm --filter @strike/subgraph graph:build              # or: pnpm exec graph build --network robinhood-testnet
pnpm --filter @strike/subgraph graph:test               # or graph:test:binary (Ubuntu 26.04, needs libpq5)
```

`subgraph.yaml` keeps zero addresses and `network: arbitrum-sepolia`. `graph build/deploy --network <name>` rewrites it from `networks.json`; don't commit that rewrite.
