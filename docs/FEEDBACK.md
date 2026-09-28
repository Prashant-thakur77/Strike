# Builder feedback

Notes for the Arbitrum and Robinhood Chain teams from building Strike during the Open House Singapore buildathon. Each item is something we hit, with what would have helped.

## Robinhood Chain

1. **Testnet tokens do not match mainnet.** `oraclePaused()` exists on the mainnet stock tokens but reverts on the testnet ones, so code that works on testnet can behave differently on mainnet and the reverse. We call it with a defensive `staticcall`. Deploying the same token implementation on both networks would remove the surprise.
2. **No Chainlink stock feeds on testnet.** Anything priced in stock tokens needs mock feeds on 46630. We wrote a `MirrorFeed` that copies mainnet rounds with their timestamps. An official mirrored feed on testnet (even a delayed one) would let every team test settlement logic against realistic data.
3. **No official list of testnet token addresses.** We found TSLA, AMZN, PLTR, NFLX and AMD on testnet through third-party repos and on-chain checks. A testnet section on docs.robinhood.com/chain/contracts would help.
4. **ERC-8056 naming differs from the spec.** The live tokens emit `TransferWithScaledUI` (the draft says `TransferWithUIAmount`) and do not implement `toUIAmount` / `fromUIAmount`. Worth documenting next to the token addresses.
5. **Say plainly that Chainlink prices include the multiplier.** This is the most dangerous integration mistake with stock tokens (applying the multiplier twice). A one-line warning on the feeds page, with the NVDA example (multiplier 1.000775), would prevent it.
6. **Heartbeat guidance.** The stock feeds have a 24-hour heartbeat and a 0.5% deviation threshold, so a "15 minute staleness" rule rejects valid prices on quiet days. Recommended `maxPriceAge` values per feed would help.

## Arbitrum Stylus

1. **Floating point fails late and cryptically.** `ruint`'s `root()` uses `f64` internally. `cargo stylus check` builds fine, then activation fails with `No implementation for floating point operation ConvertIntOp(F64, I32, false)` and no source location. A lint in `cargo stylus check` that points at the Rust function using floats would save time.
2. **The entry cost decides whether Stylus is worth it.** A single Black-Scholes quote costs ~40k gas in Stylus against ~34k in Solidity; 48 quotes in one call cost 0.24M against 1.5M, and a full protocol transaction built on them 0.59M against 1.91M. Publishing typical entry costs (cached and uncached) would help teams decide where to use Stylus before building.
3. **`forge script` fails on Arbitrum with "intrinsic gas too low".** Foundry's local simulation sets each transaction's gas without Arbitrum's L1 data component, so every broadcast fails (4 retries) even with `--gas-estimate-multiplier 300`. `--skip-simulation`, which uses the node's `eth_estimateGas`, works. A line on this in the Arbitrum Foundry docs, or a starter template that sets it, would save every team an hour.
4. **`cast send --json` drops `gasUsedForL1`.** The raw receipt has it; the formatted one does not, so gas comparisons silently include the L1 charge (a `buy` looked like 2.28M gas instead of 0.30M).
5. **No cache manager on the Nitro dev node.** `cargo stylus cache bid` fails on `nitro-devnode`, so cached-call gas cannot be measured locally.

## Tooling

1. **Foundry formatter drift.** Different Foundry versions format nested struct literals differently, which breaks `forge fmt --check` in CI unless the version is pinned. Not Arbitrum-specific, but worth a line in any starter template.
