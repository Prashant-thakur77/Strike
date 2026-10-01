# SafeStockFeed: safe stock-token prices for any Robinhood Chain protocol

Lending markets, perps, index products and payments on Robinhood Chain all read stock-token prices, and they all hit the same traps. `SafeStockFeed` is a small MIT-licensed Solidity library that handles them in one call, and `StockOracle` is a deployed contract built on it that other protocols can call directly.

## What it checks

| Check                                                | Error                                            | Why it matters                                                                                                    |
| ---------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Positive answer, not from the future                 | `InvalidPrice(answer)`                           | Broken or manipulated rounds                                                                                      |
| Age under `maxPriceAge`                              | `StalePrice(updatedAt, maxAge)`                  | Feeds freeze on weekends and holidays; the mainnet stock feeds have a 24 h heartbeat and 0.5% deviation threshold |
| Token not paused (`paused()`)                        | `TokenPaused(token)`                             | The issuer can pause transfers                                                                                    |
| Oracle side not paused (`oraclePaused()`)            | `FeedPaused(token)`                              | The second pause layer. Read defensively: testnet tokens do not implement it                                      |
| No ERC-8056 multiplier change in progress            | `CorporateActionPending(token, effectiveAt)`     | Around a split or dividend, the feed and the multiplier can briefly disagree                                      |
| L2 sequencer up and past its grace period (optional) | `SequencerDown()`, `SequencerGracePeriod(since)` | Standard Chainlink L2 guard                                                                                       |
| Decimals normalised to 18                            | none                                             | One unit everywhere                                                                                               |

It never multiplies the feed price by `uiMultiplier`. The Chainlink stock feeds already price one raw token including the multiplier; applying it again overprices the token (NVDA's live multiplier is 1.000775). The fork test `test_fork_multiplierIsNotAppliedTwice` proves this against chain 4663.

## Use it in your project

### 1. Install

```sh
forge install Prashant-thakur77/Strike
```

This clones the repo into `lib/Strike`. The library needs nothing else: `SafeStockFeed` and the two interfaces it imports (`IAggregatorV3`, `IStockToken`) have no dependencies. Only `StockOracle` and `MarketCalendar` need OpenZeppelin, which comes in as Strike's own submodule.

### 2. Add one remapping

```text
# remappings.txt
@strike/=lib/Strike/contracts/src/
```

`@strike/` points at Strike's own `contracts/src`, the files the deployed contracts are built from. There is no packaged copy that could drift from them ([decisions.md D32](decisions.md)). Without the line, Foundry's auto-remapping exposes the same files as `Strike/src/...`.

The files pin `pragma solidity 0.8.30;`, the compiler the deployment was verified with. Contracts that import them compile with 0.8.30 too: set `solc_version = "0.8.30"` or leave Foundry's auto-detection on (a `^0.8.20` pragma works).

Prefer to vendor it? Copy three files and keep their relative layout, since the library imports `../interfaces/...`: `contracts/src/libraries/SafeStockFeed.sol`, `contracts/src/interfaces/IAggregatorV3.sol` and `contracts/src/interfaces/IStockToken.sol` (for example to `src/strike/libraries/` and `src/strike/interfaces/`). Note the commit you copied, and do not edit them. Your own linter will then flag the library's `block.timestamp` comparisons, which are intended.

### 3. Read a price

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IAggregatorV3} from "@strike/interfaces/IAggregatorV3.sol";
import {SafeStockFeed} from "@strike/libraries/SafeStockFeed.sol";

