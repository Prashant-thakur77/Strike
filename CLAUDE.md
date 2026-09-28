# Project rules

- Source of truth: docs/PLAN.md. Follow its phases in order.
- Don't start a phase until the previous phase's gate passes.
- Contracts: Solidity + Foundry. Every function and custom error gets a test.
- Never apply the stock-token uiMultiplier to Chainlink prices (they already include it).
- Robinhood testnet chain 46630, mainnet 4663. USDG testnet: 0x7E955252E15c84f5768B83c41a71F9eba181802F
- After each phase: run all tests, update README, commit.

# Working state

- Resume from docs/progress.md (done / next / blockers). Decisions go in docs/decisions.md, anything that needs the owner in docs/req-you.md.
- Commit after each working task; tag each phase gate (v0.<phase>.0).
- Never commit secrets: keys live in `.env` files, which are gitignored.

# Commands

- Contracts: `make test`, `make ci-test`, `make fmt-check` (run from the repo root; Foundry must be on PATH: `export PATH="$HOME/.foundry/bin:$PATH"`).
- Stylus pricer: `cargo test --manifest-path stylus/pricer/Cargo.toml`.
- JS packages: `pnpm -r lint`, `pnpm -r test` (Node 22, see `.nvmrc`).
