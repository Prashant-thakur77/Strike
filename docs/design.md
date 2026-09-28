# Strike design

This document is the contract-level specification. [PLAN.md](PLAN.md) says what we build and why; this file says exactly how it behaves. Code, tests and this document must agree; when they disagree, fix the one that is wrong and log it in [decisions.md](decisions.md).

## 1. Actors and contracts

| Contract                           | Role                                                                                                                                                                                                |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `StrikeVault`                      | ERC-4626 vault (EIP-1167 clone). Holds collateral: the stock token (call vault) or USDG (put vault). Queues deposits and redemptions while an epoch runs. Distributes USDG premium to shareholders. |
| `VaultFactory`                     | Deploys vault clones and registers them with the `EpochManager`.                                                                                                                                    |
| `EpochManager`                     | The state machine: opens epochs, checks proposals, sells options, settles, pays option holders. The only address a vault accepts collateral moves from.                                             |
| `OptionToken`                      | ERC-1155. One id per series. Only the `EpochManager` mints and burns.                                                                                                                               |
| `MandateGuard`                     | Library. Pure check of a proposal against a vault's mandate. Returns a reason code instead of reverting.                                                                                            |
| `AgentRegistry`                    | Agents, their signer and payout addresses, ERC-8004 identity link, USDG bond, strikes and slashing.                                                                                                 |
| `FeeManager`                       | Performance-fee parameters and fee balances (pull payments).                                                                                                                                        |
| `SafeStockFeed`                    | Library. Every price read goes through it: staleness, pauses, corporate actions, decimals.                                                                                                          |
| `MarketCalendar`                   | NYSE trading calendar: DST-aware open/close times plus an admin-maintained holiday list.                                                                                                            |
| `BlackScholesRef` / `StylusPricer` | `IPricer` implementations. Identical integer algorithm in Solidity and Rust.                                                                                                                        |

Roles (OpenZeppelin `AccessControl`): `DEFAULT_ADMIN_ROLE` (config, allow-list), `GUARDIAN_ROLE` (pause, emergency cancel), `KEEPER_ROLE` (volatility updates, opening epochs). Each vault also has a `curator` (who created it) who can change the vault's agent.

## 2. Units

| Quantity                             | Unit                                         | Notes                                                                                                  |
| ------------------------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Prices, strikes, premiums per option | WAD (1e18 = $1) per **raw** token            | Same unit as the Chainlink stock feed, normalised from the feed's decimals                             |
| Option amounts                       | Underlying token base units                  | `10^underlyingDecimals` = one option on one raw token                                                  |
| Call collateral                      | Underlying token                             | One raw token per option                                                                               |
| Put collateral, premium, fees, bonds | USDG base units                              | Decimals read on-chain (6 on Robinhood testnet)                                                        |
| Volatility                           | WAD, annualised                              | Admin bounds per underlying; a keeper `setSigma` moves it at most 25% per update, at most once an hour |
| Time                                 | Seconds; `T` in years = seconds / 31,536,000 |                                                                                                        |

USDG is treated as exactly $1. Conversions from WAD USD to USDG round **up** when the vault receives (collateral required, premium owed by a buyer) and **down** when the vault pays (payouts). Every rounding favours the vault.

### Why strikes are per raw token

ERC-8056 stock tokens keep raw balances fixed and express splits and dividends through `uiMultiplier` (UI balance = raw balance × multiplier). The Chainlink feed for a stock token already prices one raw token, multiplier included. Strikes, spot and payouts are therefore all per raw token, and a split changes neither the feed price nor the strike. **We never multiply a Chainlink price by `uiMultiplier`.** The app divides by the multiplier only to _display_ a per-share price.

## 3. Epoch lifecycle

```mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> Open: openEpoch (market open, feed safe, snapshot spot and sigma)
    Open --> Selling: proposeSeries (mandate passes)
    Open --> Open: proposeSeries rejected (agent slashed)
    Open --> Idle: abortEpoch (no proposal before timeout)
    Selling --> Selling: buy (market open, before sale end)
    Selling --> Idle: settle (after expiry, first valid print)
    Selling --> Idle: emergencyCancel (guardian, expiry + grace, no settlement price recorded)
```

