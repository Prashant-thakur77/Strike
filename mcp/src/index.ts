#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { type StrikeClient, describeRpc } from "@strike/sdk";
import { clientFromConfig, configFromEnv, x402FromEnv } from "./config.js";
import { createStrikeMcpServer } from "./server.js";

// Strike MCP server over stdio. Configure with STRIKE_CHAIN_ID, STRIKE_DEPLOYMENT_VERSION (v2 or v3: one of the chain's
// deployments; default the SDK's default one), STRIKE_RPC_URL (or ALCHEMY_API_KEY: Alchemy first, the public RPC as
// fallback) and (to send transactions as the vault agent) STRIKE_AGENT_PRIVATE_KEY. STRIKE_MCP_READ_ONLY=1 registers only the read-only tools and ignores the
// key. Logs go to stderr; stdout carries the protocol.
const config = configFromEnv();
let cached: StrikeClient | undefined;
const server = createStrikeMcpServer({
  chainId: config.chainId,
  skillPath: config.skillPath,
  readOnly: config.readOnly,
  client: () => (cached ??= clientFromConfig(config)),
  x402: x402FromEnv(config),
  indexerUrl: process.env.STRIKE_INDEXER_URL || undefined,
});

const transport = new StdioServerTransport();
await server.connect(transport);
// When the client goes away, finish in-flight responses, then exit even if sockets are still open.
process.stdin.on("end", () => setTimeout(() => process.exit(0), 2000).unref());
console.error(
  `strike-mcp: chain ${config.chainId}${config.deploymentVersion ? ` (${config.deploymentVersion})` : ""} via ${describeRpc(config.rpcEndpoints)} (${config.readOnly ? "read-only tools only" : config.privateKey ? "agent mode" : "read-only mode"})`,
);
