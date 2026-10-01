# Strike: weekly options vaults for tokenized stocks, run by agents inside on-chain mandates

**Litepaper · September 2026 · Prashant Thakur**

Strike is unaudited software. The descriptions below are taken from the repository's specification ([design.md](design.md)), its contracts and its tests. Where this paper states a protocol fact, the linked file is its source. Backtest figures come from [backtest.md](backtest.md) and can be reproduced with `python3 research/backtest.py`.

**Status (1 October 2026).** Strike runs on two testnets. The v2 contracts that this paper describes run on Robinhood Chain testnet (chain 46630) and are what the app, SDK and MCP server read by default. v3 adds a fee high-water mark, EIP-712 signer consent and a Stylus risk engine; it runs next to v2 on Robinhood Chain testnet and on Arbitrum Sepolia (chain 421614), where the stock tokens are test tokens with a faucet. Three agent-run epochs are live, one per deployment. Each has an accepted proposal, an out-of-mandate proposal rejected with 10 USDG slashed, and a buyer. In both v3 epochs the accepted proposal was planned by Claude, using only Strike's read-only tools. None of the three has settled yet; all expire on Friday 2 October at 20:00 UTC. Addresses and transactions are in [DEPLOYMENTS.md](DEPLOYMENTS.md).

## Abstract

Robinhood Chain issues ERC-20 stock tokens with Chainlink price feeds. Holding one earns only the stock's return. The chain's first options venues are recent, and neither delegates strike selection to a bounded agent (§1). Strike is a set of contracts that sells weekly, European, cash-settled options against deposited collateral. A covered-call vault holds stock tokens and a cash-secured-put vault holds USDG. Premium is paid in USDG. Options are priced on-chain with a fixed-point Black-Scholes model, anchored to the oracle price at the moment of each purchase, and settled on the first oracle print at or after the Friday close. The strike is chosen by a registered software agent. The agent can propose only options that satisfy an immutable per-vault mandate, which caps delta, size, tenor and discount to fair value. A proposal that breaks the mandate does not execute, and the agent's USDG bond is slashed to the vault's depositors. This paper describes:

- the mechanism and its solvency argument;
- a formal statement of the mandate and an analysis of the agent's incentives;
- the integer pricing algorithm, which runs identically in Solidity and in Rust compiled for Arbitrum Stylus;
- a 403-week historical backtest on TSLA, NVDA, AMZN and SPY.

In the backtest, the weekly 0.20-delta covered call lowered volatility by 25–46% and lagged buy-and-hold by 6–41 percentage points a year. The cash-secured put returned between −3.8% and +3.7% a year, depending on the volatility assumption.

## 1. The problem

A Robinhood stock token earns only its stock's return. The tokens are standard 18-decimal ERC-20 tokens implementing ERC-8056 ([research.md §3](research.md)). Splits and dividends change a `uiMultiplier` instead of balances, so a holder gets the stock's total return. The issuer's documentation lists "structured products" and "Perps & derivatives" among the intended uses, but names no options partner ([research.md §8](research.md)). At the time of writing, one options product is live on the chain: Stonkhouse, which offers daily calls and puts from an order book. Another, Archer Markets, is a testnet order book with physical exercise ([research.md §8](research.md)). Neither delegates strike selection to a bounded agent. Strike does not claim to be the first options venue on the chain.

Integrating the tokens has five traps. Each one can make an options contract misprice or become insolvent:

1. The multiplier can be applied twice. The Chainlink stock feeds already include the multiplier ("Token Price = Underlying Equity Market Price × Multiplier"), while the issuer's REST price API does not ([research.md §3](research.md)). An integrator who multiplies the feed price by `uiMultiplier` overprices the token. On 2026-09-28, the NVDA multiplier was 1.000775 and SPY's was 1.001718.
2. Prices go stale. Mainnet feeds have a 24-hour heartbeat and a 0.5% deviation threshold, and "do not have heartbeats during off-hours" ([research.md §3](research.md)). A weekend price can be two days old.
3. There are two pause layers. The token can be paused (`paused()`), and so can its oracle (`oraclePaused()`). Testnet tokens do not implement the second.
4. Corporate actions move the multiplier. Around a split or dividend, a new multiplier is scheduled with an `effectiveAt` time, and the feed and the multiplier can briefly disagree.
5. Some tickers have no feed. NFLX, for example, had no Chainlink feed listed on mainnet when checked ([research.md §3a](research.md)).

Handing trading to software agents adds a third problem: how to let an agent choose parameters without letting it choose outcomes. In Strike, agents never hold funds and can only propose. The contract measures every proposal against limits the depositors saw when they deposited.

## 2. Mechanism

### 2.1 Epochs

Each vault runs one epoch per week. It moves through a small state machine ([design.md §3](design.md)):