| Phase                                                             | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Who can call          |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Idle                                                              | Vault unlocked: ERC-4626 `deposit`/`mint`/`withdraw`/`redeem` work instantly, up to the TVL cap.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | anyone                |
| `openEpoch(vault)`                                                | Requires Idle, not paused, market open, feed safe. Snapshots spot and the underlying's sigma (`epochs(vault)` returns `state, openedAt, seriesId, openSpot, openSigma`). Locks the vault (**lock**): from now until settlement every deposit or redemption is queued.                                                                                                                                                                                                                                                                                                                                                                                                                                                         | vault agent or keeper |
| `proposeSeries(vault, strike, expiry, size, premiumBps)`          | Checks the proposal with `MandateGuard` against the opening snapshot (spot and sigma) and Black-Scholes fair value, so a sigma update or a new print after `openEpoch` cannot change the verdict. The live feed must still be healthy (otherwise the call reverts). Pass: creates the series, state Selling, unless live spot has crossed the strike since the snapshot, in which case it reverts with `StrikeInTheMoney(strike, spot)` (no slash, nothing sold in the money). Fail: emits `ProposalRejected(reason)`, slashes the agent's bond to the vault's depositors and adds a strike. It does not revert, so the slash sticks. `previewProposal` gives the same verdict while the epoch is Open.                       | vault agent's signer  |
| `proposeByDelta(vault, targetDeltaBps, expiry, size, premiumBps)` | Solves the strike for the target delta (Stylus pricer) from the snapshot's spot and sigma and the tenor at execution, rounds it to a whole cent toward the middle of the mandate's delta band (target in the upper half of the band: calls round up, puts down; lower half: the opposite), then runs `proposeSeries`. A target inside the band, on the edges included, is never slashed for its delta. The SDK's `roundStrikeToCent` reproduces the rounding.                                                                                                                                                                                                                                                                 | vault agent's signer  |
| `buy(seriesId, amount, maxPremium, to)`                           | Requires Selling, not paused, market open, feed safe, before sale end. Premium per option = `max(fair × premiumBps, intrinsic)`, where fair value (current sigma) and intrinsic value use spot moved against the buyer by the token's `spotBufferBps` (calls: `S × (1 + b)`, puts: `S × (1 − b)`). The price is oracle-anchored, not fixed, so a moving spot cannot be arbitraged against a stale quote, and the buffer covers the lag between the market and the last feed print. Collateral for the new options is locked; the premium is escrowed in the manager until settlement. Mints ERC-1155.                                                                                                                         | anyone                |
| `settle(vault, roundId)`                                          | After expiry. Uses the price `StockOracle` has recorded for (token, expiry); if none is recorded yet, it records it from `roundId`, the first feed round at or after expiry, which the contract verifies (SafeStockFeed rule 10). When one round is not enough (round 1 of a new Chainlink phase, or a print inside a corporate-action window), anyone first calls `StockOracle.recordSettlementPriceWithHints(token, expiry, hints)`; `settle` then uses the recorded price and ignores `roundId`. Computes the payout, moves it from the vault to the manager for option holders, pays the performance fee, sends the net premium to the vault, processes the queue, unlocks. With nothing sold it settles without a price. | anyone                |
| `redeem(seriesId, amount, to)`                                    | After settlement: burns options and pays `amount × payoutPerOption` (pull payment).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | option holder         |
| `abortEpoch(vault)`                                               | Open state, no proposal after `proposalTimeout`: unlock and process the queue.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | anyone                |
| `emergencyCancel(vault)`                                          | Selling, `expiry + settlementGrace` passed, still unsettled (feed dead). Reverts with `SettlementAvailable(price)` if the oracle has a settlement price for (token, expiry): then `settle` works and must be used. Collateral goes back to the vault; buyers redeem their premium instead of a payout.                                                                                                                                                                                                                                                                                                                                                                                                                        | guardian              |

Expiry must be 16:00 New York time on an NYSE trading day, inside the vault's tenor limits. Sales stop `saleCutoff` before expiry.

## 4. Settlement formulas

Let `S` be the settlement price and `K` the strike (both WAD, per raw token), `n` the options sold (underlying base units), `u = 10^underlyingDecimals`.

**Call (covered, physically backed, cash-settled in the stock token)**

```
payoutPerOption (fraction of one token, WAD) = S > K ? (S − K) × 1e18 / S : 0      (rounded down)
payout (underlying base units)               = n × payoutPerOption / 1e18          (rounded down)
```

A holder of `a` options receives `a × payoutPerOption / 1e18` tokens, worth `a/u × (S − K)` dollars at `S`. Collateral locked is `n` tokens, and `(S − K)/S < 1`, so **payout < collateral always**.

**Put (cash-secured, settled in USDG)**

```
payoutPerOption (USDG per option, WAD USD) = K > S ? K − S : 0
payout (USDG base units) = n × payoutPerOption / u, converted WAD→USDG, rounded down
collateral locked        = n × K / u,              converted WAD→USDG, rounded up
```

Since `K − S ≤ K`, **payout ≤ collateral always**, even if `S = 0`.

**Premium and fee.** Premiums are held in the manager during the epoch. At settlement:

```
payoutValue (USDG) = call: payout × S converted to USDG ;  put: payout
pnl                = premium − payoutValue
fee                = pnl > 0 ? pnl × perfFeeBps / 10_000 : 0
agentFee           = fee × agentShareBps / 10_000        → agent's payout address
treasuryFee        = fee − agentFee                      → treasury
toDepositors       = premium − fee                       → vault premium accumulator
```

