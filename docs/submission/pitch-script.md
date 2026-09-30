# Pitch video script (2 minutes)

The narration of [docs/media/strike-pitch.mp4](../media/strike-pitch.mp4) (1:59), read by one voice over the 16-slide deck in the order of [deck-outline.md](deck-outline.md). Timed captions are in [strike-pitch.srt](../media/strike-pitch.srt). About 330 words; every number is from the README.

The voice is Chatterbox TTS (Resemble AI, open source) with its built-in default voice. Slide 11 (Five users, one vault) has no line and is left out of the video to stay under two minutes.

## 0:00 · Slide 1: Strike

> Robinhood Chain put US stocks on-chain. Strike turns them into weekly options vaults, paid in USDG.

## 0:06 · Slide 2: Stock tokens sit idle

> Holding a stock token earns nothing extra. Options on the chain are new, and none lets an AI agent make the weekly call inside rules the contract enforces.

## 0:14 · Slide 3: Four traps

> Stock tokens also have traps: a multiplier applied twice, prices frozen over the weekend, two layers of pause. SafeStockFeed handles each one, and our monitor checks eight mainnet stock tokens, live.

## 0:25 · Slide 4: Why now

> Stylus makes solving the strike on-chain 3.3 times cheaper per proposal.

## 0:30 · Slide 5: Agents propose, the contract decides

> An AI agent picks each week's strike, but never touches the funds. The mandate is fixed on-chain: a delta band, a premium floor, a maximum size. Break it, and the agent's bond is slashed to depositors. Agent one is ERC-8004 identity 114, with a public reputation.

## 0:47 · Slide 6: One epoch, every week

> Deposit TSLA, and each week the vault sells a covered call, for a premium in USDG. Deposit USDG, and the put vault pays you to wait for a lower price.

## 0:57 · Slide 7: The app

> It is live at strike-options.vercel.app.

## 1:01 · Slide 8: Try it without a wallet

> Test it without a wallet: the playground runs any proposal against a live mandate, and the proof page links every claim to its evidence.

## 1:08 · Slide 9: Traction, on-chain

> On testnet, a buyer agent paid 10.01 USDG of premium, and a reckless agent's 10 USDG slash was paid to depositors.

## 1:16 · Slide 10: Who pays, and how many

> Cboe's BXM index has covered-call data back to 1986, and our backtest shows 25 to 46% lower volatility than holding.

## Slide 11 · Five users, one vault (not in the video)

## 1:24 · Slide 12: Competition

> Stonkhouse and Archer Markets let traders pick strikes. In Strike, a bonded agent proposes, and the contract checks.

## 1:30 · Slide 13: Paid only when depositors win

> Strike takes ten percent of positive weekly net premium, half to the agent. A losing week pays nothing.

## 1:36 · Slide 14: Evidence, not claims

> Behind it are 802 tests and proofs: 432 Foundry tests, 9 properties proven with Halmos, and 99.1% line coverage. An internal review found 11 issues, one of them High, and all are fixed.

## 1:49 · Slide 15: What comes next

> Next come a capped mainnet vault, more tickers and put spreads.

## 1:53 · Slide 16: The ask

> Strike: weekly options vaults on Robinhood Chain, with agents the contract holds to their mandate.
