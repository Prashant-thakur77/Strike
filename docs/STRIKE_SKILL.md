---
name: strike
description: Run a Strike options vault as its agent. Read vault state, dry-run proposals against the on-chain mandate, propose the weekly strike, and settle epochs through the Strike MCP server.
---

# Strike skill for AI agents

Strike runs options vaults on Robinhood Chain stock tokens (TSLA, NVDA, SPY, ...), paid in USDG. Each week a vault sells one option series: a **covered call** (collateral: the stock token) or a **cash-secured put** (collateral: USDG). Buyers pay a USDG premium; depositors earn it.

You, the agent, only **propose** the strike, size and price. The `EpochManager` contract checks every proposal against the vault's **mandate**. A proposal outside the mandate does not revert: it is **rejected, your USDG bond is slashed** to the vault's depositors, and you get a strike. So: always dry-run first.

The MCP server exposes this skill as the resource `strike://skill`.

## Units

| Quantity                  | Unit                                                                       |
| ------------------------- | -------------------------------------------------------------------------- |
| Spot, strike, fair value  | USD per raw token (tool inputs and outputs are decimal strings: `"390.5"`) |
| Size, capacity            | Options, in underlying tokens (`"8"` = options on 8 tokens)                |
| Premium, bond, fees, PnL  | USDG                                                                       |
| Delta, deltas in mandates | Bps of 1: `2000` = 0.20 `\|delta\|`                                        |
| `premiumBps`              | Price as a share of Black-Scholes fair value: `10000` = 100%               |
| Expiry                    | Unix seconds; must be an NYSE close (Friday 16:00 New York for weeklies)   |

Prices already include the ERC-8056 `uiMultiplier`; never apply it again.

## Weekly lifecycle

1. **Idle**: vault unlocked; deposits and withdrawals are instant.
2. **Open** (`openEpoch`): needs NYSE regular hours and a fresh, unpaused price. The vault locks; deposits and redemptions queue.
3. **Selling** (`proposeSeries` / `proposeByDelta` accepted): buyers pay fair value at the current spot × `premiumBps`. Sales stop 1 hour before expiry.
4. **Settle** (after expiry, anyone): uses the first price print at or after expiry. Calls pay `(S − K) / S` tokens per option, puts pay `K − S` USDG. Premium (minus the performance fee) goes to depositors; the vault unlocks and processes its queue.

`propose_epoch` opens the epoch for you when the vault is Idle.

## The mandate

Fixed when the vault is created; it never changes. The contract checks the rules in this order and reports the **first** one broken (`MandateGuard.Reason`):

| Reason             | Rule                                                                  | How to fix                                                    |
| ------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------- |
| `None`             | Inside the mandate                                                    | Propose it                                                    |
| `ZeroSize`         | Size must be > 0                                                      | Offer some options (the vault needs collateral)               |
| `TenorOutOfRange`  | `expiry − now` within `[minTenor, maxTenor]`                          | Use the next weekly expiry (default in the tools)             |
| `InvalidExpiry`    | Expiry must be an NYSE session close                                  | Friday 16:00 New York (Thursday if Friday is a holiday)       |
| `StrikeWrongSide`  | Calls strike above spot, puts below (never in the money)              | Move the strike out of the money                              |
| `SizeTooLarge`     | `size ≤ capacity × maxShareSoldBps`                                   | Sell less; capacity is tokens (calls) or USDG / strike (puts) |
| `PremiumBelowFair` | `premiumBps ≥ minPremiumBps`                                          | Ask at least the minimum share of fair value                  |
| `PremiumAboveCap`  | `premiumBps ≤ 30000` (3x fair value)                                  | Ask less                                                      |
| `DeltaOutOfBand`   | `\|delta\|` within `[minDeltaBps, maxDeltaBps]` at proposal time      | Too high: strike further out of the money. Too low: closer    |
| `PremiumTooSmall`  | Premium per option ≥ `minYieldBps` of the collateral one option locks | Strike closer to spot, or a longer tenor                      |

The seeded demo vaults use: `|delta|` 0.10–0.35, premium ≥ 95% of fair value, yield ≥ 0.05%, size ≤ 80% of capacity, tenor 1–8 days.

Proposing **by target delta** (`targetDeltaBps`) is safer than a fixed strike: the contract solves the strike with its own pricer at execution-time spot (rounded down to a cent), so your delta survives spot moves while the transaction is pending.

## Bond, slashing and track record

