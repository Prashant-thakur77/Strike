# Social posts

Drafts for the build thread. Facts only; every number is from the repo. Each post is at most 280 characters, counting a link as 23. Replace `<live app URL>` once the app is on Vercel, and attach a clip from [media/strike-demo.mp4](../media/strike-demo.mp4) or a screenshot from [screenshots/](../screenshots/).

## X thread

**1/**

> Strike: weekly options vaults for Robinhood Chain stock tokens, paid in USDG. Built for Arbitrum Open House Singapore.
>
> An AI agent picks the strike. A proposal outside the vault's mandate is rejected on-chain and the agent's bond slashed to depositors.
>
> https://github.com/Prashant-thakur77/Strike

**2/**

> Deposit TSLA and the vault sells a covered call; deposit USDG and it sells a cash-secured put. Buyers pay premium in USDG at an oracle-anchored Black-Scholes price. Settlement uses the first Chainlink round at or after Friday's NYSE close.

**3/**

> The agent never holds vault funds. It only proposes. Each vault's mandate is fixed at creation: delta band, minimum premium against fair value, minimum yield, maximum size, tenor. The strike can be solved on-chain from a target delta, with a Rust pricer on Arbitrum Stylus.

**4/**

> Live on Robinhood Chain testnet, Sep 29: a 0.20-delta TSLA call accepted, a reckless at-the-money put rejected on-chain with 10 USDG slashed to depositors, and a buyer agent bought 4 calls for about 10 USDG. Every transaction is linked:
>
> https://github.com/Prashant-thakur77/Strike/blob/main/docs/testnet-epochs/2026-09-29.md

**5/**

> Stock tokens have traps: Chainlink prices already include the ERC-8056 multiplier, the equity feeds freeze on weekends, and both the token and its oracle can be paused. SafeStockFeed handles each one, and any Robinhood Chain protocol can reuse it.

**6/**

> Evidence: 418 Foundry tests, 9 invariants, fork tests against real mainnet tokens, Rust and Solidity pricers equal to the wei, and an internal review (1 High, 3 Medium, 4 Low, 3 Info) with every finding fixed. Unaudited, testnet only.

**7/**

> Want to try it? Five minutes with testnet tokens, then tell us what broke:
>
> https://github.com/Prashant-thakur77/Strike/blob/main/docs/testers.md

## Arbitrum Discord (#open-house)

> **Strike: agent-run options vaults on Robinhood Chain (testnet)**
>
> Weekly covered-call and cash-secured-put vaults on Robinhood stock tokens, with premium paid in USDG. An AI agent proposes each week's strike, and the `EpochManager` checks the proposal against the vault's immutable mandate. If the proposal breaks the mandate, the contract rejects it and slashes the agent's USDG bond to depositors. Strikes can be solved on-chain by a Stylus (Rust) Black-Scholes pricer, which is verified against its source with `cargo stylus verify`.
>
> - Repo: https://github.com/Prashant-thakur77/Strike
> - Live testnet epoch (an accepted proposal, an on-chain rejection with a 10 USDG slash, a buyer agent's purchase): https://github.com/Prashant-thakur77/Strike/blob/main/docs/testnet-epochs/2026-09-29.md
> - Tester guide (5 minutes): https://github.com/Prashant-thakur77/Strike/blob/main/docs/testers.md
> - App: `<live app URL>` (pending)
>
> It is unaudited and runs on testnet only. Feedback is very welcome, especially from anyone who has integrated stock tokens or Stylus.
