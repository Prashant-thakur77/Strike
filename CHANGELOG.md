# Changelog

All notable changes to Strike. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/) (pre-1.0: a minor version may change contract interfaces). Deployed contracts are immutable; a contract change means a new deployment, listed under **Deployments**.

## [Unreleased]

### Added

- Example agent: a Claude Code planner for `--llm` ([`src/claudeCode.ts`](agents/example/src/claudeCode.ts)), so Claude can plan on a Claude Pro/Max subscription through `claude -p` instead of an API key. The CLI runs in an empty temp directory with no settings, CLAUDE.md or built-in tools, only the Strike MCP server (`--strict-mcp-config`), `--allowedTools` limited to `vault_state`, `risk_check`, `agent_stats` and `quote`, `--permission-mode dontAsk`, and a `--json-schema` plan with `submit_plan`'s bounds; its Strike server is started read-only without the agent key. `--planner api|claude-code` forces a planner; by default the API is used when `ANTHROPIC_API_KEY` is set, else Claude Code when `claude` is on `PATH` or `CLAUDE_CODE_OAUTH_TOKEN` is set. The decision record names the planner (`decision.planner`, optional, so older records still parse). Checked once on the local devnet: Claude called `vault_state`, `agent_stats` and `risk_check` seven times and chose 0.20 delta at 105% of fair value, which passed the dry run.
- Example agent `--dry-run`: a propose run stops after the final dry run and sends nothing (no agent key needed).
- MCP: `STRIKE_MCP_READ_ONLY=1` registers only the read-only tools over stdio and ignores `STRIKE_AGENT_PRIVATE_KEY`.
- `agent.yml`: with the secret `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) and no `ANTHROPIC_API_KEY`, the weekly propose run installs Claude Code 2.1.263 and plans with `--llm --planner claude-code`.
- Strike v3 on Arbitrum Sepolia (421614), from `v3-contracts` ([D37](docs/decisions.md), [log](docs/testnet-epochs/2026-09-30-arbitrum-sepolia.md)). It uses the real Sepolia USDG, and TSLA and NVDA are `TestStockToken`s whose `MirrorFeed`s are seeded from the mainnet Chainlink round. The 14 contracts and the DecisionLog are verified on Blockscout (the TestStockTokens also on Sourcify). The Stylus risk engine is deployed, activated, cached in ArbOS, checked equal to `BlackScholesRef` on-chain and set as the pricer. Agent #1 is registered with EIP-712 signer consent and ERC-8004 identity #253. A live epoch ran during NYSE hours: Claude planned the covered call through the Claude Code CLI, `proposeByDelta` was accepted with `SeriesRisk`, an at-the-money put was rejected with a 10 USDG slash, a separate buyer bought 4 calls, and both decision records are anchored in the 421614 DecisionLog. `contracts/deployments/421614.json` is the SDK's `421614` entry, so the example agent and MCP server target it with `STRIKE_CHAIN_ID=421614`; `docs/agents/strike-agent-1.json` lists both ERC-8004 registrations.
- `Deploy.s.sol` (branch `v3-contracts`): `SEED_<SYMBOL>` and `SEED_AT_<SYMBOL>` seed a new MirrorFeed with a real round (answer, updatedAt), so the keeper continues from it.

## [0.9.0] - 2026-09-30

### Added

- Live risk panel from the v3 Stylus (Rust) risk engine (`0x61158d98…a4ec`, deployed with v3 on Robinhood Chain testnet), reading the live v2 TSLA covered-call series. SDK `seriesRisk(seriesId | series)`: greeks at the live spot and the epoch's sigma (and the current sigma when it differs), the depositors' exposure (−greeks × sold), the payout over the RiskLens grid (−30%…+30% in 5% steps) with the worst case against the locked collateral, and the implied volatility of the last buy solved by the engine's `impliedVol`; zero greeks after expiry, the last print flagged when the feed is unsafe. `IRiskEngine` and `RiskLens` ABIs and `riskEngine` in the 46630 map. The fixed test vector (the live series) matches an independent scipy Black-Scholes to ~5e-15 and the last buy's implied vol recovers the 60% the contract priced it with. MCP tool `series_risk` (also on `/api/mcp`); a Risk rail on the vault page (four greeks in plain words, stress-test columns with a table view, engine footnote); a v3 card on `/app/proof`.
- SafeStockFeed conformance suite (`contracts/test/conformance/`): an abstract Foundry test, `SafeStockFeedConformance`, that any oracle wrapper inherits by implementing a few hooks (deploy a token/feed pair, push rounds, pause, schedule a multiplier change, warp, read the price). 21 rules, one test each: the multiplier is never applied, staleness, both pause layers, a missing `oraclePaused()`, corporate-action windows, non-positive and future-dated answers, sequencer down and grace, and the settlement round (first at or after the target, phase changes, corporate-action hints). Rules a wrapper does not implement are reported as skipped. `StockOracle` passes 21 of 21; the `StockCollateral` example passes 14 and skips the 7 settlement rules. `SafeStockFeedConformanceWithMocks` wires the hooks to Strike's mocks; docs/safestockfeed.md explains how another protocol runs it (`@strike-test/` remapping, checked in a fresh Foundry project).
- `DecisionLog` (`contracts/src/agents/DecisionLog.sol`), deployed separately on Robinhood Chain testnet at `0xbF94f54fd0258ac59e2f54B70754dFAfFd245D93` (verified on Blockscout): agents anchor the keccak256 hash and URL of each decision record on-chain. Only the agent's current `AgentRegistry` signer may record; a rotated signer loses access. 10 tests, `script/DeployDecisionLog.s.sol`, `decisionLog` in `46630.json` and the SDK ABIs. v2 is unchanged ([decisions.md D35](docs/decisions.md)).
- Example agent `--anchor` (with `--log`): hashes the JSON decision record, calls `DecisionLog.record` with its GitHub URL, and adds the transaction to the record; the weekly `agent.yml` runs with it. The first anchor is the 2026-09-29 live epoch log (tx `0x934ab96b…24c4`).
- docs/gas.md: "Measured on the live chain", the live `proposeByDelta` (574,028 L2 gas, within 0.6% of the dev node) and `buy` receipts next to the dev-node figures, and the Stylus cache check (Robinhood Chain testnet has no CacheManager yet, so no bid and all figures are uncached).

- `docs/DEPLOYMENTS.md`: v1, v2 and the v3 branch with source and deploy commits, deploy blocks, every address with its Blockscout verification status (checked through the Blockscout API on 2026-09-30), the active pricer read with `cast`, the Stylus `cargo stylus verify` result, the live transactions with blocks and times, ERC-8004 identity #114, and a reviewer's checklist of commands.
- Charts from committed data (`scripts/charts/build_charts.py`, light and dark, SVG and PNG): tests by suite, coverage by contract with the CI gate, Solidity vs Stylus gas, backtest equity curves, the live epoch timeline, a competition matrix and a positioning chart. The palette is derived from the site colours and passes the dataviz validator in both modes ([scripts/charts/README.md](scripts/charts/README.md)).
- Competition section with sources: Strike, Stonkhouse, Archer Markets, Ribbon / Aevo, Derive (Lyra) and Thetanuts, from each project's docs and repositories, with "not described" where the docs are silent.

- Agents can join from a URL:
  - `https://strike-options.vercel.app/skill.md` serves `docs/STRIKE_SKILL.md` (embedded at build time) and `/llms.txt` an [llms.txt](https://llmstxt.org) index of Strike: what it is, the agent entry points, the app pages, the testnet contract addresses (from the SDK's deployment map) and the docs.
  - A read-only remote MCP server at `https://strike-options.vercel.app/api/mcp` (Streamable HTTP, stateless: a fresh server per request and JSON answers, so it runs on Vercel serverless). It registers only the read tools (`strike_info`, `list_vaults`, `vault_state`, `quote`, `hedge_plan`, `risk_check`, `agent_stats`) plus the `strike://skill` resource, holds no key and sends nothing. Identical chain reads are shared for 10 seconds per instance (a warm `list_vaults` answers in about 20 ms instead of about 2 s). CORS is open; GET and DELETE get 405.
  - MCP: `createStrikeMcpServer({ readOnly: true, skillText })` and `@strike/mcp/http` (`handleReadOnlyMcpRequest`), reused by the app; `node mcp/scripts/remote-check.mjs [url]` checks an endpoint with the official MCP client.
  - `STRIKE_SKILL.md`: "Connect over HTTP" with Claude Desktop, Claude Code, URL-client and curl examples. The ERC-8004 registration file's MCP endpoint is now the remote URL.
