# Decisions

Each entry: the decision, why, and what it affects. Newest last.

## D1 · Fresh `strike` folder (2026-09-28)

The Strike repo lives in `~/projects/strike`. The folder we started in held another project's unlicensed code; nothing from it is copied. **Why:** a clean, original codebase with its own history. **Affects:** everything.

## D2 · MIT license (2026-09-28)

**Why:** auditors and integrators can read and reuse `SafeStockFeed`, `MarketCalendar` and the SDK freely, which is the point of ecosystem tooling.

## D3 · Node 22 LTS, TypeScript 5.9 (2026-09-28)

**Why:** Node 22 is the LTS installed locally and in CI; TypeScript 7 (native port) is too new for Next.js tooling. **Affects:** `.nvmrc`, all JS packages.

## D4 · OpenZeppelin 5.7 plus the upgradeable package (2026-09-28)

Vaults are EIP-1167 clones, which need initializers instead of constructors, so vaults use `ERC4626Upgradeable`. No proxies are upgradeable: clones are immutable. **Affects:** `StrikeVault`, `VaultFactory`.

## D5 · One integer pricing algorithm in two languages (2026-09-28)

`BlackScholesLib.sol` and `stylus/pricer/src/math.rs` run the same WAD integer steps in the same order (atanh-series `ln`, range-reduced Taylor `exp`, Hart/West normal CDF, Newton `sqrt`). **Why:** the differential test can then demand exact equality instead of a loose tolerance, and accuracy is tested once in Rust against closed-form Black-Scholes (< 1e-9 of spot). Zero interest rate and a 365-day year: weekly tenors on a stablecoin make the rate term negligible. **Affects:** pricer, differential suite.

## D6 · No floating point in the Stylus build (2026-09-28)

`ruint::root` uses `f64` internally and Stylus activation rejected it (`ConvertIntOp(F64, I32)`). Replaced with an integer Newton square root. **Affects:** `math.rs`.

## D7 · Strikes and prices per raw token (2026-09-28)

The Chainlink stock feed already includes `uiMultiplier`, so strikes are stored in the feed's unit (per raw token). A split changes neither, so open series need no strike adjustment; sales and settlement pause during the corporate-action window instead. **Why:** removes a whole class of double-multiplier bugs. **Affects:** `SafeStockFeed`, `EpochManager`, app display.

## D8 · Series id includes the vault (2026-09-28)

`id = keccak256(vault, underlying, strike, expiry, isCall)`. **Why:** each vault's settlement escrow is isolated; two vaults selling the same strike cannot drain each other's payouts. Deviates from the plan's id (which omitted the vault).

## D9 · Oracle-anchored premium at buy time (2026-09-28)

The agent proposes `premiumBps` (price as a percentage of fair value); each buy pays fair value _at that moment_ × `premiumBps`. **Why:** a fixed premium set on Monday can be arbitraged by Wednesday if spot moves. **Affects:** `EpochManager.buy`, mandate `minPremiumBps`.

## D10 · Premium escrowed until settlement; fee on positive epoch PnL (2026-09-28)

Premiums sit in the manager during the epoch. At settlement the performance fee is charged on `premium − payout value` only when positive, and the proposing agent gets a share of it. **Why:** fees reward agents for net outcomes, not for selling risky strikes; escrow blocks deposit-just-before-settlement games.

## D11 · Premium paid in USDG through a per-share accumulator, in both vault types (2026-09-28)

**Why:** one code path; call-vault holders get USDG income without a swap; put vault accounting keeps collateral and income separate.

## D12 · Rejected proposals do not revert (2026-09-28)

`proposeSeries` returns `accepted = false`, emits `ProposalRejected(reason)`, slashes the bond to depositors and adds a strike. **Why:** a revert would undo the slash. Agents dry-run with `previewProposal` (the MCP `risk_check` tool) first. Non-mandate failures (market closed, stale feed, unauthorised caller) still revert and never slash.

## D13 · Mandate is immutable per vault (2026-09-28)

**Why:** depositors can trust the exact limits they deposited under; a new mandate means a new vault.

## D14 · Settlement price = first round at or after expiry, via a verified hint (2026-09-28)

