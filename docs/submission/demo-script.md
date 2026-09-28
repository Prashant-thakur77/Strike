# Demo video script (3 minutes)

Record on Robinhood Chain testnet with the app and a terminal side by side. Timestamps are targets.

## 0:00 to 0:20 · The problem

Screen: app landing page, the "three numbers" section.

> Robinhood Chain has tokenized TSLA, NVDA and SPY, but holding them earns nothing, and there are no options on the chain. Strike turns stock tokens into weekly income, paid in USDG, with AI agents that can only act inside limits the contract enforces.

## 0:20 to 0:50 · Deposit

Screen: `/app/faucet`, then the TSLA covered-call vault.

1. Show the wallet has testnet TSLA (Robinhood faucet) and USDG (Paxos faucet).
2. Deposit 10 TSLA into the covered-call vault. Point at the mandate panel: delta band 0.10 to 0.35, premium at least 95% of fair value, at most 80% of the vault sold, 1 to 8 day tenor.

## 0:50 to 1:40 · The agent, and the contract saying no

Screen: terminal running `pnpm --filter @strike/agent-example start`.

1. The agent reads the vault through the Strike MCP server, dry-runs `risk_check`, and proposes a 0.20-delta call with `proposeByDelta`. The contract solves the strike on-chain with the Stylus pricer. Show the accepted `SeriesProposed` event and the strike.
2. Run `pnpm --filter @strike/agent-example start -- --reckless`. The agent forces an at-the-money call (delta about 0.5). Show the transaction: `ProposalRejected(DeltaOutOfBand)`, and the agent's bond down by the slash amount. Open `/app/agents`: one strike on the agent, the rejection in the feed.

> The agent never touches vault funds. A reckless proposal costs it real USDG, and that USDG goes to the depositors.

## 1:40 to 2:10 · A buyer pays in USDG

Screen: vault page, buy panel, second wallet.

1. Quote 2 options. The premium is Black-Scholes fair value at the live oracle price. Buy with USDG.
2. Show the ERC-1155 position.

## 2:10 to 2:45 · Expiry and settlement

Screen: epoch timeline and terminal.

1. After Friday 16:00 New York, the keeper (or anyone) calls `settle`. It uses the first Chainlink round after expiry.
2. Show the payout redeemed by the buyer and the USDG premium claimable by the depositor, including the slashed bond.
3. Paused oracle case: on the test token, pause the oracle and show that settlement refuses to run (`FeedPaused`), then succeeds after unpausing.

## 2:45 to 3:00 · Close

Screen: README safety table.

> 373 tests, nine invariants, fork tests against real Robinhood mainnet tokens, Rust and Solidity pricers that agree to the wei. Strike: options on Robinhood Chain, run by agents that cannot break the rules.
