import { type IncomingHttpHeaders, type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { CLAUDE_MODEL, planWithClaude } from "../src/llm.js";

// planWithClaude against a scripted local Messages API (no network, no key) and a small in-memory MCP server:
// checks the request shape, that MCP tool results are fed back to Claude, and that only read-only tools are offered.

type Reply = { content: unknown[]; stop_reason: string };
let replies: Reply[] = [];
const requests: { headers: IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
let api: Server;
let mcp: Client;

function message(r: Reply) {
  return {
    id: `msg_${requests.length}`,
    type: "message",
    role: "assistant",
    model: CLAUDE_MODEL,
    content: r.content,
    stop_reason: r.stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

beforeAll(async () => {
  api = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      requests.push({ headers: req.headers, body: JSON.parse(raw) as Record<string, unknown> });
      const next = replies.shift();
      res.writeHead(next ? 200 : 500, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          next ? message(next) : { type: "error", error: { type: "api_error", message: "script" } },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  process.env.ANTHROPIC_API_KEY = "test-key";

  const server = new McpServer({ name: "strike-stub", version: "0.0.0" });
  const ro = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
  server.registerTool(
    "vault_state",
    { description: "vault", inputSchema: { vault: z.string() }, annotations: ro },
    async ({ vault }) => ({ content: [{ type: "text", text: `{"vault":"${vault}","spot":"369"}` }] }),
  );
  server.registerTool(
    "risk_check",
    {
      description: "dry run",
      inputSchema: { vault: z.string(), targetDeltaBps: z.number() },
      annotations: ro,
    },
    async () => ({ content: [{ type: "text", text: '{"ok":true,"reason":"None"}' }] }),
  );
  server.registerTool(
    "propose_epoch",
    { description: "write", inputSchema: { vault: z.string() }, annotations: { readOnlyHint: false } },
    async () => ({ content: [{ type: "text", text: "should never be called" }] }),
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  mcp = new Client({ name: "test", version: "0.0.0" });
  await mcp.connect(a);
});

afterAll(async () => {
  await mcp?.close();
  await new Promise((resolve) => api?.close(resolve));
});

beforeEach(() => {
  requests.length = 0;
});

describe("planWithClaude", () => {
  it("runs the tool loop over the MCP tools and returns the submitted plan", async () => {
    replies = [
      {
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "Reading the vault first." },
          { type: "tool_use", id: "tu_1", name: "vault_state", input: { vault: "0xV" } },
        ],
      },
      {
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "tu_2", name: "risk_check", input: { vault: "0xV", targetDeltaBps: 2500 } },
        ],
      },
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "tu_3",
            name: "submit_plan",
            input: { targetDeltaBps: 2500, premiumBps: 10_500, reasoning: "Volatility is high." },
          },
        ],
      },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Plan submitted." }] },
    ];
    const lines: string[] = [];
    const plan = await planWithClaude({
      mcp,
      vault: "0xV",
      skill: "SKILL TEXT",
      narrate: (l) => lines.push(l),
    });

    expect(plan).toEqual({ targetDeltaBps: 2500, premiumBps: 10_500, reasoning: "Volatility is high." });
    expect(requests).toHaveLength(4);
    const first = requests[0] as (typeof requests)[number];
    expect(first.body).toMatchObject({
      model: "claude-opus-5",
      thinking: { type: "adaptive" },
      fallbacks: "default",
    });
    expect(String(first.headers["anthropic-beta"])).toMatch(/server-side-fallback-2026-07-01/);
    expect(first.body.system).toMatch(/SKILL TEXT$/);
    const tools = (first.body.tools as { name: string }[]).map((t) => t.name).sort();
    expect(tools).toEqual(["risk_check", "submit_plan", "vault_state"]);

    // The MCP result of vault_state goes back to Claude as a tool_result.
    const second = JSON.stringify(requests[1]?.body.messages);
    expect(second).toMatch(/tool_result/);
    expect(second).toContain('{\\"vault\\":\\"0xV\\",\\"spot\\":\\"369\\"}');
    expect(lines).toContain("Claude: Reading the vault first.");
    expect(lines.some((l) => l.startsWith("Claude calls submit_plan"))).toBe(true);
  });

  it("returns null when Claude declines", async () => {
    replies = [{ stop_reason: "refusal", content: [] }];
    const lines: string[] = [];
    expect(await planWithClaude({ mcp, vault: "0xV", skill: "", narrate: (l) => lines.push(l) })).toBeNull();
    expect(lines).toContain("Claude declined to plan this epoch.");
  });
});
