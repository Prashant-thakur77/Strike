# Pitch video script (2 minutes)

One speaker over the deck ([deck-outline.md](deck-outline.md); slide numbers below follow it). About 330 words: at a brisk 165 words a minute it lands at 2:00. Every number is from the repo.

## 0:00 · Problem (slides 1 to 3)

> Robinhood Chain put US stocks on-chain, from TSLA to SPY. Holding them earns nothing extra. On Wall Street, holders sell covered calls for income, and Cboe's BXM index has data on that strategy back to 1986. On Robinhood Chain, options have only just arrived. None of them lets an AI agent make the weekly call inside rules the contract enforces.

## 0:20 · Product (slides 4 and 5)

> Strike is a weekly options vault. Deposit TSLA and the vault sells a covered call each week, for a premium paid in USDG. Deposit USDG instead, and the put vault pays you to wait for a lower entry price.

## 0:35 · Agents (slide 6)

> An AI agent picks each week's strike. It never touches the vault's funds; it only proposes. The vault's mandate is fixed on-chain: a delta band, a premium floor against fair value, a maximum size. If a proposal breaks it, the contract rejects it and pays part of the agent's bond to depositors. On testnet, our reckless agent lost ten USDG that way. The agent is ERC-8004 identity 114, so each result is posted to its public reputation. A Stylus pricer solves the strike on-chain: 3.3 times cheaper per proposal transaction, 6.5 times for the solver alone.

## 1:10 · Why it is safe (slide 7)

> Stock tokens have traps: a dividend multiplier applied twice, prices frozen over the weekend, two layers of pause. SafeStockFeed handles each one, and our monitor checks eight real mainnet stock tokens against the same rules, live. Behind that are 432 Foundry tests, 9 properties proven with Halmos, and an internal review whose 11 findings, one of them High, are all fixed.

## 1:32 · Try it, business, next (slides 9 to 11)

> You can test Strike without a wallet. The playground runs any proposal against a live vault's mandate, and the proof page links every claim to its evidence. Strike takes ten percent of a week's net premium when it is positive, half of it to the agent. Next come a capped mainnet vault, more tickers and put spreads. Strike: weekly options vaults on Robinhood Chain, paid in USDG, with agents the contract holds to their mandate.
