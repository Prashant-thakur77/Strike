# Evidence records

Machine-readable evidence that scripts write and CI checks, so the docs can link a figure instead of retyping it.

| File                                                     | What it is                                                                                                                     | Written by                | Checked by                                                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------- | ---------------------------------------------------------------------------------------------- |
| [`46630-v2-2026-10-02.json`](46630-v2-2026-10-02.json)   | The week ending Friday 2 October on v2, Robinhood Chain testnet: the TSLA covered-call and cash-secured-put vaults of agent #1 | `scripts/proven-week.mjs` | `scripts/check-claims.mjs` (every tx and block), `scripts/proven-week.mjs --check` (the chain) |
| [`46630-v3-2026-10-02.json`](46630-v3-2026-10-02.json)   | The same week on v3, Robinhood Chain testnet                                                                                   | `scripts/proven-week.mjs` | as above                                                                                       |
| [`421614-v3-2026-10-02.json`](421614-v3-2026-10-02.json) | The same week on v3, Arbitrum Sepolia                                                                                          | `scripts/proven-week.mjs` | as above                                                                                       |

## A week record

One file per deployment and week, named `<chainId>-<version>-<expiry date>.json`. It is read from the chain only (no key) and lists each vault whose proposals expire that Friday, with its epoch's lifecycle in order:

1. `deposit`: the deposits made before the epoch opened.
2. `open`: `openEpoch`, with the spot it snapshotted.
3. `proposal`: every proposal, accepted or rejected, and the decision records anchored for the vault and epoch in the `DecisionLog` (record hash, URI, anchor transaction).
4. `rejection and slash`: the reason, the USDG slashed and the ERC-8004 feedback the rejection posted (v3).
5. `accept`: the accepted series: strike, size, premium floor, fair value, delta, and v3's `SeriesRisk`.
6. `buys`: each `buy`, with the premium paid.
7. `settlement`: the settlement price, the oracle round it was recorded from, payout, premium, fee and the ERC-8004 PnL feedback; or the `abortEpoch` that closed an epoch without a series and paid the slash to the vault.
8. `redemptions and claims`: options redeemed for their payout, and depositors' withdrawals and premium claims after the epoch closed.

Every event carries its `tx`, `block` and `time` (UTC); the explorer is the file's `explorer` field. Amounts are exact decimals in the unit their name gives (`strikeUsd`, `premiumUsdg`, `options`). A step's `status` is `done`, `pending` (it has not happened yet) or `none` (it will not happen this week, for example no rejection on a vault whose proposal was accepted). Object keys are sorted and lists are in chain order, so an unchanged chain gives a byte-identical file.

## Regenerate and check

```bash
node scripts/proven-week.mjs --expiry 2026-10-02            # rewrite the three records from the chain
node scripts/proven-week.mjs --expiry 2026-10-02 --check    # exit 1 if a committed record differs from the chain
node scripts/check-claims.mjs                               # every tx and block in these records and in the docs
```

The week of 2 October settles after 20:00 UTC; the [settlement runbook](../operations.md#8-proven-week-records) reruns the first command once the three settlements and the two put-vault aborts are on chain. Until then the settlement and claim steps read `pending`.
