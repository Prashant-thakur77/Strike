#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { StrikeClient } from "@strike/sdk";
import { clientFromConfig, configFromEnv } from "./config.js";
import { createStrikeMcpServer } from "./server.js";

// Strike MCP server over stdio. Configure with STRIKE_CHAIN_ID, STRIKE_RPC_URL and (to send transactions as the
// vault agent) STRIKE_AGENT_PRIVATE_KEY. Logs go to stderr; stdout carries the protocol.
const config = configFromEnv();
let cached: StrikeClient | undefined;
const server = createStrikeMcpServer({
  chainId: config.chainId,
  skillPath: config.skillPath,
  client: () => (cached ??= clientFromConfig(config)),
});

const transport = new StdioServerTransport();
await server.connect(transport);
// When the client goes away, finish in-flight responses, then exit even if sockets are still open.
process.stdin.on("end", () => setTimeout(() => process.exit(0), 2000).unref());
console.error(
  `strike-mcp: chain ${config.chainId} via ${config.rpcUrl} (${config.privateKey ? "agent" : "read-only"} mode)`,
);