The caller passes a round id; the contract checks that round is at or after expiry and the previous round is before it. **Why:** nobody can pick a favourable later print; retries are idempotent. Extended by D30 for aggregator phase changes and corporate actions.

## D15 · Guardian pause never blocks settlement or idle withdrawals (2026-09-28)

Pause stops new epochs, proposals and buys. If the feed dies after expiry, the guardian can cancel after a grace period: collateral returns to the vault and buyers get their premium back. **Why:** funds can always leave; a paused protocol cannot trap depositors.

## D16 · MarketCalendar contract (2026-09-28)

DST-aware NYSE open/close computed on-chain; holidays kept as an admin list (seeded 2026–2027). **Why:** computing Good Friday on-chain is complex; an explicit list is auditable and easy to extend.

## D17 · Subgraph build scripts renamed until Phase 4 (2026-09-28)

`graph build` needs a manifest with deployed addresses; scripts are `graph:*` so `pnpm -r build` stays green until then.

## D18 · App visual style (2026-09-28)

The app's layout, color and motion language follows a reference site the owner chose; screenshots stay in a gitignored `.design-ref/` folder. Strike uses its own copy, logo and imagery.

## D19 · Price checks live in a separate StockOracle contract (2026-09-28)

`SafeStockFeed` is a library; `StockOracle` applies it per registered token, holds the NYSE calendar and records settlement prices once per (token, expiry). **Why:** keeps `EpochManager` under the 24 KB limit (19–21 KB) and gives other Robinhood Chain protocols a deployed, reusable safe-price contract.

## D20 · Real stock-token behaviour, not the spec, decides the interface (2026-09-28)

Function names follow the live tokens on chain 4663 (`uiMultiplier`, `newUIMultiplier`, `effectiveAt`, `paused`, `oraclePaused`). `oraclePaused()` is missing on testnet tokens, so pause checks use `staticcall` and treat a missing function as "not paused". Mainnet feeds have a 24 h heartbeat and 0.5% deviation, so `maxPriceAge` is 25 h per feed rather than 15 min.

## D21 · Testnets get MirrorFeeds (2026-09-28)

Robinhood testnet has stock tokens but no Chainlink feeds; Arbitrum Sepolia has neither. A keeper-updated `MirrorFeed` copies mainnet Chainlink rounds, with full round history so settlement works exactly as on mainnet. Arbitrum Sepolia also gets `TestStockToken`s with a rate-limited faucet. Both are in `src/testnet/` and labelled testnet-only.

## D22 · Stylus is used where it wins: on-chain strike solving (2026-09-28)

Measured on a Nitro dev node: a single `quote` costs 1.1–1.6× more in Stylus (fixed entry cost), `strikeForDelta` (48 evaluations) costs 6.5× less. `EpochManager.proposeByDelta` uses it so an agent's intended delta survives spot moves between signing and inclusion. The table is published as measured, including the case Stylus loses.

## D23 · CI pins Foundry v1.7.1 (2026-09-28)

The latest Foundry formats nested struct literals differently from 1.7.1, which broke `forge fmt --check` in CI. Pinned, and the one affected call rewritten to format identically in both.

## D24 · A fresh testnet deployer key was generated locally (2026-09-28)

`contracts/.env` (gitignored, mode 600) holds a new testnet-only key; the owner only has to fund its address. It must never hold mainnet funds: mainnet deploys use the owner's own key or a Safe.

## D25 · Deploy scripts skip Foundry's simulation on Arbitrum (2026-09-28)

A full rehearsal on an Arbitrum Nitro dev node showed `forge script` broadcasts failing with "intrinsic gas too low": Foundry's local gas estimate omits Arbitrum's L1 data component. All deploy scripts now pass `--skip-simulation --slow`, so each transaction uses the node's `eth_estimateGas`. The same rehearsal fixed Stylus address parsing (the deployment line, not the activation line, which is absent when the WASM is already activated).

## D26 · The app is built with webpack (2026-09-28)

The SDK is consumed from source through its `strike-source` export condition, and its ESM imports use `.js` specifiers for `.ts` files. Turbopack supports neither, so `app` builds with `next build --webpack`. `app/vercel.json` pins the install and build commands.

## D27 · Every review finding is fixed before the live epoch; testnet redeployed as v2 (2026-09-29)

