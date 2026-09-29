# Pitch video script (2 minutes)

One speaker over the deck ([deck-outline.md](deck-outline.md); slide numbers below follow it). About 315 words: at a brisk 160 words a minute it lands at 2:00. Every number is from the repo.

## 0:00 · Problem (slides 1 to 3)

> Robinhood Chain brought US stocks on-chain, from TSLA to SPY. Holding them earns zero. On Wall Street, holders sell covered calls for income; the CBOE BXM index has tracked that since 1986. On Robinhood Chain, options have only just arrived, and none of them let an AI agent run the weekly decision inside rules the contract enforces.

## 0:20 · Product (slides 4 and 5)

> Strike is a weekly options vault. Deposit TSLA and the vault sells a covered call each week; the premium is paid in USDG. Hold USDG instead and the put vault pays you to wait for a lower entry price.

## 0:35 · Agents (slide 6)

> An AI agent picks each week's strike, but it never holds the keys. It only proposes. Its mandate is fixed on-chain: a delta band, a premium floor against fair value, a maximum size. Break it and the contract rejects the proposal and pays the agent's bond to depositors. On testnet, our reckless agent lost ten USDG that way. Our agent holds ERC-8004 identity 114, so each result builds its reputation. Strikes are solved on-chain by a Stylus pricer: 3.3 times cheaper per proposal transaction, 6.5 times for the solver itself.

## 1:10 · Why it is safe (slide 7)

> Stock tokens have traps: dividend multipliers applied twice, frozen weekend prices, two layers of pause. SafeStockFeed handles each one, and our live monitor checks eight real mainnet stock tokens against the same rules. Behind it: 418 Foundry tests, 9 properties formally proven with Halmos, and an internal review with all 8 findings fixed: one High, three Medium, four Low.

## 1:32 · Try it, business, next (slides 9 to 11)

> You can test Strike without a wallet. The playground runs any proposal against a live vault's mandate, and the proof page links every claim to its evidence. Strike takes ten percent of a week's net premium when it is positive, half to the agent. Next: a capped mainnet vault, more tickers, put spreads. Strike: options vaults on Robinhood Chain, run by agents that cannot break the rules, paid in USDG.
