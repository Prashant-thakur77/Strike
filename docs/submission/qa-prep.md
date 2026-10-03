# Hard questions, short answers

Twenty-two questions a judge is likely to ask, each with a short answer and the file or test that backs it. Line numbers refer to `main` on 2026-09-30 (the contract sources are unchanged on 2026-10-01). What is live and what is not is also listed in the README's [What works, what does not yet, what we cut](../../README.md#what-works-what-does-not-yet-what-we-cut).

## Product and market

### 1. Why would anyone buy these options?

Three kinds of buyer: a stock-token holder who wants a week of downside protection (a put), a trader who wants upside with the loss capped at the premium (a call), and an agent hedging a position (the MCP `hedge_plan` and `buy_options` tools). The price is Black-Scholes fair value at the oracle spot times the vault's premium factor (at least 90%), never below intrinsic. We have no outside buyers yet: in each of the three live epochs the buyer was one of our own wallets, which bought 4 calls each time (10.01 USDG on v2, 8.91 USDG on Arbitrum Sepolia, 7.38 USDG on Robinhood Chain v3). Agents that trade are already common at Robinhood: at HOOD Summit (29–30 September) it said "over 150,000 customers have opened agentic trading accounts and now, agents use Robinhood's tools almost 30 million times a day", launched Agent Apps that sell options data to agents (Unusual Whales and SpotGamma tools), and added third-party agent support to Legend over the Trading MCP ([newsroom](https://robinhood.com/us/en/newsroom/hood-summit-2026/)). That announcement does not mention Robinhood Chain or stock tokens, and none of those agents use Strike.

### 2. Where does the liquidity come from, and what if nobody buys?

The vault is the only seller, and depositors are its liquidity. Collateral is locked only for options actually sold, so if nobody buys, the epoch settles with no payout and no premium, and depositors keep their tokens or USDG. The cost is time: during an epoch, deposits and withdrawals queue until settlement ([StrikeVault.sol](../../contracts/src/vaults/StrikeVault.sol)). The backtest assumes every week sells 80% of capacity at the model price, and the README says so.

### 3. Why not an order book or an auction?

A fixed price set on Monday can be picked off by Wednesday if spot moves. Pricing each buy at the oracle spot at that moment removes that, and it lets the contract check the agent's premium factor against fair value ([D9](../decisions.md)). The tradeoff is that Strike cannot discover a market price for volatility; the keeper sets sigma inside admin bounds, moving at most 25% per update and once an hour.

### 4. Is the put vault better than lending USDG?

No, and we do not pitch it that way. Over 2019 to 2026 it returned −0.9% to 3.7% a year at realised volatility × 1.15 and −3.8% to 0.5% at × 1.00. The Steakhouse USDG vault on Morpho paid about 1.9%, Pendle's PT-USDG market on Robinhood Chain (expiry March 2027) showed a fixed 3.45% implied APY on 2026-10-01 ([Pendle API](https://api-v2.pendle.finance/core/v1/4663/markets/active)), and Robinhood Earn shows about 7% ([README](../../README.md#against-usdg-lending)). Only NVDA at × 1.15 (3.7%) beat Morpho and Pendle; no case reached Earn. The put vault is for someone who would buy the stock below today's price anyway and wants to be paid while waiting.

### 5. The covered call lagged buy-and-hold on every ticker. Why build it?

