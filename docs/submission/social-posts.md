# Social posts

Drafts for the build thread. Facts only; every number is from the repo. Each post is at most 280 characters, counting a link as 23. Replace `<live app URL>` once the app is on Vercel (until then, post 5 can link the repo instead), and attach a clip from [media/strike-demo.mp4](../media/strike-demo.mp4) or a screenshot from [screenshots/](../screenshots/).

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

> Test the mandate yourself, no wallet needed. The playground asks the live EpochManager to judge your proposal. An honest 0.20-delta call: Accepted. A reckless at-the-money put: DeltaOutOfBand. Too big: SizeTooLarge. Too cheap: PremiumBelowFair.
>
> <live app URL>/app/playground

**6/**

> Stock tokens have traps: Chainlink prices already include the ERC-8056 multiplier, equity feeds freeze on weekends, and both the token and its oracle can pause. SafeStockFeed handles each one, and our monitor checks 8 real mainnet stock tokens against those rules, live.

**7/**

> Strike in Telegram: a read-only bot turns the EpochManager's logs into alerts (series proposed, proposal rejected with the slash, options bought, settlement) and answers /vaults, /quote, /agent and /status. 60 tests.
>
> https://github.com/Prashant-thakur77/Strike/tree/main/bots/telegram

**8/**

> Evidence: 432 Foundry tests, 9 properties proven with Halmos, 99.1% line coverage, Rust and Solidity pricers equal to the wei, agent #1 on ERC-8004 as identity #114, and an internal review with 8 of 8 findings fixed (1 High, 3 Medium, 4 Low) plus 3 Info. Unaudited, testnet only.

**9/**

> Want to try it? Start in the playground with no wallet, then five minutes with testnet tokens. Tell us what broke:
>
> https://github.com/Prashant-thakur77/Strike/blob/main/docs/testers.md

## Arbitrum Discord (#open-house)

> **Strike: agent-run options vaults on Robinhood Chain (testnet)**
>
> Weekly covered-call and cash-secured-put vaults on Robinhood stock tokens, with premium paid in USDG. An AI agent proposes each week's strike, and the `EpochManager` checks the proposal against the vault's immutable mandate. If the proposal breaks the mandate, the contract rejects it and slashes the agent's USDG bond to depositors. Strikes can be solved on-chain by a Stylus (Rust) Black-Scholes pricer, which is verified against its source with `cargo stylus verify`.
>
> You can test the mandate without a wallet: the playground (`/app/playground`) sends your proposal to the live `EpochManager.previewProposal` and shows the verdict. An honest 0.20-delta call is Accepted; a reckless at-the-money put gets `DeltaOutOfBand`. A read-only Telegram bot posts alerts from the contract logs (proposals, rejections with the slash, buys, settlements) and answers `/vaults`, `/quote`, `/agent` and `/status`.
>
> - Repo: https://github.com/Prashant-thakur77/Strike
> - Live testnet epoch (an accepted proposal, an on-chain rejection with a 10 USDG slash, a buyer agent's purchase): https://github.com/Prashant-thakur77/Strike/blob/main/docs/testnet-epochs/2026-09-29.md
> - Tester guide (starts with the playground, no wallet): https://github.com/Prashant-thakur77/Strike/blob/main/docs/testers.md
> - Telegram bot: https://github.com/Prashant-thakur77/Strike/tree/main/bots/telegram (`<bot handle>` once deployed)
> - App: `<live app URL>` (pending)
>
> It is unaudited and runs on testnet only. Feedback is very welcome, especially from anyone who has integrated stock tokens or Stylus.