Depositors receive premium in USDG through a per-share accumulator (claimable at any time), in both vault types. The asset side (collateral) compounds or shrinks only with settlement payouts.

## 5. Vault accounting

- `totalAssets()` is internal accounting (`managedAssets`), never `balanceOf`, so donations cannot move the share price.
- Queued deposits (`requestDeposit`) are held outside `managedAssets` until the epoch settles; queued redemptions (`requestRedeem`) escrow shares in the vault.
- At settlement, in this order:
  1. payout leaves `managedAssets`;
  2. net premium is distributed over the current supply (escrowed redeem shares included, because they carried that epoch's risk);
  3. the price per share `(assets, supply)` is snapshotted for the epoch;
  4. escrowed redeem shares are burned and their assets moved to `reservedRedeemAssets`;
  5. queued deposits mint shares to the vault for their owners to claim;
  6. the vault unlocks.
- Claims are lazy: `claimDeposit` / `claimRedeem` use the snapshot of the epoch the request belonged to. A deposit claim also credits the premium those shares earned while held by the vault; a redeem claim adds the premium of the epoch it exited in.
- All conversions round in the vault's favour (OpenZeppelin `Math.mulDiv` with `Rounding.Floor` on the way out).
- **For integrators:** while an epoch runs, `totalAssets()` and `convertToAssets` ignore the open series. They do not subtract what the vault may owe option holders (a deep in-the-money call can already owe a large share of the collateral) and do not include the premium escrowed in the manager. Shares stay transferable while the vault is locked, so do not price them with `convertToAssets` alone during an epoch. To mark the open series, read `getSeries(seriesId)` on the `EpochManager` (`collateral` is what is locked, `sold` the options outstanding) and use `quoteBuy(seriesId, sold)` as an estimate of the liability's value.

## 6. Invariants

These are the Foundry invariant suite (`contracts/test/invariant/`). Each must hold after any sequence of calls.

1. **Collateral covers payouts.** For every live series: `lockedCollateral ≥ maxPayout(sold)` (call: `sold`; put: `sold × K`), and `lockedCollateral ≤ managedAssets`.
2. **Share accounting.** `convertToAssets(totalSupply) ≤ totalAssets ≤ convertToAssets(totalSupply) + 1` (rounding only).
3. **No leakage while locked.** While a vault is locked, `managedAssets` changes only inside `settle`, and the asset balance of the vault is at least `managedAssets + pendingDeposits + reservedRedeemAssets` (+ premium owed, for put vaults).
4. **Single settlement.** A series settles at most once; `settled` never flips back; the settlement price for a (feed, expiry) pair never changes once set.
5. **Solvency to option holders.** Manager balance of each payout token ≥ Σ unredeemed payouts (and refundable premiums).
6. **Premium solvency.** Vault USDG balance ≥ Σ claimable and accrued premium of all holders.
7. **Rounding never lowers share price.** Deposits and withdrawals alone never decrease `totalAssets / totalSupply`.

## 7. SafeStockFeed rules

Every read returns a WAD price per raw token or reverts with a named error. There is also a non-reverting `status()` for the app and agents.

| #   | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Error                                                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 1   | Answer must be positive                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `InvalidPrice(answer)`                                                            |
| 2   | `updatedAt` must not be in the future                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `InvalidPrice`                                                                    |
| 3   | `block.timestamp − updatedAt ≤ maxPriceAge` (latest reads)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `StalePrice(updatedAt, maxAge)`                                                   |
| 4   | Token not paused                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `TokenPaused(token)`                                                              |
| 5   | Oracle side not paused                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `FeedPaused(token)`                                                               |
| 6   | No corporate action in progress (latest reads): if a new `uiMultiplier` is scheduled, block until `effectiveAt + corporateActionGrace`. Settlement: see rule 10                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `CorporateActionPending(effectiveAt)`                                             |
| 7   | Price used as-is: never multiplied by `uiMultiplier`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | (by construction; fork test proves feed × raw balance = UI balance × share price) |
| 8   | Decimals normalised once from `feed.decimals()` to WAD                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | (by construction)                                                                 |
| 9   | Market-hours gate for opening and selling (`MarketCalendar.isMarketOpen`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `MarketClosed(timestamp)`                                                         |
| 10  | Settlement uses the **first** round with `updatedAt ≥ expiry`, proven by hints. `hints[0]`: `updatedAt ≥ expiry` and, inside a phase, `round(hints[0] − 1).updatedAt < expiry`. Round ids are `phase << 64 \| aggregatorRound`: for round 1 of phase p > 1 the next hint must be the last round of phase p − 1, which predates expiry and has no successor. Round 1 of the first phase has no predecessor and must be within `maxPriceAge` of expiry. If the chosen print is within `corporateActionGrace` of the token's ERC-8056 `effectiveAt`, the target moves to `effectiveAt + grace` and the remaining hints prove the first round at or after it, by the same rules | `InvalidSettlementRound(roundId)`, `MissingHint(index)`                           |
| 11  | Optional L2 sequencer-uptime feed: sequencer up and past its grace period                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `SequencerDown()`                                                                 |

## 8. Mandate

Set once at vault creation and immutable, so depositors know exactly what the agent may do. `MandateGuard.validate` rejects a mandate (`InvalidMandate`) outside the protocol limits: `minDeltaBps ≤ maxDeltaBps ≤ 10,000`, `0 < maxShareSoldBps ≤ 10,000`, `9,000 ≤ minPremiumBps ≤ 30,000`, `minYieldBps ≤ 10,000`, `0 < minTenor ≤ maxTenor ≤ 35 days`. The premium floor stops a curator from letting its own agent buy the vault's options for nothing.

Proposals are checked against the spot and sigma snapshotted at `openEpoch`; tenor is measured from the proposal's block.

| Field                        | Meaning                                                                                      | Rejection reason   |
| ---------------------------- | -------------------------------------------------------------------------------------------- | ------------------ |
| `minDeltaBps`, `maxDeltaBps` | Absolute Black-Scholes delta band (opening snapshot, tenor at proposal)                      | `DeltaOutOfBand`   |
| `minPremiumBps`              | `premiumBps` (price as % of fair value) must be at least this                                | `PremiumBelowFair` |
| `minYieldBps`                | Premium per option / collateral per option at proposal ≥ this (no selling worthless strikes) | `PremiumTooSmall`  |
| `maxShareSoldBps`            | `size ≤ capacity × maxShareSoldBps`                                                          | `SizeTooLarge`     |
| `minTenor`, `maxTenor`       | `expiry − now` within limits                                                                 | `TenorOutOfRange`  |
| —                            | Expiry must be an NYSE close                                                                 | `InvalidExpiry`    |
| —                            | Call strike above snapshot spot, put strike below it (out of the money)                      | `StrikeWrongSide`  |
| —                            | Premium factor at most 30,000 (3× fair value)                                                | `PremiumAboveCap`  |
| —                            | Size nonzero                                                                                 | `ZeroSize`         |

A proposal that passes these checks but whose strike live spot has crossed since the snapshot reverts with `StrikeInTheMoney`; it is not a rejection and nobody is slashed.

## 9. Agents

- Agents register with a signer, a payout address and optionally an ERC-8004 identity (verified with `ownerOf`). Reputation feedback (rejections and epoch PnL) is posted to ERC-8004 only while the agent's owner still holds that identity; after a transfer it is skipped (`ReputationFeedback` emits `posted = false`).
- An agent is **active** only with bond ≥ `minBond`, status Active and strikes < `maxStrikes`.
- A rejected proposal slashes `slashAmount` (capped at the bond) to the vault's depositors and adds a strike. Reaching `maxStrikes` suspends the agent.
- Unbonding takes `unbondDelay` (longer than an epoch), so an agent cannot misbehave and withdraw in the same week.
- Agents never touch vault funds; the worst a compromised agent key can do is propose within the mandate or burn its own bond. The curator can switch the vault's agent at any time; admins can suspend an agent globally.

## 10. Failure modes

| Situation                                | Behaviour                                                                                                                                                                                                                                                   |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Weekend or holiday at expiry             | `settle` waits for the first print after expiry (Monday open)                                                                                                                                                                                               |
| Chainlink aggregator upgrade (new phase) | Settlement still uses the first print at or after expiry, in whichever phase it is. Round 1 of a new phase needs the old phase's last round as a hint (`recordSettlementPriceWithHints`); the SDK finds it                                                  |
| Feed stale or paused at settlement time  | `settle` reverts; anyone retries later. Settlement is idempotent                                                                                                                                                                                            |
| Token paused                             | Selling and settlement wait; idle (unlocked) withdrawals still work                                                                                                                                                                                         |
| Split or dividend mid-epoch              | Strikes are per raw token, so nothing to adjust. Sales pause until `effectiveAt` + grace. If the first print after expiry is within grace of `effectiveAt`, settlement uses the first print at or after `effectiveAt + grace` instead (recorded with hints) |
| Feed dead after expiry                   | After `settlementGrace` the guardian can cancel: collateral back to the vault, premium back to buyers. Not possible once a settlement price is recorded (`SettlementAvailable`)                                                                             |
| No proposal                              | Anyone aborts after `proposalTimeout`                                                                                                                                                                                                                       |
| Nobody buys                              | Settles without a price                                                                                                                                                                                                                                     |
| Sequencer filtering / failed tx          | Anyone can call `settle` again                                                                                                                                                                                                                              |
