# Pitch video script (2:40)

[docs/media/strike-pitch.mp4](../media/strike-pitch.mp4) (160.9 s) opens with a short hook in kinetic type, then the founder's own intro (44.6 s, the standalone cut is [strike-founder.mp4](../media/strike-founder.mp4), edited by [video/founder.mjs](../../video/founder.mjs) from [video/founder.json](../../video/founder.json)), then the narration (116.3 s), over slides of the deck in the order of [deck-outline.md](deck-outline.md). It is rendered by `node video/record.mjs pitch` from [video/pitch.mjs](../../video/pitch.mjs) and the slide copies in [video/deck](../../video/deck), and this file is written by the same run. Timed captions are in [strike-pitch.srt](../media/strike-pitch.srt).

The voice is Chatterbox TTS with a synthetic reference voice, over a quiet synthesised music bed (CC0, [credits](../media/CREDITS.md)): 311 words in 116 s (160 words a minute); the founder's intro has no music. Every number is read from README.md at render time, and the count of verified transactions from a live run of `scripts/check-claims.mjs`. The product itself is in the separate demo video; slides 6 to 8, 10, 11 and 15 of the deck are left out to keep the slides near two minutes.

## 0:00 to 0:07 · Strike

Screen: Kinetic type on the site's dark teal: each phrase slams in word by word as it is said, key words in mint (stock tokens, sit, income every week, can't break), then the wordmark.

> Own stock tokens that just sit in your wallet?
>
> What if they earned income every week, under rules the agent can't break?
>
> That's Strike.

## 0:07 to 0:52 · Founder intro

Screen: The founder, Prashant Thakur, to camera ([strike-founder.mp4](../media/strike-founder.mp4) before its end card), with word-by-word captions, his name and school in a lower third, and four short cut-aways from the live site: a decision page's specialist stages, the rejected proposal's failing rule, the two testnets on the proof page and the waitlist.

> Hello, I'm Prashant and I'm building Strike. AI-run options vault for tokenized stocks where the AI can't break your rules. Now, stock tokens are arriving on chain starting with Robinhood chain, but holding them earns nothing extra. Covered call funds made that a hundred billion dollar category off chain. Now in Strike, an AI agent picks the strike each week, but the smart contract enforces the depositors' rule. If the AI agent breaks them, it is rejected and its own bond pays the depositors. It's live on two testnets with real option sales and a real slash and over 1,500 tests. And we are working on to make it to arrive to mainnet. And that is why we would like you to fund our company and our waitlist is open today. So let's check out Strike.

## 0:52 to 1:00 · Slide 1: Strike

> This is Strike, by Prashant Thakur: weekly options vaults for Robinhood Chain stock tokens, run by AI agents the contract holds to a mandate.

## 1:00 to 1:06 · Slide 2: Stock tokens sit idle

> A stock token earns nothing extra while it sits in a wallet. On Wall Street, holders sell covered calls for that.

## 1:06 to 1:15 · Slide 3: Four traps

> Stock tokens also have traps: a multiplier that is easy to apply twice, weekend price freezes, and two pause layers. Strike's contracts handle each one.

## 1:15 to 1:29 · Slide 4: Why now, why this chain

> Robinhood Chain, an Arbitrum chain, now has every piece: stock tokens, Chainlink stock feeds, USDG, and ERC-8004 agent identity.
>
> And Stylus makes solving the strike on-chain 3.3 times cheaper per proposal.

## 1:29 to 1:42 · Slide 5: Agents propose, the contract decides

> Each week an agent proposes a strike, but never touches the funds. The contract checks it against the vault's fixed mandate.
>
> On September 29, a reckless at-the-money put was rejected, and 10 USDG of its bond went to depositors.

## 1:42 to 1:54 · Slide 9: Traction, on-chain

> It is live on Robinhood Chain testnet and Arbitrum Sepolia, with 14 contracts verified, and a buyer agent that paid 10.01 USDG of premium.
>
> On Arbitrum, Claude planned the accepted proposal.

## 1:54 to 2:01 · Slide 12: Competition

> Stonkhouse and Archer Markets let traders pick strikes. In Strike, a bonded agent proposes and the contract checks.

## 2:01 to 2:07 · Slide 13: Paid only when depositors win

> We take 10% of a week's positive net premium, half to the agent, and nothing on a losing week.

## 2:07 to 2:23 · Slide 14: Evidence, not claims

> Behind it: 1,817 tests and proofs, 99.3% line coverage, nine properties proven with Halmos, and all 11 internal-review findings fixed.
>
> CI re-checks all 177 transactions the docs cite, on-chain. It is not audited yet.

## 2:23 to 2:40 · Slide 16: The ask

> We are building Strike as a company on Robinhood Chain and Arbitrum. Funding buys an external audit and the first capped mainnet vault. We are asking for a place at Founder House Singapore, and introductions to wallets and market makers.
>
> Try the playground at strike-options.vercel.app.

## Workshop themes in this pitch

The video is rendered; this maps its lines to the buildathon's workshop themes. Tokenized RWAs and the wedge: the hook asks stock-token holders, and slides 2 and 3 say a stock token earns nothing extra and has traps Strike handles. What makes the wedge hard to copy: slide 5, the agent proposes and the contract checks the mandate and slashes the bond. Agentic, on Arbitrum: slide 4 (Stylus) and slide 9 (Claude planned the accepted proposal on Arbitrum). Security: slide 14. Governance (a Safe behind a 73-day timelock on mainnet, a trusted deployer key on the testnets today) and the work after the buildathon (x402, onboarding without test ETH, Pendle, Dune) are not in the narration; they are in [JUDGES.md](../JUDGES.md#how-strike-maps-to-the-workshop-themes) and the README's [Roadmap after the buildathon](../../README.md#roadmap-after-the-buildathon).
