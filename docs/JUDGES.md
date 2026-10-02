# Judge's tour

Strike is weekly options vaults for Robinhood Chain stock tokens, paid in USDG. An AI agent proposes each week's strike. The contract checks the proposal against the vault's immutable mandate, and if it breaks the rules, the agent's bond is slashed to depositors. v2 and v3 are live on Robinhood Chain testnet (46630) and v3 on Arbitrum Sepolia (421614). It is unaudited.

We are building Strike as a company on Robinhood Chain and Arbitrum, and these testnets are where it starts: the next steps are an external audit and a capped mainnet vault, and we keep the testnet vaults running every week after the buildathon either way. The plan, the business model and what funding buys are in the README's [Building Strike as a company](../README.md#building-strike-as-a-company).

## How Strike maps to the judging criteria

| Criterion                  | What Strike does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Innovation                 | The agent names a target delta and the contract solves, prices and checks the strike itself, so the agent never holds vault funds or sets a price. `SafeStockFeed` turns the stock-token traps (the ERC-8056 multiplier, frozen weekend feeds, two pause flags, splits) into one checked read that any Robinhood Chain protocol can reuse.                                                                                                                                                                                                                                                          | [`EpochManager.sol`](../contracts/src/core/EpochManager.sol), [playground](https://strike-options.vercel.app/app/playground), [SafeStockFeed guide](safestockfeed.md), [conformance suite](../contracts/test/conformance), [litepaper](litepaper.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Technical implementation   | 477 Foundry tests at 99.3% line coverage, invariants, 9 properties proven with Halmos, fork tests against Robinhood Chain mainnet feeds, and an internal review whose 11 findings are all fixed with regression tests. CI also runs a whole epoch on anvil with `scripts/demo-local.sh`.                                                                                                                                                                                                                                                                                                            | [testing.md](testing.md), [formal verification](security/formal-verification.md), [internal review](security/review-2026-09-29.md), [adversarial tests](../contracts/test/adversarial), [`demo-local.sh`](../scripts/demo-local.sh), [CI workflow](../.github/workflows/ci.yml), [technical note](technical-note.md), [endpoints](ENDPOINTS.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Use of Arbitrum technology | The strike solver and the v3 risk engine are Rust on Stylus: solving a strike costs 6.5× less gas than in Solidity and a whole proposal 3.3× less, the deployed program matches this source under `cargo stylus verify`, and caching it on Arbitrum Sepolia took about 19,800 gas off each call. The same contracts run on Robinhood Chain testnet, an Arbitrum chain ([Arbitrum blog](https://blog.arbitrum.io/robinhood-chain-testnet/)), and on Arbitrum Sepolia, and agent #1 holds ERC-8004 identities #114 and #253, to which v3 posts −10 feedback whenever the contract rejects a proposal. | [sponsor technology](sponsor-tech.md), [gas.md](gas.md), [`math.rs`](../stylus/pricer/src/math.rs), [`risk.rs`](https://github.com/Prashant-thakur77/Strike/blob/v3-contracts/stylus/pricer/src/risk.rs), [verification](DEPLOYMENTS.md#stylus-pricer-verification), [cache bid tx](https://sepolia.arbiscan.io/tx/0x5b1d2385b65c8a9487cb544ac9a187796a7af920950e50e80461fb7857cf596f), [Arbitrum Sepolia log](testnet-epochs/2026-09-30-arbitrum-sepolia.md), [ERC-8004 #114](DEPLOYMENTS.md#erc-8004-identity-114)                                                                                                                                                                                                                                                                                                                                  |
| Potential impact           | The plan is to build Strike as a company: an external audit, then a capped mainnet vault on Robinhood Chain, earning 10% of each week's positive net premium, with four grant milestones ($30,000 requested) that each end in something checkable on-chain or on GitHub. The README lists what Robinhood Chain, Arbitrum and Paxos get, and the SDK and MCP server are on npm for wallets and agents.                                                                                                                                                                                               | [Building Strike as a company](../README.md#building-strike-as-a-company), [partner table](../README.md#what-robinhood-chain-arbitrum-and-paxos-get-if-strike-keeps-building), [MILESTONES.md](MILESTONES.md), [`@strike-options/sdk`](https://www.npmjs.com/package/@strike-options/sdk)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Presentation quality       | A 5:13 narrated demo with chapters, a 2:02 pitch, a README that says what works, what does not yet and what was cut, and a 16-slide deck shared separately. The playground and the proof page on the live app need no wallet.                                                                                                                                                                                                                                                                                                                                                                       | [demo](media/strike-demo.mp4), [chapters](submission/demo-script.md#chapters), [pitch](media/strike-pitch.mp4), [README](../README.md#what-works-what-does-not-yet-what-we-cut), [live app](https://strike-options.vercel.app)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Novelty                    | An AI agent is held to an on-chain mandate: the contract rejects a proposal outside it and pays 10 USDG of the agent's bond to the vault's depositors. Each decision record is hash-anchored in a `DecisionLog` contract, and the vault page rebuilds the hash in the browser and checks it against the anchor. On the testnets, every price the keeper mirrors is checked round by round against Robinhood Chain mainnet Chainlink, from the app, an API and a CLI: 66 of 66 rounds on 46630 and 23 of 23 on 421614 on 2 October, and a fabricated round pushed on a fork was caught.              | [rejection and slash](https://explorer.testnet.chain.robinhood.com/tx/0x3df523aae815e10cba8f5f99076f9cb348745e7657dd1f1338820af0469dc6a0), [slash paid to depositors](https://explorer.testnet.chain.robinhood.com/tx/0x62442f37b3601aa5b56d5e991d3199464ba2e60373f70e00892746c053b629a7), [`MandateGuard.sol`](../contracts/src/libraries/MandateGuard.sol), [`AgentMandate.t.sol`](../contracts/test/integration/AgentMandate.t.sol), [`DecisionLog.sol`](../contracts/src/agents/DecisionLog.sol), [agent log](agent-log/README.md), [`whyStrike.ts`](../app/src/lib/whyStrike.ts), [`why.spec.ts`](../app/e2e/why.spec.ts), [price mirror audit](https://strike-options.vercel.app/app/proof#mirror), [`verify-mirror.mjs`](../scripts/verify-mirror.mjs), [first runs](testnet-epochs/2026-10-02-mirror-audit.md), [trust model](trust-model.md) |

For the design in one read, see the [technical note](technical-note.md); for each sponsor technology with its code and a transaction, [sponsor-tech.md](sponsor-tech.md); for every API, MCP tool and bot command, [ENDPOINTS.md](ENDPOINTS.md); for what is planned and not built, the README's [Not built yet](../README.md#not-built-yet).

There are two paths. The first needs a browser. The second needs a clone and about 15 minutes.

Before either path, the README lists [what works, what does not yet, and what we cut](../README.md#what-works-what-does-not-yet-what-we-cut), and [maps each headline claim to one test and one command](../README.md#claims-and-the-tests-that-check-them). In short: v2 runs its first epoch on Robinhood Chain testnet, and v3 runs next to it with its own epoch from 1 October ([log](testnet-epochs/2026-09-30-v3.md#7-live-epoch-1-october), [vault page](https://strike-options.vercel.app/app/vault/0x478E7BC3C3aB07fdd104e4765F178977adEe6285?chain=46630)); v3 also runs on Arbitrum Sepolia ([log](testnet-epochs/2026-09-30-arbitrum-sepolia.md)); Claude planned the accepted proposal in both v3 epochs; all three epochs settle on Friday 2026-10-02; testnet prices come from a keeper-filled `MirrorFeed`; and there is no external audit.

## What works any time, and what needs NYSE hours

Two calls check the market: `EpochManager.openEpoch` and `buy` revert with `MarketClosed` outside an NYSE regular session ([`_requireMarketOpen`](../contracts/src/core/EpochManager.sol#L756), [`MarketCalendar.sol`](../contracts/src/oracle/MarketCalendar.sol)). Nothing else does. Judging falls mostly on weekends and Singapore evenings, when the market is closed, so the app states it: the vault page, the playground and the vault list say whether the market is open now and when it reopens, in UTC and in your own time zone, read from the deployed `MarketCalendar` (`isTradingDay`, `sessionOf`).

**Works any time**

- The mandate playground: `previewProposal` is a view with no market check.
- The proof page: the evidence, the price mirror audit and the live activity feed.
- The vault page's record check ("Why this strike" rebuilds the decision record's hash and finds it in its `DecisionLog` anchor), the risk panel and the payoff chart.
- The quote: `quoteBuy` is a view, so the buy panel shows a read-only quote while the market is closed, as long as the price feed is fresh (25 hours on these deployments). Past that limit the panel says why there is no quote.
- The faucet page, agent registration on `/app/agents`, deposits and withdrawal requests (they queue while an epoch runs).
- The monitor, and every Blockscout and Arbiscan link below.
- Settlement: anyone can call `settle` once a series has expired.

**Needs NYSE hours: 13:30–20:00 UTC, which is 21:30–04:00 Singapore time**, Monday to Friday except NYSE holidays (the session moves an hour later when US daylight saving ends on 1 November)

- Buying an option with `buy`, on a vault that is selling a series with options left. Sales stop an hour before expiry (Friday 20:00 UTC).
- Opening an epoch with `openEpoch`, which the keeper or the vault's agent sends; [`agent.yml`](../.github/workflows/agent.yml) schedules it for Mondays at 15:00 UTC (23:00 Singapore time).

## 3 minutes, no install

Every step here works at any hour.

1. Watch the [narrated demo walkthrough](media/strike-demo.mp4) (5:13, captioned, with [chapters](submission/demo-script.md#chapters); [without voice](media/strike-demo-silent.mp4)) or the [2-minute pitch](media/strike-pitch.mp4) (2:02, over the deck). Both show v3 live on Arbitrum Sepolia, where Claude planned the accepted proposal.
2. Try the mandate playground: open [strike-options.vercel.app/app/playground](https://strike-options.vercel.app/app/playground), click "Reckless agent", and the deployed `EpochManager.previewProposal` returns `DeltaOutOfBand`. No wallet is needed ([source](../app/src/components/app/playground/PlaygroundPage.tsx)).
3. Open the live epoch from 2026-09-29 on Blockscout ([full log](testnet-epochs/2026-09-29.md)):

   | Step                                                                     | Transaction                                                                                                                           |
   | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
   | `proposeByDelta` accepted: 0.20-delta TSLA call, strike $369.86          | [0x92169eac…a9d4](https://explorer.testnet.chain.robinhood.com/tx/0x92169eac7bd2491d1f22f394e15643d5d54309c1e980683cf82a13088021a9d4) |
   | At-the-money put rejected on-chain (`DeltaOutOfBand`), 10 USDG slashed   | [0x3df523aa…c6a0](https://explorer.testnet.chain.robinhood.com/tx/0x3df523aae815e10cba8f5f99076f9cb348745e7657dd1f1338820af0469dc6a0) |
   | Buyer agent buys 4 calls for 10.005944 USDG                              | [0x425e5b63…e9f9](https://explorer.testnet.chain.robinhood.com/tx/0x425e5b63ddeb1fcff5d63aa9f5a9fd11f4d3c0f52facd05e0fb44096f2ede9f9) |
   | `abortEpoch` pays the slash to the put vault's depositors (20 → 30 USDG) | [0x62442f37…29a7](https://explorer.testnet.chain.robinhood.com/tx/0x62442f37b3601aa5b56d5e991d3199464ba2e60373f70e00892746c053b629a7) |

   The same week, every step from deposit to settlement with its transaction, block and amount, is one record read from the chain: [`46630-v2-2026-10-02.json`](evidence/46630-v2-2026-10-02.json) (all three deployments: [docs/evidence](evidence/README.md)). CI fetches every transaction this tour cites and checks it against its chain ([`check-claims.mjs`](../scripts/check-claims.mjs)).

4. Check agent #1's ERC-8004 identity, #114 on the official testnet Identity Registry: [registration file](agents/strike-agent-1.json), [register tx](https://explorer.testnet.chain.robinhood.com/tx/0x3bb9cad397322da84adbf78fda288dcce9a19318798b63178467899cdf9c7e53), [setIdentity tx](https://explorer.testnet.chain.robinhood.com/tx/0x324e08868492d51986b3da6142031e39ffbb67dcda5a4dbc2613205f35a87125). Agent #2 joined the way an outsider would, from a fresh wallet through the app's "Run your own agent" form, as identity #116 with its own conservative put vault: [registration file](agents/strike-agent-2.json), [ERC-8004 register tx](https://explorer.testnet.chain.robinhood.com/tx/0x46b6e7961426769c44169faea5705990b96e25d9d6f7d95feb2b0e4842b4c033), [log with every transaction](testnet-epochs/2026-10-01-agent2.md).
5. Open the proof page (`/app/proof`, each claim next to its evidence plus a live feed of `EpochManager` events) and the safety monitor (`/app/monitor`, 8 Robinhood Chain mainnet stock tokens checked live against the `SafeStockFeed` rules). Both are live on the app. In the demo video the monitor is at 3:48 and the proof page at 4:13. Source: [ProofPage.tsx](../app/src/components/app/proof/ProofPage.tsx), [MonitorPage.tsx](../app/src/components/app/monitor/MonitorPage.tsx).

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

Other numbers, from [testing.md](testing.md) and the README's [safety evidence](../README.md#safety-evidence): 99.3% line and 98.8% branch coverage (`make coverage`), 3 differential tests (Stylus against Solidity), 15 Rust tests, 259 TypeScript tests (SDK 140, MCP 59, agents 60; 2 more SDK tests are opt-in live checks), 60 Telegram bot tests, 10 subgraph tests, 151 Playwright tests per viewport (119 run by default; 32 are the opt-in UI audit). The [threat model](threat-model.md) lists 25 threats, each with the test that covers it. These counts predate the adversarial suite, the mirror audit and the indexer; the [technical note](technical-note.md#4-what-is-tested-and-how) has the counts rerun on 2 October.

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

| Document                                                                 | What it covers                                                                                                                                                 |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Technical note](technical-note.md)                                      | The problem, the design, the trust model, what is tested and the path to production, every figure linked                                                       |
| [Sponsor technology](sponsor-tech.md)                                    | Each Arbitrum, Robinhood Chain, Chainlink, Paxos, OpenZeppelin, Alchemy and AWS feature: why, what breaks without it, code, transaction, status                |
| [Endpoints](ENDPOINTS.md)                                                | The app's API, `/skill.md` and `/llms.txt`, both MCP servers' tools, the indexer, the Telegram bot and the SDK                                                 |
| [Hard questions](submission/qa-prep.md)                                  | Twenty-two likely judge questions (buyers, liquidity, malicious agents, weekend oracles, regulation, money)                                                    |
| [Milestones](MILESTONES.md)                                              | The milestone plan for the grant: v3 on two chains and the Stylus risk engine (both done), then v3 on `main`, eight settled weeks, audit and mainnet, adoption |
| [Why only here](../README.md#why-only-here-robinhood-chain-and-arbitrum) | Why Strike needs Robinhood Chain and Arbitrum: stock tokens, equity feeds, USDG, ERC-8004, Stylus                                                              |
