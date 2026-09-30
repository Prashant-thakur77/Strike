# Pitch video script (1:57)

The narration of [docs/media/strike-pitch.mp4](../media/strike-pitch.mp4) (117.6 s), over slides of the deck in the order of [deck-outline.md](deck-outline.md). It is rendered by `node video/record.mjs pitch` from [video/pitch.mjs](../../video/pitch.mjs) and the slide copies in [video/deck](../../video/deck), and this file is written by the same run. Timed captions are in [strike-pitch.srt](../media/strike-pitch.srt).

The voice is Chatterbox TTS with a synthetic reference voice: 253 words in 118 s (129 words a minute). Every number is read from README.md at render time. The product itself is in the separate demo video; slides 6 to 8, 10, 11 and 15 of the deck are left out to stay near two minutes.

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

## 1:01 to 1:10 · Slide 9: Traction, on-chain

> It is live on testnet: two vaults, 14 contracts verified, and a buyer agent that paid 10.01 USDG of premium.

## 1:10 to 1:19 · Slide 12: Competition

> Stonkhouse and Archer Markets let traders pick strikes. In Strike, a bonded agent proposes and the contract checks.

## 1:19 to 1:26 · Slide 13: Paid only when depositors win

> We take 10% of a week's positive net premium, half to the agent, and nothing on a losing week.

## 1:26 to 1:40 · Slide 14: Evidence, not claims

> Behind it: 891 tests and proofs, 99.3% line coverage, nine properties proven with Halmos, and all 11 internal-review findings fixed.
>
> It is not audited yet.

## 1:40 to 1:57 · Slide 16: The ask

> Next: an external audit, then a capped mainnet vault. We are asking for a place at Founder House Singapore, and introductions to wallets and market makers.
>
> Try the playground at strike-options.vercel.app.