```
Idle --openEpoch--> Open --proposeSeries (passes mandate)--> Selling --settle--> Idle
                    Open --proposeSeries (fails)--> Open   (bond slashed, strike recorded)
                    Open --abortEpoch (timeout)--> Idle
                    Selling --emergencyCancel (guardian, after grace, no recorded price)--> Idle
```

- `openEpoch` requires an open NYSE session and a safe price. It snapshots spot and volatility, which the proposal is judged against, and locks the vault: from then until settlement, deposits and redemptions are queued.
- The agent's signer calls `proposeSeries(vault, strike, expiry, size, premiumBps)` or `proposeByDelta(vault, targetDeltaBps, …)`. The second solves the strike on-chain from the opening snapshot and rounds it to a cent toward the middle of the mandate's delta band, so the agent knows the exact strike before it sends the transaction ([gas.md](gas.md)). If live spot has crossed the strike since the snapshot, the proposal reverts (`StrikeInTheMoney`) rather than selling an option in the money.
- Anyone may `buy` until a cutoff before expiry. They pay the fair value × `premiumBps`, but never less than intrinsic value, at the current oracle price moved slightly against the buyer (§2.3), with a slippage bound. Collateral for the new options is locked, and the premium is escrowed in the `EpochManager` until settlement.
- Expiry is 16:00 New York time on an NYSE trading day. `settle` is permissionless and idempotent, and uses the first feed round at or after expiry (§5).
- If no proposal arrives, anyone can abort the epoch after `proposalTimeout`. If the feed dies after expiry, the guardian can cancel after `settlementGrace`: collateral returns to the vault and buyers reclaim their premium. The cancel reverts once a settlement price is recorded, so it cannot turn a payout into a refund.

### 2.2 Vault accounting

`StrikeVault` is an ERC-4626 vault deployed as an EIP-1167 clone. Its share price is based on internal accounting (`managedAssets`), not on `balanceOf`, so a donation cannot move it ([design.md §5](design.md)).

**Queue.** While an epoch runs, deposit requests are held outside `managedAssets`, and redemption requests escrow their shares in the vault. At settlement, in order:

1. the payout leaves `managedAssets`;
2. the net premium is distributed over the current supply, including the escrowed redemption shares, because they carried that epoch's risk;
3. the pair `(assets, supply)` is snapshotted for the epoch;
4. escrowed shares are burned and their assets reserved;
5. queued deposits are minted at the snapshot price;
6. the vault unlocks.

Claims are lazy and use the snapshot of the epoch the request belonged to. So a depositor can neither enter just before a profitable settlement nor leave just before a losing one.

During an epoch, `convertToAssets` ignores the open series: neither what the vault may owe option holders nor the escrowed premium. Shares remain transferable, so an integrator that values them mid-epoch has to mark the series itself ([design.md §5](design.md)).

**Premium accumulator.** Premium is paid in USDG in both vault types, through a per-share accumulator with precision $10^{36}$ (`StrikeVault.sol`). An epoch whose net premium to depositors is $P$ over a supply of $N$ shares does:

$$A \leftarrow A + \left\lfloor \frac{P \cdot 10^{36}}{N} \right\rfloor .$$

Each account $i$ holds a checkpoint $c_i$. Before any balance change, it is credited $\lfloor b_i (A - c_i) / 10^{36} \rfloor$, and $c_i$ is set to $A$. Because every credit is rounded down, $\sum_i \lfloor b_i \Delta A / 10^{36} \rfloor \le \lfloor N \Delta A / 10^{36} \rfloor \le P$. The vault can never owe more premium than it received. That is invariant 6, premium solvency, in [design.md §6](design.md). Queued shares receive their premium through the epoch snapshot instead of a checkpoint.

### 2.3 Oracle-anchored pricing

The agent does not set a price. It sets `premiumBps`, a multiplier on fair value. Each purchase pays

$$\text{premium per option} = \max\left(\mathrm{BS}(\tilde S_t, K, \tau_t, \sigma) \times \frac{\text{premiumBps}}{10^4},\; \text{intrinsic}(\tilde S_t, K)\right), \qquad \tilde S_t = S_t \left(1 \pm \frac{b}{10^4}\right),$$

where $S_t$ is the `SafeStockFeed` price at the time of the purchase, $\tau_t$ is the time remaining, $\sigma$ is the volatility for the underlying, and intrinsic value is $\max(\tilde S_t - K, 0)$ for a call and $\max(K - \tilde S_t, 0)$ for a put. A premium fixed on Monday would be free money for a buyer on Wednesday if the stock had moved, and re-pricing every purchase closes that ([decisions.md D9](decisions.md)).

Two adjustments protect depositors from what the oracle cannot see. The spot buffer $b$ (`spotBufferBps`, `+` for calls, `−` for puts) moves spot against the buyer: a Chainlink stock feed prints only on a 0.5% move or its heartbeat, so the market can sit up to 0.5% from the last print, and for short-dated low-delta options that gap is a large share of the premium. The deployment sets $b = 50$ bps; the admin can set at most 200. The intrinsic floor stops a buyer from taking an in-the-money option below its exercise value when `premiumBps` is under 100%.

