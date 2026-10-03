# sTSLA-CSP weekly proposal (dry run), 2026-10-03

**Dry run.** Dry run with --ignore-session: evaluated as if the NYSE were open; nothing was sent and the record is not anchored.

- **Date:** 2026-10-03 (chain time 2026-10-03T05:41:14.000Z)
- **Chain:** Robinhood Chain Testnet (46630)
- **Agent:** #1
- **Result:** not sent

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
- **Target:** 0.20 delta at 100% of Black-Scholes fair value

Why:

> Target 0.20 delta: far enough out of the money that the stock rarely gets called away, close enough to earn a meaningful premium. Price at 100% of Black-Scholes fair value.

## Dry run

- **Verdict:** inside the mandate (`None`). Inside the mandate: the contract would accept this proposal.
- **Proposal:** put at strike $347.27 (|delta| 0.2001, solved from a 0.20 target), expiry 2026-10-09T20:00:00.000Z, 0.138220980793042876 of 0.172776225991303596 options, premium 100% of fair value
- **Fair value:** $3.4692 per option, 1% of collateral

## Specialists

Each specialist has its own inputs and tools; every number below was computed from those tools. Claude's words, where present, are labelled as narration.

- **Market analyst** (agent code, 14.2 s): PASS. Go: all 6 checks passed (the session check waived by --ignore-session, a dry run).
  - session: NYSE closed until Mon 5 Oct 13:30 UTC; limit: the NYSE regular session (openEpoch and buy revert outside it) (failed, waived by --ignore-session (dry run))
  - feed-status: StockOracle.status: Ok; limit: a valid price from a feed and token that are not paused (ok)
  - feed-fresh: last print 9.8 h old (Fri 2 Oct 19:55 UTC); limit: at most 25.0 h old (feedConfig.maxPriceAge) (ok)
  - corporate-action: none: uiMultiplier equals newUIMultiplier and no change took effect within the grace window; limit: no ERC-8056 multiplier change pending or within 24.0 h of taking effect (ok)
  - sequencer: not provided: no sequencer uptime feed is configured on this chain's StockOracle (sequencerFeed is the zero address); the contract skips the check too; limit: up and past its grace period, when a sequencer feed is configured (the contract skips the check without one) (ok)
  - sigma-bounds: sigma 60.0% a year; limit: 20% to 200% (EpochManager.underlyings minSigma, maxSigma) (ok)
  - realised volatility: 37.1% a year over 10 daily returns of mainnet Chainlink closes, against the pricer's sigma 60.0%
  - Sources: vault_state, StockOracle.status at `0x5BCdBFaB940BFAEF821392d7f58c670c2064989A`, StockOracle.feedConfig at `0x5BCdBFaB940BFAEF821392d7f58c670c2064989A`, StockOracle.isMarketOpen at `0x5BCdBFaB940BFAEF821392d7f58c670c2064989A`, StockOracle.sequencerFeed at `0x5BCdBFaB940BFAEF821392d7f58c670c2064989A`, EpochManager.underlyings at `0x256D4546486368dCb23E94758b4cb500c215929F`, MarketCalendar.isTradingDay at `0x214d21F4fCA2226091AF009B9F1BF1D3C63f95F4`, MarketCalendar.sessionOf at `0x214d21F4fCA2226091AF009B9F1BF1D3C63f95F4`, ERC-8056 uiMultiplier, newUIMultiplier, effectiveAt at `0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E`, MirrorFeed.latestRoundData at `0x5476cb08769f406dE95F6171AcC1F5FE88431230`, Chainlink latestRoundData at `0x4A1166a659A55625345e9515b32adECea5547C38` (chain 4663)
