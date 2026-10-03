# Demo video script (5:49)

The narration of [docs/media/strike-demo.mp4](../media/strike-demo.mp4) (349.8 s, 1920×1080, narrated, with a quiet music bed), and the captions of the voiceless cut [strike-demo-silent.mp4](../media/strike-demo-silent.mp4). Both are rendered by `node video/record.mjs demo` from the scene list in [video/demo.mjs](../../video/demo.mjs), and this file is written by the same run, so the times and words below are the video's own. The captions show the spoken words (two lines of at most about 42 characters); the timed captions are in [strike-demo.srt](../media/strike-demo.srt).

The arc: the problem (over stock footage), the turn, the key features, the architecture (a 3D scene with a spotlight on each part as it is named), one depositor's walkthrough of the live product on both chains (including the decision pages, the week after its expiry as the chain stands at render time, and the proof page's liveness checks), the competition, challenges and solutions, and the close. The voice is Chatterbox TTS (open source, Resemble AI) with a synthetic reference voice, read 28% faster with Rubber Band (formants kept): 937 words in 350 s (161 words a minute, numbers counted as one word). Every number is read from README.md and the epoch logs at render time; the NVDA multiplier, the decision page's break-even and odds, the mirror audit's round count and the settlement state are read from the live app, the count of verified transactions from a live run of `scripts/check-claims.mjs`, and the DecisionLog hash is recomputed and read from Arbitrum Sepolia. The 3D scenes are three.js pages ([video/three.html](../../video/three.html)) drawn from the same numbers. Footage and music credits: [docs/media/CREDITS.md](../media/CREDITS.md). Nothing here is audited: the video says so.

## Chapters

Ready to paste into a YouTube description:

```
0:00 The problem
0:19 Strike and its key features
0:38 Architecture
1:08 Walkthrough: one depositor's week
2:00 Live on Robinhood Chain testnet
2:58 Planned by Claude, on Arbitrum Sepolia
3:36 Rust on Stylus: pricer and risk engine
3:45 Decision records, identity and the multiplier trap
4:33 Backtest and evidence
5:04 Who else is here, and how Strike differs
5:31 Challenges, solutions and close
```

## Video description

```
Strike: weekly options vaults for Robinhood Chain stock tokens, run by AI agents the contract holds to a mandate. Live on Robinhood Chain testnet and Arbitrum Sepolia. Unaudited; testnet only.

App: https://strike-options.vercel.app
Code: https://github.com/Prashant-thakur77/Strike

0:00 The problem
0:19 Strike and its key features
0:38 Architecture
1:08 Walkthrough: one depositor's week
2:00 Live on Robinhood Chain testnet
2:58 Planned by Claude, on Arbitrum Sepolia
3:36 Rust on Stylus: pricer and risk engine
3:45 Decision records, identity and the multiplier trap
4:33 Backtest and evidence
5:04 Who else is here, and how Strike differs
5:31 Challenges, solutions and close

Voice: Chatterbox TTS (Resemble AI, open source) with a synthetic reference voice.
Music: "Strike ambient bed", synthesised for this video by video/narration/music.py; original work, dedicated to the public domain (CC0 1.0).
Stock footage: Pexels (Pexels License); clip list and links in docs/media/CREDITS.md.
```

## 0:00 to 0:19 · The problem

Screen: Stock footage (Pexels, free licence; credits in docs/media/CREDITS.md): stock-exchange columns, a stock app on a phone, a man on Wall Street, a chart on paper, a ticker, candlesticks, a worried face; cut on the narration.

> Millions of people own stocks.
>
> On Robinhood Chain, stocks are tokens, but a token earns nothing while it sits.
>
> Wall Street holders sell covered calls for income, but someone must pick each week's strike, and you must trust them.
>
> On-chain it's harder: multipliers easy to apply twice, weekend price freezes, pauses, mid-week splits.
>
> So tokens sit idle, or go to managers nobody can check.

## 0:19 to 0:26 · Strike

Screen: The wordmark, the one-liner and two promises, appearing as they are said.

> Now imagine an agent picking the strike each week, held to the rules by a contract.
>
> This is Strike: options vaults for stock tokens.

## 0:26 to 0:38 · Key features

Screen: Five feature cards with line icons, appearing one by one.

> Weekly premium in USDG.
>
> An AI agent picks the strike, inside a mandate.
>
> Break it, and its bond goes to depositors.
>
> Rust on Stylus does the math.
>
> Live on Robinhood Chain and Arbitrum Sepolia.

