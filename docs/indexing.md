# Indexing

The Strike subgraph lives in [`subgraph/`](../subgraph). It indexes vaults, epochs, option series, purchases, settlements, the deposit/redemption queue, agents (bond, strikes, track record, ERC-8004 feedback), mandate rejections and fees. The app and agents read it for history and charts. They read live state (quotes, `previewProposal`, balances) from the chain through the SDK or MCP server.

Everything below was checked on 2026-09-28. Anything I could not confirm is marked **unverified**.

## What gets indexed

| Data source              | Events                                                                                                                                                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EpochManager`           | `UnderlyingSet`, `SigmaSet`, `VaultRegistered`, `VaultAgentSet`, `EpochOpened`, `SeriesProposed`, `ProposalRejected`, `OptionsBought`, `EpochSettled`, `EpochAborted`, `SeriesCancelled`, `OptionsRedeemed`, `Paused`, `Unpaused` |
| `VaultFactory`           | `VaultCreated` (starts a `StrikeVault` template for the clone)                                                                                                                                                                    |
| `StrikeVault` (template) | `Deposit`, `Withdraw`, `EpochLocked`, `EpochSettled`, `DepositRequested`, `DepositRequestCancelled`, `DepositClaimed`, `RedeemRequested`, `RedeemClaimed`, `PremiumClaimed`                                                       |
| `AgentRegistry`          | `AgentRegistered`, `SignerSet`, `PayoutSet`, `BondPosted`, `UnbondRequested`, `Unbonded`, `Slashed`, `StatusSet`, `ProposalRecorded`, `ParamsSet`, `EpochResultRecorded`, `ReputationFeedback`                                    |
| `StockOracle`            | `FeedSet`, `SettlementPriceRecorded`                                                                                                                                                                                              |
| `FeeManager`             | `FeesSet`, `TreasurySet`, `FeesCredited`, `Claimed`                                                                                                                                                                               |

Entities (see [`subgraph/schema.graphql`](../subgraph/schema.graphql) for every field and its unit):

- Mutable: `ProtocolStats` (singleton, id `0x737472696b65` = "strike"), `Underlying`, `Vault`, `Epoch`, `Series`, `Agent`, `DepositRequest`, `RedeemRequest`, `VaultDayData`, `FeeAccount`.
- Immutable: `Purchase`, `Redemption`, `ProposalRejection`, `ReputationFeedback`, `DepositClaim`, `RedeemClaim`, `Deposit`, `Withdrawal`, `PremiumClaim`, `SettlementPrice`, `SharePriceSnapshot`.

Vault TVL, share supply and the queue are rebuilt from events with the vault's exact rounding, so there are no `eth_call`s per event. The subgraph makes calls in three places only: ERC-20 metadata when a vault or stock token first appears, `AgentRegistry.payoutOf` at registration (the payout address is not in the event), and `FeeManager.treasury()` once (the constructor sets it without an event).

A few things to know when reading the numbers:

- `Vault.tvlUsd` values call-vault collateral at the last price the subgraph saw for the stock: spot at epoch open, or the settlement price. It is a chart figure, not a live mark.
- `Epoch.premiumApr` is simple, not compounded: `(premium − fee) / collateral value at open × 365 days / epoch duration`. Slashing compensation is left out of it, and so are option payouts. For total return, use the `SharePriceSnapshot` history together with `accPremiumPerShare`.
- Vault share `Transfer`s are not indexed, so the subgraph has no per-account share balances. Read `balanceOf` and `pendingPremium` from the chain.
- The template starts from `VaultFactory.VaultCreated`. If the admin grants `FACTORY_ROLE` to a second factory, add that factory as a data source, or its vaults will not be indexed.

## Network names

Every indexer has its own name for Robinhood Chain. The name in `subgraph.yaml` has to match the host you deploy to, so `networks.json` keeps one entry per name:

| Chain                   | Chain id | The Graph registry id | Goldsky             | Ormi / Sentio             |
| ----------------------- | -------- | --------------------- | ------------------- | ------------------------- |
| Arbitrum Sepolia        | 421614   | `arbitrum-sepolia`    | `arbitrum-sepolia`  | `arbitrum-sepolia` (Ormi) |
| Robinhood Chain testnet | 46630    | `robinhood-sepolia`   | `robinhood-testnet` | not listed                |
| Robinhood Chain mainnet | 4663     | `robinhood`           | `robinhood-mainnet` | `robinhood`               |

Sources: [The Graph networks registry](https://networks-registry.thegraph.com/TheGraphNetworksRegistry.json) v0.8.4 (aliases `robinhood-testnet`, `evm-46630`, `robinhood-mainnet`, `robinhood-chain`, `evm-4663`), [Goldsky: Robinhood Chain](https://docs.goldsky.com/chains/robinhood-chain), [Ormi: supported chains](https://ormilabs.com/docs/supported-chains/subgraphs.md), [Sentio: supported networks](https://docs.sentio.xyz/docs/supported-network).

## Which hosts support Robinhood Chain

| Host                        | RH testnet (46630)            | RH mainnet (4663)         | Status                                                                                                                                                                                                                                                                                                                            |
| --------------------------- | ----------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The Graph Studio / Network  | no                            | no                        | Verified. The registry lists both chains with `services.subgraphs: []`, meaning Firehose/Substreams from Pinax and StreamingFast but no subgraph indexing. [The Graph's Robinhood page](https://thegraph.com/docs/en/supported-networks/robinhood/) says it is supported "with Substreams". Studio does support Arbitrum Sepolia. |
| **Goldsky**                 | **yes** (`robinhood-testnet`) | yes (`robinhood-mainnet`) | Verified in Goldsky's docs. This is the only hosted graph-node service that documents testnet subgraphs. I have not deployed to it yet.                                                                                                                                                                                           |
| Ormi (ex-0xGraph)           | not listed                    | yes (`robinhood`)         | Mainnet verified ([launch post, 2026-07-24](https://blog.ormilabs.com/ormi-subgraphs-robinhood-chain/)). Testnet **unverified**; ask Ormi.                                                                                                                                                                                        |
| Sentio (accepts subgraphs)  | **unverified**                | yes (`robinhood`)         | Mainnet is on [Sentio's network list](https://docs.sentio.xyz/docs/supported-network). The testnet status page renders client-side, so I could not check it.                                                                                                                                                                      |
| Envio HyperIndex            | RPC data source only          | yes (HyperSync)           | Verified ([supported networks](https://docs.envio.dev/docs/HyperIndex/supported-networks)). HyperIndex does not run graph-node, so the mappings would have to be rewritten in TypeScript.                                                                                                                                         |
| Alchemy Subgraphs (Satsuma) | n/a                           | n/a                       | Shut down on 2025-12-08 ([notice](https://www.alchemy.com/docs/alchemy-subgraphs/deprecation-notice)). Its users were pointed to Goldsky.                                                                                                                                                                                         |
| Chainstack                  | RPC only                      | RPC only                  | Verified ([Robinhood tooling](https://docs.chainstack.com/docs/robinhood-tooling)). It has no subgraph hosting.                                                                                                                                                                                                                   |
| SubQuery, thirdweb Insight  | **unverified**                | **unverified**            | I found no Robinhood listing.                                                                                                                                                                                                                                                                                                     |
| Self-hosted graph-node      | yes                           | yes                       | Works with any EVM RPC. Point it at `https://rpc.testnet.chain.robinhood.com` and use any network name you like, as long as it matches `networks.json`.                                                                                                                                                                           |

