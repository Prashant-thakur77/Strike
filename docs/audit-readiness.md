# Audit readiness

Everything an auditor needs to start on day one. Strike has not been audited; this package is prepared for the Arbitrum Audit Program.

## Scope

| File                              |           nSLOC | What it does                                                                    |
| --------------------------------- | --------------: | ------------------------------------------------------------------------------- |
| `src/core/EpochManager.sol`       |             617 | Epoch state machine; the only contract that moves vault collateral              |
| `src/vaults/StrikeVault.sol`      |             272 | ERC-4626 vault clone: epoch queue, premium accumulator                          |
| `src/agents/AgentRegistry.sol`    |             254 | Agents, USDG bonds, slashing, ERC-8004 link and reputation feedback             |
| `src/pricing/BlackScholesLib.sol` |             200 | Fixed-point Black-Scholes and strike solver (mirrors the Rust pricer)           |
| `src/libraries/SafeStockFeed.sol` |             134 | Price safety: staleness, pauses, corporate actions, sequencer, settlement round |
| `src/oracle/StockOracle.sol`      |              91 | Feed registry, settlement price record                                          |
| `src/oracle/MarketCalendar.sol`   |              79 | NYSE sessions, holidays, early closes                                           |
| `src/core/FeeManager.sol`         |              69 | Performance fee split, pull payments                                            |
| `src/libraries/MandateGuard.sol`  |              62 | Pure mandate predicate and protocol limits                                      |
| `src/vaults/VaultFactory.sol`     |              60 | EIP-1167 vault clones                                                           |
| `src/libraries/NyseTime.sol`      |              49 | Civil-date and DST arithmetic                                                   |
| `src/tokens/OptionToken.sol`      |              37 | ERC-1155 option positions                                                       |
| `src/pricing/BlackScholesRef.sol` |              33 | `IPricer` wrapper for the Solidity pricer                                       |
| `src/libraries/Decimals.sol`      |              32 | Unit conversions with explicit rounding                                         |
| `src/agents/DecisionLog.sol`      |              30 | On-chain hash and URL of each agent decision record (deployed separately)       |
| Interfaces                        |              93 |                                                                                 |
| **Total in scope**                |       **2,112** |                                                                                 |
| `stylus/pricer/src/{lib,math}.rs` | about 680 lines | Rust pricer deployed on Stylus (same algorithm)                                 |

Out of scope: `src/testnet/*` (testnet-only mocks: MirrorFeed, TestStockToken, TestUSDG), tests, scripts, off-chain packages.

