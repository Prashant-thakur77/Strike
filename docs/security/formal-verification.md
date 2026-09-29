# Formal verification (Halmos)

Symbolic execution with [Halmos](https://github.com/a16z/halmos) proves a property for **every** input in the stated range, where a fuzz test only samples inputs. Properties live in [`contracts/test/formal/`](../../contracts/test/formal/) and run in the `formal` CI job.

This page states exactly what is proven and what is not. A property that timed out is marked unproven, not dropped.

## Proven (9 properties, run in CI)

| Contract or library   | Property                                                                                                                                                                                          | Test                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `MandateGuard`        | An accepted proposal has a non-zero size, a tenor in range, an expiry at an exchange close, a premium factor in [minPremiumBps, 3×], and a strike out of the money (calls above spot, puts below) | `check_none_impliesBasicRules`                   |
| `MandateGuard`        | An accepted proposal satisfies size × 10,000 ≤ capacity × maxShareSoldBps (no rounding in the bound)                                                                                              | `check_none_impliesSizeWithinShareCap`           |
| `MandateGuard`        | An accepted proposal's premium per option is at least minYieldBps of the collateral one option locks                                                                                              | `check_none_impliesYieldFloor`                   |
| `MandateGuard`        | Under any mandate `validate` accepts, an accepted proposal never sells more options than the vault can back                                                                                       | `check_none_withValidMandate_sizeWithinCapacity` |
| `MandateGuard`        | `validate` accepts a mandate exactly when it is internally consistent (including the protocol floors: premium ≥ 90% of fair value, tenor ≤ 35 days)                                               | `check_validate_acceptsOnlyConsistent`           |
| `FeeManager`          | No fee and no agent cut on an epoch that did not make money, for every fee configuration and amount                                                                                               | `check_computeFee_zeroWhenNoProfit`              |
| `FeeManager`          | The constructor (and `setFees`) only accepts rates inside the caps (performance fee ≤ 30%, agent share ≤ 100%)                                                                                    | `check_constructor_enforcesCaps`                 |
| `NyseTime`            | Every session opens before it closes and lasts 6.5 hours (3.5 on an early close), inside its own UTC day                                                                                          | `check_session_openBeforeClose`                  |
| Settlement arithmetic | With at most one token per option, a call's total payout never exceeds the tokens sold (the collateral locked)                                                                                    | `check_call_payoutWithinSold`                    |

Bounds, where a property has them, are stated on each test in the source.

## Not proven (16 properties, kept as `unproven_*`)

These time out in Halmos 0.3.3 with cvc5 at 300 s per query. Each stays in the source, renamed `unproven_…` so CI does not run it and marked `NOT PROVEN`, so the property is still written down. The same behaviour is exercised by the fuzz and invariant suites ([testing.md](../testing.md)).

| Area                 | Properties                                                                                                                   | Why it is hard                                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `MandateGuard`       | delta inside the band after truncation to bps (`unproven_none_impliesDeltaInBand`)                                           | Division by 1e18 of a symbolic signed value                                                                             |
| `FeeManager`         | fee ≤ 30% of net; agent cut ≤ fee; no overflow (removed from the file; covered by `testFuzz_computeFee_boundedByNetPremium`) | Products of the net premium with both symbolic rates are non-linear; they also timed out with the rates fixed to a grid |
| `NyseTime`           | civil date ↔ day number round trips (`unproven_civil_roundTrip`, `unproven_days_roundTrip`)                                  | Long chains of integer division                                                                                         |
| `Decimals`           | conversion round trips, rounding within one unit, monotonicity (4)                                                           | `mulDiv` with symbolic amount and price                                                                                 |
| Settlement           | call payout per option ≤ 1 token, holders within escrow for calls and puts, put payout within collateral (5)                 | `mulDiv` and ratios of symbolic prices                                                                                  |
| `StrikeVault` shares | no profit from deposit-then-redeem or redeem-then-deposit, split deposits gain nothing, full redemption within assets (4)    | ERC-4626 conversions with symbolic supply and assets                                                                    |

## Reproduce

```bash
pip install halmos==0.3.3
cd contracts
halmos --match-contract Formal --solver-timeout-assertion 300s
```

Solvers are fetched by Halmos on first use (`HALMOS_ALLOW_DOWNLOAD=1`); the tests request `cvc5-int` through `@custom:halmos` annotations. To try an unproven property, rename it back to `check_…` and run it alone with `--match-test '^check_<name>\('`.