Robinhood's own docs ([docs.robinhood.com/chain](https://docs.robinhood.com/chain/)) have no indexer page. The ecosystem table lists Allium, Entropy Advisors and Alchemy's Data API.

So the plan is: The Graph Studio for Arbitrum Sepolia, Goldsky for Robinhood Chain testnet and mainnet, with Ormi as a second option on mainnet.

## Build

From the repo root, after the contracts are deployed:

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$HOME/.foundry/bin:$PATH"
(cd contracts && forge build)                         # ABIs → contracts/out
pnpm --filter @strike/subgraph abis                   # contracts/out → subgraph/abis (committed)
pnpm --filter @strike/subgraph set-network 46630      # contracts/deployments/46630.json → networks.json
pnpm --filter @strike/subgraph graph:codegen
pnpm --filter @strike/subgraph graph:build            # placeholder manifest (zero addresses)
```

`set-network <chainId>` reads `epochManager`, `vaultFactory`, `agentRegistry`, `stockOracle`, `feeManager` and `block` from `contracts/deployments/<chainId>.json`. It then writes every network name for that chain: 46630 fills `robinhood-sepolia` and `robinhood-testnet`, and 4663 fills `robinhood` and `robinhood-mainnet`. Pass `--network <name>` to write a different name (for example a local graph-node), and `--start-block <n>` to override the start block. If `block` is 0, it uses the earliest receipt in `contracts/broadcast/Deploy.s.sol/<chainId>/run-latest.json`.

`startBlock` must be an L2 block number at or before the first deployment transaction, or the constructor events (`FeesSet`, `ParamsSet`) are missed. Inside the EVM, Arbitrum chains return an L1 block estimate from `block.number`. Forge's local simulation uses the L2 number, so the `block` field should be correct, but compare it with the deployment transaction on the explorer before the first deploy.

`graph build --network <name>` and `graph deploy --network <name>` copy the addresses from `networks.json` into `subgraph.yaml`. The committed manifest is already in the layout graph-cli writes, so for a non-placeholder network only the `network`, `address` and `startBlock` lines change. Don't commit those changes. Restore the placeholder with `git checkout subgraph/subgraph.yaml`, or rebuild with `--network arbitrum-sepolia` while its entry still has zero addresses.

## Deploy

### The Graph Studio (Arbitrum Sepolia)

Create the subgraph in [Subgraph Studio](https://thegraph.com/studio/) (network: Arbitrum Sepolia), copy its slug and deploy key, then:

```bash
cd subgraph
pnpm run set-network 421614
pnpm graph:codegen
pnpm exec graph auth <STUDIO_DEPLOY_KEY>
pnpm exec graph deploy strike-arbitrum-sepolia --network arbitrum-sepolia --version-label v0.1.0
```

`graph deploy` builds first and defaults to the Studio node. The query URL is shown in Studio: `https://api.studio.thegraph.com/query/<id>/strike-arbitrum-sepolia/v0.1.0`.