It trades upside for income and lower volatility: 25% to 46% less volatility and a smaller maximum drawdown in the backtest, at the cost of CAGR ([backtest.md](../backtest.md)). That is the trade the Cboe BXM covered-call index measures, with data back to 1986 ([litepaper](../litepaper.md#7-related-work)). The backtest report opens with the underperformance rather than hiding it.

### 6. How does Strike make money?

A performance fee of 10% of positive epoch net premium (premium minus payout value), half to the proposing agent and half to the treasury, capped at 30% ([FeeManager.sol:50](../../contracts/src/core/FeeManager.sol#L50)). A losing or break-even epoch pays nothing, which Halmos proves for all inputs (`check_computeFee_zeroWhenNoProfit`). v2 has no high-water mark, so a week that only wins back an earlier loss still pays a fee; v3 (from the `v3-contracts` branch) adds one and is deployed on both testnets, but the app, SDK and MCP still default to v2 until v2 settles ([D36](../decisions.md)). At testnet size it is tiny: if the v2 epoch's calls expire out of the money, the fee on its 10.01 USDG of premium is about 1 USDG.

### 7. How is this different from Tilt Protocol, the NYC winner that also runs AI vaults on Robinhood Chain?

Tilt's AI manages its vaults, and its public sources do not describe on-chain limits on that manager. Strike's agent cannot touch funds: it only proposes a strike, the contract checks the proposal against an immutable mandate, and a proposal outside it costs the agent 10 USDG of bond, paid to depositors. Strike's return is option premium on a stock the depositor chose, not the result of an AI's picks ([research.md](../research.md#past-open-house-winner-on-robinhood-chain-tilt-protocol)).

### 8. And from Stonkhouse, which is already live on mainnet?

Stonkhouse writers set their own ask on an order book. In Strike a bonded agent proposes, the contract judges the proposal, prices every sale at the oracle, and handles ERC-8056 multipliers, pauses and corporate actions. Stonkhouse is live with users and Strike is not, so we do not claim to be first ([README competition](../../README.md#competition)).

## Agents

### 9. Why an AI agent instead of a formula?

A formula is the baseline, and the mandate is written like one: a delta band, a premium floor, a yield floor, a size cap and a tenor range. The agent chooses inside those bounds (delta, tenor, premium factor, or skipping a week), and anyone can run a plain formula agent: the example agent defaults to 0.20 delta. We have no evidence yet that an agent beats the fixed 0.20-delta rule; the backtest uses that rule, and in both Claude-planned epochs Claude also chose 0.20 delta (question 13). What the design adds is that agents compete for vaults with a public record (bond, rejections, settled results on ERC-8004).

### 10. What can a malicious agent do?

It cannot move funds; only `EpochManager` can lock or pay out collateral. A proposal outside the mandate is rejected and slashes 10 USDG to that vault's depositors, and three rejections suspend the agent ([AgentRegistry.sol:195](../../contracts/src/agents/AgentRegistry.sol#L195), deployed with a 50 USDG minimum bond). Inside the mandate, the worst it can do is sell at the floors the depositors accepted: never below 90% of fair value, never below intrinsic, priced at spot moved 50 bps against the buyer ([EpochManager.sol:717](../../contracts/src/core/EpochManager.sol#L717), `test_AUDIT_permissiveMandateLetsAgentBuyerDrain`). The vault's curator can replace the agent.

### 11. Can a price move between the agent's dry run and its transaction get an honest agent slashed?

No. `openEpoch` snapshots spot and sigma, and the proposal is judged against that snapshot, so the verdict of `previewProposal` is the verdict on-chain ([D28](../decisions.md), `test_proposal_judgedAgainstOpeningSnapshot`). A proposal whose strike live spot has already crossed reverts instead, with no slash.

### 12. Why ERC-8004?

It gives an agent an identity and a reputation record that other applications can read, instead of a record kept only by Strike. `AgentRegistry` checks `ownerOf` on the official registry before linking an identity, and posts settled results and rejections as feedback (`test_settledEpochPostsPnlFeedback`, `test_rejectionPostsNegativeFeedback`). Agent #1 is identity #114 on Robinhood Chain testnet and #253 on Arbitrum Sepolia (the same registry address on both). Both v3 rejections posted −10 feedback in the same transaction as the slash: to #114 on Robinhood Chain testnet on 1 October ([log §7](../testnet-epochs/2026-09-30-v3.md#7-live-epoch-1-october)) and to #253 on Arbitrum Sepolia on 30 September ([log §6](../testnet-epochs/2026-09-30-arbitrum-sepolia.md#6-the-epoch-1729-to-1734-utc-nyse-open)). Settled results post after Friday's settlement on 2 October.

### 13. Has an AI actually planned anything?

Yes, twice, both on v3. On Arbitrum Sepolia on 30 September, Claude (claude-opus-5, run through the Claude Code CLI with only Strike's read-only tools) called `vault_state`, ran `risk_check` on five candidates, read `agent_stats`, and chose 0.20 delta at 105% of fair value; the proposal was accepted at a $364.29 strike ([record](../agent-log/arbitrum-sepolia/2026-09-30-sTSLA-CC.md)). On Robinhood Chain testnet v3 on 1 October it tried seven candidates (0.15 to 0.30 delta) and again chose 0.20 at 105%, accepted at $369.36 ([record](../agent-log/2026-10-01-sTSLA-CC.md)). Claude only plans: the example agent checks the plan against the mandate and sends the transaction, and the contract judges it like any other proposal. The v2 epoch on 29 September used the example agent's rule-based planner, not Claude. The rejected at-the-money puts in all three epochs were sent on purpose with `force` to show the slash; no planner chose them.

## Oracles and settlement

### 14. What happens over a weekend, or if the feed stops?

Opening an epoch and buying need an open NYSE session and a fresh feed, so nothing sells on a frozen price (`test_buy_marketClosedAndSaleCutoff`, `testFuzz_staleness`). Settlement uses the first Chainlink round at or after expiry, so a Friday expiry with no later print settles on Monday's first print (`test_recordSettlementPrice_waitsOverWeekend`). If the feed never prints, the guardian can cancel once `expiry + settlementGrace` (7 days by default) has passed: collateral goes back to the vault and buyers get their premium back ([EpochManager.sol:535](../../contracts/src/core/EpochManager.sol#L535)). Robinhood said at HOOD Summit that weekend equities trading is coming early next year, in 2027, pending regulatory review ([newsroom](https://robinhood.com/us/en/newsroom/hood-summit-2026/)). The contracts do not depend on the weekend gap: settlement uses the first print after expiry, whenever it comes, so a shorter gap changes nothing in them.

### 15. How do you avoid applying the ERC-8056 multiplier twice?

Strikes, spot and payouts all stay in the feed's own unit, per raw token, because the Chainlink stock feed already includes the multiplier ([D7](../decisions.md)). The fork test reads real NVDA on mainnet, where the multiplier is above 1, and checks the price equals the feed exactly (`test_fork_multiplierIsNotAppliedTwice`).

### 16. Who picks the settlement price? Could someone choose a favourable round?

Anyone can call `settle` with a round id, and the contract checks that the round is at or after expiry and the round before it is before expiry ([D14](../decisions.md)). Chainlink phase changes and corporate actions near expiry need extra proof rounds, which `recordSettlementPriceWithHints` verifies ([D30](../decisions.md), `test_AUDIT_weekendPhaseChangeBricksSettlement`).

## Contracts and trust

### 17. What can the admin still do?

List tokens and feeds, set volatility bounds, the spot buffer (at most 200 bps), fee parameters (at most 30%), timings within bounds, and the pricer ([audit-readiness.md](../audit-readiness.md#roles-and-trust)). The admin has no function that moves user funds and cannot change a vault's mandate, and nothing is upgradeable. It can, though, choose a settlement price before it is recorded by swapping the feed (`StockOracle.setFeed`) or the oracle (`EpochManager.setOracle`), so that holds only for an honest admin; a recorded price is final, and on the testnets the [price mirror audit](../trust-model.md) detects such a swap. `setPricer` is the sharpest power: the deploy script checks the Stylus pricer against the Solidity reference before switching, but the setter itself does not, so on mainnet the admin must be a Safe multisig ([threat model T17](../threat-model.md)).

### 18. How do you know the Rust pricer matches the Solidity one?

Both run the same integer steps in the same order ([D5](../decisions.md)), so the tests demand exact equality, not a tolerance: fuzzed differential tests over FFI (`testFuzz_rustEqualsSolidity`, `testFuzz_strikeForDeltaRustEqualsSolidity`), 300 fixed vectors (`test_matchesStylusVectorsExactly`), and an on-chain equality check before the deployed pricer was switched to Stylus. The deployed program is verified against this source with `cargo stylus verify`.

### 19. Why Stylus, if a single quote costs more there?

A single quote costs 1.1 to 1.6 times more in Stylus because of its fixed entry cost. Solving the strike for a target delta takes 48 evaluations and costs 6.5 times less, and the whole `proposeByDelta` transaction 3.3 times less, measured on a Nitro dev node ([gas.md](../gas.md)). On the live chain `proposeByDelta` used within 0.6% of the dev-node figure. On Robinhood Chain testnet the pricer is not cached, because that chain has no Stylus CacheManager yet; on Arbitrum Sepolia the v3 program is cached in ArbOS.

## Status

### 20. What is live and what is mocked?

Live on Robinhood Chain testnet (46630): the 14 verified v2 contracts and the Stylus pricer; v3 next to them (its own `EpochManager`, `AgentRegistry`, vaults, `RiskLens`, `DecisionLog`, and the Stylus pricer and risk engine verified with `cargo stylus verify`); Robinhood's own testnet TSLA, Paxos testnet USDG, and the official ERC-8004 registries. Live on Arbitrum Sepolia (421614): v3, with 14 contracts verified on Blockscout or Sourcify, the Stylus program verified and cached, and the real Sepolia USDG. Three epochs ran, one per deployment (v2 on 29 September, v3 on Arbitrum Sepolia on 30 September, v3 on Robinhood Chain on 1 October), each with an accepted proposal, an out-of-mandate proposal rejected with 10 USDG slashed, and a buyer; each epoch's decision records are anchored in that deployment's `DecisionLog`. The app, the read-only MCP endpoint (`/api/mcp`) and the vault page's risk panel read these contracts live, and the keeper and the weekly agent run on GitHub Actions since 2 October. Mocked: the price feeds, because neither testnet has Chainlink stock feeds, so a keeper copies mainnet Chainlink rounds into `MirrorFeed`s; on Arbitrum Sepolia also the stock tokens (TSLA and NVDA are `TestStockToken`s with a faucet). The depositors, agents and buyers are all ours. The safety monitor reads mainnet live, and the backtest is a simulation. There is no audit, none of the three epochs has settled yet (their series expired on Friday 2 October at 20:00 UTC, after the day's last mainnet print, and settle at the first print of Monday 5 October), and the app, SDK and MCP still default to v2 on Robinhood Chain.

### 21. Is this legal to offer? Did AI write the code?

Robinhood's stock tokens are offered only to non-US persons, and the app shows a notice that it is not for US persons ([EligibilityGate.tsx](../../app/src/components/app/EligibilityGate.tsx)). Options on tokenized stocks may be regulated derivatives in many places, and we have no legal opinion yet; that has to come before any mainnet vault that is not capped. Yes, AI assistants (Claude) wrote much of the code under the author's direction; each design decision and its reason is in [decisions.md](../decisions.md), and the claims table in the README ties each claim to a test anyone can run.

### 22. Does Strike follow the advice the Foundation gives for Robinhood Chain apps?

Ben Greenberg (Arbitrum DevRel) ends his July article with "Keep contracts small, separate pricing from settlement, treat real-world asset details as part of the protocol surface" ([The first Robinhood Chain app you should build is not another token](https://x.com/hummusonrails/article/2075150298419490847)). Pricing is its own contract: the Stylus pricer quotes options and solves strikes, and `EpochManager` sells and settles, calling whichever pricer the admin set. Real-world asset details are checked as protocol surface: `SafeStockFeed` reads the ERC-8056 multiplier, both pause flags, scheduled corporate actions and NYSE hours before any price is used ([safestockfeed.md](../safestockfeed.md)). On size, `EpochManager` is the largest at 22,829 bytes of runtime code against the 24,576-byte limit, so it is not small; `StrikeVault` is 12,461, `AgentRegistry` 8,364, `FeeManager` 3,181 and `DecisionLog` 1,159 (`forge build --sizes` on `main`, 2026-10-02). None is upgradeable.
