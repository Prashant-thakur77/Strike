# Idle put collateral in Pendle PT

Status: **prototype, fork-tested, not deployed.** Nothing here changes a deployed contract. Decision record: [D47](../decisions.md).

A cash-secured-put vault holds USDG that, today, earns nothing while it waits ([Against USDG lending](../../README.md#against-usdg-lending)). This note designs a way to put the part of that USDG that no series can need into Pendle's principal token for USDG (PT-USDG), which is bought at a discount and redeems one for one at maturity. The part a series could need stays liquid USDG at all times. A prototype, [`PendleCollateralAdapter`](../../contracts/src/yield/PendleCollateralAdapter.sol), runs against the real Pendle market in fork tests.

## Contents

- [Research](#research)
- [What counts as idle](#what-counts-as-idle)
- [Hard rules](#hard-rules)
- [Maturity, price and the oracle](#maturity-price-and-the-oracle)
- [Risk analysis](#risk-analysis)
- [How the agent fits](#how-the-agent-fits)
- [Alternatives considered](#alternatives-considered)
- [The prototype](#the-prototype)
- [What it would take to ship](#what-it-would-take-to-ship)
- [Sources](#sources)

## Research

### Pendle V2 in one paragraph

Pendle wraps a yield-bearing token in a standardized yield token (SY) and splits it into a principal token (PT) and a yield token (YT) with a fixed maturity. PT redeems for one unit of the SY's asset at maturity; before that it trades below par on a Pendle market (an AMM between PT and SY), so buying PT locks a fixed rate. The router (`swapExactTokenForPt`, `swapExactPtForToken`, `redeemPyToToken`) does the wrapping and the trade in one call. `PendlePYLpOracle.getPtToAssetRate(market, duration)` gives PT's price in the asset as a time-weighted average of the market's implied rate.

### The PT-USDG market

The README's "3.45% fixed (2026-10-01)" is the date it was read, not the maturity. The market is on **Robinhood Chain mainnet (4663)**, the chain Strike's mainnet vault is planned for, and matures on 25 March 2027. Pendle's API lists it with the real USDG as its underlying, and every address below was read back from chain.

| Item                                          | Value                                                                                                                      |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Market (PT/SY AMM)                            | `0xC2B89e6EcA583e2c232201ac557E9bE58AF55f4c`                                                                               |
| PT ("PT Global Dollar 25MAR2027", 6 decimals) | `0x6982E39521a070A3C40782548bfBED6dc8F566EF`                                                                               |
| YT                                            | `0xF35Ee6bd9A93fE42BC7e628BFC4DDbdc6DE1f615`                                                                               |
| SY ("SY Global Dollar")                       | `0x8d3127aAbf76F95fE2970A0480B8662B4ad4C286`; `assetInfo()` = (0, USDG, 6); `exchangeRate()` = 1e18, so one SY is one USDG |
| USDG                                          | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (the same address as Strike's mainnet fork tests)                             |
| Router V4                                     | `0x888888888889758F76e7103c6CbF23ABbF58F946`                                                                               |
| PT/YT/LP oracle                               | `0x5542be50420E88dd7D5B4a3D488FA6ED82F6DAc2`                                                                               |
| Expiry                                        | 1805932800 (2027-03-25 00:00 UTC)                                                                                          |

Read with `cast call` on `https://rpc.mainnet.chain.robinhood.com` at block 79241832 (2026-10-03 16:55 UTC):

- `_storage()`: 14,696.62 PT and 42,648.67 SY in the pool; `lastLnImpliedRate` 0.0322367, which is a 3.28% implied APY; observation index 0, **cardinality 1, cardinality next 1**.
- `getPtToAssetRate(market, 900)` = 0.984898, so a PT costs 98.49 cents and matures at 100 (172 days to go).
- `getOracleState(market, 900)` = (**increaseCardinalityRequired true**, cardinalityRequired 901, oldestObservationSatisfied true).
- The SY holds 57,455.68 USDG; PT supply is 14,806.48.

The Pendle API showed $57,132 of liquidity and a 3.28% implied APY the same afternoon ($51k and 3.45% on 1 October, [research.md](../research.md)). It is a small pool: a vault could place tens of thousands of USDG in it, not millions.

**Arbitrum One.** Pendle's active markets on 42161 (same API, 3 October) are USDai and sUSDai only, a different dollar token with points programmes attached. There is no USDG or USDC market there that a USDG vault could use without a swap, so the design targets the 4663 market.

### Boros

Boros is Pendle's margin platform for trading funding rates (BTC and ETH perpetual funding on Binance at launch, on Arbitrum), through "Yield Units". It is not a place for idle collateral: positions are margined and can be liquidated below maintenance margin, the exposure is to crypto perpetual funding with no link to stock options, and it does not take USDG on Robinhood Chain. Putting settlement collateral into a liquidatable rate swap would break the first rule below. Not used.

## What counts as idle

The task suggested queued deposits and collateral not locked by a live series. Reading [`StrikeVault`](../../contracts/src/vaults/StrikeVault.sol) and [`EpochManager`](../../contracts/src/core/EpochManager.sol) narrows that:

| Pot of USDG                                                    | Idle?   | Why                                                                                                                                                |
| -------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Queued deposits (`pendingDepositAssets`)                       | **No**  | `cancelDepositRequest` pays them back at once, at any time; they are not collateral until settlement                                               |
| Processed redemptions not yet claimed (`reservedRedeemAssets`) | **No**  | `claimRedeem` pays at any time                                                                                                                     |
| Premium (escrowed in EpochManager, then `_premiumOwed`)        | **No**  | Not the vault's collateral; refunded on a cancel, claimable after settlement                                                                       |
| Managed collateral up to the mandate's share                   | **No**  | Any series may lock up to `maxShareSoldBps` of capacity (`MandateGuard.check`), and the next epoch can open the moment this one settles            |
| Managed collateral above that share, minus a buffer            | **Yes** | No series can ever lock it: `maxShareSoldBps` is fixed when the vault is created. With a 60% share and a 5% buffer, 35% of the collateral can earn |

During a live series the worst case is every option still for sale exercised at a price of zero: `size × strike`, which bounds a put's payout. [`StrikePutReserve`](../../contracts/src/yield/StrikePutReserve.sol) computes the larger of that and the mandate share from the deployed EpochManager's own views (`epochs`, `getSeries`, `underlyings`, `vaultConfig`) without any change to it. A vault with `maxShareSoldBps = 10000`, like today's testnet vaults, has nothing idle by this definition, which is the correct answer: its agent may sell against all of it.

## Hard rules

Each rule is enforced in the adapter's code, not by the agent, and each has a test.

| Rule                                                                                                    | Where                                                                                                                                                             | Test                                                                                                 |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Never jeopardise a settlement: after any allocation, liquid USDG ≥ reserve worst case + buffer          | `allocate` reverts `ReserveBreached`; `requiredLiquidity()` = `reserve.requiredLiquidity(totalAssets) + bufferBps`                                                | `testFuzz_allocate_neverLeavesTheReserveShort` (5,000 runs in CI), `test_fork_liquidityReserveHolds` |
| The vault can always take liquid USDG out, and always sell PT at its own limit                          | `withdraw` and `deallocate` by `owner` ignore `enabled` and the oracle                                                                                            | `test_withdraw_worksWhileDisabled`, `test_deallocate_ownerSetsItsOwnLimitWithoutTheOracle`           |
| Maturity: no PT that matures later than `maxTimeToMaturity` (immutable)                                 | `allocate` reverts `MaturityTooFar`                                                                                                                               | `test_allocate_revertsWhenMaturityIsTooFar`                                                          |
| Curator on/off; starts off, with a cap of 0                                                             | `setEnabled`, `setLimits` (curator only); `allocate` reverts `Disabled`                                                                                           | `test_constructor_startsDisabledWithNoCap`, `test_allocate_revertsWhenDisabled`                      |
| Caps: the position under the curator's `cap`, the cap under an immutable `hardCap`; slippage at most 3% | `CapExceeded`, `LimitTooHigh`                                                                                                                                     | `test_allocate_revertsAboveTheCap`, `test_setLimits_boundsAndEvent`                                  |
| Prices against the oracle: buys and the agent's or curator's sales within `maxSlippageBps` of the TWAP  | `SlippageBoundTooLoose`; Pendle's router enforces the same minimum, and the adapter re-checks the amount the router returns (`OutputTooLow`) under `nonReentrant` | `test_fork_earlyExitWithASlippageBound`, `test_allocate_checksTheOutputItself`                       |
| No trading on an oracle that cannot answer                                                              | `allocate` and the agent's sales revert `OracleNotReady` unless `getOracleState` is satisfied                                                                     | `test_fork_refusesToBuyUntilTheOracleIsReady` (the live market today)                                |
| After maturity anyone can turn PT back into USDG at par                                                 | `redeemMatured` (permissionless)                                                                                                                                  | `test_fork_buyValueAndRedeemAtMaturity`                                                              |

The choice of `maxTimeToMaturity` is the curator's at deployment. "Maturity within the next N epochs" (for example 28 days) is the safest setting, since the PT is then always close to par, but the only USDG market today matures in 25 weeks, so a 28-day limit would mean no allocation until late February 2027. The prototype allows either: a short limit, or a long one with the reserve and buffer doing the work, which is what the fork tests use (200 days).

## Maturity, price and the oracle

**Fixed rate, held to maturity.** Bought at 0.9849 with 172 days left, PT pays 3.28% a year if held. In the fork test 5,000 USDG bought 5,060.80 PT, 0.31% fewer than the oracle price implies (price impact and the market's swap fee); held to maturity that returned 5,060.79 USDG, **+60.79 USDG** (1.22% in 172 days, about 2.6% a year after the entry cost).

**The mismatch with weekly epochs.** A vault settles weekly; this PT matures in 25 weeks. The design never needs PT to settle a series: the reserve keeps every possible payout in USDG. PT is sold early only to pay redemptions above the buffer, or when the curator winds down. Before maturity the position is marked at the oracle, never above par, and from maturity at par.

**Selling early.** The round trip in a day cost **16.83 USDG on 5,000 (0.34%)** in the fork test, two trades' price impact and fees against a day's accrual. The pool holds about $57k, so size is the main risk: the curator's cap should stay a small share of the pool (the prototype's fork tests use a 10k cap). In a stressed market the discount can widen; the vault's own sale accepts its own limit, so it can always raise cash, at a cost.

**Who pays the exit cost.** In an integrated vault, a redemption that needs PT sold should bear the realised loss against the mark (an exit charge equal to the slippage), so the depositors who stay are not diluted. This is a core change, listed below.

**The oracle.** `getPtToAssetRate(market, 900)` is a 15-minute TWAP of the implied rate, so one trade, including our own, barely moves it (the fork test checks the mark within 0.05% right after a 5,000 buy). The live market keeps **one** observation, so a 900-second TWAP is not available as it stands: right after any trade the oracle reverts until 15 minutes pass. The fix is Pendle's permissionless `increaseObservationsCardinalityNext(901)`, about 20 million gas once (`test_fork_realCardinalityCall` runs it). The adapter refuses to trade until `getOracleState` says the market is ready, and once it is, cardinality never shrinks. The fork tests raise the field in storage instead of paying for 900 slots, which needs 900 RPC round trips on a fork; the contract notes say so.

## Risk analysis

| Risk                       | What could happen                                    | Mitigation in this design                                                                                                                        | Left over                                                                                                                 |
| -------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Settlement short of USDG   | A payout due while the money sits in PT              | The reserve keeps `max(size × strike, maxShareSoldBps × collateral)` liquid, plus a buffer, checked after every allocation                       | A redemption can drain liquid USDG below the rule; `shortfall()` says how much PT to sell, and the vault can sell at once |
| PT liquidity               | A thin pool: selling early costs more than the yield | Cap well under the pool's size; the agent's sales are bounded at 1% (curator may set up to 3%); hold to maturity is the default                  | In stress the vault may sell at a deep discount to pay redemptions, or wait for maturity                                  |
| PT price falls             | Rates rise and the PT's price drops before maturity  | Marked at the TWAP, never above par; the reserve is recomputed on the lower mark; the loss reverses by maturity if held                          | Share price can dip during the term                                                                                       |
| Oracle                     | Manipulated or unavailable price                     | 900 s TWAP minimum (constructor), readiness check before any trade, vault sales skip the oracle                                                  | If the oracle reverts, `totalAssets()` reverts while PT is held, which an integrated vault must handle (see core changes) |
| Pendle smart contract risk | A bug in the router, market, SY or YT                | Only the idle share is exposed; the cap bounds it; Pendle V2's contracts are audited and run on several chains                                   | A total loss of the PT position is possible; it can never reach the reserve                                               |
| SY or USDG risk            | The SY's USDG backing, or a USDG freeze              | SY Global Dollar is a plain one-for-one USDG wrapper (`exchangeRate` 1e18, 57,455 USDG held); USDG risk exists for the vault anyway              | Paxos can freeze an address; that is already true of the vault                                                            |
| Adapter bug                | A flaw in the new code                               | 52 unit tests with Pendle stand-ins, 7 reserve tests on the real EpochManager, 7 fork tests on the real market; small surface, no upgradeability | Unaudited; part of the audit scope below                                                                                  |
| Market rollover            | At maturity there may be no next USDG market         | `redeemMatured` returns everything to USDG; the adapter is one market per deployment                                                             | A new market needs a new adapter and a curator decision                                                                   |

### Effect on the mandate and the trust model

- The **option mandate is unchanged**: strikes, deltas, tenors and size limits are checked by `MandateGuard` as today, and the reserve is derived from that mandate rather than added to it.
- The **collateral** is no longer only USDG. Depositors take Pendle and PT-liquidity risk on the idle share, so the vault's page must show the PT position, its mark, the oracle and the cap, and a vault with the adapter off must be the default. The curator, not the protocol admin, turns it on, as with the mandate.
- The **trust model** gains a party (Pendle) and a role (the allocator). No new admin power over funds: the curator can lower limits and switch it off; only the vault can withdraw; the allocator can move USDG only into PT and back, inside the bounds. The [trust model](../trust-model.md) would get a row for Pendle when this ships.

## How the agent fits

The same split as strikes: the agent proposes, the contract enforces. A **collateral specialist** joins the example agent's pipeline ([D45](../decisions.md)), after settlement and before the next proposal:

1. Read `allocatable()`, `shortfall()`, `ptRate()`, `oracleReady()`, the cap and the time to maturity from the adapter, and the vault's mandate share from `StrikePutReserve`.
2. Compare the PT's implied rate (from the oracle rate and the time to maturity) with the alternatives it can see (the Morpho USDG rate, leaving it idle) and the expected round-trip cost at the planned size; propose an amount, or nothing.
3. The critic applies its rules (P0: oracle ready and the market open; P1: within `allocatable()`; a new rule for size against pool liquidity) and records PASS, MODIFY or FAIL.
4. The contract is the last stage: `allocate` reverts on any broken rule, exactly as `MandateGuard` rejects a strike.

Each run writes a decision record with the inputs and is anchored in `DecisionLog` like a proposal. One difference from strikes: a rejected allocation simply reverts, with no bond slashed. Slashing the agent for an out-of-bounds allocation would need the adapter to record and punish instead of reverting; it is listed as a possible core change, not built.

## Alternatives considered

| Option                                                                                            | For                                                                                                     | Against                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Pendle PT-USDG** (this design)                                                                  | Fixed rate known at entry (3.28% on 3 October); on the same chain; par at maturity whatever rates do    | 25-week maturity against weekly epochs; a $57k pool; exit costs 0.3% or more; an extra oracle                                                                         |
| ERC-4626 USDG lending vault (already in [MILESTONES.md](../MILESTONES.md#later-not-in-this-plan)) | Withdraw any time at par if the lender has liquidity; no maturity; same ERC-4626 interface as the vault | Variable rate (about 1.9% on Morpho in July); withdrawals depend on the lender's utilisation; needs a USDG lending market on 4663                                     |
| Aave                                                                                              | Large lending pools with a long record                                                                  | Our research lists no Aave deployment on Robinhood Chain; bridging USDG to another chain adds bridge risk and moves collateral off the chain where the options settle |
| Leave it idle                                                                                     | No added risk; simplest for depositors to understand                                                    | Earns nothing: the put vault returned less than lending USDG on most tickers in the backtest ([backtest.md](../backtest.md))                                          |

The two yield options are not exclusive: the adapter's interface (`liquidAssets`, `totalAssets`, a reserve, curator caps) fits an ERC-4626 lending sleeve as well, and a vault could split its idle share between them.

## The prototype

Files, none deployed:

- [`contracts/src/yield/PendleCollateralAdapter.sol`](../../contracts/src/yield/PendleCollateralAdapter.sol): the sleeve. Vault side `deposit`, `withdraw`; agent side `allocate(usdgIn, minPtOut)`, `deallocate(ptIn, minUsdgOut)`; anyone `redeemMatured()`; curator `setEnabled`, `setLimits(cap, bufferBps, maxSlippageBps)`, `setAllocator`; views `liquidAssets`, `ptValue`, `totalAssets`, `requiredLiquidity`, `allocatable`, `shortfall`, `ptRate`, `oracleReady`.
- [`contracts/src/yield/StrikePutReserve.sol`](../../contracts/src/yield/StrikePutReserve.sol): the worst case from the deployed EpochManager's views.
- [`contracts/src/yield/ILiquidityReserve.sol`](../../contracts/src/yield/ILiquidityReserve.sol), [`IPendle.sol`](../../contracts/src/yield/IPendle.sol): interfaces, with Pendle's structs as published.
- Tests: [`test/unit/PendleCollateralAdapter.t.sol`](../../contracts/test/unit/PendleCollateralAdapter.t.sol) (52, against Pendle stand-ins in [`test/mocks/MockPendle.sol`](../../contracts/test/mocks/MockPendle.sol)), [`test/unit/StrikePutReserve.t.sol`](../../contracts/test/unit/StrikePutReserve.t.sol) (7, on the real EpochManager through a whole epoch), [`test/fork/PendleCollateralFork.t.sol`](../../contracts/test/fork/PendleCollateralFork.t.sol) (7, on the real market).

Fork run on 3 October 2026 against the latest block:

```
ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com forge test --match-path "test/fork/PendleCollateral*" -vv
[PASS] testFuzz_fork_allocateAndExit(uint256) (runs: 8)
[PASS] test_fork_buyValueAndRedeemAtMaturity()        USDG earned on 5,000 held to maturity: 60.791787
[PASS] test_fork_earlyExitWithASlippageBound()        round-trip cost on 5,000: 16.832397
[PASS] test_fork_liquidityReserveHolds()
[PASS] test_fork_marketIsPtUsdg()                     oracle rate 0.984899; simple implied APY 3.24%
[PASS] test_fork_refusesToBuyUntilTheOracleIsReady()
[SKIP] test_fork_realCardinalityCall()                opt-in: PENDLE_FORK_SLOW=true
6 passed; 1 skipped; 34 s
```

`PENDLE_FORK_SLOW=true` runs the real `increaseObservationsCardinalityNext(901)` and then a buy and a valuation; it passed on 3 October (20,515,116 gas, 370 s, almost all of it fetching the 900 slots over RPC). The fork tests sit in `test/fork`, so CI's existing fork job (Robinhood Chain mainnet, with its retry and second-RPC fallback) runs them with the rest; they add about 35 seconds.

## What it would take to ship

**Core changes (a new vault version, not the deployed one):**

1. `StrikeVault` holds its managed USDG through the adapter: `totalAssets()` = the adapter's `totalAssets()`; deposits processed at settlement go in; `settleEpoch` pulls the payout with `withdraw` before paying the EpochManager. Queued deposits, reserved redemptions and premium stay in the vault.
2. Redemptions: pay from liquid USDG first; above that, sell PT through `deallocate` and charge the redeemer the realised loss against the mark.
3. Views must not revert if the oracle cannot answer while PT is held: fall back to a conservative mark (for example the last good rate less a haircut) for share pricing, and block deposits and redemptions that need the mark until it answers.
4. `EpochManager` is unchanged: `buy` checks collateral against `totalAssets()`, which would include the PT at its mark, while the reserve keeps the series' worst case in USDG. A vault factory option sets the adapter and its immutable limits at creation.
5. Optional: record and slash a rejected allocation instead of reverting, so the agent's bond backs collateral decisions too.

**Before mainnet:** call `increaseObservationsCardinalityNext(901)` on the market (once, about 20M gas); set the cap well under the pool's liquidity; monitor `shortfall()` in the keeper; add Pendle to the trust model and the threat model.

**Audit scope:** `PendleCollateralAdapter` (346 lines with comments), `StrikePutReserve` (58), the vault changes above, and the integration points with Pendle's router and oracle (struct encoding, approvals, the rounding of PT valuation, the readiness check). Pendle's own contracts are out of scope and treated as a dependency.

## Sources

- Pendle API, active markets: [chain 4663](https://api-v2.pendle.finance/core/v1/4663/markets/active), [chain 42161](https://api-v2.pendle.finance/core/v1/42161/markets/active) (read 2026-10-03).
- Pendle deployment addresses for 4663: [`deployments/4663-core.json`](https://github.com/pendle-finance/pendle-core-v2-public/blob/main/deployments/4663-core.json) (router, `pyYtLpOracle`).
- Pendle oracle source: [`PendlePYLpOracle.sol`](https://github.com/pendle-finance/pendle-core-v2-public/blob/main/contracts/oracles/PtYtLpOracle/PendlePYLpOracle.sol) (`getOracleState`, cardinality required for a duration).
- Pendle documentation: [docs.pendle.finance](https://docs.pendle.finance/) (PT, YT, SY, router, oracle integration).
- Boros: [Pendle Boros docs](https://docs.pendle.finance/boros-docs/Introduction), [launch on Arbitrum](https://financefeeds.com/pendle-launches-boros-on-arbitrum-unlocking-on-chain-trading-for-funding-rate-exposure/).
- On-chain reads: the `cast call` commands above, at block 79241832 on Robinhood Chain mainnet.
