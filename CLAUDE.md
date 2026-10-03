# Project rules

- Source of truth: .internal/docs/PLAN.md (local, gitignored). Follow its phases in order.
- Don't start a phase until the previous phase's gate passes.
- Contracts: Solidity + Foundry. Every function and custom error gets a test.
- Never apply the stock-token uiMultiplier to Chainlink prices (they already include it).
- Robinhood testnet chain 46630, mainnet 4663. USDG testnet: 0x7E955252E15c84f5768B83c41a71F9eba181802F
- After each phase: run all tests, update README, commit.

# Working state

- Working notes live in `.internal/` (gitignored, never committed): resume from .internal/docs/progress.md (done / next / blockers), cycle plans go in .internal/docs/plans/, anything that needs the owner in .internal/docs/req-you.md. Decisions go in docs/decisions.md (public).
- Commit after each working task; tag each passed phase gate: Phase N → `v0.(N+1).0`, submission → `v1.0.0`.
- Never commit secrets: keys live in `.env` files, which are gitignored.

# Commands

- Contracts: `make test`, `make ci-test`, `make fmt-check` (run from the repo root; Foundry must be on PATH: `export PATH="$HOME/.foundry/bin:$PATH"`).
- Stylus pricer: `cargo test --manifest-path stylus/pricer/Cargo.toml`.
- JS packages: `pnpm -r lint`, `pnpm -r test` (Node 22, see `.nvmrc`).
- Docs checks before a push: `corepack pnpm format:check`, `node scripts/check-links.mjs` (0 broken), `node scripts/check-numbers.mjs` (every stated count against `docs/evidence/facts.json`), `node scripts/check-claims.mjs` (every cited transaction on its chain).
