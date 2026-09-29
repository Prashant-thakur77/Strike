# Changelog

All notable changes to Strike. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/) (pre-1.0: a minor version may change contract interfaces). Deployed contracts are immutable; a contract change means a new deployment, listed under **Deployments**.

## [Unreleased]

### Added

- Stock-token safety monitor (`/app/monitor`): live Robinhood Chain mainnet data for every stock token with a Chainlink feed (ERC-8056 multiplier, pending changes, both pause flags, feed age, NYSE session) and the `SafeStockFeed` verdict.
- Telegram bot (`bots/telegram`): alerts for epochs opened, proposals accepted and rejected (with the slash), options bought and settlements, read from contract logs; `/vaults`, `/quote`, `/agent`, `/status`.
- CI coverage job (fails below 95% line coverage).
- Tester guide, social posts, accurate prior-art comparison (Stonkhouse, Archer Markets), HackQuest answers within the 300-character limit.

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
