# Demo video script (2:55)

Narration for the captioned demo video, [docs/media/strike-demo.mp4](../media/strike-demo.mp4) (174.5 s, 1920×1080). The times below are the cut's real scene boundaries. The same captions, with exact timings, are in [strike-demo.srt](../media/strike-demo.srt). Each scene lists what is on screen and a line to read over it. The lines run at about 150 words a minute. Every number is from the README.

The video is made by `node video/record.mjs`. If a timing drifts in a new cut, keep the order and shorten the narration, not the claims.

## 0:00 to 0:08 · Hero

Screen: the landing page, "Stock tokens that pay every week", then a scroll to the live band of real testnet events.

> Strike runs weekly options vaults for stock tokens on Robinhood Chain. Everything here is read from the testnet.

## 0:08 to 0:18 · The problem

Screen: three lines: "Idle tokens.", "Options, run by hand.", "Agent + contract."

> Stock tokens earn nothing on their own. Options exist on the chain, but people run them by hand. In Strike an AI agent runs the vault, and the contract enforces the rules.

## 0:18 to 0:29 · Competition

Screen: the README's capability matrix, then the positioning chart (`docs/media/charts/competition-*-light.png`).

> Stonkhouse and Archer Markets let traders pick strikes and trade them on an order book. In Strike, a bonded agent proposes the strike, and the contract checks it before anything is sold.

## 0:29 to 0:43 · Playground

Screen: `/app/playground`, no wallet. The honest 0.20-delta call is accepted. The at-the-money put is rejected with `DeltaOutOfBand`, and the panel shows the 10 USDG slash.

> The playground asks the deployed EpochManager about a proposal, with a read-only call. An honest 0.20-delta call is accepted. A reckless at-the-money put is rejected, DeltaOutOfBand, and a real one would cost the agent 10 USDG of its bond.

## 0:43 to 1:02 · The live epoch

Screen: a terminal replay of the real run on 29 September ([testnet-epochs/2026-09-29.md](../testnet-epochs/2026-09-29.md)): the seller agent, then the reckless agent.

> This ran on Robinhood Chain testnet on September 29. The seller agent asked for a 0.20-delta TSLA call, and the contract solved the strike on-chain: $369.86, accepted. Then a reckless agent forced an at-the-money put. The contract rejected it and slashed 10 USDG. Its bond went from 60 to 50.

## 1:02 to 1:06 · Blockscout

Screen: the rejected `proposeSeries` transaction ([0x3df523aa…c6a0](https://explorer.testnet.chain.robinhood.com/tx/0x3df523aae815e10cba8f5f99076f9cb348745e7657dd1f1338820af0469dc6a0)), with 10 USDG moved out of the agent's bond.

> Here is that rejection on Blockscout, with the 10 USDG leaving the bond.

## 1:06 to 1:13 · Buyer agent

Screen: the buyer agent's run, 4 calls for 10.005944 USDG.

> A buyer agent with a 15 USDG budget bought 4 calls. The premium is the most it can lose.

## 1:13 to 1:28 · Vault: price breakdown and payoff chart

Screen: the TSLA covered-call vault page: this week's $369.86 call (4 of 4 sold), how the buy price is set, and the result at expiry.

> This is the TSLA covered-call vault. The buy price is Black-Scholes fair value at the oracle price plus 0.5% against the buyer, never below intrinsic value. The buyer profits above $372.36. At or below the strike, depositors keep the whole premium.

## 1:28 to 1:42 · Backtest

Screen: `/app/backtest`. Switch the stock from TSLA to NVDA, then hover the equity curve so the tooltip shows.

> The backtest runs the contract rules over 403 weekly epochs, from January 2019 to September 2026. On NVDA the covered call's volatility is 26.5%, against 45.6% for holding. On every stock, it gives up upside for 25 to 46% lower volatility.

## 1:42 to 2:01 · Agents and the open agent market

Screen: `/app/agents`: the leaderboard with agent #1 and its ERC-8004 #114 link, the rejection feed, then "Run your own agent" (register, bond, run a vault).

> Every agent posts a USDG bond. Agent one is linked to ERC-8004 identity 114: one accepted proposal, one rejected, one strike, a 50 USDG bond. The rejection feed lists every slash. And the market is open: any agent can register, bond USDG and run a vault, with no permission needed.

## 2:01 to 2:11 · Telegram alerts

Screen: a chat with the bot's real alerts for the testnet, printed by `pnpm --filter @strike/telegram-bot dry-run`: the rejection and the sale.

> The Telegram bot reads the same contract logs. It posts the rejection with the rule that was broken and the slash, and the sale of 4 calls.

## 2:11 to 2:21 · Mainnet safety monitor

Screen: `/app/monitor`: every Robinhood Chain stock token on mainnet, 8 of 8 Ok; the NVDA row.

> The monitor reads every stock token on Robinhood Chain mainnet and gives each one the verdict our contracts would. NVDA's multiplier is 1.000775. It is already in the price, so Strike never applies it.

Check that the NVDA multiplier on screen still reads 1.000775; if it changed, say the number on screen.

## 2:21 to 2:35 · Proof page

Screen: `/app/proof`: verified contracts, the test counts, the Halmos properties, the internal review.

> The proof page puts each claim next to its evidence. Every deployed contract is verified on Blockscout. There are 432 Foundry tests and 9 properties proven with Halmos. An internal review found 11 issues, and all are fixed.

## 2:35 to 2:48 · Evidence

Screen: three README charts, full frame: tests by suite, coverage by contract, and gas for Stylus against Solidity.

> In total there are 802 tests and proofs, including 9 fork tests on mainnet. Line coverage is 99.1%. The strike solver written for Stylus costs 6.5 times less gas than the Solidity one.

## 2:48 to 2:55 · Close

Screen: the closing card: 802 tests and proofs (432 Foundry tests), 9 invariants, 9 formal proofs, fork tests on mainnet, 6.5× less gas for the solver, and the repository link.

> Strike: options on Robinhood Chain, run by agents that cannot break the rules. Unaudited, and live on testnet.
