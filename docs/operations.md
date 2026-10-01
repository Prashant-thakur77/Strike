# Operations runbook

How Strike is run week to week and what to do when something goes wrong. Every action below is a single transaction or script; none of them can move a depositor's funds anywhere except back to depositors or option holders.

## Weekly schedule (New York time)

| When                                        | Who                                               | Action                                                                                                                                                                                                                                            | Command                                                                              |
| ------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Monday 11:00 (15:00 UTC; 10:00 in winter)   | Agent #1, autonomous (GitHub Actions `agent.yml`) | Check the NYSE session (skip on holidays), run the keeper once, propose on both TSLA vaults (Claude plans with `--llm` when `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` is set) and commit a decision record per vault to `docs/agent-log`   | `pnpm --filter @strike/agent-example start -- --vault <symbol> --log docs/agent-log` |
| Monday after 09:30                          | Agent (or keeper)                                 | Open the epoch; propose by delta                                                                                                                                                                                                                  | `pnpm --filter @strike/agent-example start -- --vault <symbol>`                      |
| Monday–Friday 16:00 minus sale cutoff       | Buyers                                            | Buy options                                                                                                                                                                                                                                       | app or `--buy` agent                                                                 |
| Every 10 minutes (testnet)                  | Keeper                                            | Mirror mainnet Chainlink rounds into the MirrorFeeds and settle expired epochs, on Robinhood Chain testnet (v2 and v3) and Arbitrum Sepolia (v3)                                                                                                  | `scripts/keeper.sh --once` (GitHub Actions `keeper.yml`, one job per chain)          |
| Friday after 16:00                          | Anyone (keeper by default)                        | Settle at the first round at or after expiry. When that needs more than one hint (new Chainlink phase, corporate action at expiry), record the price first with `StockOracle.recordSettlementPriceWithHints`; the SDK's `settle` does this itself | `--settle` agent (SDK) or `scripts/keeper.sh --once` (one hint only)                 |
| Friday 21:15 UTC (after the close all year) | Agent #1, autonomous (`agent.yml`)                | Keeper once (settles), then record each settlement in `docs/agent-log`; the agent settles itself only if nothing has yet                                                                                                                          | `--settle --log docs/agent-log`                                                      |
| After settlement                            | Depositors, buyers                                | Claim premium, queued deposits and redemptions; redeem options                                                                                                                                                                                    | app                                                                                  |