### Goldsky (Robinhood Chain testnet and mainnet)

```bash
npm install -g @goldskycom/cli        # or: curl https://goldsky.com | sh
goldsky login                         # CI: goldsky login --token "$GOLDSKY_API_KEY"

cd subgraph
pnpm run set-network 46630
pnpm graph:codegen
pnpm exec graph build --network robinhood-testnet
goldsky subgraph deploy strike-robinhood-testnet/0.1.0 --path .

# mainnet
pnpm run set-network 4663
pnpm exec graph build --network robinhood-mainnet
goldsky subgraph deploy strike-robinhood/0.1.0 --path .
```

The commands follow [Goldsky's deploy guide](https://docs.goldsky.com/subgraphs/deploying-subgraphs). They have not been run against a live Strike deployment yet. `goldsky subgraph list` shows the GraphQL endpoint: `https://api.goldsky.com/api/public/<project>/subgraphs/strike-robinhood-testnet/0.1.0/gn`.

### Ormi (Robinhood Chain mainnet)

```bash
cd subgraph
pnpm run set-network 4663
pnpm graph:codegen
pnpm exec graph deploy strike --network robinhood --version-label v0.1.0 \
  --node https://subgraph.api.ormilabs.com/deploy \
  --ipfs https://subgraph.api.ormilabs.com/ipfs \
  --deploy-key "$ORMI_API_KEY"
```

This comes from [Ormi's CLI guide](https://ormilabs.com/docs/subgraphs/deploy-a-subgraph/deploy-subgraphs-via-cli.md). **Unverified:** Ormi's CLI reference page gives a different host, `api.subgraph.ormilabs.com`. Check which one your dashboard shows.

## Example queries

Single-entity queries take the id as a hex string. Vault ids are addresses. Agent ids are the agent number as a 32-byte word: agent 1 is `0x0000000000000000000000000000000000000000000000000000000000000001`, or `pad(toHex(1n))` in viem. You can also filter with `where: { agentId: "1" }`.

### Vault APY and chart data (app)

```graphql
query VaultApy($vault: ID!) {
  vault(id: $vault) {
    name
    symbol
    isCall
    underlying {
      symbol
      lastPrice
    }
    totalAssets
    tvlUsd
    pricePerShare
    lastPremiumApr
    cumulativePremiumToDepositors
    epochs(first: 12, orderBy: number, orderDirection: desc, where: { state: Settled }) {
      number
      openedAt
      closedAt
      spotAtOpen
      settlementPrice
      premium
      fee
      payoutValue
      premiumYield
      premiumApr
      series {
        strike
        expiry
        sold
        size
      }
    }
    sharePriceHistory(first: 52, orderBy: epochNumber, orderDirection: desc) {
      epochNumber
      pricePerShare
      premiumPerShare
      timestamp
    }
  }
  vaultDayDatas(first: 90, orderBy: date, orderDirection: desc, where: { vault: $vault }) {
    date
    tvlUsd
    premiumApr
    pricePerShare
    premiumSold
    premiumToDepositors
  }
}
```

A trailing APY is the mean of the last N `premiumApr` values. To compound it, use `(1 + premiumYield)^(52) − 1` for weekly epochs.

### Agent leaderboard (app, agents)

```graphql
query AgentLeaderboard {
  agents(first: 20, orderBy: cumulativePnl, orderDirection: desc, where: { status: Active }) {
    agentId
    owner
    erc8004Id
    bond
    strikes
    accepted
    rejected
    acceptanceRate
    settledEpochs
    cumulativePnl
    totalPremiumGenerated
    totalFeesEarned
    totalSlashed
    vaults {
      id
      symbol
      tvlUsd
    }
  }
}
```

### Rejection feed (app, agents learning from others' mistakes)

```graphql
query RejectionFeed($since: BigInt!) {
  proposalRejections(first: 50, orderBy: timestamp, orderDirection: desc, where: { timestamp_gte: $since }) {
    timestamp
    reason
    reasonCode
    slashed
    strike
    expiry
    size
    premiumBps
    epochNumber
    vault {
      id
      symbol
      underlying {
        symbol
      }
    }
    agent {
      agentId
      strikes
      status
    }
    transactionHash
  }
}
```

Add `reason: StrikeWrongSide` or `vault: "0x…"` to the `where` to narrow the feed.

### An agent's work queue

```graphql
query AgentVaults($agentId: BigInt!) {
  vaults(where: { agentId: $agentId }) {
    id
    symbol
    isCall
    locked
    totalAssets
    currentEpoch {
      number
      state
      openedAt
      spotAtOpen
      rejectionCount
      series {
        seriesId
        strike
        expiry
        size
        sold
      }
    }
  }
}
```

An epoch in state `Open` needs a proposal. One in state `Selling` whose `series.expiry` has passed can be settled by anyone.

### A depositor's queue and premium history

```graphql
query Account($account: Bytes!) {
  depositRequests(where: { account: $account, status: Pending }) {
    vault {
      id
      symbol
    }
    epochNumber
    assets
    epoch {
      state
    }
  }
  redeemRequests(where: { account: $account, status: Pending }) {
    vault {
      id
      symbol
    }
    epochNumber
    shares
    epoch {
      state
    }
  }
  premiumClaims(where: { account: $account }, orderBy: timestamp, orderDirection: desc) {
    vault {
      symbol
    }
    amount
    timestamp
  }
}
```

A pending request becomes claimable once its `epoch.state` is `Settled`, `Aborted` or `Cancelled`.

### Protocol totals

```graphql
{
  protocolStats(id: "0x737472696b65") {
    vaultCount
    agentCount
    settledEpochCount
    rejectionCount
    tvlUsd
    totalPremium
    totalFees
    totalSlashed
    totalBonded
  }
}
```

From a script:

```bash
curl -s "$SUBGRAPH_URL" -H 'content-type: application/json' \
  -d '{"query":"{ agents(first: 5, orderBy: cumulativePnl, orderDirection: desc) { agentId cumulativePnl } }"}'
```

## Tests

Unit tests use matchstick (`subgraph/tests/`). They cover vault creation (call and put), a full epoch (open, propose, buy, queued deposit and redemption, settlement out of and in the money, claims, redemption), a mandate rejection with slashing, suspension and abort, and agent registration, bonding, unbonding and slashing.

```bash
pnpm --filter @strike/subgraph graph:test          # graph-cli downloads matchstick (Ubuntu 22/24, macOS)
pnpm --filter @strike/subgraph graph:test:binary   # runs the matchstick binary directly (any Linux with libpq5)
```

Two environment notes:

- `graph test` only knows Ubuntu 22/24 and macOS. On Ubuntu 26.04 it stops with `Unsupported platform: Linux x64 26`. `graph:test:binary` downloads the same matchstick 0.6.0 Linux build and runs it. That binary needs `libpq.so.5` (`sudo apt install libpq5`).
- matchstick looks for `assemblyscript` and `@graphprotocol/graph-ts` in one folder. Under pnpm, `assemblyscript` is only a dependency of graph-cli, so `subgraph/matchstick.yaml` points `libsFolder` at pnpm's hoisted folder, `../node_modules/.pnpm/node_modules`. A cleaner fix is to add `assemblyscript@0.19.23` as a devDependency of `@strike/subgraph` and drop that line.