## 0:38 to 1:08 · Architecture

Screen: A three.js scene on two platforms (Robinhood Chain testnet, Arbitrum Sepolia), with a spotlight that dims everything but the part being named: depositors and the vault, the agent and its MCP tools, the proposal, the EpochManager's mandate check with the StockOracle (SafeStockFeed), the Stylus pricer and risk engine, options to buyers and USDG to the vault, a rejection and the bond slashed, the DecisionLog and the ERC-8004 identity, settlement to depositors, and the second chain.

> Inside one week:
>
> Depositors fill a vault with a fixed mandate.
>
> An agent reads it via MCP and dry-runs.
>
> It proposes delta, expiry, size and price.
>
> The Epoch Manager checks it at guarded oracle prices.
>
> Rust on Stylus solves and stress-tests the strike.
>
> If it passes, buyers pay premium in USDG.
>
> If not, the bond is slashed to depositors.
>
> Decisions are hashed on-chain; the agent has an ERC-8004 identity.
>
> Friday's close settles; depositors get the premium, less a fee.
>
> Same contracts on Robinhood Chain and Arbitrum Sepolia.

## 1:08 to 1:21 · Vault

Screen: The TSLA covered-call vault page (its first week, expired and waiting for settlement): zoom on the $369.86 strike and the 10.01 USDG premium collected, then the payoff chart with a zoom on the $372.36 breakeven.

> Say Maya opens the Tesla vault.
>
> Its first week sold the $369.86 call: four options, 10.01 USDG.
>
> At or below the strike, Maya keeps it; the buyer profits above $372.36.

## 1:21 to 1:33 · Mandate

Screen: The same vault page, Mandate section: each limit boxed as it is said (delta 0.10 to 0.35, at least 95% of fair value, at least 0.05% yield, at most 80% sold, 1 to 8 days).

> The limits are in the contract:
>
> Delta 0.10 to 0.35, at least 95% of fair value, at least 0.05% yield,
>
> at most 80% sold, 1 to 8 days, fixed for good.

## 1:33 to 1:46 · Playground

Screen: `/app/playground`, no wallet. Zoom on the honest 0.20-delta call preset, click it, zoom on **Accepted**; click the reckless at-the-money preset, zoom on **Rejected: DeltaOutOfBand**, then on the 10 USDG slash panel.

> The playground tests proposals live, no wallet.
>
> An honest 0.20-delta call: accepted.
>
> A reckless at-the-money strike: rejected, delta out of band.
>
> A real one costs the agent 10 USDG, paid to depositors.

## 1:46 to 2:00 · Pricing

Screen: Agent #2's put vault (sTSLA-CSP-A2, selling its first week), seen from Singapore: "How the buy price is set" with the priced spot (oracle − 0.5%, against the buyer), the Black-Scholes fair value, the premium factor and the intrinsic-value floor, each zoomed as it is said; then the market-hours notice in the buy panel, with the next NYSE open in UTC and in the viewer's time zone.

> Buyers pay at the moment they buy: oracle spot moved 0.5% against them, Black-Scholes, times the agent's factor.
>
> Never below intrinsic value, so stale prices can't be picked off.
>
> Buying waits for the NYSE open, shown in your own time zone.

## 2:00 to 2:14 · Live epoch

Screen: A terminal replay of the real run on 29 September ([testnet-epochs/2026-09-29.md](../testnet-epochs/2026-09-29.md)), opening half-printed: the seller agent's `proposeByDelta` accepted at $369.86, then the reckless agent's forced put rejected and its bond going from 60 to 50 USDG.

> Live on September 29, the seller agent asked for 0.20 delta; the contract solved $369.86, accepted.
>
> A reckless agent forced an at-the-money put:
>
> rejected, 10 USDG slashed, bond 60 to 50.

## 2:14 to 2:19 · Explorer

