import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** Connects to the Strike MCP server over stdio and prints what it offers. */
async function main() {
  const client = new Client({ name: "strike-example-agent", version: "0.1.0" });
  await client.connect(
    new StdioClientTransport({ command: "pnpm", args: ["--silent", "--filter", "@strike/mcp", "dev"] }),
  );
  const { tools } = await client.listTools();
  console.log("Strike MCP tools:", tools.map((t) => t.name).join(", "));
  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
