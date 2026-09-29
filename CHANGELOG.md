# Changelog

All notable changes to Strike. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/) (pre-1.0: a minor version may change contract interfaces). Deployed contracts are immutable; a contract change means a new deployment, listed under **Deployments**.

## [Unreleased]

### Added

- Mandate playground (`/app/playground`): anyone can test a proposal against a live testnet vault's mandate without a wallet, through the read-only `EpochManager.previewProposal`. Presets: an honest 0.20-delta call (accepted), a reckless at-the-money put (`DeltaOutOfBand`), an oversized proposal (`SizeTooLarge`) and one at half of fair value (`PremiumBelowFair`); a rejection shows the bond a real proposal would lose.
- Stock-token safety monitor (`/app/monitor`): live Robinhood Chain mainnet data for the 8 stock tokens with a Chainlink feed (TSLA, NVDA, AMZN, PLTR, AMD, SPY, AAPL, QQQ): ERC-8056 multiplier, pending changes, both pause flags, feed age, NYSE session, and the `SafeStockFeed` verdict.
- Proof page (`/app/proof`): every claim with its evidence (verified contracts, the active Stylus pricer, gas, tests, coverage, invariants, formal proofs, the security review).
- Live on-chain activity feed on the proof page and the landing page, read from the `EpochManager` logs on Robinhood Chain testnet.
- Telegram bot (`bots/telegram`, 60 tests): alerts for epochs opened, proposals accepted and rejected (with the slash), options bought and settlements, read from contract logs; `/vaults`, `/quote`, `/agent`, `/status`; a dry run that prints the alerts without a token.
- ERC-8004: agent #1 registered on the official identity registry on Robinhood Chain testnet as identity #114 and linked to `AgentRegistry`, so settled PnL and rejections post to its reputation ([registration file](docs/agents/strike-agent-1.json), [transactions](docs/testnet-epochs/2026-09-29.md#erc-8004-identity-added-2026-09-29-1930-utc)).
- Formal verification with Halmos: 9 properties proven for every input in range (mandate rules, fee caps, NYSE sessions, call payout) in a `formal` CI job; 16 more kept as `unproven_*` and marked not proven ([formal-verification.md](docs/security/formal-verification.md)).
- CI coverage job: fails below 95% line coverage (currently 99.1%).
- Vault page: a payoff chart (buyer's and depositor's result at expiry) and a buy-price breakdown (fair value at the buffered oracle spot, times the premium factor, never below intrinsic value, next to the contract's own quote).
- Repository files: `SECURITY.md` (private vulnerability reporting), `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `CODEOWNERS`, bug report and feature request issue templates (next to the testnet feedback form), a pull request template, Dependabot.
- Tester guide, social posts, accurate prior-art comparison (Stonkhouse, Archer Markets), HackQuest answers within the 300-character limit.

### Changed

- App navigation: Vaults, Playground, Agents, Monitor, Proof, Faucet; the landing page links the playground, monitor and proof page under "Try it without a wallet".
- README rewritten: badges, how it works, safety evidence, gas, deployments with the live epoch, try it, prior art, repository map.
- Submission kit refreshed: HackQuest answers, pitch and demo scripts in the new video's scene order, deck outline with a "Try it" slide, social posts, tester guide starting with the playground.

## [0.6.0] - 2026-09-29

### Security

- Internal adversarial review of every contract: 1 High, 3 Medium, 4 Low, 3 Info, each shown by a failing test. All fixed; the 19 audit tests now run as regression tests ([review](docs/security/review-2026-09-29.md)).
  - H-01: a corporate action near expiry could block settlement. Settlement now moves to the first print after `effectiveAt + grace`.
  - M-01: Chainlink phase changes. The previous phase's last round is required as proof, with no age window.
  - M-02: premium is never below intrinsic value.
  - M-03: buys are priced at spot moved against the buyer by the feed's deviation threshold (`setSpotBuffer`).
  - L-01 to L-04: band-aware strike rounding, proposals judged at the epoch-open snapshot, no emergency cancel once a price is recorded, protocol mandate floors.
  - I-02, I-03: no reputation feedback on transferred identities; keeper sigma changes capped at 25% per hour.

### Added

- `StockOracle.recordSettlementPriceWithHints` and the SDK's `findSettlementHints`; the keeper falls back to it.
- 8-year weekly backtest (TSLA, NVDA, AMZN, SPY) with the protocol's own pricer, and a litepaper.
- First live epoch on Robinhood Chain testnet v2: a 0.20-delta call accepted, a reckless put rejected with 10 USDG slashed, 4 calls bought by a buyer agent ([log](docs/testnet-epochs/2026-09-29.md)).
- Automated 2:40 demo video; audit-readiness package and operations runbook.

### Changed

- Stylus gas re-measured on v2: `proposeByDelta` 3.3× cheaper with the Stylus pricer, same strike.
- `EpochManager.epochs()` returns `openSpot` and `openSigma`; `underlyings()` returns `spotBufferBps` and `sigmaUpdatedAt`.

### Deployments

- Robinhood Chain testnet (46630) **v2**, block 125880607: 14 contracts verified on Blockscout; the verified Stylus pricer is reused ([addresses](contracts/deployments/46630.json)).
- v1 (block 125866639) is superseded ([addresses](contracts/deployments/46630-v1.json)).

## [0.5.0] - 2026-09-29

### Added

- Buyer side for agents: MCP `buy_options`, `redeem_options`, `hedge_plan`; buyer mode in the example agent; a hedge planner in the app.
- App: per-share prices for ERC-8056 tokens, a non-US-person acknowledgement, a testnet feedback form, a mobile network switcher, agent track records.
- Stylus in the production path, measured on a Nitro dev node; reproducible Stylus builds verified with `cargo stylus verify`.
- `SafeStockFeed` / `StockOracle` integration guide for other Robinhood Chain protocols.

### Deployments

- Robinhood Chain testnet (46630) **v1**, verified on Blockscout.

## [0.4.0] - 2026-09-28

### Added

- `@strike/sdk` typed client; Strike MCP server and `STRIKE_SKILL.md`; example strike-picking agent.
- Next.js app: landing page, vault list and detail, agent leaderboard and rejection feed, faucet, option metadata routes; Playwright checks on desktop and mobile.
- Subgraph for vaults, epochs, series, agents, rejections and reputation.
- One-command local demo on anvil, run in CI.

## [0.3.0] - 2026-09-28

### Added

- On-chain strike solving by delta (`proposeByDelta`) in Stylus and Solidity.
- ERC-8004 reputation feedback for settled epochs and rejections.
- Threat model (18 threats), risk model, Slither CI job with triage, coverage report, testnet keeper.

## [0.2.0] - 2026-09-28

### Added

- Core contracts: `StrikeVault` (ERC-4626 with an epoch queue), `EpochManager`, `MandateGuard`, `VaultFactory`, `OptionToken` (ERC-1155), `FeeManager`, `AgentRegistry` (USDG bonds, slashing, ERC-8004 link).
- Oracle layer: `SafeStockFeed`, `StockOracle`, on-chain NYSE `MarketCalendar`.
- Unit, integration, invariant, fork and Rust/Solidity differential tests.
- Deploy scripts for 4663, 46630, 421614 and anvil; testnet-only mocks.

### Fixed

- Processed zero-value queue requests can always be claimed.

## [0.1.0] - 2026-09-28

### Added

- Project skeleton: Foundry workspace, Stylus Black-Scholes pricer crate, pnpm workspace, SDK, MCP, app and subgraph skeletons, CI, design spec and decision log.

[Unreleased]: https://github.com/Prashant-thakur77/Strike/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/Prashant-thakur77/Strike/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/Prashant-thakur77/Strike/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Prashant-thakur77/Strike/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Prashant-thakur77/Strike/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Prashant-thakur77/Strike/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Prashant-thakur77/Strike/releases/tag/v0.1.0
