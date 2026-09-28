# Audit readiness

Everything an auditor needs to start on day one. Strike has not been audited; this package is prepared for the Arbitrum Audit Program.

## Scope

| File                              |           nSLOC | What it does                                                                    |
| --------------------------------- | --------------: | ------------------------------------------------------------------------------- |
| `src/core/EpochManager.sol`       |             579 | Epoch state machine; the only contract that moves vault collateral              |
| `src/vaults/StrikeVault.sol`      |             272 | ERC-4626 vault clone: epoch queue, premium accumulator                          |
| `src/agents/AgentRegistry.sol`    |             244 | Agents, USDG bonds, slashing, ERC-8004 link and reputation feedback             |
| `src/pricing/BlackScholesLib.sol` |             200 | Fixed-point Black-Scholes and strike solver (mirrors the Rust pricer)           |
| `src/libraries/SafeStockFeed.sol` |             106 | Price safety: staleness, pauses, corporate actions, sequencer, settlement round |
| `src/oracle/MarketCalendar.sol`   |              79 | NYSE sessions, holidays, early closes                                           |
| `src/oracle/StockOracle.sol`      |              79 | Feed registry, settlement price record                                          |
| `src/core/FeeManager.sol`         |              69 | Performance fee split, pull payments                                            |
| `src/libraries/MandateGuard.sol`  |              60 | Pure mandate predicate                                                          |
| `src/vaults/VaultFactory.sol`     |              60 | EIP-1167 vault clones                                                           |
| `src/libraries/NyseTime.sol`      |              49 | Civil-date and DST arithmetic                                                   |
| `src/tokens/OptionToken.sol`      |              37 | ERC-1155 option positions                                                       |
| `src/pricing/BlackScholesRef.sol` |              33 | `IPricer` wrapper for the Solidity pricer                                       |
| `src/libraries/Decimals.sol`      |              32 | Unit conversions with explicit rounding                                         |
| Interfaces                        |              90 |                                                                                 |
| **Total in scope**                |       **1,989** |                                                                                 |
| `stylus/pricer/src/{lib,math}.rs` | about 680 lines | Rust pricer deployed on Stylus (same algorithm)                                 |

Out of scope: `src/testnet/*` (testnet-only mocks: MirrorFeed, TestStockToken, TestUSDG), tests, scripts, off-chain packages.

Compiler: Solidity 0.8.30, EVM `cancun`, optimizer 200 runs. Dependencies: OpenZeppelin Contracts and Contracts-Upgradeable 5.7.0 (pinned submodules). Rust 1.91.0, stylus-sdk 0.10.9, cargo-stylus 0.10.9.

## Where to start

1. [design.md](design.md): the specification (units, lifecycle, formulas, invariants, oracle rules).
2. [threat-model.md](threat-model.md): 18 threats, each with the mitigation and the test.
3. `EpochManager.settle` → `StrikeVault.settleEpoch`: the path where money moves.
4. `EpochManager.buy` and `_quoteBuy`: oracle-anchored pricing and collateral locking.
5. `StrikeVault` queue and accumulator: `requestDeposit`, `requestRedeem`, `_claim*IfProcessed`, `_update`, `_distributePremium`.

## Roles and trust

| Role                                                                                        | Holder (testnet)            | Powers                                                                                                                       | Cannot                                                                         |
| ------------------------------------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `DEFAULT_ADMIN_ROLE` (EpochManager, StockOracle, AgentRegistry, FeeManager, MarketCalendar) | Deployer; a Safe on mainnet | List tokens and feeds, set volatility bounds, pricer, fee parameters (capped at 30%), timings (bounded), registry parameters | Move user funds, change a vault's mandate, set sigma outside the bounds it set |
| `GUARDIAN_ROLE`                                                                             | Deployer; a Safe on mainnet | Pause new epochs, proposals and buys; cancel a series only after `expiry + settlementGrace` with no settlement               | Block settlement or idle withdrawals; take funds                               |
| `KEEPER_ROLE`                                                                               | Deployer / keeper bot       | Update sigma within bounds; open epochs; push MirrorFeed rounds (testnet only)                                               | Anything else                                                                  |
| `FACTORY_ROLE`                                                                              | VaultFactory                | Register new vaults                                                                                                          |                                                                                |
| `SLASHER_ROLE` (AgentRegistry)                                                              | EpochManager                | Slash bonds, record results                                                                                                  |                                                                                |
| Curator                                                                                     | Whoever created the vault   | Replace the vault's agent; abort an open epoch                                                                               | Change the mandate or touch funds                                              |
| Agent signer                                                                                | Registered agent key        | Open epochs, propose inside the mandate                                                                                      | Hold or move vault funds                                                       |

No contract is upgradeable. Vault clones and the manager are immutable code; a new version means new deployments.

## Known issues and accepted risks

| Item                                                                                         | Status                                                                   |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| USDG is priced at exactly $1                                                                 | Accepted; documented in design.md                                        |
| Zero interest rate and 365-day year in Black-Scholes                                         | Accepted for weekly tenors; documented                                   |
| `emergencyCancel` refunds premium pro rata by options held, not by the price each buyer paid | Accepted (emergency path only)                                           |
| A corporate action scheduled far ahead blocks sales until `effectiveAt + grace`              | Accepted: the protocol refuses rather than guesses                       |
| Testnet MirrorFeeds are keeper-controlled                                                    | Testnet only; mainnet uses Chainlink directly                            |
| Slither findings                                                                             | 0 High; all others triaged in [security/slither.md](security/slither.md) |
| Findings of internal reviews                                                                 | See the latest `security/review-*.md`                                    |

## Evidence already available

| Kind                            | Where                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Unit, integration, fuzz         | `contracts/test` (397 tests), 99.2% line and 95.8% branch coverage                                            |
| Invariants with mutation checks | `contracts/test/invariant`, [testing.md](testing.md)                                                          |
| Fork tests on chain 4663        | `contracts/test/fork` (real tokens, feeds, USDG, ERC-8004)                                                    |
| Differential Rust vs Solidity   | `contracts/test/differential`, vectors, on-chain equality check at deploy                                     |
| Formal properties               | `contracts/test/formal` and [security/formal-verification.md](security/formal-verification.md) (when present) |
| End-to-end                      | `scripts/demo-local.sh` in CI; live epochs on Robinhood Chain testnet in `docs/testnet-epochs/`               |

## How to run

```bash
git clone --recursive https://github.com/Prashant-thakur77/Strike && cd Strike
make test && make ci-test && make coverage
ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com forge test --root contracts --match-path "test/fork/*"
cargo build --release --example pricer_cli --manifest-path stylus/pricer/Cargo.toml
PRICER_CLI=$PWD/stylus/pricer/target/release/examples/pricer_cli forge test --root contracts --ffi --match-path "test/differential/*"
```
