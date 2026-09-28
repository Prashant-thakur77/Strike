# Testing

Run everything with `make test` (default profile) or `make ci-test` (5,000 fuzz runs; 256 × 128 invariant calls). The Foundry suite has 418 tests; the SDK has 75, the example agents 20 and the MCP server 27.

| Layer            | Where                                                                   | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit             | `contracts/test/unit`, `test/agents`, `test/oracle`, `test/pricing`     | Every function and custom error                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Integration      | `contracts/test/integration`                                            | Full epochs: calls and puts, in and out of the money, queue, premium, fees, rejection and slashing, abort, emergency cancel, pause                                                                                                                                                                                                                                                                                                                                                            |
| Fuzz             | throughout (`testFuzz_*`)                                               | Pricing properties, staleness windows, calendar round trips, bond conservation, mandate validation, `proposeByDelta` at band edges                                                                                                                                                                                                                                                                                                                                                            |
| Audit regression | `contracts/test/audit` (19 tests)                                       | One test per finding of the [internal review](security/review-2026-09-29.md), each first written to reproduce the attack and now asserting the fix: settlement across Chainlink phases and corporate actions, intrinsic-value floor, spot buffer, snapshot-judged proposals, `proposeByDelta` rounding, guardian cancel, mandate floors, keeper sigma limits, ERC-8004 feedback. Plus the properties that held (round uniqueness, reentrancy, split buys and redeems, queue drift, donations) |
| Invariant        | `contracts/test/invariant`                                              | The nine properties below, on a call vault and a put vault                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Differential     | `contracts/test/differential`, `test/pricing/BlackScholesVectors.t.sol` | Stylus (Rust) and Solidity pricers return identical results                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Vectors          | `test/vectors/pricer.json`, `test/vectors/nyse.json`                    | 300 pricer outputs from Rust; NYSE sessions for every day 2026–2030 from Python `zoneinfo`                                                                                                                                                                                                                                                                                                                                                                                                    |
| Rust             | `stylus/pricer` (`cargo test`)                                          | Accuracy against closed-form Black-Scholes (< 1e-9 of spot), parity, bounds                                                                                                                                                                                                                                                                                                                                                                                                                   |

## Coverage

`make coverage` (Foundry, `--ir-minimum`, production code only):

| Contract                                                           | Lines        | Branches     | Functions |
| ------------------------------------------------------------------ | ------------ | ------------ | --------- |
| AgentRegistry                                                      | 98.6%        | 92.9%        | 100%      |
| EpochManager                                                       | 98.7%        | 98.4%        | 100%      |
| StrikeVault                                                        | 99.4%        | 100%         | 100%      |
| SafeStockFeed / StockOracle                                        | 97.5% / 100% | 90.9% / 100% | 100%      |
| MandateGuard                                                       | 94.7%        | 100%         | 100%      |
| BlackScholesLib                                                    | 100%         | 100%         | 100%      |
| MarketCalendar / NyseTime                                          | 100%         | 100%         | 100%      |
| FeeManager, Decimals, VaultFactory, OptionToken, testnet contracts | 100%         | 100%         | 100%      |
| **Total**                                                          | **99.1%**    | **97.4%**    | **100%**  |

## Invariants

Handlers drive random sequences of deposits, redemptions, queue requests, cancels, share transfers, epoch openings, valid and reckless proposals, purchases at drifting prices, settlements with ±40% moves, and option redemptions.

1. Locked collateral ≥ worst-case payout of the live series, and ≤ vault assets
2. Shares × price = assets, up to ERC-4626 virtual-share rounding
3. While locked, vault assets change only inside settlement
4. The vault holds every asset it accounts for (collateral, queued deposits, reserved redemptions, premium)
5. A settled series stays settled at the first recorded price (and the oracle record never changes)
6. The manager can pay every option holder, every escrowed premium and every slashed bond it owes
7. The vault can pay every holder's accrued and claimable premium
8. Deposits and withdrawals alone never lower the share price
9. Holders of settled or cancelled options can always redeem

## Mutation checks

The invariant suite was run against deliberately broken code to prove it can fail:

| Injected bug                                                   | Caught by                                                                                                                             |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Vault forgets to subtract the settlement payout from its books | `invariant_assetBacking`                                                                                                              |
| Premium accumulator over-credits holders by 1%                 | `invariant_premiumSolvency`                                                                                                           |
| Option payouts rounded up instead of down                      | `invariant_optionHoldersCanAlwaysRedeem` (the escrow underflow guard blocks the overpayment, so the last holder's redemption reverts) |
