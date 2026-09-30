# Milestones

A milestone plan for the buildathon's milestone-based grant (up to $30,000, [hackathon.md](hackathon.md)) and for the milestone half of any prize. Each milestone ends in something a reviewer can check on-chain or on GitHub without asking us. Timelines count weeks from the start of funding. The budget split is a draft for the owner to confirm.

It follows the roadmap in the README and the deck: Arbitrum Sepolia, then a capped mainnet vault after an audit, with the v3 risk engine in Stylus. Where Strike stands today is in the README's [What works, what does not yet, what we cut](../README.md#what-works-what-does-not-yet-what-we-cut).

## Summary

| #   | Milestone                                     | Weeks | Budget  |
| --- | --------------------------------------------- | ----- | ------- |
| 1   | v3 live on Robinhood Chain and Arbitrum       | 1–3   | $4,000  |
| 2   | Stylus risk engine in the proposal path       | 3–7   | $7,000  |
| 3   | External audit, then a capped mainnet vault   | 6–14  | $14,000 |
| 4   | Outside agents, integrators and published SDK | 10–16 | $5,000  |
|     | Total                                         |       | $30,000 |

## 1. v3 live on Robinhood Chain and Arbitrum (weeks 1–3, $4,000)

The fixes on the [`v3-contracts`](https://github.com/Prashant-thakur77/Strike/tree/v3-contracts) branch (fee high-water mark, EIP-712 signer consent, active-agent check, `InvalidMandate(reason)`) go live on both testnets, with the SDK, MCP server and app moved to the new ABIs.

Deliverables:

- `v3-contracts` merged into `main`, and v3 deployed on Robinhood Chain testnet (46630) and Arbitrum Sepolia (421614).
- SDK, MCP server, app and subgraph updated to v3.
- One full epoch on each chain, including one out-of-mandate proposal that is rejected and slashed.

Acceptance criteria:

- `contracts/deployments/46630.json` and `contracts/deployments/421614.json` list the v3 addresses, and every contract shows verified source on Blockscout and Arbiscan.
- A log in `docs/testnet-epochs/` for each chain links the open, propose, rejection with slash, buy, settle and redeem transactions.
- A second epoch on the same vault shows the high-water mark at work: no fee on a week that only wins back an earlier loss, readable from the `FeeManager` events.
- CI is green on `main`.

Budget: testnet operations, keeper hosting and development time.

## 2. Stylus risk engine in the proposal path (weeks 3–7, $7,000)

The Rust pricer grows into a risk engine: an implied-volatility solver, greeks (delta, gamma, vega, theta) and the worst-case payout of a vault's open series across spot shocks, in the same fixed-point arithmetic as today's pricer. A Solidity reference stays alongside it, as it does for the pricer now.

Deliverables:

- The risk engine in `stylus/pricer` with Rust tests, a Python reference and generated vectors.
- The Solidity reference and differential tests that demand exact equality, as for the pricer today ([`test/differential`](../contracts/test/differential)).
- `EpochManager` reports each series' greeks and scenario loss, with an event at proposal time; vault pages in the app show them.
- A gas table for the risk engine in Stylus against the Solidity reference, measured on the live chain.

Acceptance criteria:

- `make stylus-test` and the differential job pass in CI, with the new vectors checked in and the differential suite passing under `FOUNDRY_PROFILE=ci` (5,000 fuzz runs per property).
- The deployed Stylus program passes `cargo stylus verify` against the tagged source.
- One live proposal on each chain emits the risk event, with its transaction linked from `docs/DEPLOYMENTS.md`.
- `docs/gas.md` has the new table, including any case where Stylus costs more.

Budget: development time and live-chain gas measurement.

## 3. External audit, then a capped mainnet vault (weeks 6–14, $14,000)

An external audit of the v3 contracts and the Stylus program, then one capped vault on Robinhood Chain mainnet. The scope today is about 2,082 nSLOC of Solidity and about 680 lines of Rust ([audit-readiness.md](audit-readiness.md)).

Deliverables:

- An audit by an outside firm. The grant covers part of it ($11,000 in this split), and the rest is requested from the Arbitrum Audit Program, which [audit-readiness.md](audit-readiness.md) is prepared for.
- Every High and Medium finding fixed with a regression test, as was done for the internal review ([review-2026-09-29.md](security/review-2026-09-29.md)).
- One TSLA covered-call vault on Robinhood Chain mainnet (4663) with a `depositCap` agreed in advance, admin and guardian roles held by a Safe multisig, and the real Chainlink feed (no `MirrorFeed`).
- Four weekly epochs run and settled on it.

Acceptance criteria:

- The audit report is published in `docs/security/`, with each finding's status and the commit that fixed it.
- `contracts/deployments/4663.json` lists the addresses; each is verified on the Robinhood Chain explorer.
- The vault's `depositCap` and the Safe's `hasRole` on each admin role are readable on-chain.
- Four settlement transactions are linked from `docs/DEPLOYMENTS.md`.

Budget: $11,000 toward the audit; $3,000 for mainnet gas, seed collateral, monitoring and the Safe setup.

## 4. Outside agents, integrators and a published SDK (weeks 10–16, $5,000)

Strike's case rests on agents and builders it does not control. This milestone measures that.

Deliverables:

- `@strike/sdk` and the MCP server published to npm; the subgraph deployed to a hosted indexer ([indexing.md](indexing.md)).
- At least three agents registered and bonded by owners outside the team, each running a vault or proposing for one.
- At least one repository outside Strike that imports `SafeStockFeed` or runs its conformance suite ([`test/conformance`](../contracts/test/conformance)).
- Ten or more testnet testers who file the [feedback form](https://github.com/Prashant-thakur77/Strike/issues/new?template=testnet-feedback.yml).

Acceptance criteria:

- The npm package pages exist, and the subgraph URL returns epochs for the live vaults.
- `AgentRegistry` shows at least three agents whose owners are not team addresses, each with a bond at or above `minBond`.
- A public link to the outside repository and its passing CI run.
- The feedback issues are public on GitHub.

Budget: indexer hosting, npm and docs work, and tester and agent-builder support.

## Later, not in this plan

- Lend idle put collateral through an ERC-4626 USDG vault, so collateral earns while it waits (today it earns nothing; see the README's [comparison with USDG lending](../README.md#against-usdg-lending)).
- Put spreads to lower the collateral a put vault needs, and more tickers.
- A USDG gas paymaster.
- The same vaults on Arbitrum One for tokenized stocks from other issuers.
- Agent reputation from settled on-chain results used as credit.
