# Demo video script (2:50)

The narration of [docs/media/strike-demo-narrated.mp4](../media/strike-demo-narrated.mp4) (170.6 s, 1920×1080), and the captions of the silent cut [strike-demo.mp4](../media/strike-demo.mp4). Both are rendered by `node video/record.mjs demo` from the scene list in [video/demo.mjs](../../video/demo.mjs), and this file is written by the same run, so the times and words below are the video's own. The captions show the spoken words (two lines of at most about 42 characters); the timed captions are in [strike-demo.srt](../media/strike-demo.srt).

The voice is Chatterbox TTS (open source, Resemble AI) with a synthetic reference voice, 334 words in 171 s (117 words a minute, numbers counted as one word). Every number is read from README.md at render time; the NVDA multiplier is read from the live monitor. Nothing here is audited: the close says so.

## 0:00 to 0:15 · Strike

Screen: The landing page ("Stock tokens that pay every week"), then a zoom on its payoff sketch (covered call against the stock alone) and on the one-line definition.

> This is Strike: weekly options vaults for Robinhood Chain stock tokens.
>
> A covered call pays a weekly premium, but someone has to pick the strike.
>
> Here an AI agent picks it, and the contract checks it against a mandate.

## 0:15 to 0:33 · Playground

Screen: `/app/playground`, no wallet. Zoom on the honest 0.20-delta call preset, click it, zoom on **Accepted**; click the reckless at-the-money preset, zoom on **Rejected: DeltaOutOfBand**, then on the 10 USDG slash panel.

> The playground asks the deployed Epoch Manager about a proposal, with no wallet.
>
> An honest 0.20-delta call: accepted.
>
> A reckless at-the-money strike: rejected, delta out of band.
>
> A real one would cost the agent 10 USDG of its bond.

## 0:33 to 0:55 · Live epoch

Screen: A terminal replay of the real run on 29 September ([testnet-epochs/2026-09-29.md](../testnet-epochs/2026-09-29.md)), opening half-printed: the seller agent's `proposeByDelta` accepted at $369.86, then the reckless agent's forced put rejected and its bond going from 60 to 50 USDG.

> It happened for real on September 29.
>
> The seller agent asked for a 0.20-delta Tesla call, and the contract solved the strike on-chain: $369.86, accepted.
>
> Then a reckless agent forced an at-the-money put.
>
> Rejected, and 10 USDG slashed: its bond went from 60 to 50.

## 0:55 to 1:10 · Explorer

Screen: The rejected `proposeSeries` transaction on the Robinhood Chain explorer ([0x3df523aa…c6a0](https://explorer.testnet.chain.robinhood.com/tx/0x3df523aae815e10cba8f5f99076f9cb348745e7657dd1f1338820af0469dc6a0)): zoom on the **Success** status, then a highlight box and zoom on "Tokens transferred: AgentRegistry → EpochManager for 10 USDG".

> Here it is on the Robinhood Chain explorer.
>
> The status says Success, because a rejection is not a revert.
>
> The transaction ran, the contract refused the proposal, and 10 USDG left the agent's bond.

## 1:10 to 1:42 · Vault

Screen: The TSLA covered-call vault page: zoom on the $369.86 strike and the 10.01 USDG premium collected, then the payoff chart with a zoom on the $372.36 breakeven, then the Risk section (greeks and a ±30% stress test from the Rust risk engine on Stylus) with a zoom on the worst case, −$321.40, read at render time.

> The Tesla covered-call vault this week: the $369.86 call, all four sold to a buyer agent, for 10.01 USDG.
>
> The buyer profits above $372.36. At or below the strike, depositors keep the whole premium.
>
> A risk engine written in Rust on Stylus stress-tests this week's option on-chain.
>
> Its worst case: a 30% jump in Tesla, and −$321.40 for the vault.

## 1:42 to 1:51 · Agents

Screen: `/app/agents` leaderboard: zoom on agent #1's ERC-8004 #114 link, then on its 50 USDG bond.

> Agent one is ERC-8004 identity 114: one accepted, one rejected, and a 50 USDG bond.

## 1:51 to 2:04 · Monitor

Screen: `/app/monitor`, live from Robinhood Chain mainnet: scroll to NVDA and zoom on its multiplier (1.000775159, read from the page at render time).

> This monitor reads every stock token on Robinhood Chain mainnet, live.
>
> Nvidia's multiplier, 1.000775, is already in the price, so Strike never applies it twice.

## 2:04 to 2:20 · Backtest

Screen: `/app/backtest`: zoom on the volatility figures, switch the stock to NVDA, zoom again.

> Over 403 weekly epochs since 2019, the covered call traded upside for 25 to 46% lower volatility.
>
> On Nvidia, from 45.6% down to 26.5%.

## 2:20 to 2:35 · Evidence

Screen: One card with five numbers from the README, each lit as it is said.

> 891 tests and proofs, 99.3% line coverage, nine properties proven with Halmos,
>
> all 11 internal-review findings fixed, and a Stylus strike solver that uses 6.5 times less gas.

## 2:35 to 2:50 · Strike

Screen: The closing card: the line, **strike-options.vercel.app**, the repository and "Unaudited · testnet", then a few seconds of silence.

> Strike: options on Robinhood Chain, run by agents the contract holds to a mandate.
>
> Try the playground at strike-options.vercel.app. It is unaudited, and on testnet.
