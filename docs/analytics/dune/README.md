# Dune queries: the Robinhood Chain stock-token market

Strike sells weekly options on Robinhood Chain stock tokens, so the size of that market is the first number behind the [wedge](../../JUDGES.md#how-strike-maps-to-the-workshop-themes): how many wallets hold stock tokens, how much moves each day, how much is issued. These queries measure it on Dune. **They are written and not yet published: there is no Strike dashboard on Dune until the owner publishes one**, and the queries have not been run on Dune yet.

## What Dune indexes (checked 2026-10-03)

| Chain                           | On Dune                                                            | What that means for Strike                                                         |
| ------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Robinhood Chain mainnet (4663)  | Yes, as the `robinhood` schema (chain ID to confirm with query 00) | The stock tokens Strike's monitor reads can be queried: the four files below       |
| Robinhood Chain testnet (46630) | No                                                                 | Strike's live vaults are not on Dune. Use Strike's own analytics (below)           |
| Arbitrum Sepolia (421614)       | No                                                                 | Same. Dune's only testnets in the catalogue are Ethereum Sepolia and Monad Testnet |

Sources: Dune's [chain coverage table](https://docs.dune.com/data-catalog/overview) lists "Robinhood" with raw, decoded, transfers and gas data (no prices, balances or DEX tables), and no Robinhood or Arbitrum testnet; its [Robinhood Chain overview](https://docs.dune.com/data-catalog/evm/robinhood/overview) gives the `robinhood` schema (`robinhood.blocks`, `robinhood.transactions`, `robinhood.logs`, `robinhood.traces`), decoded tables and `erc20_robinhood.evt_*`. Dune announced the chain in July 2026 ([Dune on X](https://x.com/Dune/status/2072395677855043864)), naming stock-token activity and bridge flows to Ethereum.

Dune's pages do not state the chain ID. Mainnet's first block is from 30 April 2026, Dune's launch post covers stock-token issuance and bridging to Ethereum, and the testnet's stock tokens are test tokens, so the schema is very likely mainnet 4663. [`00-check-chain.sql`](00-check-chain.sql) settles it in one run: it reads block 1's time (mainnet 2026-04-30 16:52:11 UTC, testnet 2026-02-06 16:01:00 UTC, both read from the public RPCs) and counts Transfer logs of the mainnet TSLA token, which exists only on 4663.

## The queries

All of them read `robinhood.logs` and decode the ERC-20 `Transfer` event by hand, so they need no decoded tables. The token list is the eight stock tokens in [`strike.config.json`](../../../strike.config.json) `chains.4663.stocks` (TSLA, NVDA, AMZN, PLTR, AMD, SPY, AAPL, QQQ), the same tokens the [monitor](https://strike-options.vercel.app/app/monitor) checks.

| File                                                                             | What it returns                                                                                                  | Suggested chart                     |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| [`00-check-chain.sql`](00-check-chain.sql)                                       | Block 1's time, the latest block, and the TSLA token's Transfer count: proves which chain the schema is          | Counter                             |
| [`01-stock-token-transfers-daily.sql`](01-stock-token-transfers-daily.sql)       | Per token per day: transfers, transactions, unique senders and receivers, volume in tokens (mints and burns out) | Stacked bars by symbol; volume line |
| [`02-stock-token-holders.sql`](02-stock-token-holders.sql)                       | Per token: holders today, supply (minted minus burned), the top ten holders' share                               | Table, or bars of holders           |
| [`03-stock-token-issuance-daily.sql`](03-stock-token-issuance-daily.sql)         | Per token per day: minted, burned, net and cumulative net supply                                                 | Bars up and down; cumulative line   |
| [`04-stock-token-new-holders-weekly.sql`](04-stock-token-new-holders-weekly.sql) | New addresses that received any of the eight tokens, by week, and the running total                              | Bars and a cumulative line          |

Things to know when reading the results:

- Amounts are raw ERC-8056 units, the unit the Chainlink stock feeds price. The UI share count is raw × `uiMultiplier` / 1e18; on 3 October the multipliers ran from 1.0 (TSLA, AMZN, PLTR, AMD) to 1.0017 (SPY), so the two differ by under 0.2%. Strike never applies the multiplier to a price ([Why](../../../README.md#why)).
- Volume is in tokens, not dollars. Dune has no price table for Robinhood Chain yet, and the Chainlink rounds are emitted by the feeds' aggregator contracts, not the proxies in the config, so a dollar figure is left out rather than guessed.
- Holders are addresses with a balance. Pools, vaults and bridges count, so the number is not a count of people.
- Check query 02 against the chain: its `supply_tokens` for TSLA should match `totalSupply()` (12,699.61635 TSLA at the time of writing): `cast call 0x322F0929c4625eD5bAd873c95208D54E1c003b2d "totalSupply()(uint256)" --rpc-url https://rpc.mainnet.chain.robinhood.com`.

## How the owner publishes them

This needs a Dune account, which Strike does not have yet (listed for the owner in the team's to-do list).

1. Sign in at [dune.com](https://dune.com) and create a query (**Create**, then **New query**). The engine is DuneSQL, the default.
2. Paste [`00-check-chain.sql`](00-check-chain.sql), run it and confirm `block1_time` is 2026-04-30 16:52:11 and `tsla_transfer_logs` is above zero. If block 1 is in February, the schema is the testnet: stop, and change the README table above.
3. For each of 01 to 04: paste, run, save with the file's name, and add the chart from the table above (**New visualization**).
4. Create a dashboard (**Create**, then **New dashboard**), named "Robinhood Chain stock tokens (Strike)", add the visualizations, and keep it public.
5. Put the dashboard's URL in this README, in the README's [Roadmap after the buildathon](../../../README.md#roadmap-after-the-buildathon) and in the JUDGES theme table, replacing "not published". Only then does a dashboard exist.

## Strike's own activity

Dune does not index the two testnets Strike runs on, so Strike's own numbers come from Strike:

- [`/api/stats`](https://strike-options.vercel.app/api/stats): live counts across all three deployments (wallets and how many are outside the team, epochs, proposals accepted and rejected, options bought and premium, USDG slashed, decision records anchored, value locked); the proof page shows them ([ENDPOINTS.md](../../ENDPOINTS.md)).
- The Postgres indexer in [`services/indexer`](../../../services/indexer/README.md): every vault deposit, option sale, slash and settlement as rows, run locally with Docker Compose ([D41](../../decisions.md)).
- The per-week records read from the chain in [`docs/evidence`](../../evidence/README.md).

When the capped mainnet vault exists on 4663, Dune will index its events too. The plan then: submit the verified contracts for decoding on Dune and add a vault query next to these.