The internal review (docs/security/review-2026-09-29.md) found 1 High, 3 Medium and 4 Low issues, each with a failing test. All are fixed in the contracts and the tests now run as regression tests. Nothing is upgradeable, so Robinhood testnet got a fresh v2 deployment. It reuses the verified Stylus pricer, which is stateless and unchanged. The v1 agent bond (100 USDG) is unbonding (8 days). v2 bonds 60 USDG, which keeps the agent above the 50 USDG minimum after one 10 USDG slash and leaves 40 USDG for the live epoch's put collateral and buyer budget.

## D28 · Proposals are judged against the market at open, not at inclusion (2026-09-29)

The review showed a keeper sigma update or a new print between an agent's dry run and its transaction could slash an honest agent (L-02). Adding expected-market bounds to the proposal ABI was rejected: it would change every agent integration. Instead, `openEpoch` snapshots spot and sigma, and the mandate is checked against that snapshot, so a proposal's verdict is fully determined when the agent dry-runs it. The live feed must still be healthy, and a proposal whose strike live spot has already crossed reverts instead (no slash, nothing sold in the money). `proposeByDelta` also solves against the snapshot, so the agent knows the exact strike before sending. Sales still price off the live spot.

## D29 · Sales are priced conservatively: spot buffer and intrinsic floor (2026-09-29)

Chainlink stock feeds print on a 0.5% move, so the market can be up to 0.5% from the last print with no new round. Buys therefore price fair value at spot moved 50 bps against the buyer (`setSpotBuffer`, per token, capped at 200 bps). They also never charge less than intrinsic value, since a mandate may allow premiumBps down to 90%. Both only ever raise the premium.

## D30 · Hard settlement cases get a hinted recorder, not a new settle signature (2026-09-29)

An aggregator phase change or a corporate action near expiry needs more than one round of proof. `StockOracle.recordSettlementPriceWithHints` takes them. `EpochManager.settle(vault, roundId)` keeps its signature and reads the recorded price, so the keeper, the MCP tools and the app do not change in the common case. The SDK finds the hints (`findSettlementHints`) and records the price first only when needed.

## D31 · Weekly performance fee without a high-water mark (2026-09-29)

The backtest showed the weekly fee takes about 8% of gross premium even over stretches where buyers were paid more than the premium collected. A per-vault loss carry-forward needs the vault in the fee call, which is an `EpochManager` change. It is on the roadmap for the next version and stated as a known issue in audit-readiness.md, rather than being rushed into v2.

## D32 · SafeStockFeed ships from `contracts/src` through one remapping, not a package copy (2026-09-30)

Other builders get `SafeStockFeed` with `forge install Prashant-thakur77/Strike` and one line, `@strike/=lib/Strike/contracts/src/`. The example consumer lives in `contracts/examples/`, its unit tests in `contracts/test/examples/` and its fork test in `contracts/test/fork/`. A standalone `packages/safestockfeed/` was rejected. Its sources would have to be symlinks (lost on Windows checkouts and by a plain copy) or re-export files that reach out of the package root. It would also need its own CI job. A barrel file in `contracts/src` would save one import line but adds a file to the deployed tree. Adding `@strike/` to Strike's own `remappings.txt` was rejected too: solc writes remappings into every contract's metadata, so the deployed bytecode could no longer be reproduced. **Why:** one source of truth. Integrators compile the exact files the live `StockOracle` was verified from, and the new tests run in the existing `forge test` and fork jobs. **Affects:** `contracts/examples/`, docs/safestockfeed.md, the Makefile and CI format steps (`forge fmt` only covers `src`, `test` and `script` by default).

## D33 · Agent onboarding ships on the v2 contracts; their rough edges wait for the next version (2026-09-30)

Third-party agents can register, bond and create vaults through the SDK, MCP, the example agent and the app, without a contract change (the live epoch keeps its v2 history). Building it exposed four contract limits: a signer can be registered without its consent (griefing only), `createVault` accepts any agent id, `InvalidMandate` has no reason, and nothing indexes agents by owner. The tooling covers each (fresh-key advice, checks and warnings before sending, the rules re-checked off-chain, a scan). The next contract version adds an EIP-712 signer consent, an active-agent check in `createVault`, a reason code and an owner index. Listed as known issues in audit-readiness.md.

