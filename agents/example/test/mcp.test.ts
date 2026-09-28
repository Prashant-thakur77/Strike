import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type StrikeMcp, ToolError, connectStrikeMcp } from "../src/mcp.js";

// Spawns the real Strike MCP server over stdio (read-only, no chain needed for these calls).
describe("connectStrikeMcp", () => {
  let mcp: StrikeMcp;

  beforeAll(async () => {
    process.env.STRIKE_CHAIN_ID = "31337";
    process.env.STRIKE_RPC_URL = "http://127.0.0.1:9";
    delete process.env.STRIKE_AGENT_PRIVATE_KEY;
    mcp = await connectStrikeMcp();
  }, 60_000);

  afterAll(async () => {
    await mcp?.close();
  });

  it("talks to the server over stdio", async () => {
    const { tools } = await mcp.client.listTools();
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["list_vaults", "vault_state", "risk_check", "propose_epoch", "settle_epoch"]),
    );
    const info = await mcp.call<{ chainId: number; mode: string }>("strike_info");
    expect(info).toMatchObject({ chainId: 31337, mode: "read-only" });
  });

  it("surfaces tool errors", async () => {
    await expect(
      mcp.call("propose_epoch", { vault: "sTSLA-CC", targetDeltaBps: 2000 }),
    ).rejects.toBeInstanceOf(ToolError);
  });

  it("serves the skill resource", async () => {
    const res = await mcp.client.readResource({ uri: "strike://skill" });
    expect(JSON.stringify(res.contents)).toMatch(/Strike skill for AI agents/);
  });
});
