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

/** How to start the Strike MCP server over stdio: command, arguments, environment and working directory. */
export interface StrikeMcpCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

/**
 * The command that starts the Strike MCP server. It defaults to the workspace's `pnpm --filter @strike/mcp dev`;
 * override it with STRIKE_MCP_COMMAND (for example `node mcp/dist/index.js`). STRIKE_* variables (chain, RPC, agent
 * key) and ALCHEMY_API_KEY (the server then reads through Alchemy) are passed through; `extraEnv` is added on top.
 */
export function strikeMcpCommand(
  processEnv: NodeJS.ProcessEnv = process.env,
  extraEnv: Record<string, string> = {},
): StrikeMcpCommand {
  const command = processEnv.STRIKE_MCP_COMMAND?.trim();
  const [cmd = "pnpm", ...args] = command
    ? command.split(/\s+/)
    : ["pnpm", "--silent", "--filter", "@strike/mcp", "dev"];
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(processEnv)) {
    if (value === undefined || key === "STRIKE_MCP_COMMAND") continue;
    if (key.startsWith("STRIKE_") || key === "ALCHEMY_API_KEY") env[key] = value;
  }
  return { command: cmd, args, env: { ...env, ...extraEnv }, cwd: repoRoot };
}

/** Spawn the Strike MCP server ({@link strikeMcpCommand}) and connect over stdio. */
export async function connectStrikeMcp(): Promise<StrikeMcp> {
  const { command: cmd, args, env: strikeEnv, cwd } = strikeMcpCommand();
  const env: Record<string, string> = { ...getDefaultEnvironment(), ...strikeEnv };
  const transport = new StdioClientTransport({ command: cmd, args, env, cwd, stderr: "pipe" });
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