- **Risk analyst** (agent code, 42.9 s): PASS. 8 rungs dry-run, 6 inside the mandate; greeks and stress from the risk engine at 0x61158d98C6C2b7cCb22755A098D0Da2BbCf2a4Ec.
  - 0.05 delta: strike $325.48, outside the mandate (`DeltaOutOfBand`), yield 0.2%, model P(exercise) 5.9%, break-even $324.8363 (12.3% from spot), worst ±30% payout $9.757857 (20.3% of collateral), greeks per option: delta -0.0500, gamma 0.00345, vega 5.137, theta -0.234 a day
  - 0.10 delta: strike $335.16, inside the mandate, yield 0.44%, model P(exercise) 11.5%, break-even $333.6962 (9.9% from spot), worst ±30% payout $10.862356 (22.6% of collateral), greeks per option: delta -0.1000, gamma 0.00587, vega 8.741, theta -0.398 a day
  - 0.15 delta: strike $341.85, inside the mandate, yield 0.7%, model P(exercise) 17.0%, break-even $339.4419 (8.4% from spot), worst ±30% payout $11.589139 (24.1% of collateral), greeks per option: delta -0.1500, gamma 0.00780, vega 11.612, theta -0.528 a day
  - 0.20 delta: strike $347.27, inside the mandate, yield 1%, model P(exercise) 22.3%, break-even $343.8006 (7.2% from spot), worst ±30% payout $12.15742 (25.3% of collateral), greeks per option: delta -0.2001, gamma 0.00937, vega 13.945, theta -0.634 a day
  - 0.25 delta: strike $351.97, inside the mandate, yield 1.32%, model P(exercise) 27.6%, break-even $347.3285 (6.2% from spot), worst ±30% payout $12.636041 (26.3% of collateral), greeks per option: delta -0.2499, gamma 0.01063, vega 15.823, theta -0.720 a day
  - 0.30 delta: strike $356.26, inside the mandate, yield 1.67%, model P(exercise) 32.9%, break-even $350.3224 (5.4% from spot), worst ±30% payout $13.061885 (27.2% of collateral), greeks per option: delta -0.3000, gamma 0.01164, vega 17.314, theta -0.787 a day
  - 0.35 delta: strike $360.28, inside the mandate, yield 2.04%, model P(exercise) 38.0%, break-even $352.9184 (4.7% from spot), worst ±30% payout $13.451724 (28.0% of collateral), greeks per option: delta -0.3500, gamma 0.01240, vega 18.446, theta -0.839 a day
  - 0.40 delta: strike $364.13, outside the mandate (`DeltaOutOfBand`), yield 2.45%, model P(exercise) 43.1%, break-even $355.2064 (4.1% from spot), worst ±30% payout $13.817008 (28.8% of collateral), greeks per option: delta -0.3999, gamma 0.01293, vega 19.239, theta -0.875 a day
  - Risk engine: `0x61158d98C6C2b7cCb22755A098D0Da2BbCf2a4Ec` (EpochManager.pricer())
  - Rejected by the dry run: 2 DeltaOutOfBand
  - Sources: risk_check, IRiskEngine.greeks at `0x61158d98C6C2b7cCb22755A098D0Da2BbCf2a4Ec`, IRiskEngine.scenarioLoss at `0x61158d98C6C2b7cCb22755A098D0Da2BbCf2a4Ec`, normCdf (model probability of exercise)
- **Strike planner** (agent code, 1 ms): PASS. The rung at the profile's 0.20 delta, which the contract's dry run accepts.
  - Chose 0.20 delta at 100% of fair value, strike $347.27, 0.138220 options
  - Sources: profile default
