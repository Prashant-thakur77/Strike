import { expect, test, type APIRequestContext } from "@playwright/test";

// The remote MCP endpoint (/api/mcp) and the agent entry points (/skill.md, /llms.txt) on the production build.
// Tool calls read Robinhood Chain testnet through its public RPC, so this spec needs network access.
const READ_TOOLS = [
  "strike_info",
  "list_vaults",
  "vault_state",
  "quote",
  "hedge_plan",
  "risk_check",
  "agent_stats",
];
const HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  "mcp-protocol-version": "2025-06-18",
};

test.beforeEach(({}, info) => {
  test.skip(info.project.name !== "desktop", "HTTP only: one viewport is enough");
});

let nextId = 1;
async function rpc(request: APIRequestContext, method: string, params: object = {}) {
  const res = await request.post("/api/mcp", {
    headers: HEADERS,
    data: { jsonrpc: "2.0", id: nextId++, method, params },
  });
  expect(res.status(), await res.text()).toBe(200);
  expect(res.headers()["content-type"]).toContain("application/json");
  return (await res.json()) as { result?: Record<string, unknown>; error?: { message: string } };
}

type ToolResult = {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
};

async function callTool(request: APIRequestContext, name: string, args: object = {}) {
  const res = await rpc(request, "tools/call", { name, arguments: args });
  expect(res.error).toBeUndefined();
  return res.result as unknown as ToolResult;
}

test("initializes, lists only read tools, and reads vaults and a dry run", async ({ request }) => {
  const init = await rpc(request, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "strike-e2e", version: "0.0.0" },
  });
  expect(init.result).toMatchObject({ serverInfo: { name: "strike" }, capabilities: { tools: {} } });
  const ack = await request.post("/api/mcp", {
    headers: HEADERS,
    data: { jsonrpc: "2.0", method: "notifications/initialized" },
  });
  expect(ack.status()).toBe(202);

  const list = await rpc(request, "tools/list");
  const tools = (list.result as { tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] })
    .tools;
  expect(tools.map((t) => t.name)).toEqual(READ_TOOLS);
  for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);

  const info = await callTool(request, "strike_info");
  expect(info.structuredContent).toMatchObject({ chainId: 46630, mode: "read-only", agentAddress: null });

  const vaults = await callTool(request, "list_vaults");
  expect(vaults.isError, vaults.content[0]?.text).toBeFalsy();
  const listed = (vaults.structuredContent as { chainId: number; vaults: { symbol: string }[] }).vaults;
  expect((vaults.structuredContent as { chainId: number }).chainId).toBe(46630);
  expect(listed.length).toBeGreaterThan(0);
  const symbol = listed[0]!.symbol;
  expect(symbol).toMatch(/^s[A-Z]+-(CC|CSP)$/);

  // A dry run with the contract's previewProposal. It can be refused in plain words (for example a stale feed
  // outside market hours); otherwise it carries a verdict.
  const check = await callTool(request, "risk_check", { vault: symbol, targetDeltaBps: 2000 });
  if (check.isError) {
    expect(check.content[0]?.text).toMatch(/\w+/);
  } else {
    expect(check.structuredContent).toMatchObject({ vaultSymbol: symbol, proposal: { mode: "delta" } });
    expect(typeof check.structuredContent?.ok).toBe("boolean");
    expect(typeof check.structuredContent?.explanation).toBe("string");
  }

  // Write tools are not there at all.
  const write = await rpc(request, "tools/call", { name: "propose_epoch", arguments: { vault: symbol } });
  expect(write.error ?? (write.result as ToolResult | undefined)?.isError).toBeTruthy();

  // The skill resource is embedded at build time.
  const skill = await rpc(request, "resources/read", { uri: "strike://skill" });
  const text = (skill.result as { contents: { text: string }[] }).contents[0]!.text;
  expect(text).toContain("# Strike skill for AI agents");
});

test("answers CORS preflight and refuses GET with 405", async ({ request }) => {
  const pre = await request.fetch("/api/mcp", { method: "OPTIONS" });
  expect(pre.status()).toBe(204);
  expect(pre.headers()["access-control-allow-origin"]).toBe("*");
  const get = await request.get("/api/mcp", { headers: { accept: "text/event-stream" } });
  expect(get.status()).toBe(405);
  expect(get.headers()["allow"]).toBe("POST");
});

test("serves /skill.md and /llms.txt", async ({ request }) => {
  const skill = await request.get("/skill.md");
  expect(skill.status()).toBe(200);
  expect(skill.headers()["content-type"]).toContain("text/markdown");
  const md = await skill.text();
  expect(md).toContain("# Strike skill for AI agents");
  expect(md).toContain("/api/mcp");

  const llms = await request.get("/llms.txt");
  expect(llms.status()).toBe(200);
  expect(llms.headers()["content-type"]).toContain("text/plain");
  const txt = await llms.text();
  expect(txt.startsWith("# Strike\n\n> ")).toBe(true);
  expect(txt).toContain("https://strike-options.vercel.app/skill.md");
  expect(txt).toContain("https://strike-options.vercel.app/api/mcp");
  expect(txt).toMatch(/EpochManager\]\(.+\): `0x[0-9a-fA-F]{40}`/);
});