A keeper sets $\sigma$ inside bounds set by the admin; the deploy script uses 20%–200%. Each keeper update may move $\sigma$ by at most 25% and comes at least an hour after the last one. The agent cannot influence $\sigma$.

### 2.4 Settlement and solvency

Let $S$ be the settlement price and $K$ the strike, both in WAD ($10^{18} = \$1$) per raw token. Let $n$ be the number of options sold in underlying base units, and $u = 10^{d}$ one token, where $d$ is the token's decimals ([design.md §4](design.md)).

**Call vault (covered, settled in the stock token).**

$$w = \begin{cases} \left\lfloor \dfrac{(S-K)\cdot 10^{18}}{S} \right\rfloor & S > K \\ 0 & \text{otherwise} \end{cases}, \qquad \text{payout} = \left\lfloor \frac{n \, w}{10^{18}} \right\rfloor .$$

A holder of $a$ options receives $a w / 10^{18}$ tokens, worth $(a/u)(S-K)$ dollars at $S$: the payoff of a cash-settled call, delivered in the underlying.

_Coverage._ The vault locks $n$ base units, one raw token per option. For $K > 0$ we have $(S-K)/S < 1$, so $(S-K)\cdot 10^{18}/S < 10^{18}$ and $w \le 10^{18}-1$. Therefore payout $\le n w/10^{18} < n$. The payout is always strictly less than the locked collateral, however high $S$ rises. The call vault needs no USDG and no swap at settlement.

**Put vault (cash-secured, settled in USDG).**

$$\text{collateral} = \left\lceil \frac{n K}{u} \right\rceil_{\text{USDG}}, \qquad \text{payout} = \left\lfloor \frac{n \max(K-S,0)}{u} \right\rfloor_{\text{USDG}} .$$

_Coverage._ Since $S \ge 0$, we have $K - S \le K$. Collateral is converted from WAD to USDG rounding up, and payout rounding down, so $\text{payout} \le nK/u \le \text{collateral}$. This holds even if $S = 0$.

Both results are invariant 1 in the Foundry suite: `lockedCollateral ≥ maxPayout`, together with `test_putVault_collateralCoversCrashToZero`.

**Fee.** At settlement, with payout value $X$ in USDG (for calls, payout × $S$):

$$\Pi = \text{premium} - X, \quad \text{fee} = \max(\Pi, 0)\cdot \frac{\text{perfFeeBps}}{10^4}, \quad \text{agentFee} = \text{fee}\cdot\frac{\text{agentShareBps}}{10^4}.$$

Depositors receive premium − fee. The deployment uses a 10% performance fee (`perfFeeBps` 1000), half of it to the agent (`agentShareBps` 5000). The contract caps the fee at 30% (`FeeManager.MAX_PERF_FEE_BPS`).

## 3. The agent mandate as a constraint system

### 3.1 Definition

A vault's mandate is a tuple fixed at creation and never changed afterwards ([decisions.md D13](decisions.md)):

$$m = (\delta_{\min}, \delta_{\max}, \beta_{\min}, y_{\min}, s_{\max}, \tau_{\min}, \tau_{\max}),$$

with deltas, premium factor, yield and share sold in basis points. The contract refuses a mandate with $\beta_{\min} < 9\,000$ or $\tau_{\max} > 35$ days, among other consistency checks (`MandateGuard.validate`). The agent chooses a proposal $\pi = (K, T, n, \beta)$: strike, expiry, size and premium factor. The contract then measures the state $\sigma$:

- spot $S$ from `SafeStockFeed`, as snapshotted by `openEpoch`;
- tenor $\tau = T - t$, at the proposal's block;
- capacity $c$: `totalAssets` tokens for a call vault, `totalAssets`$/K$ for a put vault;
- the keeper's volatility $\hat\sigma$, as snapshotted by `openEpoch`;
- from these, fair value $F = \mathrm{BS}(S,K,\tau,\hat\sigma)$ and delta $\Delta$.

The mandate predicate implemented by `MandateGuard.check` is

$$
M(\pi,\sigma) \iff
\begin{aligned}[t]
& n > 0 \;\wedge\; \tau_{\min} \le \tau \le \tau_{\max} \;\wedge\; \text{isNyseClose}(T) \\
& \wedge\; (\text{call} \Rightarrow K > S) \;\wedge\; (\text{put} \Rightarrow K < S) \\
& \wedge\; n \le \lfloor c \, s_{\max} / 10^4 \rfloor \;\wedge\; \beta_{\min} \le \beta \le 30\,000 \\
& \wedge\; \delta_{\min} \le \lfloor |\Delta| \cdot 10^4 \rfloor \le \delta_{\max} \\
& \wedge\; F \cdot \beta \ge y_{\min} \cdot (\text{call} ? S : K).
\end{aligned}
$$

