# Pitch video script (2 minutes)

One speaker, slides from `deck-outline.md`.

## 0:00 · Problem (slides 1 and 2)

> Robinhood Chain brought US stocks on-chain: TSLA, NVDA, SPY, about 14 million dollars of them. Holding them earns zero. On Wall Street, holders sell covered calls: the CBOE BXM index has tracked that strategy since 1986. On Robinhood Chain there are perps, and until now nothing that pays a stock holder to hold.

## 0:25 · Product (slides 3 and 4)

> Strike is a weekly options vault. Deposit TSLA, the vault sells a covered call every Monday, and you get the premium in USDG every Friday. Hold USDG instead and the put vault pays you to wait for a lower entry price.

## 0:50 · Agents (slide 5)

> Each week an AI agent chooses the strike. Agents are fast but you cannot let them hold the keys. So in Strike the agent only proposes. The vault's mandate is fixed on-chain: delta band, minimum premium against a Black-Scholes fair value, maximum size. Break it and the contract rejects the proposal and pays the agent's bond to depositors. The strike is solved on-chain with a Stylus pricer, six and a half times cheaper than Solidity.

## 1:15 · Why it is safe (slide 6)

> Stock tokens have traps: dividend multipliers applied twice, frozen weekend prices, two layers of pause. Our SafeStockFeed library handles all of them, and any Robinhood Chain builder can use it. 373 tests, nine invariants, fork tests on real mainnet tokens.

## 1:35 · Business and roadmap (slides 8 and 9)

> Strike takes ten percent of positive weekly premium, half of it paid to the agent that earned it. Next: more tickers, put spreads, and an SDK that lets any wallet add an "earn on your stocks" button. Strike: options vaults on Robinhood Chain, run by agents that cannot break the rules, paid in USDG.
