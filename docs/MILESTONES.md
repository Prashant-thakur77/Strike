# Milestones

A milestone plan for the buildathon's milestone-based grant (up to $30,000, [hackathon.md](hackathon.md)) and for the milestone half of any prize. Each milestone ends in something a reviewer can check on-chain or on GitHub without asking us. Timelines count weeks from the start of funding; with funding from October 2026, the plan ends around February 2027. The budget split is a draft for the owner to confirm.

It follows the roadmap in the README and the deck: v3 with the Stylus risk engine on Robinhood Chain testnet and Arbitrum Sepolia, then a capped mainnet vault after an audit. Where Strike stands today is in the README's [What works, what does not yet, what we cut](../README.md#what-works-what-does-not-yet-what-we-cut).

The first two milestones of the original plan were finished during the buildathon (30 September and 1 October 2026), so they ask for no money. Their $11,000 moved to the work that is still open: making v3 the main version, running and settling it week after week, a larger audit scope (the risk engine doubled the Rust code), and support for outside agents.

## Summary

| #    | Milestone                                               | Weeks      | Budget  |
| ---- | ------------------------------------------------------- | ---------- | ------- |
| Done | v3 live on Robinhood Chain testnet and Arbitrum Sepolia | buildathon | $0      |
| Done | Stylus risk engine in the proposal path                 | buildathon | $0      |
| 1    | v3 becomes the main version                             | 1–3        | $3,000  |
| 2    | Eight settled weeks on both testnets                    | 1–9        | $4,000  |
| 3    | External audit, then a capped mainnet vault             | 6–18       | $17,000 |
| 4    | Outside agents, integrators and published SDK           | 8–18       | $6,000  |
|      | Total                                                   |            | $30,000 |

## Done: v3 live on Robinhood Chain testnet and Arbitrum Sepolia