`check` returns the first clause that fails, as a reason code (`ZeroSize`, `TenorOutOfRange`, `InvalidExpiry`, `StrikeWrongSide`, `SizeTooLarge`, `PremiumBelowFair`, `PremiumAboveCap`, `DeltaOutOfBand`, `PremiumTooSmall`), instead of reverting. That is deliberate. A revert would also undo the slash, so `_propose` records the rejection, slashes and returns `accepted = false` ([decisions.md D12](decisions.md)). Failures that are not mandate violations still revert and are never slashed: market closed, stale feed, an unauthorised caller, and a strike that live spot has crossed since the snapshot (`StrikeInTheMoney`). Because $S$ and $\hat\sigma$ are fixed for the epoch, the dry run `previewProposal` returns the verdict the transaction will get; a volatility update or a new print in between cannot turn an honest proposal into a slash.

The demo vaults use $\delta \in [0.10, 0.35]$, $\beta_{\min} = 95\%$, $y_{\min} = 5$ bps, $s_{\max} = 80\%$ and a tenor of 1 to 8 days (`script/Seed.s.sol`).

Two properties follow from the construction:

- **The agent cannot move the inputs it is judged on.** Spot comes from Chainlink and volatility from the keeper, both fixed at `openEpoch`; capacity comes from vault accounting. The agent controls only $\pi$.
- **The mandate bounds the worst case per epoch.** No accepted series can lock more than $s_{\max}$ of capacity, sell below $\beta_{\min}$ of the model price or below intrinsic value, or be created in the money.

