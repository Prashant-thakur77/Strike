# Judge's tour

Strike is weekly options vaults for Robinhood Chain stock tokens, paid in USDG. An AI agent proposes each week's strike. The contract checks the proposal against the vault's immutable mandate, and if it breaks the rules, the agent's bond is slashed to depositors. v2 is live on Robinhood Chain testnet (46630). It is unaudited.

There are two paths. The first needs a browser. The second needs a clone and about 15 minutes.

Before either path, the README lists [what works, what does not yet, and what we cut](../README.md#what-works-what-does-not-yet-what-we-cut), and [maps each headline claim to one test and one command](../README.md#claims-and-the-tests-that-check-them). In short: v2 runs its first epoch on Robinhood Chain testnet and v3 is deployed next to it; v3 also runs on Arbitrum Sepolia, where Claude planned the first accepted proposal ([log](testnet-epochs/2026-09-30-arbitrum-sepolia.md)); both epochs settle on Friday 2026-10-02; testnet prices come from a keeper-filled `MirrorFeed`; and there is no external audit.

## 3 minutes, no install

1. Watch the [narrated demo walkthrough](media/strike-demo.mp4) (5:13, captioned, with [chapters](submission/demo-script.md#chapters); [without voice](media/strike-demo-silent.mp4)) or the [2-minute pitch](media/strike-pitch.mp4) (2:02, over the deck). Both show v3 live on Arbitrum Sepolia, where Claude planned the accepted proposal.
2. Try the mandate playground: open [strike-options.vercel.app/app/playground](https://strike-options.vercel.app/app/playground), click "Reckless agent", and the deployed `EpochManager.previewProposal` returns `DeltaOutOfBand`. No wallet is needed ([source](../app/src/components/app/playground/PlaygroundPage.tsx)).
3. Open the live epoch from 2026-09-29 on Blockscout ([full log](testnet-epochs/2026-09-29.md)):

   | Step                                                                     | Transaction                                                                                                                           |
   | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
   | `proposeByDelta` accepted: 0.20-delta TSLA call, strike $369.86          | [0x92169eac…a9d4](https://explorer.testnet.chain.robinhood.com/tx/0x92169eac7bd2491d1f22f394e15643d5d54309c1e980683cf82a13088021a9d4) |
   | At-the-money put rejected on-chain (`DeltaOutOfBand`), 10 USDG slashed   | [0x3df523aa…c6a0](https://explorer.testnet.chain.robinhood.com/tx/0x3df523aae815e10cba8f5f99076f9cb348745e7657dd1f1338820af0469dc6a0) |
   | Buyer agent buys 4 calls for 10.005944 USDG                              | [0x425e5b63…e9f9](https://explorer.testnet.chain.robinhood.com/tx/0x425e5b63ddeb1fcff5d63aa9f5a9fd11f4d3c0f52facd05e0fb44096f2ede9f9) |
   | `abortEpoch` pays the slash to the put vault's depositors (20 → 30 USDG) | [0x62442f37…29a7](https://explorer.testnet.chain.robinhood.com/tx/0x62442f37b3601aa5b56d5e991d3199464ba2e60373f70e00892746c053b629a7) |

4. Check agent #1's ERC-8004 identity, #114 on the official testnet Identity Registry: [registration file](agents/strike-agent-1.json), [register tx](https://explorer.testnet.chain.robinhood.com/tx/0x3bb9cad397322da84adbf78fda288dcce9a19318798b63178467899cdf9c7e53), [setIdentity tx](https://explorer.testnet.chain.robinhood.com/tx/0x324e08868492d51986b3da6142031e39ffbb67dcda5a4dbc2613205f35a87125).
5. Open the proof page (`/app/proof`, each claim next to its evidence plus a live feed of `EpochManager` events) and the safety monitor (`/app/monitor`, 8 Robinhood Chain mainnet stock tokens checked live against the `SafeStockFeed` rules). Both are pending the same app URL. In the video they are at 2:09 (monitor) and 2:21 (proof). Source: [ProofPage.tsx](../app/src/components/app/proof/ProofPage.tsx), [MonitorPage.tsx](../app/src/components/app/monitor/MonitorPage.tsx).

## 15 minutes, with a clone

Needs Foundry, Node 22+ with pnpm, and Python 3 ([Quickstart](../README.md#quickstart) has the versions).

```bash
git clone --recursive https://github.com/Prashant-thakur77/Strike && cd Strike
pnpm install
scripts/demo-local.sh   # full epoch on anvil: accept, reject + slash, buy, settle, redeem
make test               # 477 Foundry tests
```

`scripts/demo-local.sh` takes about 15 seconds once the contracts are compiled. `SETTLE_PRICE=400 scripts/demo-local.sh` settles in the money instead. CI runs both.

Formal proofs ([formal-verification.md](security/formal-verification.md)): 9 properties proven with Halmos, 16 more written down and marked unproven.

```bash
pip install halmos==0.3.3
cd contracts
halmos --match-contract Formal --solver-timeout-assertion 300s
```

Fork tests: 9 tests against real Robinhood Chain mainnet TSLA, NVDA and SPY feeds, real USDG and the real ERC-8004 registries ([RobinhoodFork.t.sol](../contracts/test/fork/RobinhoodFork.t.sol), [StockCollateralFork.t.sol](../contracts/test/fork/StockCollateralFork.t.sol)).

```bash
ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com forge test --root contracts --match-path "test/fork/*"
```

Backtest ([backtest.md](backtest.md)): 403 weeks on TSLA, NVDA, AMZN and SPY, 2019 to 2026, about 15 seconds. The 0.20-delta covered call lagged buy-and-hold on every ticker with 25–46% less volatility, and the report opens with that result.

```bash
python3 research/backtest.py
```

Internal security review ([review-2026-09-29.md](security/review-2026-09-29.md)): 11 findings (1 High, 3 Medium, 4 Low, 3 Info), all fixed. Each finding's test first reproduced the attack; the 19 tests now run as regression tests.

```bash
forge test --root contracts --match-path "test/audit/*" -vv
```

Other numbers, from [testing.md](testing.md) and the README's [safety evidence](../README.md#safety-evidence): 99.3% line and 98.8% branch coverage (`make coverage`), 3 differential tests (Stylus against Solidity), 15 Rust tests, 202 TypeScript tests (SDK 109, MCP 49, agents 44), 60 Telegram bot tests, 10 subgraph tests, 106 Playwright tests. The [threat model](threat-model.md) lists 21 threats, each with the test that covers it.

## What each step shows

| Step                                 | Smart contract quality | Product-market fit | Innovation and creativity | Real problem solving | Paxos USDG |
| ------------------------------------ | :--------------------: | :----------------: | :-----------------------: | :------------------: | :--------: |
| Demo video                           |                        |         ✓          |             ✓             |                      |     ✓      |
| Mandate playground                   |           ✓            |                    |             ✓             |                      |            |
| Blockscout epoch (4 txs)             |           ✓            |                    |             ✓             |          ✓           |     ✓      |
| ERC-8004 identity #114               |                        |                    |             ✓             |                      |            |
| Proof page and monitor               |                        |         ✓          |                           |          ✓           |            |
| `scripts/demo-local.sh`              |           ✓            |                    |             ✓             |                      |     ✓      |
| `make test` (477 tests, 99.3% lines) |           ✓            |                    |                           |                      |            |
| Halmos (9 proven, 16 unproven)       |           ✓            |                    |                           |                      |            |
| Fork tests (9, mainnet)              |           ✓            |                    |                           |          ✓           |     ✓      |
| Backtest (403 weeks)                 |                        |         ✓          |                           |          ✓           |            |
| Internal review (11 fixed)           |           ✓            |                    |                           |                      |            |

USDG is the premium, the put collateral, the fee currency and the agent bond, so every slash is paid in USDG ([`Deploy.s.sol`](../contracts/script/Deploy.s.sol#L139) has the real addresses on three networks). The stock-token problems the monitor and fork tests cover are listed in the README's [Why](../README.md#why) table.

## Further reading

| Document                                                                 | What it covers                                                                                          |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| [Hard questions](submission/qa-prep.md)                                  | Twenty likely judge questions (buyers, liquidity, malicious agents, weekend oracles, regulation, money) |
| [Milestones](MILESTONES.md)                                              | The milestone plan for the grant: v3 on two chains, the Stylus risk engine, audit and mainnet, adoption |
| [Past winners](research-winners.md)                                      | What earlier Open House and Stylus winners built, and what Strike took from them                        |
| [Why only here](../README.md#why-only-here-robinhood-chain-and-arbitrum) | Why Strike needs Robinhood Chain and Arbitrum: stock tokens, equity feeds, USDG, ERC-8004, Stylus       |
