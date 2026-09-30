# Demo video script (3 minutes)

Narration for the re-cut demo video, [docs/media/strike-demo.mp4](../media/strike-demo.mp4), which is captioned. The scenes below follow the new cut's order. Each scene gives a target window, what is on screen, and a narration line to read over the captions; the lines run at about 150 words a minute and leave a few seconds of slack. Every number is from the repo.

If a timing drifts in the final cut, keep the order and shorten the narration, not the claims.

## 0:00 to 0:14 · Hero

Screen: the landing page hero, "Stock tokens that pay every week", with the covered-call payoff line.

> Stock tokens on Robinhood Chain earn nothing on their own. Strike turns them into weekly income, paid in USDG, with AI agents that can only act inside limits the contract enforces.

## 0:14 to 0:42 · Playground: accepted, then rejected

Screen: `/app/playground`, no wallet connected. Pick the presets in order: **Honest agent** (0.20-delta call) shows **Accepted**; **Reckless agent** (at-the-money put) shows **DeltaOutOfBand** and the bond a real proposal would lose; then flash **Too big** (`SizeTooLarge`) and **50% of fair value** (`PremiumBelowFair`).

> No wallet needed. The playground asks the live EpochManager on Robinhood Chain testnet to judge a proposal, with previewProposal. An honest 0.20-delta call: accepted. A reckless at-the-money put: DeltaOutOfBand, and a real proposal like this would cost the agent part of its bond. Too big, or priced below fair value: rejected too.

## 0:42 to 1:14 · The real testnet epoch, on Blockscout

Screen: [testnet-epochs/2026-09-29.md](../testnet-epochs/2026-09-29.md), then its Blockscout links: the accepted `proposeByDelta` ([0x92169eac…a9d4](https://explorer.testnet.chain.robinhood.com/tx/0x92169eac7bd2491d1f22f394e15643d5d54309c1e980683cf82a13088021a9d4)), the rejection with `ProposalRejected(DeltaOutOfBand)` and the slash ([0x3df523aa…c6a0](https://explorer.testnet.chain.robinhood.com/tx/0x3df523aae815e10cba8f5f99076f9cb348745e7657dd1f1338820af0469dc6a0)), and the buyer agent's purchase ([0x425e5b63…e9f9](https://explorer.testnet.chain.robinhood.com/tx/0x425e5b63ddeb1fcff5d63aa9f5a9fd11f4d3c0f52facd05e0fb44096f2ede9f9)).

> This happened on-chain on September 29. Our agent asked for a 0.20-delta TSLA call; the Stylus pricer solved the strike, $369.86, and the contract accepted it. Stylus makes that transaction 3.3 times cheaper, and the solver 6.5 times. Then a reckless agent forced an at-the-money put: rejected, and 10 USDG of its bond went to depositors. A buyer agent bought 4 calls for about 10 USDG.

## 1:14 to 1:40 · Vault page: price breakdown and payoff chart

Screen: the TSLA covered-call vault page. The mandate panel, then the live series with its buy-price breakdown and payoff chart.

> Each vault shows its mandate and its live series. The breakdown shows how a buyer's price is made: Black-Scholes fair value at the oracle price moved against the buyer, times the agent's premium factor, never below intrinsic value, next to the contract's own quote. The payoff chart shows what buyer and depositor get at expiry.

## 1:40 to 1:58 · Agents: ERC-8004 identity #114

Screen: `/app/agents`, agent #1's row open: bond, one strike, accepted and rejected proposals, and the **ERC-8004 #114** link.

> Every agent posts a USDG bond, and three strikes suspend it. Agent one is linked to ERC-8004 identity 114 on the official Robinhood testnet registry, so each settled epoch and each rejection feeds its public reputation.

## 1:58 to 2:14 · Telegram alert

Screen: the Telegram alert for the rejection ("sTSLA-CSP: agent 1 proposal rejected, DeltaOutOfBand … Slashed 10 USDG"), then a `/quote` reply. If the bot is not deployed yet, show `pnpm --filter @strike/telegram-bot dry-run "/quote sTSLA-CC 1"` instead: it prints the same alerts from the real testnet logs and sends nothing.

> The Telegram bot reads the same contract logs. Here is its alert for that rejection, with the slash and a Blockscout link. It also answers vaults, quote, agent and status.

## 2:14 to 2:32 · Mainnet safety monitor

Screen: `/app/monitor`, eight Robinhood Chain mainnet stock tokens with their verdicts; open NVDA.

> The monitor reads eight stock tokens on Robinhood Chain mainnet, live, and judges each one by our SafeStockFeed rules: multiplier, both pause flags, feed age, market hours. NVDA's multiplier is 1.000775, and Strike never applies it twice.

Check that the NVDA multiplier on screen still reads 1.000775 (it was read on 2026-09-29); if it changed, say the number on screen.

## 2:32 to 2:50 · Proof

Screen: `/app/proof`: the headline numbers, the security section, then the live activity feed.

> The proof page puts each claim next to its evidence: 432 Foundry tests, 9 properties proven with Halmos, all 8 review findings fixed, one High, three Medium, four Low, plus three Info notes, and a live feed of the EpochManager's events.

## 2:50 to the end · Close

Screen: the landing page, "Try it without a wallet" (Playground, Monitor, Proof).

> Strike: options on Robinhood Chain, run by agents that cannot break the rules, paid in USDG. Unaudited, live on testnet.