- **Critic** (agent code, 5.6 s): PASS. All 5 rules pass.
  - market: go (session waived by --ignore-session: a dry run evaluated as if the NYSE were open); limit: the market analyst's go (ok)
  - mandate: previewProposal accepts it (None); limit: every rule of the vault's mandate (ok)
  - cushion: break-even $343.8008 is 7.2% below spot $370.448; the worst ±30% move (-30%) would cost $12.15742, 25.3% of the collateral, against $0.479516 of premium; limit: at least 4.0% (0.5 x the 8.1% one-sigma move to expiry) (ok)
  - drift: strike $347.27 in the risk table, $347.27 now (0.00%); spot $370.448 then, $370.448 now (0.00%); limit: both within 0.5% (ok)
  - yield: risk_check reports 1.00% of collateral; rebuilt from fair value $3.4692 x 100% over $347.27 it is 1.00%; the risk table had 1.00% for this rung; limit: within 2% of the rebuilt yield and 10% of the table's (ok)
  - Model odds the option expires worthless: 77.7% (Black-Scholes N(d2), risk-neutral with a zero rate, at the pricer's sigma 60.0% and 6.60 days to expiry: model odds, not a forecast and not self-reported)
  - Sources: risk_check, IRiskEngine.greeks at `0x61158d98C6C2b7cCb22755A098D0Da2BbCf2a4Ec`, IRiskEngine.scenarioLoss at `0x61158d98C6C2b7cCb22755A098D0Da2BbCf2a4Ec`
- **Contract**: NOT RUN. Dry run with --ignore-session (evaluated as if the NYSE were open): nothing was sent

## Alternatives to grade at settlement

Model numbers for what the week could have been, to grade against the settlement price:

- **chosen strike:** strike $347.27, 0.138220 options, premium $0.479516, break-even $343.8008, model P(exercise) 22.3%, worst ±30% payout $12.15742. Source: the critic's exact dry run and risk engine read.
- **kept cash (what the agent did):** no option sold, 0 options, premium $0, worst ±30% payout $0. Source: no option sold: no premium, no payout.
- **half size:** strike $347.27, 0.06911 options, premium $0.239758, break-even $343.8008, model P(exercise) 22.3%, worst ±30% payout $6.07871. Source: the chosen strike at half the size: premium and stress loss halved.
- **one step nearer:** strike $351.97, 0.136375 options, premium $0.632986, break-even $347.3285, model P(exercise) 27.6%, worst ±30% payout $12.636041. Source: the risk table's 0.25 delta rung at 100% of fair value.
- **one step farther:** strike $341.85, 0.140412 options, premium $0.338127, break-even $339.4419, model P(exercise) 17.0%, worst ±30% payout $11.589139. Source: the risk table's 0.15 delta rung at 100% of fair value.

Inputs that should agree, compared:

- testnet MirrorFeed latest round against mainnet Chainlink latest round: agree. the mirror has the mainnet's latest print ($370.448 at Fri 2 Oct 19:55 UTC) (limit: the mirror at most 30 min behind mainnet).
- pricer sigma (EpochManager) against realised volatility (10 daily mainnet closes): agree. sigma 60.0% against realised 37.1% a year (limit: neither more than 2x the other).
- MCP vault_state spot against StockOracle.status price: agree. $370.448 against $370.448 (limit: within 0.01%).

## Alternatives it dry-ran

The agent's ladder: the same dry run at several target deltas across the mandate's band and a little beyond each edge, all at the chosen premium factor and the largest size the mandate allows:

- **0.05 delta at 100% of fair value**: strike $325.48, |delta| 0.05, fair value $0.6437, premium $0.6437 per option, yield 0.2% of collateral, 0.147474 of 0.184343 options. Outside the mandate: `DeltaOutOfBand`, |delta| 0.05 against 0.10 to 0.35.
- **0.10 delta at 100% of fair value**: strike $335.16, |delta| 0.1, fair value $1.4638, premium $1.4638 per option, yield 0.44% of collateral, 0.143215 of 0.179018 options. Inside the mandate.
- **0.15 delta at 100% of fair value**: strike $341.85, |delta| 0.15, fair value $2.4081, premium $2.4081 per option, yield 0.7% of collateral, 0.140412 of 0.175515 options. Inside the mandate.
- **0.20 delta at 100% of fair value** (chosen): strike $347.27, |delta| 0.2001, fair value $3.4694, premium $3.4694 per option, yield 1% of collateral, 0.138220 of 0.172776 options. Inside the mandate.
- **0.25 delta at 100% of fair value**: strike $351.97, |delta| 0.2499, fair value $4.6415, premium $4.6415 per option, yield 1.32% of collateral, 0.136375 of 0.170469 options. Inside the mandate.
- **0.30 delta at 100% of fair value**: strike $356.26, |delta| 0.3, fair value $5.9376, premium $5.9376 per option, yield 1.67% of collateral, 0.134733 of 0.168416 options. Inside the mandate.
- **0.35 delta at 100% of fair value**: strike $360.28, |delta| 0.35, fair value $7.3616, premium $7.3616 per option, yield 2.04% of collateral, 0.133229 of 0.166537 options. Inside the mandate.
- **0.40 delta at 100% of fair value**: strike $364.13, |delta| 0.3999, fair value $8.9236, premium $8.9236 per option, yield 2.45% of collateral, 0.131821 of 0.164776 options. Outside the mandate: `DeltaOutOfBand`, |delta| 0.3999 against 0.10 to 0.35.

## Transactions

None sent by this run.

## Result

**Not sent.** Dry run only (--dry-run --ignore-session, evaluated as if the NYSE were open): the plan passed every specialist and was not sent.

- **Strike:** $347.27
- **Expiry:** 2026-10-09T20:00:00.000Z
- **Size:** 0.138220980793042876 options

## Track record afterwards

- **Agent #1:** Active
- **Proposals:** 1 accepted, 1 rejected; 1/3 strikes
- **Bond:** 70 USDG
- **Settled epochs:** 0, cumulative depositor PnL 0 USDG
- **Claimable fees:** 0 USDG

---

Written by the Strike example agent (`--log`). Machine-readable copy: [2026-10-03-sTSLA-CSP-as-if-open-dry-run.json](2026-10-03-sTSLA-CSP-as-if-open-dry-run.json).