This scope is the source on `main`: the v2 contracts deployed on Robinhood Chain testnet, and `DecisionLog`, of which each of the three deployments has its own instance. v3, deployed on Robinhood Chain testnet next to v2 and on Arbitrum Sepolia, is built from the [`v3-contracts`](https://github.com/Prashant-thakur77/Strike/tree/v3-contracts) branch: the same files with the fixes listed under Known issues, plus `RiskLens`, `RiskLib`, `IRiskEngine` and the Stylus risk engine (`stylus/pricer/src/risk.rs`) ([DEPLOYMENTS.md](DEPLOYMENTS.md)). `main` switches to v3 after v2's Friday settlement ([decisions.md D36](decisions.md)).

Compiler: Solidity 0.8.30, EVM `cancun`, optimizer 200 runs. Dependencies: OpenZeppelin Contracts and Contracts-Upgradeable 5.7.0 (pinned submodules). Rust 1.91.0, stylus-sdk 0.10.9, cargo-stylus 0.10.9.

## Where to start

1. [design.md](design.md): the specification (units, lifecycle, formulas, invariants, oracle rules).
2. [threat-model.md](threat-model.md): 21 threats, each with the mitigation and the test.
3. [security/review-2026-09-29.md](security/review-2026-09-29.md): the internal review, its 11 findings and the fixes.
4. `EpochManager.settle` → `StrikeVault.settleEpoch`: the path where money moves.
5. `SafeStockFeed.settlementPrice` / `_firstAtOrAfter`: settlement round proofs across Chainlink phases and corporate actions.
6. `EpochManager.buy` and `_quoteBuy`: oracle-anchored pricing (spot buffer, intrinsic floor) and collateral locking.
7. `StrikeVault` queue and accumulator: `requestDeposit`, `requestRedeem`, `_claim*IfProcessed`, `_update`, `_distributePremium`.

## Roles and trust

| Role                                                                                        | Holder (testnet)            | Powers                                                                                                                                                      | Cannot                                                                         |
| ------------------------------------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `DEFAULT_ADMIN_ROLE` (EpochManager, StockOracle, AgentRegistry, FeeManager, MarketCalendar) | Deployer; a Safe on mainnet | List tokens and feeds, set volatility bounds, spot buffer (at most 200 bps), pricer, fee parameters (capped at 30%), timings (bounded), registry parameters | Move user funds, change a vault's mandate, set sigma outside the bounds it set |
| `GUARDIAN_ROLE`                                                                             | Deployer; a Safe on mainnet | Pause new epochs, proposals and buys; cancel a series only after `expiry + settlementGrace` with no settlement price recorded                               | Block settlement or idle withdrawals; take funds                               |
| `KEEPER_ROLE`                                                                               | Deployer / keeper bot       | Update sigma within bounds (at most 25% per update, once an hour); open epochs; push MirrorFeed rounds (testnet only)                                       | Anything else                                                                  |
| `FACTORY_ROLE`                                                                              | VaultFactory                | Register new vaults                                                                                                                                         |                                                                                |
| `SLASHER_ROLE` (AgentRegistry)                                                              | EpochManager                | Slash bonds, record results                                                                                                                                 |                                                                                |
| Curator                                                                                     | Whoever created the vault   | Replace the vault's agent; abort an open epoch                                                                                                              | Change the mandate or touch funds                                              |
| Agent signer                                                                                | Registered agent key        | Open epochs, propose inside the mandate                                                                                                                     | Hold or move vault funds                                                       |

No contract is upgradeable. Vault clones and the manager are immutable code; a new version means new deployments.

## Known issues and accepted risks

| Item                                                                                                                                                                            | Status                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `AgentRegistry.register` needs no consent from the signer, so anyone can register another address as a signer and block it ("one agent per signer"): griefing, no loss of funds | Accepted for v2; agents are told to use a fresh signer key. Fixed in v3: the signer signs the registration and `setSigner` (EIP-712) (D33, D36) |
| `VaultFactory.createVault` accepts any `agentId`, including an unbonded or foreign agent, whose signer then proposes for that vault. Only the vault's own creator is affected   | Accepted for v2; the SDK, MCP and app refuse an unknown agent and warn on an unbonded or foreign one. Fixed in v3: an active-agent check (D36)  |
| `InvalidMandate()` carries no reason, and the registry has no index of agents by owner                                                                                          | Off-chain tooling re-checks the rules and scans agents. v3 adds `InvalidMandate(reason)`; it has no owner index, so agents are still scanned    |
| USDG is priced at exactly $1                                                                                                                                                    | Accepted; documented in design.md                                                                                                               |
| Zero interest rate and 365-day year in Black-Scholes                                                                                                                            | Accepted for weekly tenors; documented                                                                                                          |
| `emergencyCancel` refunds premium pro rata by options held, not by the price each buyer paid                                                                                    | Accepted (emergency path only)                                                                                                                  |
| Weekly performance fee has no high-water mark: a week that only recovers an earlier loss still pays a fee                                                                       | Accepted for v2 (decisions.md D31). Fixed in v3: a per-vault fee high-water mark (loss carry-forward) (D36)                                     |
| A corporate action scheduled far ahead blocks sales until `effectiveAt + grace`                                                                                                 | Accepted: the protocol refuses rather than guesses                                                                                              |
| Testnet MirrorFeeds are keeper-controlled                                                                                                                                       | Testnet only; mainnet uses Chainlink directly                                                                                                   |
| `convertToAssets` ignores the open series (liability and escrowed premium) during an epoch                                                                                      | Accepted; documented for integrators in design.md §5                                                                                            |
| The keeper can still move sale prices through sigma (within bounds, 25% per hour)                                                                                               | Accepted; proposals are judged at the opening snapshot, so it cannot cause a slash                                                              |
| Slither findings                                                                                                                                                                | 0 High; all others triaged in [security/slither.md](security/slither.md)                                                                        |
| Findings of internal reviews                                                                                                                                                    | 11 findings (1 High, 3 Medium, 4 Low, 3 Info), all fixed with regression tests: [security/review-2026-09-29.md](security/review-2026-09-29.md)  |

## Evidence already available

| Kind                            | Where                                                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Unit, integration, fuzz         | `contracts/test` (477 tests, 19 of them audit regressions in `contracts/test/audit`), 99.3% line and 98.8% branch coverage            |
| Invariants with mutation checks | `contracts/test/invariant`, [testing.md](testing.md)                                                                                  |
| Fork tests on chain 4663        | `contracts/test/fork` (real tokens, feeds, USDG, ERC-8004)                                                                            |
| Differential Rust vs Solidity   | `contracts/test/differential`, vectors, on-chain equality check at deploy                                                             |
| Formal properties               | `contracts/test/formal` and [security/formal-verification.md](security/formal-verification.md) (9 proven, 16 unproven)                |
| End-to-end                      | `scripts/demo-local.sh` in CI; live epochs on Robinhood Chain testnet (v2 and v3) and Arbitrum Sepolia (v3) in `docs/testnet-epochs/` |

## How to run

```bash
git clone --recursive https://github.com/Prashant-thakur77/Strike && cd Strike
make test && make ci-test && make coverage
ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com forge test --root contracts --match-path "test/fork/*"
cargo build --release --example pricer_cli --manifest-path stylus/pricer/Cargo.toml
PRICER_CLI=$PWD/stylus/pricer/target/release/examples/pricer_cli forge test --root contracts --ffi --match-path "test/differential/*"
```