Screen: The rejected `proposeSeries` transaction on the Robinhood Chain explorer ([0x3df523aa…c6a0](https://explorer.testnet.chain.robinhood.com/tx/0x3df523aae815e10cba8f5f99076f9cb348745e7657dd1f1338820af0469dc6a0)): zoom on the **Success** status, then a highlight box and zoom on "Tokens transferred: AgentRegistry → EpochManager for 10 USDG".

> The explorer says Success: a rejection isn't a revert, and 10 USDG left the bond.

## 2:19 to 2:35 · Settlement

Screen: The same covered-call vault page after the Friday 20:00 UTC expiry, unsettled at render time (from /api/status): the "Expired, settling" panel, why it waits (the first mainnet Chainlink print at or after expiry; settle reverts with InvalidSettlementRound for any other round), the last print at 19:55 UTC, then the epoch trace with each step's transaction and "Settlement pending".

> The call expired Friday at 20:00 UTC; it has not settled yet.
>
> It settles at the first mainnet Chainlink print after expiry; the contract rejects any other price.
>
> The last print, at 19:55, came before expiry.
>
> The epoch trace shows each step's transaction, and what is pending.

## 2:35 to 2:58 · Run an agent

Screen: `/app/agents`, "Run your own agent": a test wallet connects, fills the form (its ERC-8004 identity, a 60 USDG bond) and signs two transactions (register, then bond; the USDG allowance was set before the take) in a confirmation panel labelled as the test wallet; the app shows each pending and done state; then the bond transaction on the explorer. Recorded for real on 1 October: this is how agent #2 joined.

> Anyone can run an agent, with no permission.
>
> Here a test wallet registers an agent and bonds 60 USDG, above the 50 minimum.
>
> The wallet signs each step: register, then bond.
>
> Each one waits for its block on Robinhood Chain testnet.
>
> Now it can propose. Every rejected proposal costs it 10 USDG.

## 2:58 to 3:14 · Claude

Screen: A terminal replay of the Claude-planned run on Arbitrum Sepolia, 30 September ([log](../testnet-epochs/2026-09-30-arbitrum-sepolia.md), [record](../agent-log/arbitrum-sepolia/2026-09-30-sTSLA-CC.json)): Claude (claude-opus-5, through the Claude Code CLI) calls vault_state, risk_check on 5 candidates and agent_stats, writes its plan (0.20 delta at 105% of fair value) and why, and the contract accepts the call at $364.29.

> On Arbitrum Sepolia, Claude planned it: via Strike's MCP server, it read the vault and dry-ran five candidates.
>
> It chose 0.20 delta at 105% of fair value, and wrote why: mid-band, safe from small moves.
>
> The contract solved $364.29: accepted.

## 3:14 to 3:22 · Arbiscan

Screen: The accepted `proposeByDelta` transaction on Arbiscan ([0xf26315b3…b5f4](https://sepolia.arbiscan.io/tx/0xf26315b33df93548bfa31d68b7d9964792ef88184cb154796180e19b9365b5f4)): zoom on the **Success** status, then on the transaction action (a call from the agent's signer to the EpochManager).

> On Arbiscan: a successful call from the agent's signer.
>
> The same run slashed a reckless put 10 USDG, and a buyer took all 4 calls.

## 3:22 to 3:36 · Payoff in 3D

Screen: A three.js surface of the Claude-planned series (strike $364.29, spot $350.23, σ 60%, 2.10 days, $2.226358 paid per option): the value of one covered share against TSLA's price and the days left to expiry, with the expiry edge, the strike plane and the stock alone for comparison; the camera orbits slowly.

> In 3D:
>
> Across, Tesla's price. Back, days left. Up, a share's value.
>
> At expiry it bends flat at the $364.29 strike: upside goes to the buyer.
>
> Below, the depositor keeps stock plus $2.23 per option.

## 3:36 to 3:45 · Stylus

Screen: Three.js bars of L2 gas from the README's gas table: `strikeForDelta` (1546443 in Solidity, 235880 in Stylus) and the whole `proposeByDelta` (1878918 and 577041).

> The math is Rust, on Arbitrum Stylus.
>
> Solving a strike takes 48 Black-Scholes runs: 6.5 times less gas than Solidity, 3.3 times less per proposal.

## 3:45 to 3:56 · DecisionLog

Screen: A terminal: the Claude-planned decision record (planner, target, the start of the reasoning), then its keccak256 recomputed from the published file and the DecisionRecorded event of its anchoring transaction, read from Arbitrum Sepolia at render time; both are 0x7ca1bd76…

> Every run leaves a decision record.
>
> Its hash is anchored in the DecisionLog; rehash the file, and it matches the chain.
>
> CI re-checks every cited transaction: 160 of 160 verified.

## 3:56 to 4:12 · Decision page

Screen: Agent #2's decision page for 2 October (/app/decision/46630/2026-10-02-sTSLA-CSP-A2): the accepted $342.91 put, the mandate check rule by rule with the headroom left, the "why not the other strikes" ladder, and "what would make this week lose" (below $340.20, 17.0% model odds), read from the page at render time.

> Each proposal gets a decision page. Agent two's put on October 2:
>
> each mandate rule it passed, with the headroom left.
>
> Why not the other strikes: the same proposal at each delta, judged by the rules.
>
> And what would make this week lose: TSLA below $340.20, 17% odds under the model.

## 4:12 to 4:18 · Decision page

Screen: Agent #1's rejected put of 1 October (/app/decision/46630/2026-10-01-sTSLA-CSP): the verdict, then the mandate check with the delta band rule marked FAILS and the rule after it NOT REACHED.

> Agent one's forced put: rejected, delta out of band.
>
> The check stops there; later rules are never reached.

## 4:18 to 4:25 · ERC-8004

Screen: `/app/agents` leaderboard: agent #1's row opened, a zoom on its ERC-8004 identity (#114 on Robinhood Chain testnet).

> Its ERC-8004 identity: 114 on Robinhood Chain testnet, 253 on Arbitrum Sepolia.

## 4:25 to 4:33 · Monitor

Screen: `/app/monitor`, live from Robinhood Chain mainnet: scroll to NVDA and zoom on its multiplier (1.000775159, read from the page at render time).

> The monitor, live on mainnet:
>
> Nvidia's multiplier, 1.000775, is already in the price, so Strike never applies it twice.

## 4:33 to 4:47 · Backtest

Screen: `/app/backtest` (TSLA): zoom on the volatility figures, then on the annual return (23.1% against 44.0% held); then the assumption.

> Over 403 weeks since 2019, covered calls cut volatility 25 to 46%,
>
> but lagged holding everywhere: Tesla 23.1% a year, against 44.0% held.
>
> And it assumes full weekly sales.

## 4:47 to 5:04 · Proof

Screen: `/app/proof`: the headline tiles (deployment, Foundry tests, coverage, internal review), then "Running by itself" (read from both testnets, mainnet and GitHub by /api/status: price age, each vault's epoch and last settlement, the scheduled keeper and weekly agent) and its price mirror audit: 84 of 84 mirrored rounds match Robinhood Chain mainnet Chainlink, read at render time.

> The proof page:
>
> 1,385 tests and proofs, 99.3% line coverage, nine Halmos proofs, all 11 review findings fixed.
>
> Running by itself reads both testnets: prices, each vault's week, the scheduled jobs.
>
> The mirror audit checks every copied price: 84 of 84 rounds match mainnet Chainlink.

## 5:04 to 5:21 · Competition

Screen: The capability matrix from scripts/charts/data/competition.json (checked 2026-09-30): rows appear, then the columns being described light up in turn (Stonkhouse and Archer Markets; Ribbon/Aevo, Derive and Thetanuts; Tilt Protocol), Strike's column shaded throughout.

> Who else is here?
>
> Stonkhouse and Archer Markets on Robinhood Chain are order books: traders pick strike and price.
>
> Ribbon, Derive and Thetanuts sell crypto options by auction, order book or RFQ.
>
> Tilt's AI manages vaults, with no options; its sources don't say what limits it on-chain.

## 5:21 to 5:31 · Competition

Screen: The whole positioning chart (docs/media/charts/competition-positioning-light.png: who picks the strike against how the price is set) above the caption bar; Strike is boxed, then Stonkhouse and Archer Markets, the two others on Robinhood Chain.

> In Strike, a bonded agent proposes, the contract enforces mandate and price, and rule-breakers pay.
>
> Stock-token traps are handled on-chain.
>
> Holders get income and keep their keys.

## 5:31 to 5:44 · Challenges

Screen: A two-column card: each challenge and how Strike solves it, lit as it is said, ending with what is not done yet.

> Weekend freezes: settle on the first post-expiry price.
>
> Multiplier: never applied, fork-tested.
>
> Agent trust: fixed mandate, bond, slashing.
>
> Gas: Rust on Stylus, 6.5 times cheaper.
>
> Not done: no audit, and testnet only.

## 5:44 to 5:49 · Strike

Screen: The closing card: the line, **strike-options.vercel.app**, the repository and "Live on Robinhood Chain testnet and Arbitrum Sepolia · Unaudited", then a few seconds of silence.

> Strike: options on Robinhood Chain and Arbitrum, run by agents held to a mandate.
