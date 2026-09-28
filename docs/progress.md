# Progress

Resume here. Newest status first.

## Current phase: 0 (Setup) → gate check

### Done

- Repo created at `~/projects/strike`, pushed to github.com/Prashant-thakur77/Strike
- Plan rewritten for Strike ([PLAN.md](PLAN.md)), README, MIT license
- Foundry workspace: Solidity 0.8.30/cancun, forge-std 1.16.2, OpenZeppelin 5.7 (+ upgradeable), ci profile
- Stylus pricer crate: fixed-point Black-Scholes, 13 Rust tests incl. proptest; `cargo stylus check` passes (15.1 KB)
- pnpm workspace: `@strike/sdk` (chains + tests), `@strike/mcp` (stdio server), `agents/example` (connects to MCP), Next.js 16 app, subgraph package
- GitHub Actions CI (forge, cargo, pnpm) with badge
- [design.md](design.md), [decisions.md](decisions.md), [req-you.md](req-you.md), [review.md](review.md)

### Next

- Phase 0 gate: CI green on GitHub, design doc complete
- Phase 1: `BlackScholesLib`/`BlackScholesRef`, `StrikeVault`, `VaultFactory`, `OptionToken`, `EpochManager`, `FeeManager`

### Blockers

- Deploys need a funded deployer key ([req-you.md](req-you.md))
