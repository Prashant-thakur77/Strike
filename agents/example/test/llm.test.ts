import { type IncomingHttpHeaders, type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { type PlannerCall, plannerCandidates } from "../src/candidates.js";
import { CLAUDE_MODEL, planWithClaude } from "../src/llm.js";
import type { LlmUsage } from "../src/usage.js";

// planWithClaude against a scripted local Messages API (no network, no key) and a small in-memory MCP server:
// checks the request shape, that MCP tool results are fed back to Claude, and that only read-only tools are offered.

type Reply = { content: unknown[]; stop_reason: string; usage?: Record<string, unknown> };
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
    usage: r.usage ?? { input_tokens: 10, output_tokens: 10 },
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
    async ({ targetDeltaBps }) =>
      targetDeltaBps === 9999
        ? {
            isError: true,
            content: [{ type: "text" as const, text: "price feed down at https://rpc.example/key123" }],
          }
        : {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  ok: true,
                  reason: "None",
                  explanation: "Inside the mandate.",
                  isCall: false,
                  spot: "369",
                  proposal: {
                    strike: "340.5",
                    targetDeltaBps,
                    expiryIso: "2026-10-09T20:00:00.000Z",
                    size: "1",
                    premiumBps: 10_500,
                  },
                  measured: { fairValue: "2.5", delta: targetDeltaBps / 10_000, capacity: "2", yieldBps: 80 },
                }),
              },
            ],
          },
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

  it("captures each risk_check Claude makes, with its inputs and result or error, and none of its other calls", async () => {
    const call = (id: string, name: string, input: Record<string, unknown>) => ({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id, name, input }],
    });
    replies = [
      call("a", "vault_state", { vault: "0xV" }),
      call("b", "risk_check", { vault: "0xV", targetDeltaBps: 1500, premiumBps: 10_500 }),
      call("c", "risk_check", { vault: "0xV", targetDeltaBps: 9999 }),
      call("d", "risk_check", { vault: "0xV", targetDeltaBps: 2000, premiumBps: 10_500 }),
      call("e", "submit_plan", { targetDeltaBps: 2000, premiumBps: 10_500, reasoning: "Balanced." }),
      { stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] },
    ];
    const captured: PlannerCall[] = [];
    const plan = await planWithClaude({
      mcp,
      vault: "0xV",
      skill: "",
      narrate: () => {},
      capture: (c) => captured.push(c),
    });
    expect(plan).toMatchObject({ targetDeltaBps: 2000 });
    expect(captured.map((c) => c.input.targetDeltaBps)).toEqual([1500, 9999, 2000]);
    expect(captured[0]).toMatchObject({
      tool: "risk_check",
      input: { vault: "0xV", targetDeltaBps: 1500, premiumBps: 10_500 },
      error: null,
      result: { ok: true, reason: "None", measured: { delta: 0.15 } },
    });
    expect(captured[1]).toMatchObject({ result: null, error: expect.stringContaining("price feed down") });
    expect(captured[1]?.error).not.toContain("key123");
    // The captured calls become the record's planner candidates.
    const mandate = {
      minDeltaBps: 1000,
      maxDeltaBps: 3500,
      minPremiumBps: 9500,
      minYieldBps: 5,
      maxShareSoldBps: 8000,
      minTenor: 86_400,
      maxTenor: 691_200,
      summary: "",
    };
    const cands = plannerCandidates(captured, mandate, "2026-10-05T15:00:00.000Z");
    expect(cands.map((c) => [c.source, c.targetDeltaBps, c.ok, c.error === undefined])).toEqual([
      ["planner", 1500, true, true],
      ["planner", 9999, false, false],
      ["planner", 2000, true, true],
    ]);
    // The tool loop itself is unchanged: Claude still got the results.
    expect(JSON.stringify(requests.at(-1)?.body.messages)).toContain("tool_result");
  });

  it("works without a capture callback", async () => {
    replies = [
      {
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "x", name: "risk_check", input: { vault: "0xV", targetDeltaBps: 1500 } },
        ],
      },
      { stop_reason: "end_turn", content: [{ type: "text", text: "No plan." }] },
    ];
    expect(await planWithClaude({ mcp, vault: "0xV", skill: "", narrate: () => {} })).toBeNull();
  });

  it("returns null when Claude declines", async () => {
    replies = [{ stop_reason: "refusal", content: [] }];
    const lines: string[] = [];
    expect(await planWithClaude({ mcp, vault: "0xV", skill: "", narrate: (l) => lines.push(l) })).toBeNull();
    expect(lines).toContain("Claude declined to plan this epoch.");
  });

  it("reports the API's usage, summed over every response, with cache fields and no invented price", async () => {
    const use = (input: number, output: number, read: number, created: number) => ({
      input_tokens: input,
      output_tokens: output,
      cache_read_input_tokens: read,
      cache_creation_input_tokens: created,
    });
    replies = [
      {
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "u1", name: "vault_state", input: { vault: "0xV" } }],
        usage: use(1200, 80, 0, 3000),
      },
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "u2",
            name: "submit_plan",
            input: { targetDeltaBps: 2000, premiumBps: 10_500, reasoning: "Balanced." },
          },
        ],
        usage: use(300, 150, 3000, 0),
      },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Done." }], usage: use(50, 10, 3000, 0) },
    ];
    const usages: LlmUsage[] = [];
    const plan = await planWithClaude({
      mcp,
      vault: "0xV",
      skill: "",
      narrate: () => {},
      onUsage: (u) => usages.push(u),
    });
    expect(plan).toMatchObject({ targetDeltaBps: 2000 });
    expect(usages).toHaveLength(1);
    expect(usages[0]).toMatchObject({
      planner: "api",
      model: CLAUDE_MODEL,
      calls: 3,
      inputTokens: 1550,
      outputTokens: 240,
      cacheReadTokens: 6000,
      cacheCreationTokens: 3000,
      costUsd: { provided: false, reason: expect.stringContaining("not a price") },
    });
    expect(typeof usages[0]?.durationMs).toBe("number");
    expect(usages[0]?.source).toContain("3 responses");
  });

  it("writes {provided: false, reason} for a figure a response left out, and still reports on a refusal", async () => {
    replies = [
      {
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "n1", name: "vault_state", input: { vault: "0xV" } }],
        usage: { input_tokens: 700, output_tokens: 40 },
      },
      { stop_reason: "refusal", content: [], usage: { input_tokens: 20, output_tokens: 5 } },
    ];
    const usages: LlmUsage[] = [];
    const plan = await planWithClaude({
      mcp,
      vault: "0xV",
      skill: "",
      narrate: () => {},
      onUsage: (u) => usages.push(u),
    });
    expect(plan).toBeNull();
    expect(usages[0]).toMatchObject({ calls: 2, inputTokens: 720, outputTokens: 45 });
    expect(usages[0]?.cacheReadTokens).toEqual({
      provided: false,
      reason: "2 of 2 API responses did not report cache_read_input_tokens",
    });
  });

  it("reports no usage when the API never answered", async () => {
    replies = [];
    const usages: LlmUsage[] = [];
    await expect(
      planWithClaude({ mcp, vault: "0xV", skill: "", narrate: () => {}, onUsage: (u) => usages.push(u) }),
    ).rejects.toThrow();
    expect(usages).toEqual([]);
  });
});
