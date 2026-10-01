# Demo video script (8:02)

The narration of [docs/media/strike-demo.mp4](../media/strike-demo.mp4) (482.8 s, 1920×1080, narrated, with a quiet music bed), and the captions of the voiceless cut [strike-demo-silent.mp4](../media/strike-demo-silent.mp4). Both are rendered by `node video/record.mjs demo` from the scene list in [video/demo.mjs](../../video/demo.mjs), and this file is written by the same run, so the times and words below are the video's own. The captions show the spoken words (two lines of at most about 42 characters); the timed captions are in [strike-demo.srt](../media/strike-demo.srt).

The arc: the problem (over stock footage), the turn, the key features, the architecture (a 3D scene with a spotlight on each part as it is named), one depositor's walkthrough of the live product on both chains, challenges and solutions, and the close. The voice is Chatterbox TTS (open source, Resemble AI) with a synthetic reference voice, 1088 words in 483 s (135 words a minute, numbers counted as one word). Every number is read from README.md and the epoch logs at render time; the NVDA multiplier is read from the live monitor, and the DecisionLog hash is recomputed and read from Arbitrum Sepolia. The 3D scenes are three.js pages ([video/three.html](../../video/three.html)) drawn from the same numbers. Footage and music credits: [docs/media/CREDITS.md](../media/CREDITS.md). Nothing here is audited: the video says so.

## Chapters

Ready to paste into a YouTube description:

```
0:00 The problem
0:31 Strike
0:43 Key features
1:03 Architecture
1:57 Walkthrough: one depositor's week
3:18 Live on Robinhood Chain testnet, 29 September
3:50 Planned by Claude, on Arbitrum Sepolia
4:54 Rust on Stylus: pricer and risk engine
5:11 Decision records and identity
5:42 The multiplier trap, live
5:55 Backtest: what it shows, and what it doesn't
6:19 Evidence: the proof page
6:33 Who else is here, and how Strike differs
7:22 Challenges and solutions
7:47 Close
```

## Video description

```
Strike: weekly options vaults for Robinhood Chain stock tokens, run by AI agents the contract holds to a mandate. Live on Robinhood Chain testnet and Arbitrum Sepolia. Unaudited; testnet only.

App: https://strike-options.vercel.app
Code: https://github.com/Prashant-thakur77/Strike

0:00 The problem
0:31 Strike
0:43 Key features
1:03 Architecture
1:57 Walkthrough: one depositor's week
3:18 Live on Robinhood Chain testnet, 29 September
3:50 Planned by Claude, on Arbitrum Sepolia
4:54 Rust on Stylus: pricer and risk engine
5:11 Decision records and identity
5:42 The multiplier trap, live
5:55 Backtest: what it shows, and what it doesn't
6:19 Evidence: the proof page
6:33 Who else is here, and how Strike differs
7:22 Challenges and solutions
7:47 Close

Voice: Chatterbox TTS (Resemble AI, open source) with a synthetic reference voice.
Music: "Strike ambient bed", synthesised for this video by video/narration/music.py; original work, dedicated to the public domain (CC0 1.0).
Stock footage: Pexels (Pexels License); clip list and links in docs/media/CREDITS.md.
```

## 0:00 to 0:31 · The problem

Screen: Stock footage (Pexels, free licence; credits in docs/media/CREDITS.md): stock-exchange columns, a stock app on a phone, a man on Wall Street, a chart on paper, a ticker, candlesticks, a worried face; cut on the narration.

> Millions of people own stocks.
>
> On Robinhood Chain, they can hold them as tokens. But a token earns nothing while it sits in a wallet.
>
> On Wall Street, holders sell covered calls for weekly income. But someone has to pick the strike each week, and you have to trust them.
>
> On-chain it is harder: a multiplier that is easy to apply twice, prices that freeze on weekends, pause switches, and mid-week splits.
>
> So the tokens sit idle, or go to a manager nobody can check.

## 0:31 to 0:43 · Strike

Screen: The wordmark, the one-liner and two promises, appearing as they are said.