contract NvdaCollateral {
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC; // Robinhood Chain 4663
    IAggregatorV3 constant NVDA_USD = IAggregatorV3(0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15); // Chainlink

    /// USD value (18 decimals) of `raw` NVDA: raw balance × feed price, never × uiMultiplier.
    function valueOf(uint256 raw) external view returns (uint256) {
        SafeStockFeed.Config memory c = SafeStockFeed.Config(NVDA_USD, 25 hours, 1 days, 8);
        (uint256 priceWad,) = SafeStockFeed.latest(c, NVDA); // reverts on stale, paused or corporate action
        return raw * priceWad / 1e18;
    }
}
```

This exact contract was built in a fresh Foundry project through the remapping above and checked against the live NVDA feed on chain 4663. The `Config` fields:

- `feed`: the token's Chainlink **Standard** proxy. Every Robinhood Chain stock feed is listed in [research.md](research.md) (token and feed side by side).
- `maxPriceAge`: 25 hours fits the feeds' 24 h heartbeat. The feeds do not print over weekends and US holidays, so `latest` reverts `StalePrice` then. For liquidations that is the point. To show a value anyway, use `status`, which returns the last price together with `StalePrice`.
- `corporateActionGrace`: how long after an ERC-8056 multiplier change prices are refused (Strike uses 1 day).
- `feedDecimals`: 8 for every Robinhood Chain stock feed; read `feed.decimals()` once in your constructor if you prefer.

The price is USD per **raw** token. Multiply it by `balanceOf`, never by `balanceOfUI` and never by `uiMultiplier`: the feed already includes the multiplier, so either one counts a split or dividend twice. The only correct use of the multiplier is dividing by it, to show the price of one share as a wallet displays it (`priceWad × 1e18 / uiMultiplier`). The UI balance times that share price gives back the same value.

Sequencer: call `SafeStockFeed.checkSequencer(uptimeFeed, grace)` before `latest`. Chainlink has not published an L2 sequencer uptime feed for Robinhood Chain yet ([research.md §7](research.md#7-chainlink-l2-sequencer-uptime-feeds)). A zero address skips the check, so wire it in now and set the feed once one exists.

### 4. The full example

[`contracts/examples/StockCollateral.sol`](../contracts/examples/StockCollateral.sol) is the collateral side of a lending market for one stock token: `deposit`, `withdraw`, `collateralValue` (raw balance × feed price), `borrowLimit` (value × LTV), `sharePrice` (feed price ÷ `uiMultiplier`, display only) and an optional sequencer feed. Its comments walk through the double-multiplier bug and why the multiplier is only ever divided by. Every USD read reverts with the library's errors.

- Unit tests with the repo's mocks: [`contracts/test/examples/StockCollateral.t.sol`](../contracts/test/examples/StockCollateral.t.sol) (14 tests: a 2-for-1 split leaves the value unchanged, fuzzed multipliers, each revert, the testnet token without `oraclePaused`, a plain ERC-20).
- Fork tests on chain 4663: [`contracts/test/fork/StockCollateralFork.t.sol`](../contracts/test/fork/StockCollateralFork.t.sol) (3 tests). They value real NVDA collateral against the raw feed answer, show both double-counting variants are strictly larger, check all 8 mainnet stock tokens that have a feed, and trigger each revert on the real token. They are skipped when the RPC is unset or unreachable.

```sh
cd contracts
forge test --match-path "test/examples/*"
ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com forge test --match-path "test/fork/*"
```

### 5. What each error means

| Error                                        | Raised by                   | Meaning                                                                                                                 | What a lending or perps protocol should do                                            |
| -------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `InvalidPrice(answer)`                       | `latest`, `settlementPrice` | The round's answer is zero or negative, or its timestamp is in the future                                               | Treat the feed as broken; stop price-dependent actions                                |
| `StalePrice(updatedAt, maxAge)`              | `latest`                    | The newest round is older than `maxPriceAge`. Normal over weekends and holidays                                         | Pause borrows and liquidations until the next print; never fall back to the old price |
| `TokenPaused(token)`                         | `latest`, `settlementPrice` | The issuer paused the token (`paused()`)                                                                                | Pause liquidations: seized collateral could not move anyway                           |
| `FeedPaused(token)`                          | `latest`, `settlementPrice` | The issuer paused the token's oracle side (`oraclePaused()`)                                                            | Pause price-dependent actions                                                         |
| `CorporateActionPending(token, effectiveAt)` | `latest`                    | A split or dividend is scheduled (`newUIMultiplier ≠ uiMultiplier`) or took effect less than `corporateActionGrace` ago | Wait until `effectiveAt + grace`; the feed and the multiplier can disagree until then |
| `SequencerDown()`                            | `checkSequencer`            | The uptime feed reports the sequencer down                                                                              | Pause; users cannot top up positions                                                  |
| `SequencerGracePeriod(since)`                | `checkSequencer`            | The sequencer came back less than `grace` ago                                                                           | Wait, so users can top up before liquidations resume                                  |
| `MissingHint(index)`                         | `settlementPrice`           | The hint array ended before the proof was complete (a phase change or corporate action needs extra hints)               | Supply the full array (the SDK's `findSettlementHints`)                               |
| `InvalidSettlementRound(roundId)`            | `settlementPrice`           | That round is not the first at or after the target, or a phase hint is wrong                                            | Supply the correct round; nobody can pick a later, more convenient print              |

### Other functions

`status(config, token)` is the non-reverting version for front ends and agents: it returns `Ok`, `InvalidPrice`, `StalePrice`, `TokenPaused`, `FeedPaused` or `CorporateActionPending` together with the price.

`corporateAction(token, grace)` returns whether a multiplier change is in progress and its `effectiveAt`, and `checkToken(token, grace)` runs the pause and corporate-action checks alone. Both read the token defensively, so a plain ERC-20 passes.

### Settlement prices

`settlementPrice(config, token, hints, target)` returns the price of the first round published at or after `target`, proven by an array of round ids. Use it for anything that settles "at time T" (options, futures, auctions) so nobody can choose a convenient later print. The rules:

- `hints[0]` is the candidate: published at or after `target`. Inside a Chainlink phase, the round before it must predate `target`.
- Round ids are `phase << 64 | aggregatorRound`. When the candidate is round 1 of phase p > 1 (an aggregator upgrade), the next hint must be the last round of phase p − 1: it must predate `target` and have no successor. An upgrade therefore neither offers a second candidate price nor blocks settlement, however late the new phase starts.
- Round 1 of the first phase has no predecessor to check, so it must be within `maxPriceAge` of `target`.
- If the chosen print is within `corporateActionGrace` of the token's ERC-8056 `effectiveAt`, the feed and the multiplier may disagree. The target moves to `effectiveAt + grace` and the remaining hints prove the first round at or after it, by the same rules.
- A missing hint reverts `MissingHint(index)`; a round that fails a check reverts `InvalidSettlementRound(roundId)`.

In the common case (one phase, no corporate action) one hint is enough. The Strike SDK's `findSettlementHints` computes the full array from the feed.

## Or call the deployed StockOracle

`StockOracle` holds a registry of stock tokens and their feeds, the NYSE calendar, and a record of settlement prices shared by every consumer. With the remapping above, `import {IStockOracle} from "@strike/interfaces/IStockOracle.sol";` is all a caller needs:

| Function                                               | Returns                                                                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `latestPrice(token)`                                   | `(priceWad, updatedAt)` or a `SafeStockFeed` error                                                                             |
| `status(token)`                                        | non-reverting status and price                                                                                                 |
| `recordSettlementPrice(token, expiry, roundId)`        | the price of the first round at or after `expiry`, stored once and never changed (the one-hint case)                           |
| `recordSettlementPriceWithHints(token, expiry, hints)` | the same, with the full hint array (phase change or corporate action); records once for every consumer of that (token, expiry) |
| `settlementPrice(token, expiry)`                       | the recorded price (0 if none yet)                                                                                             |
| `isMarketOpen()`                                       | whether a regular NYSE session is open now                                                                                     |
| `isValidExpiry(ts)`                                    | whether `ts` is an NYSE session close                                                                                          |

`MarketCalendar` computes NYSE sessions on-chain (DST-aware, matched against Python `zoneinfo` for every day from 2026 to 2030) with holidays and 13:00 early closes kept as an admin list. It also answers `weeklyExpiry(ts)` (Friday close, or Thursday when Friday is a holiday) and `nextSessionClose(ts)`.

On Robinhood Chain testnet (46630) the v2 `StockOracle` is [`0x7bb3cAb211E7Ce51e37693E0155C77f477F8aB89`](https://explorer.testnet.chain.robinhood.com/address/0x7bb3cAb211E7Ce51e37693E0155C77f477F8aB89) and the `MarketCalendar` [`0x214d21F4fCA2226091AF009B9F1BF1D3C63f95F4`](https://explorer.testnet.chain.robinhood.com/address/0x214d21F4fCA2226091AF009B9F1BF1D3C63f95F4). v3 on the same chain has its own `StockOracle`, [`0x5BCdBFaB940BFAEF821392d7f58c670c2064989A`](https://explorer.testnet.chain.robinhood.com/address/0x5BCdBFaB940BFAEF821392d7f58c670c2064989A), and shares that `MarketCalendar`. On Arbitrum Sepolia (421614, v3, test stock tokens) the `StockOracle` is [`0x8B89A4dE3d8E74888e0135CCBeE5eE00Df36bA9F`](https://sepolia.arbiscan.io/address/0x8B89A4dE3d8E74888e0135CCBeE5eE00Df36bA9F). Every address is in [DEPLOYMENTS.md](DEPLOYMENTS.md).

## Conformance suite

Wrapping `SafeStockFeed` in your own oracle contract is easy to get subtly wrong: apply the multiplier, catch the wrong revert, pick a later settlement round. [`contracts/test/conformance/SafeStockFeedConformance.sol`](../contracts/test/conformance/SafeStockFeedConformance.sol) is an abstract Foundry test that checks every rule the library enforces against _your_ wrapper, called from the outside the way a lending market or perps protocol calls it. Each rule is its own test:

| Rule                                                                                                                                                   | Tests                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| The multiplier is never applied (fuzzed from 0.5× to 10×); any feed decimals normalise to 18                                                           | `testFuzz_conformance_multiplierIsNeverApplied`, `testFuzz_conformance_decimalsNormalised`, `test_conformance_freshPriceIsReturnedInWad`        |
| Stale prices revert (`maxPriceAge` old is still fresh, one second more is not)                                                                         | `test_conformance_stalePriceReverts`                                                                                                            |
| Token pause, oracle pause, token pause reported first                                                                                                  | `test_conformance_tokenPauseReverts`, `test_conformance_oraclePauseReverts`, `test_conformance_tokenPauseIsCheckedBeforeOraclePause`            |
| A token without `oraclePaused()` counts as not paused                                                                                                  | `test_conformance_missingOraclePausedIsNotPaused`                                                                                               |
| Corporate-action window: from announcement until `effectiveAt + grace`                                                                                 | `test_conformance_scheduledCorporateActionReverts`, `test_conformance_corporateActionWindowClosesAfterGrace`                                    |
| Zero, negative (fuzzed) and future-dated answers                                                                                                       | `test_conformance_zeroAnswerReverts`, `testFuzz_conformance_negativeAnswerReverts`, `test_conformance_futureTimestampReverts`                   |
| Sequencer down, then inside its grace period (if the wrapper checks one)                                                                               | `test_conformance_sequencerDownAndGrace`                                                                                                        |
| Settlement is the first round at or after the target; round 1 of the first phase must be fresh; paused tokens and invalid rounds revert (if supported) | `test_conformance_settlementIsFirstRoundAtOrAfterTarget`, `…FirstRoundOfFirstPhaseMustBeFresh`, `…RespectsPauseLayers`, `…RejectsInvalidRounds` |
| Phase changes need the previous phase's last round and cannot skip an old-phase print; a corporate action moves the target and needs its hint          | `test_conformance_settlementAcrossPhaseChange`, `…PhaseChangeCannotSkipOldPhase`, `test_conformance_settlementCorporateActionHint`              |

Rules a wrapper does not implement (no settlement price, no sequencer check) are reported as `[SKIP]`, never as passed. Both of Strike's own consumers run the suite: [`StockOracleConformance.t.sol`](../contracts/test/conformance/StockOracleConformance.t.sol) (21 of 21) and [`StockCollateralConformance.t.sol`](../contracts/test/conformance/StockCollateralConformance.t.sol) for the example (14 passed, the 7 settlement rules skipped).

### Run it against your wrapper

`@strike/` points at Strike's `contracts/src` only, so add a second line for the test tree next to it:

```text
# remappings.txt
@strike/=lib/Strike/contracts/src/
@strike-test/=lib/Strike/contracts/test/
```

(`@strike/../test/...` does not resolve: the suite's own relative imports break.) Then inherit `SafeStockFeedConformanceWithMocks`, which drives Strike's mocks (`MockStockToken`, `MockAggregator` for the price and the sequencer), and implement two hooks:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SafeStockFeedConformanceWithMocks} from "@strike-test/conformance/SafeStockFeedConformance.sol";
import {IAggregatorV3} from "@strike/interfaces/IAggregatorV3.sol";
import {MyOracle} from "../src/MyOracle.sol";

contract MyOracleConformanceTest is SafeStockFeedConformanceWithMocks {
    MyOracle internal oracle;

    /// Deploy your wrapper for this token, feed and sequencer uptime feed, configured with the suite's
    /// MAX_AGE (1 h), CA_GRACE (1 day) and SEQ_GRACE (1 h).
    function _deployWrapper(address token_, IAggregatorV3 feed_, IAggregatorV3 sequencer_) internal override {
        oracle = new MyOracle(token_, feed_, sequencer_);
    }

    /// Read the price the way your protocol does. It must revert with SafeStockFeed's errors.
    function _readPrice() internal view override returns (uint256) {
        return oracle.price();
    }

    /// Optional: your wrapper calls SafeStockFeed.checkSequencer.
    function _supportsSequencer() internal pure override returns (bool) {
        return true;
    }
}
```

