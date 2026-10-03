# sTSLA-CSP weekly proposal (dry run), 2026-10-03

**Dry run.** Dry run: nothing was sent and the record is not anchored.

- **Date:** 2026-10-03 (chain time 2026-10-03T05:40:56.000Z)
- **Chain:** Arbitrum Sepolia (421614)
- **Agent:** #1
- **Result:** no trade

## Vault and mandate

- **Vault:** sTSLA-CSP (Strike TSLA Cash-Secured Put), a cash-secured put vault on TSLA, `0x02B701210aA006CEAbd389dBc32af0047B1B9bbe`
- **Collateral:** 30 USDG; epoch Idle when the run started
- **Mandate:** |delta| 0.10-0.35, premium >= 95% of fair value, yield >= 0.05% of collateral, size <= 80% of capacity, tenor 1-8 days

## Market inputs

- **Spot:** $370.448
- **Implied volatility (sigma):** 60.00% a year
- **Source:** live values: no epoch is running, so there is no opening snapshot
- **Oracle:** Ok; NYSE closed at the time of the run

## Target delta and why

- **Strategy:** default strategy (deterministic)
- **Planner:** rule: default

Why:

> No trade this week: the market analyst stopped the run (market closed until Mon 5 Oct 13:30 UTC). Nothing was sent.

## Dry run

No dry run.

## Specialists

Each specialist has its own inputs and tools; every number below was computed from those tools. Claude's words, where present, are labelled as narration.

- **Market analyst** (agent code, 13.6 s): FAIL. No-go: market closed until Mon 5 Oct 13:30 UTC.
  - session: NYSE closed until Mon 5 Oct 13:30 UTC; limit: the NYSE regular session (openEpoch and buy revert outside it) (failed)
  - feed-status: StockOracle.status: Ok; limit: a valid price from a feed and token that are not paused (ok)
  - feed-fresh: last print 9.8 h old (Fri 2 Oct 19:55 UTC); limit: at most 25.0 h old (feedConfig.maxPriceAge) (ok)
  - corporate-action: none: uiMultiplier equals newUIMultiplier and no change took effect within the grace window; limit: no ERC-8056 multiplier change pending or within 24.0 h of taking effect (ok)
  - sequencer: not provided: no sequencer uptime feed is configured on this chain's StockOracle (sequencerFeed is the zero address); the contract skips the check too; limit: up and past its grace period, when a sequencer feed is configured (the contract skips the check without one) (ok)
  - sigma-bounds: sigma 60.0% a year; limit: 20% to 200% (EpochManager.underlyings minSigma, maxSigma) (ok)
  - realised volatility: 37.1% a year over 10 daily returns of mainnet Chainlink closes, against the pricer's sigma 60.0%
  - Sources: vault_state, StockOracle.status at `0x8B89A4dE3d8E74888e0135CCBeE5eE00Df36bA9F`, StockOracle.feedConfig at `0x8B89A4dE3d8E74888e0135CCBeE5eE00Df36bA9F`, StockOracle.isMarketOpen at `0x8B89A4dE3d8E74888e0135CCBeE5eE00Df36bA9F`, StockOracle.sequencerFeed at `0x8B89A4dE3d8E74888e0135CCBeE5eE00Df36bA9F`, EpochManager.underlyings at `0xB8Ed17588AB022d8f84b8305d784Fa01478Cb7F0`, MarketCalendar.isTradingDay at `0xefD1121ef13F1187F9ac9A54076DFa09A586d31D`, MarketCalendar.sessionOf at `0xefD1121ef13F1187F9ac9A54076DFa09A586d31D`, ERC-8056 uiMultiplier, newUIMultiplier, effectiveAt at `0x2EbdbAe172d733f96F9742A7e319e311E552BF37`, MirrorFeed.latestRoundData at `0x85B92cF975E3cf9Ad44c0664d6aF67f358360FFA`, Chainlink latestRoundData at `0x4A1166a659A55625345e9515b32adECea5547C38` (chain 4663)
- **Risk analyst**: NOT RUN. The market analyst stopped the run before this stage
- **Strike planner**: NOT RUN. The market analyst stopped the run before this stage
- **Critic**: NOT RUN. The market analyst stopped the run before this stage
- **Contract**: NOT RUN. The market analyst stopped the run, so no proposal was sent

## Alternatives to grade at settlement

Model numbers for what the week could have been, to grade against the settlement price:

- **kept cash (what the agent did):** no option sold, 0 options, premium $0, worst ±30% payout $0. Source: no option sold: no premium, no payout.

Inputs that should agree, compared:

- testnet MirrorFeed latest round against mainnet Chainlink latest round: agree. the mirror has the mainnet's latest print ($370.448 at Fri 2 Oct 19:55 UTC) (limit: the mirror at most 30 min behind mainnet).
- pricer sigma (EpochManager) against realised volatility (10 daily mainnet closes): agree. sigma 60.0% against realised 37.1% a year (limit: neither more than 2x the other).
- MCP vault_state spot against StockOracle.status price: agree. $370.448 against $370.448 (limit: within 0.01%).

## Transactions

None sent by this run.

## Result

**No trade.** No trade this week: the market analyst stopped the run (market closed until Mon 5 Oct 13:30 UTC). Nothing was sent.

- **Stopped by:** the market analyst (market closed until Mon 5 Oct 13:30 UTC)
- **Reason:** `no-trade`

## Track record afterwards

- **Agent #1:** Active
- **Proposals:** 1 accepted, 1 rejected; 1/3 strikes
- **Bond:** 50 USDG
- **Settled epochs:** 0, cumulative depositor PnL 0 USDG
- **Claimable fees:** 0 USDG

---

Written by the Strike example agent (`--log`). Machine-readable copy: [2026-10-03-sTSLA-CSP-dry-run.json](2026-10-03-sTSLA-CSP-dry-run.json).
