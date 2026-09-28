# Strike

**Options vaults for Robinhood Chain stock tokens, paid in USDG, run by AI agents that can only act inside a mandate the contract enforces.**

Deposit TSLA, NVDA or SPY stock tokens (or USDG). Each week the vault sells a covered call (or a cash-secured put) and pays the premium in USDG. An AI agent picks the strike, but the contract rejects any proposal outside the vault's mandate and slashes the agent's bond.

> Status: under active development for the Arbitrum Open House Singapore buildathon. Unaudited. Not for use with real funds.

## Why

- **Stock tokens earn nothing.** Robinhood Chain stock tokens sit idle: there are perps, but no options and no yield.
- **Integrations get stock-token data wrong.** Chainlink prices already include the ERC-8056 `uiMultiplier`; applying it again double-counts splits and dividends. Weekend feeds freeze, and both the token and its oracle can be paused.
- **Agents need guardrails, not just keys.** An agent that can trade a vault can drain it. Strike's agents only propose; the contract decides.

## How it works

1. A vault opens a weekly epoch once the market is open and the price feed is fresh.
2. A registered agent proposes a strike and a size. `MandateGuard` checks it against the vault's delta band, minimum premium (vs Black-Scholes fair value), maximum share sold and tenor.
3. Buyers pay USDG for ERC-1155 option tokens.
4. At Friday 16:00 New York time the option expires. `SafeStockFeed` only accepts a fresh, unpaused, multiplier-correct price.
5. Settlement pays calls `(S − K) / S` stock tokens per option and puts `(K − S)` USDG per option. The rest rolls back to depositors.

See [docs/PLAN.md](docs/PLAN.md) for the full plan.

## Repository layout

| Folder | Contents |
| --- | --- |
| `contracts/` | Solidity (Foundry): vaults, factory, epoch manager, option token, mandate guard, agent registry, fee manager, `SafeStockFeed` |
| `stylus/pricer/` | Rust (Arbitrum Stylus): fixed-point Black-Scholes pricer |
| `sdk/` | `@strike/sdk`: typed TypeScript client |
| `mcp/` | MCP server for agents |
| `app/` | Next.js app |
| `subgraph/` | Indexer for epochs, premiums and PnL |
| `agents/example/` | Example strike-picking agent |
| `docs/` | Design, threat model, decisions |

## License

[MIT](LICENSE)
