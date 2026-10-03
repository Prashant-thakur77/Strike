# @strike-options/mcp

[![npm](https://img.shields.io/npm/v/@strike-options/mcp?color=cb3837&logo=npm)](https://www.npmjs.com/package/@strike-options/mcp)

MCP server for [Strike](https://github.com/Prashant-thakur77/Strike): AI agents quote, dry-run, propose, settle and buy weekly options on Robinhood Chain stock tokens (covered calls and cash-secured puts, paid in USDG). Every proposal is checked on-chain against the vault's immutable mandate; one that breaks it is rejected and the agent's bond slashed. Unaudited, testnet only.

Inside the Strike repository this package is the workspace package `@strike/mcp`; on npm it is `@strike-options/mcp`. It uses [`@strike-options/sdk`](https://www.npmjs.com/package/@strike-options/sdk).

## Run it

```bash
npx -y @strike-options/mcp
```

It speaks MCP over stdio. With no configuration it reads Strike v2 on Robinhood Chain testnet (46630) through the chain's public RPC, and needs no key.

| Variable                    | Default                       | What it does                                                                                   |
| --------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------- |
| `STRIKE_CHAIN_ID`           | `46630`                       | `46630` (Robinhood Chain testnet, v2) or `421614` (Arbitrum Sepolia, v3)                       |
| `STRIKE_DEPLOYMENT_VERSION` | the chain's default           | `v2` or `v3`: one of the chain's deployments (`v3` reads v3 on Robinhood Chain testnet)        |
| `STRIKE_RPC_URL`            | the chain's public RPC        | Your own RPC endpoint                                                                          |
| `ALCHEMY_API_KEY`           | unset                         | Read and send through Alchemy (key sent in a header), with the public RPC as fallback          |
| `STRIKE_MCP_READ_ONLY`      | unset                         | `1`: register only the read tools and never load a key                                         |
| `STRIKE_AGENT_PRIVATE_KEY`  | unset                         | The agent signer's key (0x + 64 hex). Without it the write tools are listed but refuse to send |
| `STRIKE_PAYER_KEY`          | the agent key                 | The key `paid_risk_report` pays with over x402 (needs the token, not gas)                      |
| `STRIKE_X402_MAX_SPEND`     | `0.05`                        | The most `paid_risk_report` pays in one run, in token units                                    |
| `STRIKE_SKILL_PATH`         | the bundled `STRIKE_SKILL.md` | Another file for the `strike://skill` resource                                                 |

Read tools: `strike_info`, `list_vaults`, `vault_state`, `quote`, `hedge_plan`, `risk_check`, `agent_stats`, `series_risk`. Write tools (need `STRIKE_AGENT_PRIVATE_KEY`): `propose_epoch`, `settle_epoch`, `buy_options`, `redeem_options`, `register_agent`, `set_signer`, `create_vault`. Paid tool (with a payer key, in the repository build): `paid_risk_report`, a vault's full risk report bought over x402 for 0.01 test USDC or USDG ([how](https://github.com/Prashant-thakur77/Strike/blob/main/docs/ENDPOINTS.md#paid-route-x402)). The `strike://skill` resource is [STRIKE_SKILL.md](https://strike-options.vercel.app/skill.md): the mandate rules, slashing and a safe proposal loop. Read it first.

## Claude Desktop and Claude Code

`claude_desktop_config.json`, read-only on both chains:

```json
{
  "mcpServers": {
    "strike-robinhood": {
      "command": "npx",
      "args": ["-y", "@strike-options/mcp"],
      "env": { "STRIKE_CHAIN_ID": "46630", "STRIKE_MCP_READ_ONLY": "1" }
    },
    "strike-arbitrum": {
      "command": "npx",
      "args": ["-y", "@strike-options/mcp"],
      "env": { "STRIKE_CHAIN_ID": "421614", "STRIKE_MCP_READ_ONLY": "1" }
    }
  }
}
```

Claude Code:

```bash
claude mcp add strike-robinhood -e STRIKE_CHAIN_ID=46630 -e STRIKE_MCP_READ_ONLY=1 -- npx -y @strike-options/mcp
claude mcp add strike-arbitrum -e STRIKE_CHAIN_ID=421614 -e STRIKE_MCP_READ_ONLY=1 -- npx -y @strike-options/mcp
```

To act as a vault agent, drop `STRIKE_MCP_READ_ONLY` and set `STRIKE_AGENT_PRIVATE_KEY` to a testnet key you control. Keep keys in your MCP client's environment, never in a shared file.

## Nothing to install

A hosted read-only server (Streamable HTTP, stateless, no keys) runs at `https://strike-options.vercel.app/api/mcp`. It reads every deployment on Robinhood Chain testnet (v2 and v3; `list_vaults` labels each vault with `chainId` and `version`). The query picks one chain or deployment: `?chainId=421614` for Arbitrum Sepolia, `?version=v3` for v3 alone.

```bash
claude mcp add --transport http strike https://strike-options.vercel.app/api/mcp
claude mcp add --transport http strike-arbitrum 'https://strike-options.vercel.app/api/mcp?chainId=421614'
```

## As a library

```ts
import { createStrikeMcpServer, READ_ONLY_TOOLS } from "@strike-options/mcp"; // connect any MCP transport
import { handleReadOnlyMcpRequest } from "@strike-options/mcp/http"; // the stateless read-only HTTP handler
```

Source, tests and docs: [github.com/Prashant-thakur77/Strike](https://github.com/Prashant-thakur77/Strike). MIT licence.
