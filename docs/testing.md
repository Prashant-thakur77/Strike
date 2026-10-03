# Testing

Run everything with `make test` (default profile) or `make ci-test` (5,000 fuzz runs; 256 × 128 invariant calls). The Foundry suite has 607 passing tests and 7 skipped (the conformance suite's settlement rules, which the `StockCollateral` example does not implement), plus 16 fork tests, 3 differential fuzz tests and 9 Halmos proofs in their own CI jobs. The Stylus crate has 15 Rust tests. The SDK has 280 tests (2 more are skipped: `sdk/test/live.consent.test.ts`, which simulates v3 registration against the two deployed v3 registries and runs only with `STRIKE_LIVE=1`), the MCP server 96, the example agents 159, the indexer 53, the Telegram bot 104 and the subgraph 10; the app has 438 Playwright tests in 43 files, each run at desktop and mobile sizes (876 runs). The SDK, MCP and Playwright suites register agents on a v3 devnet too (Deploy and Seed from `v3-contracts` on anvil); the register spec runs its v2 test or its three v3 tests depending on the devnet's registry. 33 of the 438 are the UI audit (`app/e2e/ui-audit.spec.ts`), which runs only with `UI_AUDIT=1` and only at desktop size, so 405 run by default. In total that is 1,790 tests and proofs (counted on 2026-10-02; every figure here is in [`evidence/facts.json`](evidence/facts.json), and CI fails when this page states a different one). The `v3-contracts` branch has 531 Foundry tests passing (1 skipped) and 28 Rust tests.

| Layer            | Where                                                                   | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit             | `contracts/test/unit`, `test/agents`, `test/oracle`, `test/pricing`     | Every function and custom error                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Integration      | `contracts/test/integration`                                            | Full epochs: calls and puts, in and out of the money, queue, premium, fees, rejection and slashing, abort, emergency cancel, pause                                                                                                                                                                                                                                                                                                                                                            |
| Fuzz             | throughout (`testFuzz_*`)                                               | Pricing properties, staleness windows, calendar round trips, bond conservation, mandate validation, `proposeByDelta` at band edges                                                                                                                                                                                                                                                                                                                                                            |
| Audit regression | `contracts/test/audit` (19 tests)                                       | One test per finding of the [internal review](security/review-2026-09-29.md), each first written to reproduce the attack and now asserting the fix: settlement across Chainlink phases and corporate actions, intrinsic-value floor, spot buffer, snapshot-judged proposals, `proposeByDelta` rounding, guardian cancel, mandate floors, keeper sigma limits, ERC-8004 feedback. Plus the properties that held (round uniqueness, reentrancy, split buys and redeems, queue drift, donations) |
| Conformance      | `contracts/test/conformance`                                            | The 21 `SafeStockFeed` rules against `StockOracle` (21 pass) and the `StockCollateral` example (14 pass, 7 settlement rules skipped)                                                                                                                                                                                                                                                                                                                                                          |
| Invariant        | `contracts/test/invariant`                                              | The nine properties below, on a call vault and a put vault                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Differential     | `contracts/test/differential`, `test/pricing/BlackScholesVectors.t.sol` | Stylus (Rust) and Solidity pricers return identical results                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Vectors          | `test/vectors/pricer.json`, `test/vectors/nyse.json`                    | 300 pricer outputs from Rust; NYSE sessions for every day 2026–2030 from Python `zoneinfo`                                                                                                                                                                                                                                                                                                                                                                                                    |
| Rust             | `stylus/pricer` (`cargo test`)                                          | Accuracy against closed-form Black-Scholes (< 1e-9 of spot), parity, bounds                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Formal           | `contracts/test/formal` (Halmos)                                        | 9 properties proven for every input in range; 16 more kept and marked unproven ([formal-verification.md](security/formal-verification.md))                                                                                                                                                                                                                                                                                                                                                    |
| App end-to-end   | `app/e2e` (Playwright)                                                  | Every page at desktop and mobile sizes, the remote MCP endpoint, navigation and the glossary; the opt-in UI audit checks every page at 1440, 1024, 768, 390 and 360 px for overflow, clipped text, overlaps, console errors and layout shift                                                                                                                                                                                                                                                  |

## App end-to-end in CI

The `playwright` job in [`ci.yml`](../.github/workflows/ci.yml) runs every spec in `app/e2e`, one job per Playwright project (desktop and mobile), each against its own anvil devnet. The same steps run locally:

```bash
anvil --port 8545 --timestamp 1791212400 --silent &   # Mon 2026-10-05 15:00 UTC, NYSE open
cd contracts
for s in Deploy Seed DeployUsdgDrip; do               # anvil's account 0, a public dev key
  PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
    forge script script/$s.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --silent --skip test
done
cd ../app
RPC_URL=http://127.0.0.1:8545 node scripts/demo-chain.mjs   # deposits, settled epochs, live series, rejections
corepack pnpm build && corepack pnpm e2e
```

The addresses on chain 31337 are deterministic and match the SDK's deployments map, which the app and the specs read. The desktop job then replaces the devnet with v3 (`Deploy.s.sol` and `Seed.s.sol` from the `v3-contracts` branch, with the same core addresses) and runs `register.spec.ts` again, so its three v3 registration tests run too. Each job's summary lists every skipped run with the reason the spec gives. The `devnet-ts` job runs the SDK's and the MCP server's devnet suites (`e2e.devnet.test.ts` and `e2e.v3.devnet.test.ts`, 27 tests), which skip in the `js` job because it has no Foundry, and fails if any of them skips. [CI run 37012852801](https://github.com/Prashant-thakur77/Strike/actions/runs/37012852801) on 2 October: desktop 157 passed and 41 skipped, mobile 68 passed and 130 skipped (396 runs, 225 passed, 171 skipped), and the v3 pass 3 passed and 2 skipped. The skips, as follows.

| Skipped runs                                        | Why                                                                                                                                                                                                                                     |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 104: one viewport of a test that runs in the other  | Pure functions, HTTP-only routes and flows that change the chain run at desktop size only; the phone menu and touch tests run at mobile size only                                                                                       |
| 64: `ui-audit.spec.ts` (32 tests in each project)   | An opt-in capture tool with no assertions: it saves screenshots and DOM reports for review. Run it with `UI_AUDIT=1`                                                                                                                    |
| 3: `register.spec.ts`'s v3 tests on the v2 devnet   | They run in the desktop job's v3 pass, where the v2 test skips instead                                                                                                                                                                  |
| 0 in that run: live reads of the testnets or GitHub | `app`, `faucet`, `mirror`, `playground`, `proof`, `risk`, `usage`, `v3robinhood` and `why` read Robinhood Chain testnet, Arbitrum Sepolia or GitHub and skip when it does not answer from the runner; nothing is sent to a public chain |

## Coverage

`make coverage` (Foundry, `--ir-minimum`, production code only):

| Contract                                                                                          | Lines     | Branches  | Functions |
| ------------------------------------------------------------------------------------------------- | --------- | --------- | --------- |
| AgentRegistry                                                                                     | 98.6%     | 92.9%     | 100%      |
| EpochManager                                                                                      | 98.7%     | 98.4%     | 100%      |
| StrikeVault                                                                                       | 99.4%     | 100%      | 100%      |
| PendleCollateralAdapter (prototype, not deployed)                                                 | 99.3%     | 100%      | 100%      |
| SafeStockFeed / StockOracle                                                                       | 100%      | 100%      | 100%      |
| MandateGuard                                                                                      | 94.7%     | 100%      | 100%      |
| BlackScholesLib                                                                                   | 100%      | 100%      | 100%      |
| MarketCalendar / NyseTime                                                                         | 100%      | 100%      | 100%      |
| DecisionLog, FeeManager, Decimals, VaultFactory, OptionToken, StrikePutReserve, testnet contracts | 100%      | 100%      | 100%      |
| **Total**                                                                                         | **99.3%** | **99.0%** | **100%**  |

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
