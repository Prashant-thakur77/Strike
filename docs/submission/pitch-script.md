# Pitch video script (2:02)

The narration of [docs/media/strike-pitch.mp4](../media/strike-pitch.mp4) (122.6 s), over slides of the deck in the order of [deck-outline.md](deck-outline.md). It is rendered by `node video/record.mjs pitch` from [video/pitch.mjs](../../video/pitch.mjs) and the slide copies in [video/deck](../../video/deck), and this file is written by the same run. Timed captions are in [strike-pitch.srt](../media/strike-pitch.srt).

The voice is Chatterbox TTS with a synthetic reference voice, over a quiet synthesised music bed (CC0, [credits](../media/CREDITS.md)): 264 words in 123 s (129 words a minute). Every number is read from README.md at render time. The product itself is in the separate demo video; slides 6 to 8, 10, 11 and 15 of the deck are left out to stay near two minutes.

The quotes below are what the rendered video says, so they keep the figures of its render on the morning of 1 October (UTC), before the third epoch ran. Since then: the count of tests and proofs is 1,373 (the video says 891); Robinhood Chain testnet also ran a v3 epoch on 1 October in which Claude planned the accepted proposal again, so Claude has planned two accepted proposals (Arbitrum Sepolia at a $364.29 strike, Robinhood Chain v3 at $369.36); and the buyers in the three epochs paid 10.01, 8.91 and 7.38 USDG. None of the three epochs has settled yet (expiry Friday 2 October, 20:00 UTC).

## 0:00 to 0:09 · Slide 1: Strike

> This is Strike, by Prashant Thakur: weekly options vaults for Robinhood Chain stock tokens, run by AI agents the contract holds to a mandate.

## 0:09 to 0:16 · Slide 2: Stock tokens sit idle

> A stock token earns nothing extra while it sits in a wallet. On Wall Street, holders sell covered calls for that.

## 0:16 to 0:28 · Slide 3: Four traps

> Stock tokens also have traps: a multiplier that is easy to apply twice, weekend price freezes, and two pause layers. Strike's contracts handle each one.

## 0:28 to 0:44 · Slide 4: Why now, why this chain

> Robinhood Chain, an Arbitrum chain, now has every piece: stock tokens, Chainlink stock feeds, USDG, and ERC-8004 agent identity.
>
> And Stylus makes solving the strike on-chain 3.3 times cheaper per proposal.

## 0:44 to 1:01 · Slide 5: Agents propose, the contract decides

> Each week an agent proposes a strike, but never touches the funds. The contract checks it against the vault's fixed mandate.
>
> On September 29, a reckless at-the-money put was rejected, and 10 USDG of its bond went to depositors.

## 1:01 to 1:16 · Slide 9: Traction, on-chain

> It is live on Robinhood Chain testnet and Arbitrum Sepolia, with 14 contracts verified, and a buyer agent that paid 10.01 USDG of premium.
>
> On Arbitrum, Claude planned the accepted proposal.

## 1:16 to 1:24 · Slide 12: Competition

> Stonkhouse and Archer Markets let traders pick strikes. In Strike, a bonded agent proposes and the contract checks.

## 1:24 to 1:31 · Slide 13: Paid only when depositors win

> We take 10% of a week's positive net premium, half to the agent, and nothing on a losing week.

## 1:31 to 1:45 · Slide 14: Evidence, not claims

> Behind it: 891 tests and proofs, 99.3% line coverage, nine properties proven with Halmos, and all 11 internal-review findings fixed.
>
> It is not audited yet.

## 1:45 to 2:02 · Slide 16: The ask

> Next: an external audit, then a capped mainnet vault. We are asking for a place at Founder House Singapore, and introductions to wallets and market makers.
>
> Try the playground at strike-options.vercel.app.
