# Security policy

Strike is **unaudited** and runs on testnets only: **Robinhood Chain testnet** (v2 and v3) and **Arbitrum Sepolia** (v3). Do not deposit real funds. Any mainnet vault will be capped until an external audit is done.

## Reporting a vulnerability

Report privately through GitHub: **Security → Report a vulnerability** on this repository ([private advisory form](https://github.com/Prashant-thakur77/Strike/security/advisories/new)). Please do not open a public issue for a vulnerability.

Include the affected contract or package, the commit or deployed address, a description of the impact, and a proof of concept (a Foundry test is ideal: see `contracts/test/audit/` for the format). We aim to acknowledge within 72 hours and to publish a fix, a regression test and an advisory once it is resolved.

## Scope

| In scope                                                                                                                                                                                            | Out of scope                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `contracts/src/**` except `src/testnet/*`, on `main` and on the `v3-contracts` branch                                                                                                               | `contracts/src/testnet/*` (testnet-only mocks: MirrorFeed, TestStockToken, TestUSDG) |
| The deployed contracts in [`46630.json`](contracts/deployments/46630.json) (v2), [`46630-v3.json`](contracts/deployments/46630-v3.json) and [`421614.json`](contracts/deployments/421614.json) (v3) | The v1 deployment in `46630-v1.json` (superseded)                                    |
| The Stylus pricer `stylus/pricer/src/**`                                                                                                                                                            | Third-party dependencies (report upstream)                                           |
| `sdk/`, `mcp/`, `bots/`, `app/` where a bug can move or lock user funds or mislead a signer                                                                                                         | Issues requiring a compromised admin key (see the trust model)                       |

## What is already known

- Trust model, roles and accepted risks: [docs/audit-readiness.md](docs/audit-readiness.md).
- Threat model (21 threats, each with its mitigation and test): [docs/threat-model.md](docs/threat-model.md).
- Internal adversarial review of 2026-09-29, all findings fixed with regression tests: [docs/security/review-2026-09-29.md](docs/security/review-2026-09-29.md).
- Static analysis triage: [docs/security/slither.md](docs/security/slither.md).

## Supported versions

Only the current deployments (v2 and v3 on Robinhood Chain testnet, v3 on Arbitrum Sepolia), the `main` branch and the `v3-contracts` branch receive fixes. Contracts are not upgradeable; a fix ships as a new deployment and is recorded in [CHANGELOG.md](CHANGELOG.md).