## D34 · v3 fixes live on a branch until the testnet run ends (2026-09-30)

D31 and D33 are implemented on `v3-contracts` (fee high-water mark, EIP-712 signer consent, active-agent check, `InvalidMandate(reason)`), with 475 tests and new invariants and formal properties. `main` stays byte-for-byte on the deployed v2 source, so the verified Blockscout code, the SDK ABIs and the live epoch history all agree. v3 ships as a new deployment once the testnet run is over; the interface changes the SDK, MCP and app need are listed in the branch's CHANGELOG.

## D35 · Decision records are anchored by a separate DecisionLog contract, not by v2 (2026-09-30)

The weekly agent publishes a decision record per vault in `docs/agent-log`, but a file in a repository can be rewritten after the fact. `DecisionLog.record(agentId, vault, epoch, recordHash, uri)` commits each record's keccak256 hash and URL on-chain at the time of the decision. It is a new, separately deployed contract (`0xbF94f54f…5D93` on 46630) that reads `signerOf` from the live v2 AgentRegistry. Putting the hash into `proposeByDelta` or the AgentRegistry was rejected: v2 is immutable, `main` must stay byte-for-byte on the verified v2 source (D34), and records also cover runs that send no protocol transaction (a dry run that failed, a keeper settlement). Authorising by the registry's current signer, not a stored owner, means a signer rotation revokes the old key in the log at the same moment. The hash covers the JSON as written before anchoring: the anchoring transaction cannot be inside the bytes it hashes, so the published record carries it in `transactions` and `anchor`, and verification drops both first. A failed anchor never blocks writing the record. **Why:** tamper evidence for the agent log without redeploying the protocol. **Affects:** `contracts/src/agents/DecisionLog.sol`, `agents/example` (`--anchor`), `agent.yml`, `46630.json` (`decisionLog`), the SDK ABIs.

## D36 · v3 is deployed next to v2; `main` switches after v2's Friday settlement (2026-09-30)

v3 (the `v3-contracts` branch: fee high-water mark, EIP-712 signer consent, active-agent check, `InvalidMandate(reason)`, the Stylus risk engine with `SeriesRisk` and `RiskLens`) is deployed on Robinhood Chain testnet as a second, independent set of contracts, with its own AgentRegistry, EpochManager, vaults and DecisionLog. This changes D34's order (v3 after the testnet run): an epoch opened on Wednesday expires on the same Friday as v2's, so both versions settle in the same week and v3 runs live instead of as branch code. v2 is not touched: its covered-call series settles on Friday 2026-10-02 at 20:00 UTC as planned. After that settlement `main` merges `v3-contracts` and the SDK, MCP, app and subgraph switch to `46630-v3.json`; v2 stays readable as an archived version and its source stays at tag `v0.8.0`, which the verified Blockscout code matches. v3 reuses v2's `MarketCalendar` (identical source) and its five `MirrorFeed`s, so one keeper serves both. Agent #1 on v3 signs with its own key, registered through the new consent path. **Why:** the v3 changes are the main contract work since v2, and only a live deployment shows them working. **Affects:** `contracts/deployments/46630-v3.json` (branch), DEPLOYMENTS.md, `docs/testnet-epochs/2026-09-30-v3.md`, the cycle 9 plan (9.4 after Friday).

## D37 · v3 also runs on Arbitrum Sepolia, with test stock tokens (2026-09-30)