> Now imagine an AI agent that picks the strike every week, and a contract that won't let it break the rules.
>
> This is Strike: weekly options vaults for Robinhood Chain stock tokens.

## 0:43 to 1:03 · Key features

Screen: Five feature cards with line icons, appearing one by one.

> Depositors earn a weekly premium in USDG.
>
> An AI agent picks the strike, inside a mandate the contract enforces.
>
> Break the mandate, and its bond goes to the depositors.
>
> The math runs on-chain, in Rust on Arbitrum Stylus.
>
> And it is live on Robinhood Chain testnet and Arbitrum Sepolia.

## 1:03 to 1:57 · Architecture

Screen: A three.js scene on two platforms (Robinhood Chain testnet, Arbitrum Sepolia), with a spotlight that dims everything but the part being named: depositors and the vault, the agent and its MCP tools, the proposal, the EpochManager's mandate check with the StockOracle (SafeStockFeed), the Stylus pricer and risk engine, options to buyers and USDG to the vault, a rejection and the bond slashed, the DecisionLog and the ERC-8004 identity, settlement to depositors, and the second chain.

> Here is one week, inside Strike.
>
> Depositors put stock tokens in a vault with a fixed mandate.
>
> An agent reads the vault through MCP tools, and dry-runs its proposal.
>
> Then it proposes a call: a delta, an expiry, a size and a price.
>
> The Epoch Manager checks it against the mandate, at prices from a guarded stock oracle.
>
> A Rust pricer on Stylus solves the strike, and a risk engine stress-tests it.
>
> If it passes, buyers pay premium in USDG.
>
> If not, it is rejected, and the bond is slashed to depositors.
>
> Each decision is hashed into a DecisionLog, and the agent has an ERC-8004 identity.
>
> After Friday's close the options settle, and the premium, less a fee, goes to depositors.
>
> The same contracts run on Robinhood Chain testnet and Arbitrum Sepolia.

## 1:57 to 2:21 · Vault

Screen: The TSLA covered-call vault page: zoom on the $369.86 strike and the 10.01 USDG premium collected, then the payoff chart with a zoom on the $372.36 breakeven.

> Now one depositor: say Maya holds Tesla tokens, and opens the covered-call vault.
>
> This week it sold the $369.86 call, all four options, to a buyer agent, for 10.01 USDG.
>
> At or below the strike, depositors like Maya keep all of it. The buyer only profits above $372.36.

## 2:21 to 2:41 · Mandate

Screen: The same vault page, Mandate section: each limit boxed as it is said (delta 0.10 to 0.35, at least 95% of fair value, at least 0.05% yield, at most 80% sold, 1 to 8 days).

> She doesn't have to trust the agent: the limits are in the contract.
>
> Delta between 0.10 and 0.35. At least 95% of fair value. A yield of at least 0.05%.
>
> At most 80% sold, and 1 to 8 days to expiry. Nobody can change them.

## 2:41 to 3:02 · Playground

Screen: `/app/playground`, no wallet. Zoom on the honest 0.20-delta call preset, click it, zoom on **Accepted**; click the reckless at-the-money preset, zoom on **Rejected: DeltaOutOfBand**, then on the 10 USDG slash panel.

> She can test the rules herself: the playground asks the deployed Epoch Manager, with no wallet.
>
> An honest 0.20-delta call: accepted.
>
> A reckless at-the-money strike: rejected, delta out of band.
>
> A real one would cost the agent 10 USDG of its bond, paid to depositors like Maya.

## 3:02 to 3:18 · Pricing

Screen: The vault page, "How the buy price is set": the priced spot (oracle + 0.5% against the buyer), the Black-Scholes fair value, the premium factor and the intrinsic-value floor, each zoomed as it is said.

> Buyers pay a price set when they buy: the oracle spot moved 0.5% against them, priced with Black-Scholes, times the agent's premium factor.
>
> Never below intrinsic value, so Monday's price can't be picked off on Wednesday.

## 3:18 to 3:41 · Live epoch