- App: a dismissible **Season 0** banner on `/app/agents`: testnet agents welcome, a four-step checklist (register, bond, run one epoch, file feedback), and links to "Run your own agent" and the feedback form. Dismissal is remembered in the browser and applied before first paint.
- CI: CodeQL for JavaScript/TypeScript (push, pull request, weekly), and a gitleaks secret scan of the whole history on every push and pull request. Its allowlist covers only public addresses and the well-known anvil and nitro devnode dev keys; on the current history it finds nothing else.
- Tests: `app/e2e/mcp.spec.ts` (initialize, the read-only tool list, `list_vaults` and `risk_check` against Robinhood Chain testnet, CORS, `/skill.md`, `/llms.txt`) and `mcp/test/http.test.ts` (read-only registration, the embedded skill, the stateless handler).

### Changed

- Demo and pitch videos re-cut to the pattern of 12 winning hackathon videos (`docs/research-winners.md`): the product on screen from the first second, one continuous journey, a 15-second explorer shot with the slash transfer highlighted, the Rust risk engine on the vault page, one evidence card and the live app URL at the close. Narration by Chatterbox at about 120 words a minute (was 165), checked with Whisper (0.98 word match). Every number is read from README.md at render time (`video/record.mjs`, scenes in `video/demo.mjs` and `video/pitch.mjs`).
- README: "What works, what does not yet, what we cut", a table mapping each headline claim to one test and one command, "Why only here", the put vault against USDG lending, Tilt Protocol in the competition table. New docs: `docs/MILESTONES.md` (grant milestones), `docs/submission/qa-prep.md` (20 judge questions), `docs/research-winners.md`.
- README: screenshot gallery of every page (desktop and mobile), "Evidence in numbers" with the tests, coverage and gas charts and their tables, the live epoch timeline, a backtest section, the competition section in place of Prior art, an architecture diagram, and a "Versions and deployments" timeline.
- Screenshots in `docs/screenshots/` retaken from the current app on the live testnet (landing, vaults, vault, playground, backtest, agents, monitor, proof, faucet at 1440×900 and 390×844); the superseded images were removed.
- Test counts re-measured: 477 Foundry tests passing and 7 skipped (the conformance suite's settlement rules on the `StockCollateral` example), SDK 109, MCP 49, example agents 44, Telegram bot 60, subgraph 10, and Playwright lists 106 tests (212 runs over two viewports): 891 tests and proofs with fork, differential, Halmos and Rust. Coverage 99.3% of lines and 98.8% of branches (`SafeStockFeed` now at 100%).

### Fixed

- SDK: transactions are sent with a 25% gas margin over the estimate, and a mined revert says whether it ran out of gas. The pricer's series expansions run a tenor-dependent number of terms, which is the likely cause of the intermittent CI failure where the dry run passed and the mined `proposeByDelta` reverted.
- Playground: the reckless and cheap presets fall back to the funded vault, so an empty put vault no longer turns them into `ZeroSize`.
- Charts: the gas chart reads only the dev-node tables in `docs/gas.md`, not the live-chain table.

### Deployments

- v3 on Robinhood Chain testnet (46630) next to v2, all contracts verified on Blockscout and the Stylus pricer and risk engine (`0x61158d98…a4ec`) with `cargo stylus verify`: EpochManager `0x256D4546…929F`, AgentRegistry `0x1c427401…052f`, RiskLens `0xFDb8Ba33…Cc6D`, a v3 DecisionLog `0xa98106db…03a4`; the MarketCalendar and MirrorFeeds are shared with v2. Agent #1 registered with EIP-712 signer consent and linked to ERC-8004 identity #114. No vaults yet: they need a bonded agent, which waits on testnet USDG ([log](docs/testnet-epochs/2026-09-30-v3.md), [D36](docs/decisions.md)).
- `DecisionLog` for v2 at `0xbF94f54f…5D93`.
- The v2 put vault's depositor withdrew the 20 USDG deposit and the 10 USDG slash.

## [0.8.0] - 2026-09-30

### Added

- Self-serve agent onboarding: any third-party agent can join without permission (register, bond, run a vault).
  - SDK: `registerAgent` (returns the agent id from `AgentRegistered`), `postBond` (approves USDG first), `createVault` (returns the vault from `VaultCreated`; checks the mandate floors and that the agent exists before sending), `agentRegistryParams`, `identityOwner`, `isUnderlyingAllowed`, `maxDepositCap`, plus `mandateProblems`, `DEFAULT_MANDATE`, `MIN_PREMIUM_FLOOR_BPS` and `MAX_TENOR_CAP`. New error hints for `SignerTaken`, `NotIdentityOwner`, `InvalidMandate`, `UnderlyingNotAllowed` and `DepositCapTooHigh`.
  - MCP: `register_agent` (registers the server's key and optionally bonds) and `create_vault` (a vault on an allowed stock with a mandate and your agent). Both check first (signer free, identity owned, USDG for the bond, minimum bond, allowed token, mandate floors, deposit cap), explain the rules, refuse to send while a check fails, and take `dryRun`.
  - Example agent: `--register [--bond N] [--create-vault TSLA:call|put]`, safe to re-run.
  - App: a **Run your own agent** section on `/app/agents` with the three steps and, behind a fold, a form with live checks (signer not taken, identity owned, USDG balance, the minimum bond) that sends approve, register and postBond from the connected wallet, then a compact vault form with mandate defaults that pass the floors.
  - Docs: "Join as a new agent" in `STRIKE_SKILL.md`, "Run your own agent" in the README.
- `SafeStockFeed` for other builders: `forge install Prashant-thakur77/Strike` plus one remapping (`@strike/=lib/Strike/contracts/src/`) gives any Foundry project the library from the same source as the deployed contracts ([decisions.md D32](docs/decisions.md)).
- Example consumer `contracts/examples/StockCollateral.sol`: stock-token collateral valued with `SafeStockFeed.latest`, a per-share display price (feed ÷ `uiMultiplier`) and comments on why the feed is never multiplied by the multiplier. 14 unit tests with the repo's mocks and 3 fork tests on Robinhood Chain mainnet (real NVDA collateral against the raw feed, all 8 stock feeds, each revert on the real token).

### Changed

- docs/safestockfeed.md: new "Use it in your project" section (install, remapping, a 10-line snippet checked in a fresh Foundry project, the example, what each error means and what to do about it).
- `make fmt`, `make fmt-check` and the CI format step also cover `contracts/examples`.

### Fixed

- App: a `Fold` that starts closed now shows its toggle on wide screens too (it was unreachable above 820px).

## [0.7.0] - 2026-09-30

### Added

- Re-cut 2:43 demo video on live data (playground verdicts, the real testnet epoch with Blockscout, price breakdown and payoff chart, ERC-8004 #114, Telegram alerts, mainnet monitor, proof page), with burned-in captions and an `.srt` for voice-over.
- Autonomous weekly agent (`.github/workflows/agent.yml`): Monday proposals and Friday settlements with published decision records in `docs/agent-log/`.
- Agent decision log on `/app/agents`: each weekly record (market inputs, target and reasoning, the contract's verdict, transactions, track record) read from `docs/agent-log/`.
- On-chain: the put vault's stale epoch was closed and the slashed 10 USDG paid to its depositors (20 → 30 USDG).
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

[Unreleased]: https://github.com/Prashant-thakur77/Strike/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/Prashant-thakur77/Strike/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/Prashant-thakur77/Strike/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/Prashant-thakur77/Strike/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/Prashant-thakur77/Strike/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/Prashant-thakur77/Strike/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Prashant-thakur77/Strike/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Prashant-thakur77/Strike/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Prashant-thakur77/Strike/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Prashant-thakur77/Strike/releases/tag/v0.1.0