The same v3 contracts (`v3-contracts`, contract source unchanged since `6e43348`) are deployed on Arbitrum Sepolia (chain 421614) as a second live network next to Robinhood Chain testnet, from the 421614 configuration that `Deploy.s.sol` already had: the real Sepolia USDG (Paxos, `0xFFC95faa…1892`), and TSLA and NVDA as `TestStockToken`s with a faucet, because Robinhood's stock tokens do not exist on Arbitrum Sepolia. Their `MirrorFeed`s copy the Robinhood Chain mainnet Chainlink rounds, like the Robinhood testnet feeds; a new `SEED_<SYMBOL>`/`SEED_AT_<SYMBOL>` option seeds each feed with the mainnet round current at deploy time, so the keeper continues from a real price instead of the placeholder. The Stylus pricer and risk engine is deployed, activated and verified on 421614 the same way, and the EpochManager is switched to it after the on-chain equality check. Agent #1 is registered with EIP-712 signer consent and linked to its own ERC-8004 identity on the official Identity Registry, which has the same address on both chains; the registration file lists both identities. The deployment is `contracts/deployments/421614.json` (the chain has no older version, so no `-v3` suffix), which is also the SDK's `421614` entry, so the example agent and the MCP server target it with `STRIKE_CHAIN_ID=421614`. **Why:** Arbitrum Sepolia is where Stylus and the Arbitrum tooling (CacheManager, Arbiscan, Blockscout) are standard, so the Stylus risk engine and the agent loop can be checked on a second, independent chain; the stock tokens are the only testnet stand-in. **Affects:** `contracts/deployments/421614.json` (branch and `main`), `sdk/src/deployments.generated.ts`, DEPLOYMENTS.md, `docs/testnet-epochs/2026-09-30-arbitrum-sepolia.md`, `docs/agents/strike-agent-1.json`.

## D38 · A team-funded test-USDG faucet on Robinhood Chain testnet (2026-10-01)

Testers need USDG for a first transaction (a put deposit, an option buy, an agent bond), and the only source was Paxos's faucet, which stalled for about a day on 30 September to 1 October. `UsdgDrip` (`contracts/src/testnet/UsdgDrip.sol`, `0x1f37…5632` on 46630) holds real testnet USDG that the team puts in and hands 10 USDG to any address once per 24 hours; `TooSoon(next)` and `Empty()` say why a drip fails, and the app decodes them ("again at 14:05"). The wallet sends `drip()` itself, so there is no server, API route or hot key handing out tokens: nothing to rate-limit, and nothing to leak. The contract only moves USDG the team gave it, so a drained faucet costs testnet USDG and nothing else; the owner can `sweep` what is left. Minting was not an option (we do not control Paxos USDG), and a Strike `TestUSDG` would split liquidity from the real token the vaults use. It is testnet only (`DeployUsdgDrip.s.sol` refuses chain 4663), a new file next to the other testnet contracts, so `main`'s protocol source stays byte-identical to verified v2 (D34). It was funded with 100 USDG (ten testers a day) and is refilled by hand. **Why:** a tester's first transaction should not depend on a third-party faucet. **Affects:** `contracts/src/testnet/UsdgDrip.sol`, `46630.json` (`usdgDrip`), the SDK (`usdgDripAbi`, `STRIKE_USDG_DRIP`), the app's faucet and vault pages, the local devnet, DEPLOYMENTS.md, testers.md.

## D39 · Alchemy behind a server-side, read-only proxy, with the public RPCs as fallback (2026-10-02)

The public RPCs (`rpc.testnet.chain.robinhood.com`, `sepolia-rollup.arbitrum.io/rpc`, `rpc.mainnet.chain.robinhood.com`) rate-limited us this week: Cloudflare 403s in the CI fork tests and empty keeper reads. Alchemy serves all three chains (`robinhood-testnet`, `arb-sepolia`, `robinhood-mainnet`). The app does not get the key as a `NEXT_PUBLIC_` variable: that would put it in every visitor's bundle, where anyone could copy it and spend its quota on any method. Instead `POST /api/rpc/<chainId>` keeps it on the server and forwards only 15 read methods (no `eth_sendRawTransaction`: wallets send their own transactions), batches of up to 100 calls and bodies up to 256 kB. It reuses a call for 30 s per instance only when the call is pinned to a block (never at `latest`, so a read right after a transaction never sees the state before it), and sends no CORS headers, so other sites' pages cannot use it as a free RPC. Each call falls back to the public RPC when Alchemy is down, rate-limits or refuses it: the free tier caps `eth_getLogs` at 10 blocks, so the app's long log scans land on the public RPC there. A revert is the chain's answer and goes straight back. Browsers use the proxy only when the build saw the key (`NEXT_PUBLIC_STRIKE_RPC_PROXY`, a flag, never the key). Without a key they keep reading the public RPC directly, so visitors are not all funnelled through Vercel's IPs into the same rate limit. Everywhere else (SDK, MCP server, example agent, Telegram bot) the SDK's `rpcEndpointsFor` sends the key in an `Authorization: Bearer` header, not in the URL, because viem prints request URLs in its error messages, and those reach logs, MCP tool answers and the decision records committed to this repository. A loopback `STRIKE_RPC_URL` (a fork rehearsal) is never swapped for a live provider, so a rehearsal cannot send to a real chain. Shell scripts need a URL for `cast`, so `scripts/rpc.sh` builds one and checks it with `eth_chainId` first; GitHub masks the key in CI logs. The proxy is still an open read endpoint on our quota: its limits bound what abuse can cost, and Alchemy's method and contract allowlists or a per-IP rate limit are the next step if it is abused. **Why:** reliable reads without shipping the key to browsers or into the repository, and nothing breaks without a key. **Affects:** `app/src/app/api/rpc/[chainId]/route.ts`, `app/src/lib/rpc/`, `sdk/src/rpc.ts`, `scripts/rpc.sh`, the MCP server, the example agent, the Telegram bot, the keeper and weekly agent, `ci.yml`, `keeper.yml`, `agent.yml`, `/app/proof`.

