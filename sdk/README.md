# @strike-options/sdk

[![npm](https://img.shields.io/npm/v/@strike-options/sdk?color=cb3837&logo=npm)](https://www.npmjs.com/package/@strike-options/sdk)

Typed TypeScript client for [Strike](https://github.com/Prashant-thakur77/Strike): weekly options vaults (covered calls and cash-secured puts) on Robinhood Chain stock tokens, paid in USDG, run by mandate-bound AI agents. Built on [viem](https://viem.sh). Unaudited, testnet only.

It reads vaults, series, quotes, agents and risk; dry-runs proposals against a vault's mandate with the contract's own `previewProposal`; and sends deposits, buys, proposals, settlements and agent registration (v2 and v3, including v3's EIP-712 signer consent). The deployed addresses for Robinhood Chain testnet (46630) and Arbitrum Sepolia (421614) are built in.

Inside the Strike repository this package is the workspace package `@strike/sdk`; on npm it is `@strike-options/sdk`.

## Install

```bash
npm install @strike-options/sdk viem
```

Node 22 or later, ESM only.

## Read a vault and a quote (no wallet)

```ts
import { createStrikeClient, formatUsdg, formatWad, getStrikeChain } from "@strike-options/sdk";
import { createPublicClient, http } from "viem";

const publicClient = createPublicClient({ chain: getStrikeChain(46630), transport: http() });
const strike = createStrikeClient({ publicClient, chainId: 46630 }); // Robinhood Chain testnet, read-only

const vault = await strike.getVault("0xADFF7900dbe01E8170a750AB88e1f4eA8D9D1D4e"); // TSLA covered call
console.log(vault.symbol, vault.kind, vault.epoch.state, vault.mandate); // sTSLA-CC covered-call Selling {...}
if (vault.series) {
  const quote = await strike.quoteBuy(vault.series.id, 10n ** 18n); // one option
  console.log(`strike $${formatWad(vault.series.strike, 2)}: ${formatUsdg(quote.premium)} USDG per option`);
}
```

Reads need only a `publicClient`. Pass a viem `walletClient` too and the client can write: every write simulates first (a revert surfaces as a decoded custom error such as `MarketClosed`), approves tokens when needed, sends, and waits for the receipt.

## More

- `listVaults()`, `getVault()`, `getSeries()`, `quoteBuy()`, `previewProposeByDelta()`, `seriesRisk()`, `agentStats()`, `claimables()`
- `deposit`, `buy`, `redeemOptions`, `proposeByDelta`, `settle`, `registerAgent`, `setSigner`, `postBond`, `createVault`
- Pricing helpers (`blackScholes`, `strikeForDelta`, `vaultCapacity`), mandate checks (`mandateProblems`, `explainMandateReason`), settlement-hint discovery, decision-record anchoring (`verifyDecisionAnchor`) and every contract ABI
- `deploymentsFor(chainId)` lists every deployment of a chain (v2 and v3 on 46630); `createStrikeClient({ deployment })` targets one

Agents that would rather speak MCP can use [`@strike-options/mcp`](https://www.npmjs.com/package/@strike-options/mcp). How Strike works, the mandate rules and a safe proposal loop: [STRIKE_SKILL.md](https://strike-options.vercel.app/skill.md). Source, tests and docs: [github.com/Prashant-thakur77/Strike](https://github.com/Prashant-thakur77/Strike).

MIT licence.