Screen: A terminal replay of the real run on 29 September ([testnet-epochs/2026-09-29.md](../testnet-epochs/2026-09-29.md)), opening half-printed: the seller agent's `proposeByDelta` accepted at $369.86, then the reckless agent's forced put rejected and its bond going from 60 to 50 USDG.

> Maya's vault ran for real on September 29.
>
> The seller agent asked for a 0.20-delta Tesla call, and the contract solved the strike on-chain: $369.86, accepted.
>
> Then a reckless agent forced an at-the-money put.
>
> Rejected, and 10 USDG slashed: its bond went from 60 to 50.

## 3:41 to 3:50 · Explorer

Screen: The rejected `proposeSeries` transaction on the Robinhood Chain explorer ([0x3df523aa…c6a0](https://explorer.testnet.chain.robinhood.com/tx/0x3df523aae815e10cba8f5f99076f9cb348745e7657dd1f1338820af0469dc6a0)): zoom on the **Success** status, then a highlight box and zoom on "Tokens transferred: AgentRegistry → EpochManager for 10 USDG".

> On the explorer it says Success: a rejection is not a revert, and 10 USDG left the agent's bond.

## 3:50 to 4:17 · Claude

Screen: A terminal replay of the Claude-planned run on Arbitrum Sepolia, 30 September ([log](../testnet-epochs/2026-09-30-arbitrum-sepolia.md), [record](../agent-log/arbitrum-sepolia/2026-09-30-sTSLA-CC.json)): Claude (claude-opus-5, through the Claude Code CLI) calls vault_state, risk_check on 5 candidates and agent_stats, writes its plan (0.20 delta at 105% of fair value) and why, and the contract accepts the call at $364.29.

> On Arbitrum Sepolia, Claude planned the proposal itself.
>
> Through Claude Code and Strike's MCP server, it read the vault, and dry-ran five candidates with risk_check.
>
> It chose a 0.20 delta at 105% of fair value, and wrote down why: mid-band, so a small move can't push it out of the mandate.
>
> The contract solved the strike, $364.29, and accepted it.

## 4:17 to 4:30 · Arbiscan

Screen: The accepted `proposeByDelta` transaction on Arbiscan ([0xf26315b3…b5f4](https://sepolia.arbiscan.io/tx/0xf26315b33df93548bfa31d68b7d9964792ef88184cb154796180e19b9365b5f4)): zoom on the **Success** status, then on the transaction action (a call from the agent's signer to the EpochManager).

> On Arbiscan: a successful call to the Epoch Manager, from the agent's signer.
>
> In the same run, a reckless put was rejected with a 10 USDG slash, and a buyer took all 4 calls.

## 4:30 to 4:54 · Payoff in 3D

Screen: A three.js surface of the Claude-planned series (strike $364.29, spot $350.23, σ 60%, 2.10 days, $2.226358 paid per option): the value of one covered share against TSLA's price and the days left to expiry, with the expiry edge, the strike plane and the stock alone for comparison; the camera orbits slowly.

> Here is that covered call, in 3D.
>
> Across, Tesla's price. Front to back, days to expiry. Up, one covered share's value.
>
> At expiry, it bends flat at the $364.29 strike: above it, the upside goes to the buyer.
>
> Below it, the depositor keeps the stock, plus $2.23 of premium per option.

## 4:54 to 5:11 · Stylus

Screen: Three.js bars of L2 gas from the README's gas table: `strikeForDelta` (1546443 in Solidity, 235880 in Stylus) and the whole `proposeByDelta` (1878918 and 577041).

> The math is written in Rust, and runs on Arbitrum Stylus.
>
> Solving the strike takes 48 Black-Scholes evaluations. In Stylus, that costs 6.5 times less gas than in Solidity, and the whole proposal 3.3 times less.

## 5:11 to 5:25 · DecisionLog

Screen: A terminal: the Claude-planned decision record (planner, target, the start of the reasoning), then its keccak256 recomputed from the published file and the DecisionLog's `latestHash` read from Arbitrum Sepolia at render time; both are 0x7ca1bd76…

> Every run leaves a decision record: what the agent saw, what it chose and why, and what the contract said.
>
> Its hash is anchored in the DecisionLog contract. Hash the published file again, and it matches the chain.

## 5:25 to 5:42 · ERC-8004

Screen: `/app/agents` leaderboard: zoom on agent #1's ERC-8004 #114 link, then on its 50 USDG bond.

> On the leaderboard, the agent's public ERC-8004 identity: 114 on Robinhood Chain testnet, 253 on Arbitrum Sepolia.
>
> Any agent can join the same way, through the public MCP server, with no allow-list.

## 5:42 to 5:55 · Monitor

Screen: `/app/monitor`, live from Robinhood Chain mainnet: scroll to NVDA and zoom on its multiplier (1.000775159, read from the page at render time).

> This monitor reads every stock token on Robinhood Chain mainnet, live.
>
> Nvidia's multiplier, 1.000775, is already in the price, so Strike never applies it twice.

## 5:55 to 6:19 · Backtest

Screen: `/app/backtest` (TSLA): zoom on the volatility figures, then on the annual return (23.1% against 44.0% held); then the assumption.

> Over 403 weekly epochs since 2019, the covered call cut volatility by 25 to 46%.
>
> But it lagged holding on every ticker: Tesla returned 23.1% a year in the vault, against 44.0% held.
>
> And it assumes buyers take the full size every week, which no contract can guarantee.

## 6:19 to 6:33 · Proof

Screen: `/app/proof`: the headline tiles (deployment, Foundry tests, coverage, internal review), then the pricer read from the chain when the page loads.

> The proof page puts every claim next to its evidence.
>
> 891 tests and proofs, 99.3% line coverage, nine properties proven with Halmos, and all 11 internal-review findings fixed.

## 6:33 to 7:01 · Competition

Screen: The capability matrix from scripts/charts/data/competition.json (checked 2026-09-30): rows appear, then the columns being described light up in turn (Stonkhouse and Archer Markets; Ribbon/Aevo, Derive and Thetanuts; Tilt Protocol), Strike's column shaded throughout.

> Who else is here?
>
> Stonkhouse and Archer Markets, on Robinhood Chain, are order books: traders and writers pick the strike and set the price.
>
> Ribbon, Derive and Thetanuts, on other chains, sell options on crypto by auction, order book or RFQ.
>
> Tilt Protocol, a past winner, has an AI manage tokenized-asset vaults. It sells no options, and its sources don't describe what limits that AI on-chain.

## 7:01 to 7:22 · Competition

Screen: The whole positioning chart (docs/media/charts/competition-positioning-light.png: who picks the strike against how the price is set) above the caption bar; Strike is boxed, then Stonkhouse and Archer Markets, the two others on Robinhood Chain.

> In Strike, a bonded agent proposes, the contract checks an immutable mandate, prices every buy at the oracle, and makes a rule-breaking agent pay the depositors.
>
> The stock-token traps are handled in the contract.
>
> For a holder: income without handing over the keys, and every decision checkable on-chain.

## 7:22 to 7:47 · Challenges

Screen: A two-column card: each challenge and how Strike solves it, lit as it is said, ending with what is not done yet.

> Weekend freezes: settle on the first price after expiry.
>
> The multiplier: never applied, tested on a mainnet fork.
>
> Trusting an agent: a fixed mandate, a bond, and slashing.
>
> On-chain pricing: Rust on Stylus, 6.5 times cheaper.
>
> What's not done: there is no external audit, it is testnet only, and both epochs settle on Friday 2 October.

## 7:47 to 8:02 · Strike

Screen: The closing card: the line, **strike-options.vercel.app**, the repository and "Live on Robinhood Chain testnet and Arbitrum Sepolia · Unaudited", then a few seconds of silence.

> Strike: options on Robinhood Chain and Arbitrum, run by agents the contract holds to a mandate.
>
> Try the playground at strike-options.vercel.app. It is unaudited, and on testnet.