The backtest found one edge case in an earlier version: `proposeByDelta` rounded the solved strike down to a whole cent, which for a put lowers $|\Delta|$, so a put proposed at exactly $\delta_{\min}$ measured $\delta_{\min} - 1$ bps and was rejected in 403 of 403 simulated weeks ([backtest.md](backtest.md#mandate-check)). The contract now rounds toward the middle of the band (a target in the upper half moves the call strike up and the put strike down; the lower half the opposite), so any target inside the band, edges included, passes the delta check (`testFuzz_proposeByDelta_bandEdgeNeverSlashed`).

### 3.2 When is a reckless proposal unprofitable?

The registry parameters in the deploy script are:

| Parameter                            | Value                        |
| ------------------------------------ | ---------------------------- |
| minimum bond $b_{\min}$              | 50 USDG                      |
| slash $s$                            | 10 USDG                      |
| strikes before suspension $k_{\max}$ | 3                            |
| unbonding delay                      | 8 days, longer than an epoch |

A slash takes up to $s$ from the bond and then from bond still unbonding (`AgentRegistry.slash`). An agent can propose only while it is active: bond $\ge b_{\min}$, status Active and strikes $< k_{\max}$.

**Outside the mandate.** A rejected proposal creates no series, so it has no upside. Its payoff is

$$U_{\text{reject}} = -\min(s,\, b + b_{\text{unbonding}}) - \mathbb{1}[\text{strikes} = k_{\max}]\, V - \mathbb{1}[b - s < b_{\min}]\, C_{\text{top-up}},$$

where $V$ is the agent's continuation value (all future fees) and $C_{\text{top-up}}$ is the cost of posting bond again before it can propose. With a bond at exactly 50 USDG, one slash leaves 40 and the agent is inactive until it tops up. Proposing nothing pays 0. So a proposal known to break the mandate is strictly dominated whatever the bond size. Slashing is not what makes the mandate hold; the on-chain check does that.

**Against an imperfect check.** Suppose an attacker believes a proposal slips through a flaw in `MandateGuard` with probability $q$ and would then yield a gain $G$, for example through a colluding buyer. The attempt is unprofitable when

$$q\,G < (1-q)\,(s + \mathbb{E}[\text{suspension and top-up losses}]).$$

With $s = 10$ USDG, this deters only attacks with a tiny $qG$. Against a real bypass, the protection is the correctness of `MandateGuard` (42 unit tests, fuzzed proposals and invariant suites), not the slash. The slash exists to make careless and spam proposals cost something, and to pay depositors for them. It is sized relative to fee income. Using the backtest's base case (0.20 delta, VRP 1.15), the agent's expected fee at $100,000 of vault capital is about $5 a week for SPY calls and about $13 a week for TSLA calls. So one slash equals roughly one to two weeks of fees. A curator who expects larger vaults should ask for a larger bond.

**Inside the mandate.** The agent's fee is $a f \max(\Pi, 0)$, with $a f = 5\%$: a call option on the epoch's profit and loss. Because $\max(\Pi,0) = \Pi + \max(-\Pi, 0)$,

$$\mathbb{E}[\text{agentFee}] = a f\big(\mathbb{E}[\Pi] + \mathbb{E}[\max(-\Pi,0)]\big),$$

and the agent earns something even when the strategy loses on average, as long as $\Pi$ varies. The backtest shows this. The fee took 7.6–8.8% of gross premium in all 16 base configurations, including TSLA calls priced at trailing realised volatility, where buyers received 1.85× the premium collected. In v2 the fee is charged weekly, with no high-water mark. Ribbon's Theta Vaults charged theirs the same way ([§7](#7-related-work)). v3's `FeeManager` charges only on net premium above the vault's high-water mark.

The incentive is convex, so a fee-maximising agent prefers the riskier end of the band: higher delta, maximum size. The mandate's $\delta_{\max}$ and $s_{\max}$ are the binding limits on that, and curators should set them expecting agents to sit at the edge.

**Collusion with a buyer.** An agent can set $\beta = \beta_{\min}$ and let a colluding buyer take the discount. The buyer's edge per epoch is at most

$$(1 - \beta_{\min}/10^4) \cdot F \cdot \lfloor c\, s_{\max}/10^4 \rfloor,$$

which is 5% of the model premium under the demo mandate, and at most 10% under any mandate the contract accepts ($\beta_{\min} \ge 9\,000$). The intrinsic floor also keeps an in-the-money option from being sold below its exercise value. In the backtest, selling at 95% instead of 100% of fair value cost depositors 0.1–0.75 percentage points of annual return. A curator who does not want to allow this sets $\beta_{\min} = 10^4$.

## 4. Pricing

### 4.1 Model and representation

The model is Black-Scholes with a zero interest rate and a 365-day year. For weekly tenors quoted in a stablecoin, the rate term is negligible ([decisions.md D5](decisions.md)):

$$C = S\,N(d_1) - K\,N(d_2), \quad P = K\,N(-d_2) - S\,N(-d_1), \quad d_{1,2} = \frac{\ln(S/K) \pm \tfrac12 \sigma^2 T}{\sigma\sqrt{T}}.$$

All values are unsigned 256-bit integers scaled by $10^{18}$ (WAD). Signs are carried separately, as (magnitude, sign) pairs for $\ln(S/K)$, $d_1$ and $d_2$. The Stylus WASM runtime rejects floating-point instructions, so there is no floating point anywhere ([decisions.md D6](decisions.md)). The inputs are bounded: price $10^{-12}$ to $10^{12}$, tenor 1 s to 2 years, volatility 1% to 500%. Outside those bounds the pricer refuses to quote.

### 4.2 Elementary functions

These are implemented in `stylus/pricer/src/math.rs` and mirrored step for step in `BlackScholesLib.sol`.

- **Logarithm (atanh series).** For $x \ge 1$, write $x = 2^k m$ with $m \in [1,2)$. Then $\ln x = k \ln 2 + 2\,\mathrm{atanh}(z)$, where $z = (m-1)/(m+1) \in [0, 1/3)$, and $\mathrm{atanh}(z) = \sum_{j\ge0} z^{2j+1}/(2j+1)$. Each term shrinks by a factor of at least $z^2 < 1/9$, so the loop reaches a zero term in about 20 iterations. $\ln(S/K)$ is always evaluated on the ratio $\ge 1$, with the sign kept.
- **Exponential (range-reduced Taylor).** For $y \ge 0$, write $y = k \ln 2 + r$ with $r \in [0, \ln 2)$. Then $e^{-y} = 2^{-k} / e^{r}$. $e^r$ is summed as a Taylor series until the next term rounds to zero, and $2^{-k}$ is a right shift. For $y \ge 42$ the result is 0, because $e^{-42} \approx 5.7\times10^{-19}$ is below one wei of WAD.
- **Normal CDF (Hart 1968, in West's 2005 form).**
  - For $|x| < 10/\sqrt2 \approx 7.07$, the lower tail is $e^{-x^2/2}$ times a degree-6 over degree-7 rational polynomial in $|x|$, with Hart's coefficients.
  - Beyond that it uses the continued fraction $e^{-x^2/2} / \big(\sqrt{2\pi}\,(x + 1/(x + 2/(x + 3/(x + 4/(x+0.65)))))\big)$.
  - For $|x| > 37$ the tail is 0.
- **Square root.** Integer Newton iteration, started from a power of two above the root, so it decreases monotonically to the floor.
- **Strike for a target delta.** 48 bisection rounds over $[S/10, 10S]$, giving a relative precision of about $7\times10^{-14}$ of spot. The fixed round count makes the result deterministic, so Solidity and Rust return the same strike.

### 4.3 Accuracy

The Rust tests (`math.rs`) establish:

| Quantity                                                                                                         | Bound                                                         |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| $\ln$                                                                                                            | within $10^{-12}$ of `f64` on test points from 1 to $10^{12}$ |
| $e^{-y}$                                                                                                         | within $10^{-15}$ for $y \in [0, 40]$                         |
| $N(\pm x)$                                                                                                       | within $10^{-14}$ of `erfc` for $x \in [0,10]$                |
| Price vs closed form (2,000 random cases: spot 1–5,000, moneyness 0.5–1.5, 1 hour to 60 days, volatility 5–200%) | $< 10^{-9}$ of spot                                           |
| Delta vs closed form (same cases)                                                                                | within $10^{-9}$                                              |
| Put-call parity $C - P = S - K$                                                                                  | within $\max(S,K)\cdot 10^{-14}$                              |

Premiums never exceed their cap (S for a call, K for a put) and never fall below intrinsic value, less rounding. The Solidity library reproduces the Rust output **exactly**, on 300 generated vectors and more than 10,000 differential fuzz runs ([gas.md](gas.md), [testing.md](testing.md)).

An independent check for this paper compared a `float64` closed-form implementation with those 300 vectors. The largest price difference was $3.6\times10^{-16}$ of spot and the largest delta difference $8.9\times10^{-16}$. For the reference quote $S=250$, $K=275$, 7 days, 60%, both give 1.36028323765224.

### 4.4 Stylus against Solidity

These figures were measured on a local Arbitrum Nitro dev node through a probe contract that includes the cross-contract call overhead, with the Stylus program not cached ([gas.md](gas.md)):

| Call                                                               | Solidity gas | Stylus gas |
| ------------------------------------------------------------------ | -----------: | ---------: |
| `quote`, 7-day call                                                |       33,969 |     40,624 |
| `quote`, 30-day at-the-money call                                  |       24,793 |     39,038 |
| `strikeForDelta`, 0.20-delta call, 7 days                          |    1,546,443 |    235,880 |
| `EpochManager.proposeByDelta` (full transaction, L2 execution gas) |    1,878,918 |    577,041 |

A Stylus call has a fixed entry cost of about 35–40k gas, so for a single quote the EVM's native 256-bit arithmetic wins. When a call does real work (48 Black-Scholes evaluations to solve a strike), WASM is 6.5× cheaper. Strike therefore uses the Stylus pricer where it wins: solving strikes on-chain inside `proposeByDelta` ([decisions.md D22](decisions.md)). The deployed testnet programs were built reproducibly, and `cargo stylus verify` matches each to its source: the v2 pricer on Robinhood Chain testnet, and the v3 pricer and risk engine, one program with the same project hash on Robinhood Chain testnet and Arbitrum Sepolia.

## 5. Safety

**SafeStockFeed.** Every price read goes through one library that returns a WAD price per raw token or reverts with a named error ([design.md §7](design.md), [safestockfeed.md](safestockfeed.md)):

- the answer must be positive and not dated in the future;
- the price must be younger than `maxPriceAge`;
- the token must not be paused, and neither may its oracle (read defensively, because testnet tokens lack `oraclePaused()`);
- for live reads, no multiplier change may be pending until `effectiveAt` plus a grace period;
- decimals are normalised once;
- the price is never multiplied by `uiMultiplier`;
- opening and selling require an open NYSE session (`MarketCalendar`, DST-aware, with an admin-maintained holiday list);
- an optional L2 sequencer-uptime check can be enabled.

Settlement uses the **first** round with `updatedAt ≥ expiry`. The caller supplies a hint, and the contract checks that the round before it predates expiry, so nobody can pick a convenient later print. Chainlink round ids carry a phase that changes when an aggregator is upgraded; for round 1 of a new phase the caller also supplies the old phase's last round, which must predate expiry and have no successor. An upgrade therefore neither offers a second candidate price nor blocks settlement. If the chosen print is within the corporate-action grace of a multiplier change, settlement moves to the first print at or after `effectiveAt` plus the grace, proven the same way. The price for a (token, expiry) pair is recorded once and never changed, and the guardian cannot cancel a series once it is.

**Invariants.** The Foundry invariant suite checks, after any sequence of calls ([design.md §6](design.md)):

1. collateral covers the maximum payout of every live series;
2. share accounting holds to within one unit of rounding;
3. nothing leaks while a vault is locked;
4. each series settles at most once;
5. the manager can pay every unredeemed payout and refund;
6. the vault can pay all premium owed;
7. deposits and withdrawals never lower the share price.

**Threat model.** [threat-model.md](threat-model.md) lists 21 threats, each with a mitigation and the tests that cover it. The ones specific to this design:

- oracle manipulation (T1), stale weekend prices (T2), a double-counted multiplier (T3) and corporate actions mid-epoch (T4);
- reckless or compromised agents (T6, T7), and an agent that withdraws its bond before punishment (T8, handled by the 8-day unbonding period, during which unbonding funds can still be slashed);
- stale-premium arbitrage (T9, handled by re-pricing every purchase), sales below intrinsic value (T19) and oracle-latency arbitrage (T20, handled by the spot buffer);
- a market-data race that slashes an honest agent (T21, handled by the opening snapshot);
- price gaps past the strike (T10, handled by full collateralisation);
- funds stuck when a feed dies (T14, handled by abort and guardian cancel, which is refused once a settlement price exists).

The trust assumptions are stated plainly:

- Chainlink publishes correct prices per raw token;
- the issuer can pause tokens and change multipliers;
- the admin can list tokens, set bounded parameters and pause, but cannot move user funds;
- the guardian can only return funds to depositors and buyers;
- USDG is treated as exactly $1.

There are no upgradeable proxies. The contracts have not been audited.

## 6. Economics

**Fees.** The performance fee is 10% of each epoch's positive net premium, split evenly between the proposing agent and the treasury. Losing epochs pay no fee. There is no management fee.

**Backtest.** The strategy was simulated week by week from January 2019 to September 2026 (403 epochs) on split- and dividend-adjusted daily closes, with the contract rules above. Full method and results are in [backtest.md](backtest.md). The key assumptions are:

- the vault sells its full 80% of capacity at the Monday-close quote (no demand risk, no bid/ask);
- implied volatility is modelled as trailing 21-day realised volatility × a volatility-risk-premium factor (VRP) of 1.00 or 1.15;
- USDG earns no interest.

For SPY, the median ratio of the VIX to trailing realised volatility over the same period was 1.30, so 1.15 is conservative for the index. No comparable data was used for the single stocks.

Base case: 0.20 delta, premium at fair value, premium held as USDG. Each cell shows VRP 1.00 / VRP 1.15.

|                                            | TSLA               | NVDA               | AMZN               | SPY                |
| ------------------------------------------ | ------------------ | ------------------ | ------------------ | ------------------ |
| Buy-and-hold CAGR                          | 44.0%              | 71.2%              | 15.6%              | 17.2%              |
| Covered call CAGR                          | 17.2% / 23.1%      | 30.6% / 38.6%      | 4.3% / 8.0%        | 8.6% / 11.3%       |
| Covered call Sharpe (B&H)                  | 0.64 / 0.78 (0.89) | 1.15 / 1.36 (1.40) | 0.33 / 0.53 (0.61) | 0.68 / 0.85 (0.97) |
| Covered call max drawdown (B&H)            | −50% / −46% (−72%) | −46% / −43% (−66%) | −42% / −38% (−55%) | −29% / −29% (−32%) |
| Cash-secured put CAGR                      | −2.6% / 1.0%       | 0.5% / 3.7%        | −3.8% / −0.9%      | −2.4% / −0.6%      |
| Weekly premium per option, call (VRP 1.15) | 0.75%              | 0.61%              | 0.42%              | 0.21%              |
| Weeks assigned, call (VRP 1.15)            | 18%                | 24%                | 22%                | 23%                |

Three findings stand out.

1. **The covered call works as a risk reducer, not a return enhancer, in this sample.** It cut volatility by 25–46%, but all four stocks rose strongly and the weekly cap gave most of that away. Buyers of calls received 1.16–1.37× the premium at VRP 1.15.
2. **The put vault's result depends on the volatility premium.** At trailing realised volatility it lost money on three of four tickers. At VRP 1.15 it was roughly break-even. With the VIX as SPY's implied volatility it earned 1.1% a year, with a 4.9% maximum drawdown.
3. **Lower-delta calls and higher-delta puts did better** over 2019–2026 (see the sensitivity table in [backtest.md](backtest.md#sensitivity-to-delta-volatility-premium-and-premium-factor)).

These results match what the literature expects of option selling. Its return is a volatility risk premium on top of the underlying's exposure (Israelov & Nielsen 2015; Carr & Wu 2009). Strike can collect that premium only if its keeper prices above realised volatility and buyers still buy.

## 7. Related work

- **Ribbon Finance Theta Vaults** ([docs](https://docs.ribbon.finance/theta-vault/theta-vault)) introduced weekly on-chain option-selling vaults: covered calls and puts on crypto assets. Ribbon's documentation states:
  - strikes are chosen by an algorithm at a fixed 10 delta, based on Black-Scholes ([strike selection](https://docs.ribbon.finance/theta-vault/theta-vault/strike-selection-and-expiry));
  - options were sold in auctions, first on Gnosis and later through Paradigm ([auctions](https://docs.ribbon.finance/theta-vault/theta-vault/auctions));
  - the fee is a 2% annual management fee plus a 10% performance fee, charged weekly when the week is profitable ([fees](https://docs.ribbon.finance/theta-vault/theta-vault/fees)).

  Ribbon's own options exchange, Aevo, is order-book based ([docs](https://docs.ribbon.finance/aevo)). Strike differs in three ways: prices come from an oracle-anchored model rather than an auction; strike selection is delegated to an agent bounded by an on-chain mandate; and collateral is tokenized equity.

- **Lyra, now Derive.** Lyra v1 priced options on-chain with a Solidity Black-Scholes library against a liquidity pool that took the other side of trades (`BlackScholes.sol`, `LiquidityPool.sol` and `OptionMarketPricer.sol` in [derivexyz/v1-core](https://github.com/derivexyz/v1-core)). Its successor is Derive V2 ([derivexyz/v2-core](https://github.com/derivexyz/v2-core), [docs](https://docs.derive.xyz/)). Strike's pricer does the same job in fixed-point arithmetic, but in two languages that are proven identical, with the expensive search moved to Stylus.
- **Thetanuts Finance** offers structured option vaults. Its V4 is built around a request-for-quote engine in which liquidity providers quote directly instead of trading against an AMM ([docs](https://docs.thetanuts.finance/)).
- **Cboe BXM and PUT indices.**
  - The [Cboe S&P 500 BuyWrite Index (BXM)](https://www.cboe.com/us/indices/dashboard/bxm/) tracks buying the S&P 500 and writing one-month near-the-money calls. It was announced in April 2002, with daily data from June 30, 1986, and was analysed by Whaley (2002).
  - The [Cboe S&P 500 PutWrite Index (PUT)](https://www.cboe.com/us/indices/dashboard/put/) holds one- and three-month Treasury bills and sells at-the-money SPX puts, rolled monthly.

  Strike's vaults are weekly, out-of-the-money analogues on single stocks. The put vault lacks PUT's Treasury-bill yield, because USDG collateral earns nothing.

- **On Robinhood Chain.** Stonkhouse offers daily calls and puts on stock tokens from an order book, settled in USDG. Archer Markets is a testnet order book with physical exercise ([research.md §8](research.md)).

## 8. Limitations and future work

- **Demand.** The backtest assumes every option sells at the model price. Strike has no market maker and no auction. If buyers do not come at the oracle-anchored price, unsold size earns nothing. Measuring real fill rates on testnet and mainnet is the most important open question.
- **Volatility input.** One keeper-set volatility per underlying ignores skew and earnings events. A volatility surface, or quotes from an RFQ, would price out-of-the-money puts more accurately. The deploy script's 20% floor, applied to SPY, binds in 70% of simulated weeks at VRP 1.15, so it prices above SPY's recent realised volatility in those weeks.
- **Fee design.** A weekly fee on positive profit and loss, with no high-water mark, pays the agent in losing periods. v3 adds a multi-epoch high-water mark. A clawback from the bond would align the agent with depositors further.
- **Bond sizing.** A 10 USDG slash is small next to the capital an agent steers. The bond could scale with vault TVL.
- **Scope.** There is one series per epoch, no spreads and no early exercise. Spreads (v1.1) would reduce the collateral put vaults need.
- **Premium compounding.** Premium is paid as claimable USDG, and reinvesting it takes a manual claim and deposit. An auto-compounding option would make the covered call behave like the reinvested variant in the backtest.
- **Audit.** The contracts have had an internal security review, whose 11 findings are fixed with regression tests ([security/review-2026-09-29.md](security/review-2026-09-29.md)), but no external audit. Mainnet vaults are capped.

## References

- Black, F. and Scholes, M. (1973). The Pricing of Options and Corporate Liabilities. _Journal of Political Economy_ 81(3), 637–654. https://doi.org/10.1086/260062
- Bakshi, G. and Kapadia, N. (2003). Delta-Hedged Gains and the Negative Market Volatility Risk Premium. _Review of Financial Studies_ 16(2), 527–566. https://doi.org/10.1093/rfs/hhg002
- Carr, P. and Wu, L. (2009). Variance Risk Premiums. _Review of Financial Studies_ 22(3), 1311–1341. https://doi.org/10.1093/rfs/hhn038
- Hart, J. F. et al. (1968). _Computer Approximations_. Wiley.
- Israelov, R. and Nielsen, L. N. (2015). Covered Calls Uncovered. _Financial Analysts Journal_ 71(6), 44–57. https://doi.org/10.2469/faj.v71.n6.1
- West, G. (2005). Better approximations to cumulative normal functions. _Wilmott Magazine_.
- Whaley, R. E. (2002). Return and Risk of CBOE Buy Write Monthly Index. _The Journal of Derivatives_ 10(2), 35–42. https://doi.org/10.3905/jod.2002.319194
- Cboe. S&P 500 BuyWrite Index (BXM). https://www.cboe.com/us/indices/dashboard/bxm/
- Cboe. S&P 500 PutWrite Index (PUT). https://www.cboe.com/us/indices/dashboard/put/
- Ribbon Finance documentation. https://docs.ribbon.finance/
- Derive (formerly Lyra). https://github.com/derivexyz/v1-core, https://github.com/derivexyz/v2-core
- Thetanuts Finance documentation. https://docs.thetanuts.finance/
- ERC-4626, ERC-8004, ERC-8056. https://eips.ethereum.org/EIPS/eip-4626, https://eips.ethereum.org/EIPS/eip-8004, https://eips.ethereum.org/EIPS/eip-8056
- Arbitrum Stylus. https://docs.arbitrum.io/stylus/gentle-introduction
- Strike repository documents: [design.md](design.md), [decisions.md](decisions.md), [threat-model.md](threat-model.md), [safestockfeed.md](safestockfeed.md), [gas.md](gas.md), [research.md](research.md), [backtest.md](backtest.md).
