# Social posts

Drafts for the build thread. Facts only; every number is from the repo. Each post in the X thread is at most 280 characters, counting a link as 23. The app is live at https://strike-options.vercel.app. Attach a clip from [media/strike-demo.mp4](../media/strike-demo.mp4) or a screenshot from [screenshots/](../screenshots/).

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

> Claude planned two accepted proposals, both on v3. Arbitrum Sepolia, Sep 30: five dry runs, then a 0.20-delta call at 105% of fair value ($364.29 strike). Robinhood Chain testnet, Oct 1: seven dry runs, same choice ($369.36). Records anchored on-chain:
>
> https://github.com/Prashant-thakur77/Strike#the-live-epochs

**6/**

> Test the mandate yourself, no wallet needed. The playground asks the live EpochManager to judge your proposal. An honest 0.20-delta call: Accepted. A reckless at-the-money put: DeltaOutOfBand. Too big: SizeTooLarge. Too cheap: PremiumBelowFair.
>
> https://strike-options.vercel.app/app/playground

**7/**

> Stock tokens have traps: Chainlink prices already include the ERC-8056 multiplier, equity feeds freeze on weekends, and both the token and its oracle can pause. SafeStockFeed handles each one, and our monitor checks 8 real mainnet stock tokens against those rules, live.

**8/**

> Strike in Telegram: a read-only bot turns the EpochManager's logs into alerts (series proposed, proposal rejected with the slash, options bought, settlement) and answers /vaults, /quote, /agent and /status. 60 tests.
>
> https://github.com/Prashant-thakur77/Strike/tree/main/bots/telegram

**9/**

> Evidence: 1,498 tests and proofs, 9 of them Halmos proofs, 99.3% line coverage, Rust and Solidity pricers equal to the wei, agent #1 on ERC-8004 (#114 and #253), and an internal review with 11 findings (1 High, 3 Medium, 4 Low, 3 Info), all fixed. Unaudited, testnet only.

**10/**

> To try it, start in the playground (no wallet), then spend five minutes with testnet tokens. Tell us what broke:
>
> https://github.com/Prashant-thakur77/Strike/blob/main/docs/testers.md

## Arbitrum Discord (#open-house)

> **Strike: agent-run options vaults on Robinhood Chain testnet and Arbitrum Sepolia**
>
> Weekly covered-call and cash-secured-put vaults on Robinhood stock tokens, with premium paid in USDG. An AI agent proposes each week's strike, and the `EpochManager` checks the proposal against the vault's immutable mandate. If the proposal breaks the mandate, the contract rejects it and slashes the agent's USDG bond to depositors. Strikes can be solved on-chain by a Stylus (Rust) Black-Scholes pricer, which is verified against its source with `cargo stylus verify`.
>
> You can test the mandate without a wallet: the playground (`/app/playground`) sends your proposal to the live `EpochManager.previewProposal` and shows the verdict. An honest 0.20-delta call is Accepted; a reckless at-the-money put gets `DeltaOutOfBand`. A read-only Telegram bot posts alerts from the contract logs (proposals, rejections with the slash, buys, settlements) and answers `/vaults`, `/quote`, `/agent` and `/status`.
>
> - Repo: https://github.com/Prashant-thakur77/Strike
> - Three live epochs, one on v2 and two on v3 across both chains, each with an accepted proposal, an on-chain rejection with a 10 USDG slash and a buyer; Claude planned the accepted proposal in both v3 epochs: https://github.com/Prashant-thakur77/Strike#the-live-epochs
> - Tester guide (starts with the playground, no wallet): https://github.com/Prashant-thakur77/Strike/blob/main/docs/testers.md
> - Telegram bot: https://github.com/Prashant-thakur77/Strike/tree/main/bots/telegram (`<bot handle>` once deployed)
> - App: https://strike-options.vercel.app
>
> It is unaudited and runs on testnet only. Feedback is very welcome, especially from anyone who has integrated stock tokens or Stylus.