- To propose, your agent must be **Active**, bonded at least `minBond` USDG, and below `maxStrikes`.
- Each rejected proposal slashes `slashAmount` USDG (bond first, then any unbonding amount) to that vault's depositors and adds a strike. At `maxStrikes` strikes you are **suspended**.
- If a slash takes your bond below `minBond`, you cannot propose until you top it up (`AgentRegistry.postBond`). With the deployed defaults (`minBond` 50, `slashAmount` 10, `maxStrikes` 3), **one rejection at the minimum bond stops you**.
- Unbonding takes `unbondDelay` (8 days, longer than an epoch) and stays slashable, so you cannot misbehave and exit in the same week.
- Every settled epoch updates your on-chain track record (`settledEpochs`, `cumulativePnl` = premium minus payouts, in USDG) and, when you have an ERC-8004 identity, posts it to the ERC-8004 Reputation Registry. Rejections are posted too.
- Accepted epochs earn your payout address a share of the performance fee (charged only on positive epoch PnL).

Read the live numbers with `agent_stats`.

## Tools

| Tool            | Kind  | What it does                                                                                          |
| --------------- | ----- | ----------------------------------------------------------------------------------------------------- |
| `strike_info`   | read  | Protocol, chain, read-only or agent mode                                                              |
| `list_vaults`   | read  | Every vault: stock, kind, collateral, epoch state, mandate, live series                               |
| `vault_state`   | read  | One vault plus spot and oracle status, market hours, next expiry, its agent, and the next step        |
| `quote`         | read  | USDG premium to buy options of a live series now                                                      |
| `risk_check`    | read  | Dry run with the contract's `previewProposal`: verdict, explanation, fair value, delta, suggestion    |
| `propose_epoch` | write | Dry-run, open the epoch if Idle, propose by delta or strike. Refuses a failing dry run unless `force` |
| `settle_epoch`  | write | Settle an expired series (settlement round found automatically)                                       |
| `agent_stats`   | read  | Bond, strikes, accepted/rejected, track record, fees, rejections left before you are stopped          |

Write tools need `STRIKE_AGENT_PRIVATE_KEY` (the agent signer's key); otherwise they return a read-only error.

Example calls (arguments are JSON):

```jsonc
// What is there?
list_vaults {}
vault_state { "vault": "sTSLA-CC" }

// Dry runs: by delta (preferred), or an explicit strike
risk_check { "vault": "sTSLA-CC", "targetDeltaBps": 2000 }
risk_check { "vault": "sTSLA-CC", "strike": "370", "size": "8", "premiumBps": 10000 }
// → { "ok": false, "reason": "DeltaOutOfBand", "explanation": "... |delta| is 0.4912; the band is 0.10 to 0.35 ...",
//     "suggestion": { "targetDeltaBps": 2000, "strike": "389.79", "ok": true, ... } }

// Propose (opens the epoch first when Idle)
propose_epoch { "vault": "sTSLA-CC", "targetDeltaBps": 2000, "size": "8", "premiumBps": 10000 }
// → { "submitted": true, "accepted": true, "seriesId": "...", "strike": "389.79", ... }

// Buyers
quote { "vault": "sTSLA-CC", "amount": "2" }

// After Friday's close
settle_epoch { "vault": "sTSLA-CC" }
agent_stats {}
```

## Recommended loop

1. `vault_state`: check `nextStep`, `marketOpen`, `spot.ok`, the mandate and your agent (`active`, bond).
2. Choose a target `|delta|` inside the band with a margin (for example 0.20 in a 0.10–0.35 band) and `premiumBps` at or above the minimum (10000 = fair value).
3. `risk_check` with `targetDeltaBps`, `size` and `premiumBps`. Continue only if `ok` is true; otherwise apply the explanation or take the `suggestion`.
4. `propose_epoch` with the same arguments. Read `accepted`, `seriesId`, and on a rejection the `reason` and `slashed` amount.
5. Monitor with `vault_state` / `quote` while Selling.
6. After expiry, `settle_epoch` (anyone may call; retrying is safe). Check `agent_stats` for the updated track record.

## Safety rules

- **Always dry-run** (`risk_check`) right before proposing, with exactly the arguments you will send.
- **Never use `force: true` in production.** It exists to demonstrate the on-chain rejection; a forced proposal outside the mandate is rejected and slashed every time.
- Prefer `targetDeltaBps` over a fixed strike; keep a margin inside the delta band.
- Do not propose when `spot.ok` is false (stale, paused, or a corporate action in progress) or the market is closed; the transaction reverts (no slash, but gas is wasted).
- Keep your bond above `minBond` plus at least one `slashAmount`, and watch `rejectionsUntilInactive`.
- The agent key can only propose. It never holds or moves vault funds; keep it separate from any funded wallet.
