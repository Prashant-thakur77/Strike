# Contributing to Strike

Thanks for helping. Bug reports, testnet feedback and pull requests are all welcome.

## Before you start

- Testnet feedback: use the [feedback form](https://github.com/Prashant-thakur77/Strike/issues/new?template=testnet-feedback.yml). The [tester guide](docs/testers.md) takes five minutes.
- Bugs and ideas: open an issue with the bug-report or feature-request form.
- Security issues: never in public. See [SECURITY.md](SECURITY.md).
- Big changes: open an issue first. Design decisions are recorded in [docs/decisions.md](docs/decisions.md), and the specification is [docs/design.md](docs/design.md).

## Setup

Requirements: Foundry v1.7.1, Rust 1.91 with `cargo-stylus` 0.10.9 (only for the Stylus pricer), Node 22+ and pnpm 10.

```bash
git clone --recursive https://github.com/Prashant-thakur77/Strike && cd Strike
pnpm install
make build && make test          # contracts
pnpm -r lint && pnpm -r test     # SDK, MCP, agents, bots, app type-check
scripts/demo-local.sh            # the full story on a local chain
```

## What CI checks

Every push and pull request runs: `forge fmt --check`, the contract build and tests (CI profile), coverage (at least 95% of lines), the Stylus crate tests, Rust vs Solidity differential tests, mainnet fork tests, Slither, the Halmos proofs, TypeScript lint, tests and build, the subgraph build and tests, prettier, the end-to-end demo, the app's Playwright suite on an anvil devnet (desktop and mobile; `register.spec.ts` again on a v3 devnet), the indexer tests on a Postgres 17 service container, and the Docker images (hadolint, build, `docker compose config`, and the compose stack started until the indexer's `/health` answers and its migrations are applied). Separate workflows run CodeQL and a gitleaks secret scan. Please run the relevant ones locally first; [docs/testing.md](docs/testing.md#app-end-to-end-in-ci) has the commands CI uses to start the devnet for Playwright.

## Conventions

- **Contracts:** Solidity 0.8.30, `forge fmt`. Every new branch or error needs a test; every new external function a unit test and, where it moves value, an invariant or fuzz test. Keep `EpochManager` under the 24 KiB code-size limit (`forge build --sizes`).
- **Units:** prices are WAD per raw token; never multiply a Chainlink stock price by the ERC-8056 `uiMultiplier` ([design.md §2](docs/design.md)).
- **TypeScript:** strict mode, `prettier`. Consume the SDK rather than re-encoding ABIs.
- **Commits:** small and focused, with a conventional prefix (`feat(scope):`, `fix(scope):`, `test:`, `docs:`, `ci:`, `chore:`). Describe what changed and why.
- **Docs:** keep numbers and addresses in sync with the code; a claim in the README needs a link to its evidence.

## Pull requests

Fill in the template: what changed, why, how it was tested, and any change to a deployed interface. A contract change also needs an entry in [CHANGELOG.md](CHANGELOG.md) under Unreleased.

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE) and that you follow the [Code of Conduct](CODE_OF_CONDUCT.md).