## D40 · A price mirror audit makes the testnet prices checkable (2026-10-02)

On Robinhood Chain testnet and Arbitrum Sepolia there are no Chainlink stock feeds, so Strike's prices come from `MirrorFeed`s that our keeper fills with Robinhood Chain mainnet Chainlink rounds. That was the one input a depositor still had to take on our word: a dishonest keeper could push a price the mainnet feed never printed and settle a vault at it. We considered three ways to shrink what has to be trusted:

1. **Mirror audit (chosen).** Check every testnet round against the mainnet Chainlink round it claims to copy: the mainnet round with the same `updatedAt` must exist and carry the same answer. A script anyone can run without a key (`scripts/verify-mirror.mjs`), the SDK's `auditMirror` and `auditSettlement`, `GET /api/mirror-audit` and a "Price mirror audit" section on `/app/proof`, with a one-line badge under the spot price on each testnet vault page.
2. **Admin-action audit.** List every privileged call since deployment (pricer, spot buffer, roles, pause, feeds) and show that nothing changed. Rejected as the main mechanism: the admin powers are already visible on Blockscout as events, none of them can change a mandate, and none can change a settlement price once it is recorded. The admin powers that touch settlement, pointing a token's `StockOracle` at another feed (`setFeed`) or the EpochManager at another oracle (`setOracle`), let a compromised admin choose the price before it is recorded (the adversarial suite's ["Not defended in code"](security/adversarial.md#not-defended-in-code) list; [threat model](threat-model.md) T17). The mirror audit covers them instead: it checks that each EpochManager reads its recorded oracle and each oracle the feed it audits, which detects a swap but does not prevent it.
3. **Proof that the agent's reasoning is the model's.** Rejected: nothing can prove that a model produced a text. The anchored decision record already proves that the text existed before the proposal, and the contract judges the proposal, not the text.

**Why the mirror audit:** it turns the last trusted input into a public check, and it is the input settlement depends on. The first runs (12:12 UTC, before Friday's expiry) found 66 of 66 keeper rounds matching on 46630 and 23 of 23 on 421614 ([log](testnet-epochs/2026-10-02-mirror-audit.md)). They also found what the audit does not excuse: round 1 of each 46630 feed is the seed price `Deploy.s.sol` pushed when it created the feed, not a mainnet print. The audit lists those four seeds apart (round 1 equal to the script's committed seed, nothing else) and no vault opened an epoch at one. The `--settlement <vault>` mode checks the specific round a series settled at (or will settle at), the one a depositor cares about, and says whether it is mainnet's first print after expiry.

**What stays trusted:** when the keeper pushes. A keeper that withholds prints and pushes a later, real one passes the audit; the audit shows the largest gap between pushes and how many mainnet prints each feed's keeper mirrored, and for a settlement whether earlier post-expiry prints were skipped. The full table of what is trusted and what is checked is [trust-model.md](trust-model.md). **Affects:** `sdk/src/mirror.ts`, `scripts/verify-mirror.mjs`, `app/src/app/api/mirror-audit/route.ts`, `app/src/lib/mirrorAudit.ts`, `/app/proof`, the vault page, `docs/trust-model.md`, the README.