The autonomous runs are off until the owner flips three switches in the repository settings (Settings → Secrets and variables → Actions): the secret `KEEPER_PRIVATE_KEY` (the deployer key, agent #1's signer and the keeper key, also used by `keeper.yml`), the variable `AGENT_ENABLED` = `true`, and optionally a Claude credential so Claude plans each epoch: the secret `ANTHROPIC_API_KEY` (the Claude API, billed per token), or the secret `CLAUDE_CODE_OAUTH_TOKEN` to use a Claude Pro/Max subscription instead. Create that token with `claude setup-token` on a machine where Claude Code is logged in to the subscription; the job then installs Claude Code (pinned) and plans through `claude -p` with only the read-only Strike tools, and each run counts against the subscription's usage limits. The API key wins when both are set. See [Claude plans the epoch](../agents/example/README.md#claude-plans-the-epoch---llm). The agent and the keeper share a concurrency group, so they never send from the same key at once. See [agent-log](agent-log/README.md) for what each record contains.

## Keeper: which vaults it covers

`scripts/keeper.sh` reads every active deployment file for its `CHAIN_ID` in [`contracts/deployments`](../contracts/deployments): `<chainId>.json` and any `<chainId>-<name>.json`, skipping `*-vaults.json` and files whose `status` starts with "superseded" (`46630-v1.json`). For each one it walks the `EpochManager`'s `allVaults` and settles every epoch that is past expiry.

| Chain                         | Deployment files read                               | Vaults settled                                               |
| ----------------------------- | --------------------------------------------------- | ------------------------------------------------------------ |
| Robinhood Chain testnet 46630 | `46630.json` (v2), `46630-v3.json` (v3, next to v2) | Both versions' TSLA covered-call and cash-secured-put vaults |
| Arbitrum Sepolia 421614       | `421614.json` (v3)                                  | The v3 TSLA covered-call and cash-secured-put vaults         |

v3 on Robinhood Chain shares v2's `MarketCalendar` and MirrorFeeds, so one push serves both; a feed listed in two files is pushed once. If a single settlement round is not enough (a Chainlink phase change or a corporate action at expiry), the keeper settles through the example agent and the SDK; for a file other than `<chainId>.json` it passes that file's addresses as the SDK's `STRIKE_*` overrides. Settlement is permissionless, so anyone can also settle a vault with `EpochManager.settle(vault, round)` or the agent's `--settle --vault <address>`.

Check what a run would do without sending anything (no key needed):

```bash
CHAIN_ID=46630 scripts/keeper.sh --once --dry-run
CHAIN_ID=421614 RPC_URL=https://sepolia-rollup.arbitrum.io/rpc scripts/keeper.sh --once --dry-run
```

On 2026-10-01 this listed the v2 and v3 covered-call epochs on 46630 and the v3 covered-call epoch on 421614 as selling, all expiring 2026-10-02 20:00 UTC.

## Friday 2 October settlement runbook

Three series expire on Friday 2026-10-02 at 20:00 UTC (`expiry` 1790971200): the v2 TSLA covered call on Robinhood Chain testnet (vault `0xADFF7900…1D4e`, 4 calls at $369.86, 10.005944 USDG of premium, bought by the deployer), the v3 covered call next to it (`0x478E7BC3…6285`, 4 calls at $369.36, 7.38387 USDG, buyer `0x1a00…7364`) and the v3 covered call on Arbitrum Sepolia (`0x5655659E…7311`, 4 calls at $364.29, 8.905435 USDG, buyer `0x85f0…33E1`). The two v3 cash-secured-put vaults (`0x1bc73c1B…3690` on 46630, `0x02B70121…9bbe` on 421614) are still `Open` after the rejected proposals, each with 10 USDG of slashed bond waiting as `compensation`; v2's put vault is `Idle`. Everything below ran on anvil forks of both chains on 1 October, in and out of the money: [testnet-epochs/2026-10-02-settlement-rehearsal.md](testnet-epochs/2026-10-02-settlement-rehearsal.md).

Pause the automation first, so one person sends from the keeper key: set the repository variable `KEEPER_ENABLED` to anything but `true` (`keeper.yml` runs every 10 minutes on both chains while it is `true`) and leave `AGENT_ENABLED` off (`agent.yml` would run `--settle --log --anchor` at 21:15 UTC from its own job; step 7 runs the same by hand). Everything runs from the repository root on `main` with Foundry and Node 22 (`corepack pnpm`). `PRIVATE_KEY` is the keeper key (the deployer, which holds `KEEPER_ROLE` on every MirrorFeed and is the curator of all four vaults); the deployer's ETH (0.0153 on 46630, 0.0427 on 421614) covers the day many times over at 0.01 gwei. Addresses: `contracts/deployments/46630.json`, `46630-v3.json`, `421614.json` and the `-vaults.json` next to them.

```bash
# The v3-on-46630 addresses for the SDK, the MCP and the example agent (46630's map entry is v2).
export STRIKE_EPOCH_MANAGER=0x256D4546486368dCb23E94758b4cb500c215929F STRIKE_AGENT_REGISTRY=0x1c42740145B245b2f894d8e989ca29dfd9A9052f \
  STRIKE_VAULT_FACTORY=0x97ab9ed707758Fc23b4e59132d97Ab7cb9fb215e STRIKE_STOCK_ORACLE=0x5BCdBFaB940BFAEF821392d7f58c670c2064989A \
  STRIKE_OPTION_TOKEN=0xfbeb6cf8350C182c7895165A8Fdd3D9884aB46B6 STRIKE_FEE_MANAGER=0x8DBE22eAa3CEFC367C435ce2b6F779fabe7D2Fa7 \
  STRIKE_PRICER=0x2B6A2A51bd802Ed11bE7c0B954a7Ec9287c362d0 STRIKE_VAULT_IMPLEMENTATION=0x2E67F1Cf23eAAeecaee36d248d76e8366DA076D9 \
  STRIKE_DECISION_LOG=0xa98106db53519F8cfE4D7C56B34D4Fe0460403a4 STRIKE_RISK_ENGINE=0x61158d98c6c2b7ccb22755a098d0da2bbcf2a4ec \
  STRIKE_RISK_LENS=0xFDb8Ba33f4aAF1A699f1D5877E8ee5b6eDeDCc6D STRIKE_DEPLOY_BLOCK=126713718
```

### 1. Before the close: dry runs (any time on Friday)

```bash
CHAIN_ID=46630 scripts/keeper.sh --once --dry-run
CHAIN_ID=421614 RPC_URL=https://sepolia-rollup.arbitrum.io/rpc scripts/keeper.sh --once --dry-run
```

Expect `0xADFF7900… (46630.json) selling, expires 2026-10-02T20:00:00Z`, the same for `0x478E7BC3… (46630-v3.json)`, and `0x5655659E… (421614.json)` on the second. Anything else (a vault missing, "no deployment file", a feed read failure) is fixed before the close, not after.

### 2. After 20:00 UTC: wait for the first mainnet print after the close

The MirrorFeeds take their rounds from the Robinhood Chain mainnet Chainlink TSLA feed, which prints about every 24 minutes (deviation-triggered; on 1 October six rounds spanned 16:04 to 19:55 UTC with gaps up to 1.7 hours). The settlement round is the first mirrored round with `updatedAt >= 1790971200`, so the first print at or after 20:00:00 UTC may land at 20:00 or well after. Repeat the dry run every few minutes:

- `dry run: would push TSLA <answer> @ <updatedAt>` with `updatedAt >= 1790971200` means the round is there: go to step 3.
- `TSLA: no print after expiry yet` with the push line showing an `updatedAt` before 1790971200 (or no push line): wait.
- `TSLA: feed read failed (mainnet: '', …); skipped`: the mainnet RPC refused the read (Cloudflare 403 under load). Wait a minute and retry; do not hammer it with other scripts at the same time.

### 3. Robinhood Chain testnet: mirror and settle v2 and v3 in one run

```bash
CHAIN_ID=46630 PRIVATE_KEY=<keeper key> scripts/keeper.sh --once
```

Expect three lines: `TSLA mirrored <answer> @ <updatedAt>`, `settled 0xADFF7900dbe01E8170a750AB88e1f4eA8D9D1D4e at round N` and `settled 0x478E7BC3C3aB07fdd104e4765F178977adEe6285 at round N` (the same round: the feed is shared). Other symbols may mirror too. The keeper sends `settle` with `cast estimate` × 1.5 (a bare estimate left v2's ERC-8004 feedback out of gas on the fork). Check, with `EM=0x5A3b58DF27e4DD5E0fa6493D90fF653e0E199C99` for v2 and `0x256D4546486368dCb23E94758b4cb500c215929F` for v3, and the block the run started at as `--from-block`:

```bash
RPC=https://rpc.testnet.chain.robinhood.com
cast call $EM "epochs(address)(uint8,uint64,uint256,uint128,uint64)" <vault> --rpc-url $RPC | head -1   # 0 = Idle
cast logs --from-block <block> --address $EM "EpochSettled(address,uint64,uint256,uint256,uint256,uint256,uint256)" --rpc-url $RPC
cast logs --from-block <block> --address <agentRegistry> "ReputationFeedback(uint256,uint256,int128,string,bool)" --rpc-url $RPC
cast call <feeManager> "lossCarried(address)(uint256)" 0x478E7BC3C3aB07fdd104e4765F178977adEe6285 --rpc-url $RPC   # v3 only
```

`EpochSettled` carries the settlement price (WAD), the payout (TSLA, WAD), the premium and the fee; `ReputationFeedback` must end in `true` (the last word of its decoded data; value = premium − payout value in USDG, 6 decimals, tag `strike.epoch.pnl`, to identity #114). `SettlementPriceRecorded(TSLA, 1790971200, N, price)` sits on each StockOracle (`0x7bb3cAb2…aB89` for v2, `0x5BCdBFaB…989A` for v3). The vault's USDG balance equals premium − fee, and `AgentRegistry.track(1)` reads 1 settled epoch with the PnL.

### 4. Arbitrum Sepolia: the same, v3 only

```bash
CHAIN_ID=421614 RPC_URL=https://sepolia-rollup.arbitrum.io/rpc PRIVATE_KEY=<keeper key> scripts/keeper.sh --once
```

Expect `TSLA mirrored …` and `settled 0x5655659E18bf54ee0EF8f6A816E2e18D000F7311 at round M`. The same checks with `EM=0xB8Ed17588AB022d8f84b8305d784Fa01478Cb7F0`, the registry `0xAa3CA784…341E` (feedback to #253), the FeeManager `0xaD2C4aC0…4569` and the oracle `0x8B89A4dE…bA9F`.

### 5. Buyers redeem (only worth it in the money)

With each buyer's key as `STRIKE_AGENT_PRIVATE_KEY` (the v3 keys are in the local files the epoch logs name; the v2 buyer is the deployer):

```bash
STRIKE_CHAIN_ID=46630 pnpm --filter @strike/agent-example start -- --redeem --vault sTSLA-CC            # v2, deployer key
STRIKE_CHAIN_ID=46630 <v3 overrides above> pnpm --filter @strike/agent-example start -- --redeem --vault sTSLA-CC   # v3, buyer 0x1a00…7364
STRIKE_CHAIN_ID=421614 pnpm --filter @strike/agent-example start -- --redeem --vault sTSLA-CC           # buyer 0x85f0…33E1
```

In the money it prints "settled at $S, in the money: 4 options paid X TSLA" and the TSLA arrives in the buyer's wallet; out of the money it burns the options for nothing ("expired worthless"), which can also just be left. By hand: `cast send $EM "redeem(uint256,uint256,address)" <seriesId> 4000000000000000000 <buyer>` from the buyer.

### 6. Curator: close the v3 put epochs and let depositors claim

```bash
cast send 0x256D4546486368dCb23E94758b4cb500c215929F "abortEpoch(address)" 0x1bc73c1B28F520E57982FAe6127477190FA53690 --rpc-url https://rpc.testnet.chain.robinhood.com --private-key <deployer key>
cast send 0xB8Ed17588AB022d8f84b8305d784Fa01478Cb7F0 "abortEpoch(address)" 0x02B701210aA006CEAbd389dBc32af0047B1B9bbe --rpc-url https://sepolia-rollup.arbitrum.io/rpc --private-key <deployer key>
```

After each: `compensation(vault)` reads 0, the vault's USDG is up by 10 (60 → 70 on 46630, 30 → 40 on 421614), the epoch is `Idle`, and `pendingPremium(deployer)` reads 9.999999 USDG (one unit stays in the vault). `claimPremium()` from the deployer collects it. On the call vaults the deployer's `claimPremium()` collects the premium (minus the fee when there is one), and out of the money `FeeManager.claim()` from the deployer collects the fee (the deployer is both treasury and agent #1's payout address). A deposit or redemption queued during the week is processed by the settlement and claimed with `claimDeposit(account)` / `claimRedeem(account)`.

### 7. Settlement records

```bash
STRIKE_CHAIN_ID=46630 STRIKE_AGENT_PRIVATE_KEY=<v2 signer = deployer> pnpm --filter @strike/agent-example start -- --settle --vault sTSLA-CC --log docs/agent-log --anchor
STRIKE_CHAIN_ID=46630 STRIKE_AGENT_PRIVATE_KEY=<v3 signer 0x4fd9…AC6f> <v3 overrides> pnpm --filter @strike/agent-example start -- --settle --vault sTSLA-CC --log docs/agent-log --anchor
STRIKE_CHAIN_ID=421614 STRIKE_AGENT_PRIVATE_KEY=<v3 signer> pnpm --filter @strike/agent-example start -- --settle --vault sTSLA-CC --log docs/agent-log/arbitrum-sepolia --anchor
```

Each finds the keeper's settlement ("Already settled by the keeper at $S: …") and writes `2026-10-02-sTSLA-CC.{md,json}`; v2's and v3's records on 46630 share the folder, so the second gets a `-2` suffix. **Settlement records are anchored (`--anchor`):** a settlement record anchors under the vault's current epoch, still 1, and so replaces `latestHash(1, vault, 1)`, but the app's "Why this strike" panel checks each record against its own anchoring transaction's `DecisionRecorded` event, so the proposal record keeps "hash matches (anchored in tx …)" and the panel notes that a later record for the epoch exists. If the series is not settled yet when this runs, the agent settles it itself through the SDK (with hints if a single round is not enough).

### Expected numbers

Per option of a call: payout = (S − K) / S TSLA when S > K, else 0; payout value = payout × S in USDG. Fee = 10% of max(premium − payout value − `lossCarried`, 0) (`lossCarried` is v3 only and 0 today), half to agent #1's payout address, half to the treasury; both are the deployer. Feedback value = premium − payout value. Depositors can claim premium − fee.

| Settlement price    | 46630 v2 (K 369.86, premium 10.005944)                                                         | 46630 v3 (K 369.36, premium 7.38387)                                                                 | 421614 v3 (K 364.29, premium 8.905435)                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| $380                | buyer gets 0.106736842105263156 TSLA (40.56 USDG); fee 0; PnL −30.554055; depositors 10.005944 | buyer gets 0.112 TSLA (42.56 USDG); fee 0; PnL −35.17613; `lossCarried` 35.17613; depositors 7.38387 | buyer gets 0.165368421052631576 TSLA (62.84 USDG); fee 0; PnL −53.934564; `lossCarried` 53.934564; depositors 8.905435 |
| $350 (or any S ≤ K) | payout 0; fee 1.000594 (0.500297 + 0.500297); PnL +10.005944; depositors 9.00535               | payout 0; fee 0.738387 (0.369193 + 0.369194); PnL +7.38387; depositors 6.645482                      | payout 0; fee 0.890543 (0.445271 + 0.445272); PnL +8.905435; depositors 8.014891                                       |

For another price S above the strike: 4 × (S − K) / S TSLA to the buyer, and the vault's `lossCarried` (v3) becomes payout value − premium. The settlement price is the first mirrored mainnet round after the close, not the official NYSE close.

### If something fails

| Symptom                                                                                               | Cause                                                                                                         | Do                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TSLA: no print after expiry yet` for a long time                                                     | The mainnet feed has not printed since the close, or the keeper did not mirror it                             | Keep running the dry run; settlement waits for the first mirrored print after expiry, even if that is Monday. Only if the mainnet feed is dead for days: the guardian's `emergencyCancel` after `settlementGrace` (7 days) returns the collateral and refunds premiums                                                                                                     |
| `feed read failed (mainnet: '' …); skipped`                                                           | `rpc.mainnet.chain.robinhood.com` answered with a Cloudflare 403                                              | Retry after a minute. As a last resort push the Chainlink round by hand from the keeper key: `cast send <feed> "push(int256,uint64)" <answer, 8 decimals> <the round's updatedAt>` with the values of the real mainnet round (`updatedAt` must be after the feed's last round and not in the future)                                                                       |
| `push failed (is the key the feed's KEEPER_ROLE?)`, `AccessControlUnauthorizedAccount` (`0xe2517d3f`) | `PRIVATE_KEY` is not the deployer                                                                             | Use the deployer key, or `grantRole(KEEPER_ROLE, key)` from it                                                                                                                                                                                                                                                                                                             |
| `single-round settle failed; settling through the SDK with hints`, then `settle failed for <vault>`   | `settle` reverted                                                                                             | Read the reason: `cast call $EM "settle(address,uint80)" <vault> <round>`. `InvalidSettlementRound` (`0xc0b00676`): the round is before expiry or not the first after it; find it with `getRoundData` and settle by hand with `--gas-limit 1200000`. `NotExpired` (`0xb8b92567`): the chain is not past 20:00 UTC yet. `WrongState`: already settled; check `EpochSettled` |
| `MissingHint` (`0x4e3cd8d0`)                                                                          | Cannot happen on a MirrorFeed (no phases); on a real Chainlink proxy it means a phase change at expiry        | The keeper's SDK fallback records the price with `recordSettlementPriceWithHints`; by hand, `findSettlementHints` in the SDK gives the hints                                                                                                                                                                                                                               |
| `ReputationFeedback(…, posted = false)`                                                               | Too little gas for the ERC-8004 call inside `settle`'s `try/catch`, or the owner no longer holds the identity | Nothing: the feedback is only posted inside `settle` and the settlement is final. Note it in the log; `track(1)` on the AgentRegistry still has the PnL. Avoid it by settling through the keeper or with `--gas-limit 1200000`                                                                                                                                             |
| `abortEpoch` reverts `TooEarly`                                                                       | The sender is not the curator (the deployer) and the proposal timeout has not passed                          | Send from the deployer                                                                                                                                                                                                                                                                                                                                                     |
| `--settle --log` says "no live series … and no settlement in the last 7 days"                         | The vault was settled more than 7 days ago, or the chain read used the wrong deployment                       | Check `STRIKE_CHAIN_ID` and the v3 overrides                                                                                                                                                                                                                                                                                                                               |
| `--redeem` says "nothing to redeem"                                                                   | The series settled out of the money, or the wallet holds no options of a settled series                       | Nothing to do                                                                                                                                                                                                                                                                                                                                                              |

## Incidents

| Situation                                             | What the protocol does by itself                                                                                                                                                                                                        | Operator action                                                                                                                                                                                                                                                 |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Feed stale (weekend, outage)                          | Opening and buying revert `StalePrice`; settlement waits for the first print after expiry                                                                                                                                               | None. Check the feed; the keeper retries settlement                                                                                                                                                                                                             |
| Token or oracle paused by the issuer                  | Reads revert `TokenPaused` / `FeedPaused`; settlement waits; idle withdrawals keep working                                                                                                                                              | None. Announce; wait for unpause                                                                                                                                                                                                                                |
| Split or dividend announced                           | Sales and opening revert `CorporateActionPending` until `effectiveAt + grace`. If the first print after expiry is within grace of `effectiveAt`, settlement uses the first print at or after `effectiveAt + grace`                      | None. Optionally announce the pause window. For settlement, use the SDK `settle` (or `findSettlementHints` + `recordSettlementPriceWithHints`), then `settle`                                                                                                   |
| Chainlink aggregator upgrade (new phase) near expiry  | Settlement accepts round 1 of the new phase once the old phase's last round proves nothing was printed after expiry                                                                                                                     | None. Use the SDK `settle`; `scripts/keeper.sh` passes one hint and will revert `MissingHint`                                                                                                                                                                   |
| Agent proposes outside the mandate                    | Rejected, bond slashed to depositors, strike counted; three strikes suspend. Judged against the spot and sigma snapshotted at `openEpoch`; if live spot has since crossed the strike the proposal reverts `StrikeInTheMoney` (no slash) | Review the agent; curator may switch agents (`setVaultAgent`)                                                                                                                                                                                                   |
| Implied volatility needs a large move                 | Keeper `setSigma` moves at most 25% per update, once an hour (`SigmaOutOfBounds`, `TooEarly`)                                                                                                                                           | Step it hourly, or the admin sets it directly with `setSigmaBounds`                                                                                                                                                                                             |
| Agent key compromised                                 | The key can only propose inside the mandate                                                                                                                                                                                             | Owner rotates the signer (`setSigner`); curator switches the agent; admin suspends (`setStatus`)                                                                                                                                                                |
| No proposal by the timeout                            | Anyone can `abortEpoch`; queue processed                                                                                                                                                                                                | Keeper aborts                                                                                                                                                                                                                                                   |
| Feed dead after expiry for `settlementGrace` (7 days) | Nothing settles                                                                                                                                                                                                                         | First check `StockOracle.settlementPrice(token, expiry)`: if a price is recorded, `settle` works and `emergencyCancel` reverts `SettlementAvailable`. Otherwise the guardian calls `emergencyCancel`: collateral back to the vault, buyers redeem their premium |
| Suspected bug                                         |                                                                                                                                                                                                                                         | Guardian `pause()`: stops new epochs, proposals and buys; settlement, claims and idle withdrawals keep working                                                                                                                                                  |
| Sequencer down (where a sequencer feed is configured) | Reads revert `SequencerDown` / `SequencerGracePeriod`                                                                                                                                                                                   | None                                                                                                                                                                                                                                                            |

## Keys

| Key              | Where                                      | Mainnet requirement                                        |
| ---------------- | ------------------------------------------ | ---------------------------------------------------------- |
| Admin / guardian | `contracts/.env` on testnet                | A Safe multisig; guardian may be a faster 2-of-3           |
| Keeper           | GitHub Actions secret `KEEPER_PRIVATE_KEY` | Separate hot key with `KEEPER_ROLE` only                   |
| Agent signer     | Agent operator                             | Separate from the agent owner key; rotate with `setSigner` |

## Monitoring

Watch these events (the subgraph indexes all of them): `ProposalRejected`, `Slashed`, `StatusSet` (suspensions), `EpochSettled` (payout vs premium), `SeriesCancelled`, `Paused`, `SettlementPriceRecorded`, `FeedSet`, `SigmaSet`. `SpotBufferSet` is not indexed; read it from the chain. Alert when an epoch stays `Selling` more than a day past expiry, or when a MirrorFeed (testnet) is older than 24 hours.