Finished during the buildathon. The fixes on the [`v3-contracts`](https://github.com/Prashant-thakur77/Strike/tree/v3-contracts) branch (fee high-water mark, EIP-712 signer consent, active-agent check, `InvalidMandate(reason)`) are deployed on both testnets:

- Robinhood Chain testnet (46630), next to v2, block 126,713,718 on 2026-09-30, address files [`46630-v3.json`](../contracts/deployments/46630-v3.json) and [`46630-v3-vaults.json`](../contracts/deployments/46630-v3-vaults.json). Log: [testnet-epochs/2026-09-30-v3.md](testnet-epochs/2026-09-30-v3.md).
- Arbitrum Sepolia (421614), block 314,350,623 on 2026-09-30, address file [`421614.json`](../contracts/deployments/421614.json), which is also the SDK's `421614` entry. Log: [testnet-epochs/2026-09-30-arbitrum-sepolia.md](testnet-epochs/2026-09-30-arbitrum-sepolia.md).
- Every contract has verified source on Blockscout (the two test stock tokens on Sourcify), and the Stylus program passes `cargo stylus verify` on both chains ([DEPLOYMENTS.md](DEPLOYMENTS.md)).
- One live epoch on each chain (30 September on Arbitrum Sepolia, 1 October on Robinhood Chain testnet): Claude planned the accepted 0.20-delta call, an at-the-money put was rejected and 10 USDG slashed, a separate buyer bought 4 calls, and both decision records are anchored in that chain's DecisionLog.

Moved to milestones 1 and 2: the settlement and redeem transactions (the first series expire on Friday 2026-10-02 at 20:00 UTC), a second epoch on the same vault to show the high-water mark, merging `v3-contracts` into `main`, and moving the SDK, MCP server, app and subgraph to v3 on Robinhood Chain testnet.

## Done: Stylus risk engine in the proposal path

Finished during the buildathon, on the `v3-contracts` branch and live on both testnets:

- The risk engine in `stylus/pricer` (implied volatility, greeks, scenario loss), with Rust tests, a Python reference (`research/risk_reference.py`) and generated vectors (`contracts/test/vectors/risk.json`).
- The Solidity twin (`RiskLib.sol`) and differential tests that demand exact equality (`contracts/test/differential/RiskDifferential.t.sol`).
- `EpochManager` emits `SeriesRisk` at proposal time and `RiskLens` reads a series' greeks and scenario loss; the app's vault page shows them in its risk panel. The accepted proposals on [Arbitrum Sepolia](https://sepolia.arbiscan.io/tx/0xf26315b33df93548bfa31d68b7d9964792ef88184cb154796180e19b9365b5f4) and [Robinhood Chain testnet](https://explorer.testnet.chain.robinhood.com/tx/0xe823a351b82404077c126482ca61f6be9c1c461606b4626f55bea1898d335a45) carry the event, and both are linked from [DEPLOYMENTS.md](DEPLOYMENTS.md).
- Gas: the branch's `docs/gas.md` compares the risk engine in Stylus and Solidity, including where Stylus costs more, and [gas.md](gas.md#v3-on-arbitrum-sepolia-uncached-and-cached) has live figures from Arbitrum Sepolia, cached and uncached.

Moved to milestone 1: `cargo stylus verify` against a tagged release, once the branch is merged.

## 1. v3 becomes the main version (weeks 1–3, $3,000)

After v2's last series settles, `main` carries v3 and v2 becomes an archived, read-only version ([decisions.md D36](decisions.md)).

Deliverables:

- `v3-contracts` merged into `main` and tagged; v2's source stays at commit [`1ff5382`](https://github.com/Prashant-thakur77/Strike/commit/1ff5382), which its verified Blockscout code matches.
- SDK, MCP server, app and subgraph on v3 on Robinhood Chain testnet (`46630-v3.json`), as the SDK, MCP server and app already are on Arbitrum Sepolia; v2 stays readable in the app as an archived version.

Acceptance criteria:

- CI is green on `main` with the v3 contracts, and the tag exists.
- `cargo stylus verify` against the tag reports **Verification successful** for the Stylus program on both chains.
- The app's vault pages on both chains show v3 vaults, with the risk panel read through `RiskLens`.

Budget: development time.

## 2. Eight settled weeks on both testnets (weeks 1–9, $4,000)

One live epoch shows the contracts work; eight in a row show they can be operated. The keeper and the weekly agent run on their schedule on both chains, without anyone starting them by hand.

Deliverables:

- The keeper and the weekly agent workflow enabled on both chains, with Claude planning each proposal.
- Eight consecutive weekly epochs on each chain, each opened, proposed, sold where there is demand, settled and redeemed.
- A later epoch on the same vault that shows the high-water mark at work: no fee on a week that only wins back an earlier loss.
- The subgraph deployed to a hosted indexer ([indexing.md](indexing.md)), and the [Telegram bot](../bots/telegram/README.md) hosted and posting settlement and rejection alerts.

Acceptance criteria:

- A log in `docs/testnet-epochs/` for each week and chain links the open, propose, buy, settle and redeem transactions, and every slash's payout to depositors.
- The high-water mark is readable from the `FeeManager` events of the epoch that won back a loss.
- The subgraph URL returns the epochs for the live vaults.
- The agent's decision record for every week is in `docs/agent-log` and anchored in the DecisionLog.

Budget: keeper, bot and indexer hosting, testnet gas and development time.

## 3. External audit, then a capped mainnet vault (weeks 6–18, $17,000)

An external audit of the v3 contracts and the Stylus program, then one capped vault on Robinhood Chain mainnet. The scope is about 2,100 nSLOC of Solidity on `main` plus the v3 changes ([audit-readiness.md](audit-readiness.md)), and about 1,340 lines of Rust in the v3 Stylus program (`lib.rs`, `math.rs` and `risk.rs`), about twice the Rust of v2.

Deliverables:

- An audit by an outside firm. The grant covers part of it ($14,000 in this split), and the rest is requested from the Arbitrum Audit Program, which [audit-readiness.md](audit-readiness.md) is prepared for.
- Every High and Medium finding fixed with a regression test, as was done for the internal review ([review-2026-09-29.md](security/review-2026-09-29.md)).
- One TSLA covered-call vault on Robinhood Chain mainnet (4663) with a `depositCap` agreed in advance, admin and guardian roles held by a Safe multisig, and the real Chainlink feed (no `MirrorFeed`).
- Four weekly epochs run and settled on it.

Acceptance criteria:

- The audit report is published in `docs/security/`, with each finding's status and the commit that fixed it.
- `contracts/deployments/4663.json` lists the addresses; each is verified on the Robinhood Chain explorer.
- The vault's `depositCap` and the Safe's `hasRole` on each admin role are readable on-chain.
- Four settlement transactions are linked from `docs/DEPLOYMENTS.md`.

Budget: $14,000 toward the audit; $3,000 for mainnet gas, seed collateral, monitoring and the Safe setup.

## 4. Outside agents, integrators and a published SDK (weeks 8–18, $6,000)

Strike's case rests on agents and builders it does not control. This milestone measures that.

Deliverables:

- `@strike/sdk` and the MCP server published to npm, next to the read-only remote MCP that is already live at `https://strike-options.vercel.app/api/mcp`.
- At least three agents registered and bonded by owners outside the team, each running a vault or proposing for one.
- At least one repository outside Strike that imports `SafeStockFeed` or runs its conformance suite ([`test/conformance`](../contracts/test/conformance)).
- Ten or more testnet testers who file the [feedback form](https://github.com/Prashant-thakur77/Strike/issues/new?template=testnet-feedback.yml).

Acceptance criteria:

- The npm package pages exist.
- `AgentRegistry` shows at least three agents whose owners are not team addresses, each with a bond at or above `minBond`.
- A public link to the outside repository and its passing CI run.
- The feedback issues are public on GitHub.

Budget: npm and docs work, and tester and agent-builder support.

## Later, not in this plan

- Lend idle put collateral through an ERC-4626 USDG vault, so collateral earns while it waits (today it earns nothing; see the README's [comparison with USDG lending](../README.md#against-usdg-lending)).
- Put spreads to lower the collateral a put vault needs, and more tickers.
- A USDG gas paymaster.
- The same vaults on Arbitrum One for tokenized stocks from other issuers.
- Agent reputation from settled on-chain results used as credit.