This file, with a 20-line `MyOracle` that calls `checkSequencer` and `latest`, was run in a fresh Foundry project through these two remappings: 14 passed, 7 skipped. A wrapper with a settlement price also overrides `_supportsSettlement()` to return true and `_settlementPrice(hints, target)` (Strike's calls `recordSettlementPriceWithHints`).

The hooks, all `internal`:

| Hook                                                                 | Does                                                                                                                                                                  |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `_deploy(feedDecimals, withOraclePause) returns (token)`             | Fresh token/feed pair and wrapper. `withOraclePause = false` means a token without `oraclePaused()`, as on testnet. The mocks base implements it via `_deployWrapper` |
| `_pushRound(answer, updatedAt) returns (roundId)`, `_newFeedPhase()` | Feed rounds, and an aggregator upgrade (round ids restart in a new phase)                                                                                             |
| `_setTokenPaused(bool)`, `_setOraclePaused(bool)`                    | The two pause layers                                                                                                                                                  |
| `_scheduleMultiplier(multiplier, effectiveAt)`, `_applyMultiplier()` | An ERC-8056 corporate action                                                                                                                                          |
| `_warp(timestamp)`                                                   | Moves time (`vm.warp` by default; override if your wrapper needs a keeper step)                                                                                       |
| `_readPrice() returns (priceWad)`                                    | The price through your wrapper                                                                                                                                        |
| `_supportsSettlement()`, `_settlementPrice(hints, target)`           | Optional settlement price                                                                                                                                             |
| `_supportsSequencer()`, `_setSequencer(answer, startedAt)`           | Optional sequencer check                                                                                                                                              |

With your own token or feed contracts instead of the mocks, inherit `SafeStockFeedConformance` and implement the token and feed hooks too.

## Tests

- Unit and fuzz: `contracts/test/oracle/StockOracle.t.sol` (21 tests), `contracts/test/oracle/MarketCalendar.t.sol` (13 tests)
- Fork against chain 4663: `contracts/test/fork/RobinhoodFork.t.sol` (real TSLA, NVDA and SPY feeds, real pause flags and multipliers)
- Example consumer: `contracts/test/examples/StockCollateral.t.sol` (14 unit and fuzz tests) and `contracts/test/fork/StockCollateralFork.t.sol` (3 fork tests: NVDA collateral against the raw feed, all 8 mainnet feeds, each revert on the real token)
- Audit regression: `contracts/test/audit/AuditSettlement.t.sol` (phase changes, corporate action at expiry, round uniqueness)
- Conformance suite: `contracts/test/conformance/` (21 rules; `StockOracle` passes 21, the `StockCollateral` example passes 14 and skips the 7 settlement rules)
- Coverage: 100% of lines and branches for `SafeStockFeed` (the conformance suite reaches the last branches), `StockOracle` and the `StockCollateral` example
