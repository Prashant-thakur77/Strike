# Decisions

Each entry: the decision, why, and what it affects. Newest last.

## D1 · Fresh `strike` folder (2026-09-28)

The Strike repo lives in `~/projects/strike`. The folder we started in held another project's unlicensed code; nothing from it is copied. **Why:** a clean, original codebase with its own history. **Affects:** everything.

## D2 · MIT license (2026-09-28)

**Why:** judges and integrators can read and reuse `SafeStockFeed`, `MarketCalendar` and the SDK freely, which is the point of ecosystem tooling.

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

The caller passes a round id; the contract checks that round is at or after expiry and the previous round is before it. **Why:** nobody can pick a favourable later print; retries are idempotent.

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
