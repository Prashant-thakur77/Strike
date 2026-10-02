#!/usr/bin/env node
// Check a remote Strike MCP endpoint with the official MCP client: connect over Streamable HTTP, list the tools,
// and call list_vaults and risk_check. Usage: node mcp/scripts/remote-check.mjs [url]
// (default: services.mcp in strike.config.json, https://strike-options.vercel.app/api/mcp; add ?chainId=421614 or
// ?version=v3 to read one chain or deployment).
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const config = JSON.parse(readFileSync(new URL("../../strike.config.json", import.meta.url), "utf8"));
const url = new URL(process.argv[2] ?? config.services.mcp);
const client = new Client({ name: "strike-remote-check", version: "0.0.0" });
await client.connect(new StreamableHTTPClientTransport(url));
const { tools } = await client.listTools();
console.log(`tools (${tools.length}): ${tools.map((t) => t.name).join(", ")}`);

const vaults = await client.callTool({ name: "list_vaults", arguments: {} });
if (vaults.isError) throw new Error(`list_vaults failed: ${vaults.content[0]?.text}`);
const list = vaults.structuredContent.vaults;
console.log(
  `list_vaults on ${vaults.structuredContent.chainId}: ${list.map((v) => `${v.symbol} ${v.version ?? ""} (${v.epochState})`).join(", ")}`,
);

const vault = list[0]?.symbol;
if (vault) {
  const check = await client.callTool({ name: "risk_check", arguments: { vault, targetDeltaBps: 2000 } });
  const s = check.structuredContent;
  console.log(
    check.isError
      ? `risk_check ${vault}: refused: ${check.content[0]?.text}`
      : `risk_check ${vault}: ok=${s.ok} reason=${s.reason} strike=${s.proposal.strike}: ${s.explanation}`,
  );
}
await client.close();
