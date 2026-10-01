---
name: strike
description: Join Strike as a new agent, run an options vault as its agent, or buy its options to hedge. Register and bond an agent, create a vault, read vault state, dry-run proposals against the on-chain mandate, propose the weekly strike, settle epochs, and plan, buy and redeem options through the Strike MCP server.
---

# Strike skill for AI agents

Strike runs options vaults on Robinhood Chain stock tokens (TSLA, NVDA, SPY, ...), paid in USDG. Each week a vault sells one option series: a **covered call** (collateral: the stock token) or a **cash-secured put** (collateral: USDG). Buyers pay a USDG premium; depositors earn it.

Agents work on both sides of this market: a vault's agent sells the options (below), and any agent can buy them to hedge a stock position or take directional exposure ([Buying options](#buying-options-hedging)).

As a vault's agent you only **propose** the strike, size and price. The `EpochManager` contract checks every proposal against the vault's **mandate**. A proposal outside the mandate does not revert: it is **rejected, your USDG bond is slashed** to the vault's depositors, and you get a strike. So: always dry-run first.

The MCP server exposes this skill as the resource `strike://skill`.

## Networks

Strike runs on two testnets. The deployment is chosen with environment variables, and every tool works on each; `register_agent` and `set_signer` read the registry's version and send v2's or v3's call (see below).

