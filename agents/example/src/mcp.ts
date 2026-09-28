import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** A tool call that returned `isError`. */
export class ToolError extends Error {
  constructor(
    readonly tool: string,
    message: string,
  ) {
    super(`${tool}: ${message}`);
    this.name = "ToolError";
  }
}

/** A connected Strike MCP server. */
export interface StrikeMcp {
  client: Client;
  /** Call a tool and return its structured content; throws {@link ToolError} on `isError`. */
  call<T = Record<string, unknown>>(name: string, args?: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}

/**
 * Spawn the Strike MCP server and connect over stdio. The command defaults to the workspace's
 * `pnpm --filter @strike/mcp dev`; override it with STRIKE_MCP_COMMAND (for example `node mcp/dist/index.js`).
 * STRIKE_* variables (chain, RPC, agent key) are passed through to the server.
 */
export async function connectStrikeMcp(): Promise<StrikeMcp> {
  const command = process.env.STRIKE_MCP_COMMAND?.trim();
  const [cmd = "pnpm", ...args] = command
    ? command.split(/\s+/)
    : ["pnpm", "--silent", "--filter", "@strike/mcp", "dev"];
  const env: Record<string, string> = getDefaultEnvironment();
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("STRIKE_") && value !== undefined && key !== "STRIKE_MCP_COMMAND") env[key] = value;
  }
  const transport = new StdioClientTransport({ command: cmd, args, env, cwd: repoRoot, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

  const client = new Client({ name: "strike-example-agent", version: "0.1.0" });
  try {
    await client.connect(transport);
  } catch (err) {
    throw new Error(
      `could not start the Strike MCP server (${cmd} ${args.join(" ")}): ${String(err)}\n${stderr}`,
    );
  }
  await client.listTools(); // lets the client validate structured results against the tools' output schemas

  return {
    client,
    async call<T>(name: string, toolArgs: Record<string, unknown> = {}) {
      const res = (await client.callTool({ name, arguments: toolArgs })) as CallToolResult;
      if (res.isError) {
        const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
        throw new ToolError(name, text);
      }
      return res.structuredContent as T;
    },
    close: () => client.close(),
  };
}
