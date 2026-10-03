# sTSLA-CSP weekly proposal (dry run), 2026-10-03

**Dry run.** Dry run with --ignore-session: evaluated as if the NYSE were open; nothing was sent and the record is not anchored.

- **Date:** 2026-10-03 (chain time 2026-10-03T07:21:55.000Z)
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

- **Strategy:** Claude chose the plan (read-only Strike tools, then the agent's own mandate guard)
- **Planner:** Claude via Claude Code CLI, model claude-opus-5
- **Claude usage:** 10 calls, 8 input tokens, 2,604 output tokens, 57,383 cache-read tokens, 23,371 cache-creation tokens, $0.3297 (Claude Code's list-price estimate), 44.4 s (Claude Code stream-json result message (usage, num_turns, duration_ms, total_cost_usd); total_cost_usd is Claude Code's own estimate at list prices, not a bill)
- **Target:** 0.20 delta at 105% of Black-Scholes fair value
- **Note:** Claude via Claude Code CLI, model claude-opus-5.

Why:

> We will sell TSLA cash-secured puts at |delta| 0.20 (strike ~347.38, about 6.2% below the 370.45 spot) for the 9 October expiry, priced at 105% of Black-Scholes fair value. The contract's own previewProposal accepts this rung: fair value 3.4492 USDG per option and a yield of 104 bps of locked collateral for 6.5 days, with a roughly 22% model chance of being assigned and a break-even 7.2% under spot. We passed on 0.25 delta because the extra 27 bps of yield came with a 28% assignment probability and a thinner cushion while TSLA vol sits at 0.60, and 0.20 keeps a full 0.10 of margin to both edges of the 0.10-0.35 mandate band - cheap insurance given the agent's bond already carries one strike. The 5% markup over fair value adds premium for depositors while staying close enough to fair that buyers should still take the series.

## Dry run

- **Verdict:** inside the mandate (`None`). Inside the mandate: the contract would accept this proposal.
- **Proposal:** put at strike $347.38 (|delta| 0.2, solved from a 0.20 target), expiry 2026-10-09T20:00:00.000Z, 0.138177212274742356 of 0.172721515343427946 options, premium 105% of fair value
- **Fair value:** $3.449 per option, 1.04% of collateral

## Specialists

Each specialist has its own inputs and tools; every number below was computed from those tools. Claude's words, where present, are labelled as narration.

- **Market analyst** (agent code, 14.1 s): PASS. Go: all 6 checks passed (the session check waived by --ignore-session, a dry run).
  - session: NYSE closed until Mon 5 Oct 13:30 UTC; limit: the NYSE regular session (openEpoch and buy revert outside it) (failed, waived by --ignore-session (dry run))
  - feed-status: StockOracle.status: Ok; limit: a valid price from a feed and token that are not paused (ok)
  - feed-fresh: last print 11.4 h old (Fri 2 Oct 19:55 UTC); limit: at most 25.0 h old (feedConfig.maxPriceAge) (ok)
  - corporate-action: none: uiMultiplier equals newUIMultiplier and no change took effect within the grace window; limit: no ERC-8056 multiplier change pending or within 24.0 h of taking effect (ok)
  - sequencer: not provided: no sequencer uptime feed is configured on this chain's StockOracle (sequencerFeed is the zero address); the contract skips the check too; limit: up and past its grace period, when a sequencer feed is configured (the contract skips the check without one) (ok)
  - sigma-bounds: sigma 60.0% a year; limit: 20% to 200% (EpochManager.underlyings minSigma, maxSigma) (ok)
  - realised volatility: 37.1% a year over 10 daily returns of mainnet Chainlink closes, against the pricer's sigma 60.0%
  - Sources: vault_state, StockOracle.status at `0x5BCdBFaB940BFAEF821392d7f58c670c2064989A`, StockOracle.feedConfig at `0x5BCdBFaB940BFAEF821392d7f58c670c2064989A`, StockOracle.isMarketOpen at `0x5BCdBFaB940BFAEF821392d7f58c670c2064989A`, StockOracle.sequencerFeed at `0x5BCdBFaB940BFAEF821392d7f58c670c2064989A`, EpochManager.underlyings at `0x256D4546486368dCb23E94758b4cb500c215929F`, MarketCalendar.isTradingDay at `0x214d21F4fCA2226091AF009B9F1BF1D3C63f95F4`, MarketCalendar.sessionOf at `0x214d21F4fCA2226091AF009B9F1BF1D3C63f95F4`, ERC-8056 uiMultiplier, newUIMultiplier, effectiveAt at `0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E`, MirrorFeed.latestRoundData at `0x5476cb08769f406dE95F6171AcC1F5FE88431230`, Chainlink latestRoundData at `0x4A1166a659A55625345e9515b32adECea5547C38` (chain 4663)
- **Risk analyst** (agent code, 42.9 s): PASS. 8 rungs dry-run, 6 inside the mandate; greeks and stress from the risk engine at 0x61158d98C6C2b7cCb22755A098D0Da2BbCf2a4Ec.
  - 0.05 delta: strike $325.7, outside the mandate (`DeltaOutOfBand`), yield 0.2%, model P(exercise) 5.9%, break-even $325.0597 (12.3% from spot), worst ±30% payout $9.783688 (20.4% of collateral), greeks per option: delta -0.0500, gamma 0.00347, vega 5.110, theta -0.235 a day
  - 0.10 delta: strike $335.33, inside the mandate, yield 0.43%, model P(exercise) 11.5%, break-even $333.8745 (9.9% from spot), worst ±30% payout $10.881183 (22.7% of collateral), greeks per option: delta -0.1000, gamma 0.00591, vega 8.694, theta -0.400 a day
  - 0.15 delta: strike $341.99, inside the mandate, yield 0.7%, model P(exercise) 16.9%, break-even $339.5952 (8.3% from spot), worst ±30% payout $11.604045 (24.2% of collateral), greeks per option: delta -0.1500, gamma 0.00785, vega 11.550, theta -0.531 a day
  - 0.20 delta: strike $347.38, inside the mandate, yield 0.99%, model P(exercise) 22.3%, break-even $343.9305 (7.2% from spot), worst ±30% payout $12.16877 (25.4% of collateral), greeks per option: delta -0.2000, gamma 0.00942, vega 13.870, theta -0.638 a day
  - 0.25 delta: strike $352.06, inside the mandate, yield 1.31%, model P(exercise) 27.6%, break-even $347.4441 (6.2% from spot), worst ±30% payout $12.645081 (26.3% of collateral), greeks per option: delta -0.2499, gamma 0.01069, vega 15.739, theta -0.723 a day
  - 0.30 delta: strike $356.33, inside the mandate, yield 1.66%, model P(exercise) 32.8%, break-even $350.4246 (5.4% from spot), worst ±30% payout $13.068749 (27.2% of collateral), greeks per option: delta -0.3000, gamma 0.01170, vega 17.223, theta -0.792 a day
  - 0.35 delta: strike $360.32, inside the mandate, yield 2.03%, model P(exercise) 38.0%, break-even $353.002 (4.7% from spot), worst ±30% payout $13.45556 (28.0% of collateral), greeks per option: delta -0.3499, gamma 0.01246, vega 18.346, theta -0.843 a day
  - 0.40 delta: strike $364.16, outside the mandate (`DeltaOutOfBand`), yield 2.44%, model P(exercise) 43.1%, break-even $355.2848 (4.1% from spot), worst ±30% payout $13.819824 (28.8% of collateral), greeks per option: delta -0.3999, gamma 0.01300, vega 19.137, theta -0.880 a day
  - Risk engine: `0x61158d98C6C2b7cCb22755A098D0Da2BbCf2a4Ec` (EpochManager.pricer())
  - Rejected by the dry run: 2 DeltaOutOfBand
  - Sources: risk_check, IRiskEngine.greeks at `0x61158d98C6C2b7cCb22755A098D0Da2BbCf2a4Ec`, IRiskEngine.scenarioLoss at `0x61158d98C6C2b7cCb22755A098D0Da2BbCf2a4Ec`, normCdf (model probability of exercise)
- **Strike planner** (Claude, 46.0 s): PASS. Claude chose 0.20 delta at 105% of fair value, a rung of the ladder (its words are the narration).
  - Chose 0.20 delta at 105% of fair value, strike $347.38, 0.138177 options
  - Sources: vault_state, risk_check
  - Claude usage: 10 calls, 8 input tokens, 2,604 output tokens, 57,383 cache-read tokens, 23,371 cache-creation tokens, $0.3297 (Claude Code's list-price estimate), 44.4 s
  - Narration by Claude via Claude Code CLI, model claude-opus-5 (Claude's words, not a computed number):

    > We will sell TSLA cash-secured puts at |delta| 0.20 (strike ~347.38, about 6.2% below the 370.45 spot) for the 9 October expiry, priced at 105% of Black-Scholes fair value. The contract's own previewProposal accepts this rung: fair value 3.4492 USDG per option and a yield of 104 bps of locked collateral for 6.5 days, with a roughly 22% model chance of being assigned and a break-even 7.2% under spot. We passed on 0.25 delta because the extra 27 bps of yield came with a 28% assignment probability and a thinner cushion while TSLA vol sits at 0.60, and 0.20 keeps a full 0.10 of margin to both edges of the 0.10-0.35 mandate band - cheap insurance given the agent's bond already carries one strike. The 5% markup over fair value adds premium for depositors while staying close enough to fair that buyers should still take the series.

- **Critic** (agent code, 5.8 s): PASS. All 5 rules pass.
  - market: go (session waived by --ignore-session: a dry run evaluated as if the NYSE were open); limit: the market analyst's go (ok)
  - mandate: previewProposal accepts it (None); limit: every rule of the vault's mandate (ok)
  - cushion: break-even $343.75855 is 7.2% below spot $370.448; the worst ±30% move (-30%) would cost $12.16877, 25.4% of the collateral, against $0.500402 of premium; limit: at least 4.0% (0.5 x the 8.0% one-sigma move to expiry) (ok)
  - drift: not applicable: the risk table has no rung at this delta and premium factor to compare with; limit: strike and spot within 0.5% of the risk table (not applicable)
  - yield: risk_check reports 1.04% of collateral; rebuilt from fair value $3.449 x 105% over $347.38 it is 1.04%; limit: within 2% of the rebuilt yield (ok)
  - Model odds the option expires worthless: 77.7% (Black-Scholes N(d2), risk-neutral with a zero rate, at the pricer's sigma 60.0% and 6.53 days to expiry: model odds, not a forecast and not self-reported)
  - Sources: risk_check, IRiskEngine.greeks at `0x61158d98C6C2b7cCb22755A098D0Da2BbCf2a4Ec`, IRiskEngine.scenarioLoss at `0x61158d98C6C2b7cCb22755A098D0Da2BbCf2a4Ec`
- **Contract**: NOT RUN. Dry run with --ignore-session (evaluated as if the NYSE were open): nothing was sent

## Alternatives to grade at settlement

Model numbers for what the week could have been, to grade against the settlement price:

- **chosen strike:** strike $347.38, 0.138177 options, premium $0.500402, break-even $343.75855, model P(exercise) 22.3%, worst ±30% payout $12.16877. Source: the critic's exact dry run and risk engine read.
- **kept cash (what the agent did):** no option sold, 0 options, premium $0, worst ±30% payout $0. Source: no option sold: no premium, no payout.
- **half size:** strike $347.38, 0.069089 options, premium $0.250201, break-even $343.75855, model P(exercise) 22.3%, worst ±30% payout $6.084385. Source: the chosen strike at half the size: premium and stress loss halved.
- **one step nearer:** strike $352.06, 0.136340 options, premium $0.629334, break-even $347.4441, model P(exercise) 27.6%, worst ±30% payout $12.645081. Source: the risk table's 0.25 delta rung at 100% of fair value.
- **one step farther:** strike $341.99, 0.140354 options, premium $0.336122, break-even $339.5952, model P(exercise) 16.9%, worst ±30% payout $11.604045. Source: the risk table's 0.15 delta rung at 100% of fair value.

Inputs that should agree, compared:

- testnet MirrorFeed latest round against mainnet Chainlink latest round: agree. the mirror has the mainnet's latest print ($370.448 at Fri 2 Oct 19:55 UTC) (limit: the mirror at most 30 min behind mainnet).
- pricer sigma (EpochManager) against realised volatility (10 daily mainnet closes): agree. sigma 60.0% against realised 37.1% a year (limit: neither more than 2x the other).
- MCP vault_state spot against StockOracle.status price: agree. $370.448 against $370.448 (limit: within 0.01%).
- Claude's own risk_check of its plan against the critic's exact dry run: agree. strike $347.38 when Claude dry-ran it, $347.38 at the critic (0.00%) (limit: within 0.5%).

## Alternatives it dry-ran

Claude's own `risk_check` calls, in order:

- **0.15 delta at 100% of fair value**: strike $342, |delta| 0.1501, fair value $2.3962, premium $2.3962 per option, yield 0.7% of collateral, 0.140350 of 0.175438 options. Inside the mandate.
- **0.20 delta at 100% of fair value**: strike $347.38, |delta| 0.2, fair value $3.4492, premium $3.4492 per option, yield 0.99% of collateral, 0.138177 of 0.172721 options. Inside the mandate.
- **0.25 delta at 100% of fair value**: strike $352.06, |delta| 0.2499, fair value $4.6156, premium $4.6156 per option, yield 1.31% of collateral, 0.136340 of 0.170425 options. Inside the mandate.
- **0.20 delta at 105% of fair value** (chosen): strike $347.38, |delta| 0.2, fair value $3.4492, premium $3.62166 per option, yield 1.04% of collateral, 0.138177 of 0.172721 options. Inside the mandate.
- **0.20 delta at 110% of fair value**: strike $347.38, |delta| 0.2, fair value $3.4492, premium $3.79412 per option, yield 1.09% of collateral, 0.138177 of 0.172721 options. Inside the mandate.
- **0.18 delta at 105% of fair value**: strike $345.33, |delta| 0.18, fair value $3.0136, premium $3.16428 per option, yield 0.92% of collateral, 0.138997 of 0.173746 options. Inside the mandate.

The agent's ladder: the same dry run at several target deltas across the mandate's band and a little beyond each edge, all at the chosen premium factor and the largest size the mandate allows:

- **0.05 delta at 100% of fair value**: strike $325.7, |delta| 0.05, fair value $0.6403, premium $0.6403 per option, yield 0.2% of collateral, 0.147374 of 0.184218 options. Outside the mandate: `DeltaOutOfBand`, |delta| 0.05 against 0.10 to 0.35.
- **0.10 delta at 100% of fair value**: strike $335.33, |delta| 0.1, fair value $1.4555, premium $1.4555 per option, yield 0.43% of collateral, 0.143142 of 0.178928 options. Inside the mandate.
- **0.15 delta at 100% of fair value**: strike $341.99, |delta| 0.15, fair value $2.3948, premium $2.3948 per option, yield 0.7% of collateral, 0.140354 of 0.175443 options. Inside the mandate.
- **0.20 delta at 100% of fair value**: strike $347.38, |delta| 0.2, fair value $3.4495, premium $3.4495 per option, yield 0.99% of collateral, 0.138177 of 0.172721 options. Inside the mandate.
- **0.25 delta at 100% of fair value**: strike $352.06, |delta| 0.2499, fair value $4.6159, premium $4.6159 per option, yield 1.31% of collateral, 0.136340 of 0.170425 options. Inside the mandate.
- **0.30 delta at 100% of fair value**: strike $356.33, |delta| 0.3, fair value $5.9054, premium $5.9054 per option, yield 1.66% of collateral, 0.134706 of 0.168383 options. Inside the mandate.
- **0.35 delta at 100% of fair value**: strike $360.32, |delta| 0.3499, fair value $7.318, premium $7.318 per option, yield 2.03% of collateral, 0.133214 of 0.166518 options. Inside the mandate.
- **0.40 delta at 100% of fair value**: strike $364.16, |delta| 0.3999, fair value $8.8752, premium $8.8752 per option, yield 2.44% of collateral, 0.131810 of 0.164762 options. Outside the mandate: `DeltaOutOfBand`, |delta| 0.3999 against 0.10 to 0.35.

## Transactions

None sent by this run.

## Result

**Not sent.** Dry run only (--dry-run --ignore-session, evaluated as if the NYSE were open): the plan passed every specialist and was not sent.

- **Strike:** $347.38
- **Expiry:** 2026-10-09T20:00:00.000Z
- **Size:** 0.138177212274742356 options

## Track record afterwards

- **Agent #1:** Active
- **Proposals:** 1 accepted, 1 rejected; 1/3 strikes
- **Bond:** 70 USDG
- **Settled epochs:** 0, cumulative depositor PnL 0 USDG
- **Claimable fees:** 0 USDG

---

Written by the Strike example agent (`--log`). Machine-readable copy: [2026-10-03-sTSLA-CSP-as-if-open-claude-dry-run-2.json](2026-10-03-sTSLA-CSP-as-if-open-claude-dry-run-2.json).