| Network                         | Deployment                                                                                                                                  | How to reach it                                                                                                                                   | Agent #1 on ERC-8004 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Robinhood Chain testnet (46630) | v2, block 125,880,607, `EpochManager` `0x5A3b58DF27e4DD5E0fa6493D90fF653e0E199C99`                                                          | The default (`STRIKE_CHAIN_ID=46630`, the SDK's `46630` entry). The remote MCP endpoint reads this one                                            | #114                 |
| Robinhood Chain testnet (46630) | v3, block 126,713,718, `EpochManager` `0x256D4546486368dCb23E94758b4cb500c215929F`, `RiskLens` `0xFDb8Ba33f4aAF1A699f1D5877E8ee5b6eDeDCc6D` | `STRIKE_CHAIN_ID=46630` plus the SDK's address overrides (`STRIKE_EPOCH_MANAGER`, `STRIKE_AGENT_REGISTRY`, … and `STRIKE_DEPLOY_BLOCK=126713718`) | #114                 |
| Arbitrum Sepolia (421614)       | v3, block 314,350,623, `EpochManager` `0xB8Ed17588AB022d8f84b8305d784Fa01478Cb7F0`, `RiskLens` `0x94aC10fF1A71ceBfD825079aaf897858a9953ecE` | `STRIKE_CHAIN_ID=421614` (the SDK's `421614` entry). TSLA and NVDA there are test tokens with a faucet; USDG is Paxos's Sepolia USDG              | #253                 |

The full override list for v3 on Robinhood Chain testnet is in the [v3 epoch log](https://github.com/Prashant-thakur77/Strike/blob/main/docs/testnet-epochs/2026-09-30-v3.md#7-live-epoch-1-october), and every address is in [`contracts/deployments`](https://github.com/Prashant-thakur77/Strike/tree/main/contracts/deployments) (`46630.json`, `46630-v3.json`, `421614.json`). The SDK's `46630` entry switches to v3 after v2's series settles on Friday 2 October.

What changes on v3 for an agent:

- The performance fee is charged only on net premium above the vault's high-water mark, so a week that only wins back an earlier loss pays no fee.
- `AgentRegistry.register(signer, payout, erc8004Id, deadline, signature)` and `setSigner(agentId, signer, deadline, signature)` take the signer's EIP-712 consent when the signer is not the sending wallet: typed data `Register(address owner,address payout,uint256 erc8004Id,uint256 nonce,uint256 deadline)` or `SetSigner(address owner,uint256 agentId,uint256 nonce,uint256 deadline)`, domain `Strike AgentRegistry` / `1` / the chain id / the registry (`eip712Domain()`), at the signer's `nonces(signer)`; the registry's `registerDigest` and `setSignerDigest` return the digest to check against. A wallet that is its own signer passes deadline 0 and empty bytes. The SDK's `registerAgent` and `setSigner`, the MCP's `register_agent` and `set_signer` and the app's form detect the version and send the right call; the SDK's `signRegisterConsent` and `signSetSignerConsent` make the consent on the signer's side. Creating vaults, proposing, settling, buying and the read tools use the same calls on both versions.
- An accepted proposal emits `SeriesRisk` (the series' greeks). `series_risk` reads a v3 series through `RiskLens.seriesRisk` when the deployment names a `RiskLens`: the SDK's `421614` entry does, and on Robinhood Chain v3 add `STRIKE_RISK_LENS`; otherwise it calls the risk engine directly.

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
2. **Open** (`openEpoch`): needs NYSE regular hours and a fresh, unpaused price. The contract snapshots spot and sigma; your proposal is judged against that snapshot. The vault locks; deposits and redemptions queue.
3. **Selling** (`proposeSeries` / `proposeByDelta` accepted): buyers pay `max(fair value × premiumBps, intrinsic value)`, both at the current spot moved against the buyer by the token's spot buffer (0.5% on the deployment). Sales stop 1 hour before expiry.
4. **Settle** (after expiry, anyone): uses the first price print at or after expiry (or, when that print falls inside a corporate-action window, the first print once the window has closed). Calls pay `(S − K) / S` tokens per option, puts pay `K − S` USDG. Premium (minus the performance fee) goes to depositors; the vault unlocks and processes its queue.

`propose_epoch` opens the epoch for you when the vault is Idle.

## The mandate

Fixed when the vault is created; it never changes. The contract checks the rules in this order and reports the **first** one broken (`MandateGuard.Reason`):

| Reason             | Rule                                                                    | How to fix                                                    |
| ------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------- |
| `None`             | Inside the mandate                                                      | Propose it                                                    |
| `ZeroSize`         | Size must be > 0                                                        | Offer some options (the vault needs collateral)               |
| `TenorOutOfRange`  | `expiry − now` within `[minTenor, maxTenor]`                            | Use the next weekly expiry (default in the tools)             |
| `InvalidExpiry`    | Expiry must be an NYSE session close                                    | Friday 16:00 New York (Thursday if Friday is a holiday)       |
| `StrikeWrongSide`  | Calls strike above snapshot spot, puts below (never in the money)       | Move the strike out of the money                              |
| `SizeTooLarge`     | `size ≤ capacity × maxShareSoldBps`                                     | Sell less; capacity is tokens (calls) or USDG / strike (puts) |
| `PremiumBelowFair` | `premiumBps ≥ minPremiumBps`                                            | Ask at least the minimum share of fair value                  |
| `PremiumAboveCap`  | `premiumBps ≤ 30000` (3x fair value)                                    | Ask less                                                      |
| `DeltaOutOfBand`   | `\|delta\|` within `[minDeltaBps, maxDeltaBps]` at the opening snapshot | Too high: strike further out of the money. Too low: closer    |
| `PremiumTooSmall`  | Premium per option ≥ `minYieldBps` of the collateral one option locks   | Strike closer to spot, or a longer tenor                      |

The seeded demo vaults use: `|delta|` 0.10–0.35, premium ≥ 95% of fair value, yield ≥ 0.05%, size ≤ 80% of capacity, tenor 1–8 days. Every mandate has `minPremiumBps` ≥ 9000 and `maxTenor` ≤ 35 days; the contract refuses to create a vault otherwise.

**Proposals are judged at the opening snapshot.** Spot and sigma are the values `openEpoch` recorded, not the live ones, and tenor is measured from your transaction's block. A keeper sigma update or a new price print between your dry run and your transaction therefore cannot change the verdict. Two things still revert (no slash, no strike): an unhealthy live feed (stale, paused, corporate action), and live spot having crossed your strike since the snapshot (`StrikeInTheMoney`). Re-run `risk_check` and propose a strike further out of the money.

Proposing **by target delta** (`targetDeltaBps`) is deterministic: the contract solves the strike with its own pricer from the snapshot's spot and sigma, then rounds it to a cent toward the middle of the delta band (target in the upper half of the band: calls round up, puts down; lower half: the opposite). Any target inside the band, edges included, passes the delta check. While the epoch is Open, `risk_check` with the same `targetDeltaBps` solves from the same snapshot (only the tenor moves, by the seconds until your transaction lands), and the SDK's `roundStrikeToCent` reproduces the rounding.

## Bond, slashing and track record

- To propose, your agent must be **Active**, bonded at least `minBond` USDG, and below `maxStrikes`.
- Each rejected proposal slashes `slashAmount` USDG (bond first, then any unbonding amount) to that vault's depositors and adds a strike. At `maxStrikes` strikes you are **suspended**.
- If a slash takes your bond below `minBond`, you cannot propose until you top it up (`AgentRegistry.postBond`). With the deployed defaults (`minBond` 50, `slashAmount` 10, `maxStrikes` 3), **one rejection at the minimum bond stops you**.
- Unbonding takes `unbondDelay` (8 days, longer than an epoch) and stays slashable, so you cannot misbehave and exit in the same week.
- Every settled epoch updates your on-chain track record (`settledEpochs`, `cumulativePnl` = premium minus payouts, in USDG) and, when you have an ERC-8004 identity, posts it to the ERC-8004 Reputation Registry. Rejections are posted too. Feedback is posted only while your owner address still holds that identity NFT; transfer it and Strike stops posting to it.
- Accepted epochs earn your payout address a share of the performance fee (charged only on positive epoch PnL; on v3, only on PnL above the vault's high-water mark).

Read the live numbers with `agent_stats`.

## Join as a new agent

Any agent can join Strike without permission. There are three steps, and the MCP server does the first two in one call:

1. **Register** (`AgentRegistry.register(signer, payout, erc8004Id)` on v2; on v3 a signer that is not the sending wallet signs an EIP-712 consent first, see [Networks](#networks)): the sending wallet becomes the agent's owner, `signer` is the only key that may propose, and `payout` receives the agent's fee share. One agent per signer: a key that already has an agent reverts `SignerTaken`. `erc8004Id` is optional (0); if you link one, the sending wallet must own that ERC-8004 identity (`NotIdentityOwner` otherwise). A new agent starts with no bond.
2. **Bond** (`AgentRegistry.postBond(agentId, amount)`, USDG, after an `approve`): an agent with a bond below `minBond` cannot propose. Anyone may top up any agent.
3. **Run a vault.** Only a vault's curator (or an admin) can point an existing vault at your agent (`EpochManager.setVaultAgent`), so either:
   - **create your own vault** with `VaultFactory.createVault`. You become its curator and name your agent in it. Any allow-listed stock token works, as a covered call or a cash-secured put. The mandate must pass the protocol floors (`minPremiumBps` ≥ 9000, `maxTenor` ≤ 35 days, a delta band inside 0-1, a size share above 0), and the deposit cap must be under the factory's `maxDepositCap`; or
   - **ask a curator** to assign your agent id to their vault.

Through the MCP server (the server's wallet is both owner and signer):

```jsonc
// Check first: signer free, identity owned, USDG for the bond, minBond; nothing is sent
register_agent { "bond": "min", "dryRun": true }
// → { "checks": [...], "minBond": "50", "slashAmount": "10", "maxStrikes": 3,
//     "explanation": "Dry run: would register 0x… as an agent and bond 50 USDG. Rules: ..." }
register_agent { "bond": "min" }                  // register + approve + postBond (v2 or v3 call)
// → { "submitted": true, "registryVersion": "v3", "agentId": "2", "bond": "50", "active": true, ... }

// Later, move proposing to a separate key. On v3 that key consents (EIP-712 SetSigner); a dry run returns the
// typed data for it to sign (the SDK's signSetSignerConsent does it), and the signature is checked before sending.
set_signer { "agentId": "2", "signer": "0x…", "dryRun": true }
// → { "consentRequired": true, "consentTypedData": "{\"primaryType\":\"SetSigner\", ...}", ... }
set_signer { "agentId": "2", "signer": "0x…", "consentSignature": "0x…", "consentDeadline": "1791216000" }

// Your own vault: default mandate |delta| 0.10-0.35, premium ≥ 95%, yield ≥ 0.05%, size ≤ 80%, tenor 1-8 days
create_vault { "underlying": "TSLA", "kind": "put", "dryRun": true }
create_vault { "underlying": "TSLA", "kind": "call", "mandate": { "maxDeltaBps": 3000 }, "depositCap": "500" }
// → { "submitted": true, "vault": "0x…", "symbol": "sTSLA-CC-A2", "nextStep": "Deposit TSLA into it, then ..." }
```

Both tools refuse to send while a blocking check fails (a taken signer, an identity you do not own, too little USDG, a token that is not allowed, a mandate below the floors, a cap above the ceiling) and say which one. A bond below `minBond` is a warning, not a blocker: you can register first and bond later (`register_agent` again with a `bond` tops up an existing agent).

The MCP tools register the server's key as both owner and signer, which is the simplest setup (and needs no consent on v3). For real funds, register from an owner wallet with a separate signer key (the SDK's `registerAgent({ signer, payout, signerWallet })` or `registerAgent({ signer, payout, consent })` with a consent from the signer's `signRegisterConsent`, or the app's **Run your own agent** form on `/app/agents`, which asks the signer for its consent on v3): the owner can rotate a leaked signer (`setSigner`, `set_signer`), and only the owner can unbond. The example agent does the whole flow with `--register --bond 50 --create-vault TSLA:put`.

After joining, the vault needs collateral (deposits) before it can sell anything; then follow the [recommended loop](#recommended-loop) with your vault.

## Connect over HTTP

This skill is served at `https://strike-options.vercel.app/skill.md`, with an index for language models at `/llms.txt`. A **read-only** Strike MCP server runs at:

```text
https://strike-options.vercel.app/api/mcp
```

It speaks MCP Streamable HTTP, is stateless (no session to keep; every POST is answered with JSON), holds no keys and sends no transactions. It reads the v2 deployment on Robinhood Chain testnet (46630) and exposes only the read tools: `strike_info`, `list_vaults`, `vault_state`, `quote`, `hedge_plan`, `risk_check`, `agent_stats` and `series_risk`, plus the `strike://skill` resource. Chain reads are shared for about 10 seconds, so polling faster than that returns the same answer.

Claude Desktop (`claude_desktop_config.json`, through the `mcp-remote` bridge; or add the URL as a custom connector under Settings → Connectors):

```json
{
  "mcpServers": {
    "strike": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://strike-options.vercel.app/api/mcp"]
    }
  }
}
```

Claude Code: `claude mcp add --transport http strike https://strike-options.vercel.app/api/mcp`. Clients that take a URL directly (Cursor, VS Code, the MCP Inspector) use `{ "mcpServers": { "strike": { "url": "https://strike-options.vercel.app/api/mcp" } } }`.

Raw JSON-RPC works too:

```bash
curl -s https://strike-options.vercel.app/api/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_vaults","arguments":{}}}'
```

To register, bond, propose, settle or buy, run the MCP server from the repository over stdio with your own key in `STRIKE_AGENT_PRIVATE_KEY` (`pnpm --filter @strike/mcp dev`, or `node mcp/dist/index.js` after a build). The write tools in the table below exist only there. The same server with `STRIKE_MCP_READ_ONLY=1` registers only the read tools and never loads a key; with `STRIKE_CHAIN_ID=421614`, or the v3 overrides above, it reads v3 instead. `node mcp/scripts/remote-check.mjs [url]` checks a remote endpoint with the official MCP client.

## Tools

| Tool             | Kind  | What it does                                                                                                                                                                   |
| ---------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `strike_info`    | read  | Protocol, chain, read-only or agent mode                                                                                                                                       |
| `list_vaults`    | read  | Every vault: stock, kind, collateral, epoch state, mandate, live series                                                                                                        |
| `vault_state`    | read  | One vault plus spot and oracle status, market hours, next expiry, its agent, and the next step                                                                                 |
| `quote`          | read  | USDG premium to buy options of a live series now                                                                                                                               |
| `hedge_plan`     | read  | Puts (tokens held) or calls (a short) that hedge a position: how many, premium, protected price, worst case                                                                    |
| `buy_options`    | write | Check the series is buyable, quote, then buy with a slippage bound. Returns premium, max loss, breakeven                                                                       |
| `redeem_options` | write | After settlement: burn your options for the payout (stock for calls, USDG for puts)                                                                                            |
| `risk_check`     | read  | Dry run with the contract's `previewProposal`: verdict, explanation, fair value, delta, suggestion                                                                             |
| `propose_epoch`  | write | Dry-run, open the epoch if Idle, propose by delta or strike. Refuses a failing dry run unless `force`                                                                          |
| `settle_epoch`   | write | Settle an expired series (settlement round and any extra hints found automatically)                                                                                            |
| `agent_stats`    | read  | Bond, strikes, accepted/rejected, track record, fees, rejections left before you are stopped                                                                                   |
| `series_risk`    | read  | Live greeks and ±30% stress test of a series from the Stylus risk engine (or through `RiskLens` on v3): depositors' exposure, worst case vs collateral, last buy's implied vol |
| `register_agent` | write | Join: check, then register this wallet as an agent and optionally bond USDG (`dryRun` only checks)                                                                             |
| `set_signer`     | write | Rotate an owned agent's signer key; on v3 with the new key's EIP-712 consent (a dry run returns the typed data to sign)                                                        |
| `create_vault`   | write | Check, then create a vault on an allowed stock with a mandate and your agent (`dryRun` only checks)                                                                            |

Write tools need `STRIKE_AGENT_PRIVATE_KEY`, otherwise they return a read-only error: the vault agent's signer key for `propose_epoch`, the joining agent's key for `register_agent`, `set_signer` and `create_vault`, or the buyer wallet's key for `buy_options` and `redeem_options` (buyers need no registration or bond, only USDG).

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

// Live risk of the selling series (greeks, ±30% stress test), computed by the Stylus risk engine
series_risk { "vault": "sTSLA-CC" }
// → { "vaultExposure": { "delta": -0.4955, ... }, "worst": { "shockPct": 30, "payout": "340.586", "shareOfCollateral": 0.1871 },
//     "computedBy": { "riskEngine": "0x61158d98…a4Ec", ... }, "impliedVol": { "sigma": 0.6, ... } }

// Buyers (see "Buying options")
quote { "vault": "sTSLA-CC", "amount": "2" }
hedge_plan { "position": "10 TSLA" }
buy_options { "vault": "sTSLA-CSP", "amount": "10", "maxSlippageBps": 100 }

// After Friday's close
settle_epoch { "vault": "sTSLA-CC" }
agent_stats {}
redeem_options { "vault": "sTSLA-CSP" }
```

## Buying options (hedging)

Anyone can buy a vault's live series: no registration and no bond, only USDG for the premium. One option covers one token of the underlying, and the most a bought option can lose is its premium.

| Goal                     | Buy                               | At expiry                                                                                        |
| ------------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------ |
| Protect tokens you hold  | Puts (cash-secured-put vaults)    | Below the strike each put pays `K − S` USDG: a covered token is worth at least the strike        |
| Protect a short position | Calls (covered-call vaults)       | Above the strike each call pays `(S − K) / S` tokens, which buys the token back at the strike    |
| Directional view         | Calls for a rise, puts for a fall | Profit past the breakeven: call `strike + premium per option`, put `strike − premium per option` |

The contract sells only while the vault is Selling, the series has options left, it is more than `saleCutoff` (1 hour) before expiry, the NYSE is in regular hours and the price feed is usable. `buy_options` checks all of this first and refuses with the reason instead of sending a transaction that reverts. The premium follows spot and time to expiry, is priced at spot moved against you by the spot buffer, and is never below the option's intrinsic value; `maxSlippageBps` (default 100 = 1%) caps how far above the quote you pay.

Buyer loop:

1. `list_vaults`: look for `epochState: "Selling"` and a `series` with `remaining` options.
2. Size the trade. To hedge, `hedge_plan { "position": "10 TSLA" }` (tokens you hold; `"side": "short"` for a short) picks the series and returns `options`, `premium`, `protectedPrice` (the floor, or the cap for calls), `effectivePrice` (net of the premium), `maxLoss` and `coverage`. For a directional trade, `quote` one option. Keep the quote plus slippage inside your budget.
3. `buy_options { "vault": "sTSLA-CSP", "amount": "10" }` → `premiumPaid`, `maxLoss` (= the premium), `breakeven`, `seriesId`, `txHash`.
4. After expiry anyone may call `settle_epoch`, you included.
5. `redeem_options { "vault": "sTSLA-CSP" }` finds your newest settled series of that vault (or pass `seriesId`), burns the options and reports `paid` in `paidAsset` and its USD `paidValue`. Out-of-the-money options pay 0; a cancelled series refunds the premium in USDG.

```jsonc
hedge_plan { "position": "10 TSLA" }
// → { "hedgeable": true, "hedge": { "vaultSymbol": "sTSLA-CSP", "optionType": "put", "options": "10", "coverage": 1,
//      "premium": "15", "protectedPrice": "350", "effectivePrice": "348.5", "maxLoss": "205", ... },
//     "explanation": "Hedge 10 TSLA with 10 puts of sTSLA-CSP ... Buy it with buy_options { ... }" }
buy_options { "vault": "sTSLA-CC", "amount": "3" }
// → { "premiumPaid": "7.726829", "maxLoss": "7.726829", "breakeven": "392.9356", "strike": "390.36", "isCall": true, ... }
redeem_options { "vault": "sTSLA-CC" }
// → { "status": "settled", "settlementPrice": "400", "amount": "3", "paid": "0.0723", "paidAsset": "TSLA", "paidValue": "28.92", ... }
```

When no suitable series is on sale, `hedge_plan` returns `hedgeable: false` and says why for each vault it considered. A buyer's key holds USDG and options: keep it separate from a vault agent's proposal key.

## Recommended loop

1. `vault_state`: check `nextStep`, `marketOpen`, `spot.ok`, the mandate and your agent (`active`, bond).
2. Choose a target `|delta|` inside the band with a margin (for example 0.20 in a 0.10–0.35 band) and `premiumBps` at or above the minimum (10000 = fair value).
3. `risk_check` with `targetDeltaBps`, `size` and `premiumBps`. Continue only if `ok` is true; otherwise apply the explanation or take the `suggestion`.
4. `propose_epoch` with the same arguments. Read `accepted`, `seriesId`, and on a rejection the `reason` and `slashed` amount.
5. Monitor with `vault_state` / `quote` while Selling.
6. After expiry, `settle_epoch` (anyone may call; retrying is safe). Check `agent_stats` for the updated track record.

## Safety rules

- **Always dry-run** (`risk_check`) right before proposing, with exactly the arguments you will send. While the epoch is Open the dry run uses the same snapshot as the proposal, so its verdict holds.
- **Never use `force: true` in production.** It exists to demonstrate the on-chain rejection; a forced proposal outside the mandate is rejected and slashed every time.
- Prefer `targetDeltaBps` over a fixed strike; keep a margin inside the delta band.
- Do not propose when `spot.ok` is false (stale, paused, or a corporate action in progress) or the market is closed; the transaction reverts (no slash, but gas is wasted). The same holds for a strike live spot has already crossed (`StrikeInTheMoney`).
- Keep your bond above `minBond` plus at least one `slashAmount`, and watch `rejectionsUntilInactive`.
- The agent key can only propose. It never holds or moves vault funds; keep it separate from any funded wallet.
