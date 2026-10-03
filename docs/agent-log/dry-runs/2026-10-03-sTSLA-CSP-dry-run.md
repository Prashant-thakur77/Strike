# sTSLA-CSP weekly proposal (dry run), 2026-10-03

**Dry run.** Dry run: nothing was sent and the record is not anchored.

- **Date:** 2026-10-03 (chain time 2026-10-03T05:40:56.000Z)
- **Chain:** Robinhood Chain Testnet (46630)
- **Agent:** #1
- **Result:** no trade

## Vault and mandate

- **Vault:** sTSLA-CSP (Strike TSLA Cash-Secured Put), a cash-secured put vault on TSLA, `0x1bc73c1B28F520E57982FAe6127477190FA53690`
- **Collateral:** 60 USDG; epoch Idle when the run started
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

- **Market analyst** (agent code, 13.8 s): FAIL. No-go: market closed until Mon 5 Oct 13:30 UTC.
  - session: NYSE closed until Mon 5 Oct 13:30 UTC; limit: the NYSE regular session (openEpoch and buy revert outside it) (failed)
  - feed-status: StockOracle.status: Ok; limit: a valid price from a feed and token that are not paused (ok)
  - feed-fresh: last print 9.8 h old (Fri 2 Oct 19:55 UTC); limit: at most 25.0 h old (feedConfig.maxPriceAge) (ok)
  - corporate-action: none: uiMultiplier equals newUIMultiplier and no change took effect within the grace window; limit: no ERC-8056 multiplier change pending or within 24.0 h of taking effect (ok)
  - sequencer: not provided: no sequencer uptime feed is configured on this chain's StockOracle (sequencerFeed is the zero address); the contract skips the check too; limit: up and past its grace period, when a sequencer feed is configured (the contract skips the check without one) (ok)
  - sigma-bounds: sigma 60.0% a year; limit: 20% to 200% (EpochManager.underlyings minSigma, maxSigma) (ok)
  - realised volatility: 37.1% a year over 10 daily returns of mainnet Chainlink closes, against the pricer's sigma 60.0%
  - Sources: vault_state, StockOracle.status at `0x5BCdBFaB940BFAEF821392d7f58c670c2064989A`, StockOracle.feedConfig at `0x5BCdBFaB940BFAEF821392d7f58c670c2064989A`, StockOracle.isMarketOpen at `0x5BCdBFaB940BFAEF821392d7f58c670c2064989A`, StockOracle.sequencerFeed at `0x5BCdBFaB940BFAEF821392d7f58c670c2064989A`, EpochManager.underlyings at `0x256D4546486368dCb23E94758b4cb500c215929F`, MarketCalendar.isTradingDay at `0x214d21F4fCA2226091AF009B9F1BF1D3C63f95F4`, MarketCalendar.sessionOf at `0x214d21F4fCA2226091AF009B9F1BF1D3C63f95F4`, ERC-8056 uiMultiplier, newUIMultiplier, effectiveAt at `0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E`, MirrorFeed.latestRoundData at `0x5476cb08769f406dE95F6171AcC1F5FE88431230`, Chainlink latestRoundData at `0x4A1166a659A55625345e9515b32adECea5547C38` (chain 4663)
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
- **Bond:** 70 USDG
- **Settled epochs:** 0, cumulative depositor PnL 0 USDG
- **Claimable fees:** 0 USDG

---

Written by the Strike example agent (`--log`). Machine-readable copy: [2026-10-03-sTSLA-CSP-dry-run.json](2026-10-03-sTSLA-CSP-dry-run.json).
