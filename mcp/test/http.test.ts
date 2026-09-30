import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { StrikeClient } from "@strike/sdk";
import { describe, expect, it } from "vitest";
import { handleReadOnlyMcpRequest } from "../src/http.js";
import { READ_ONLY_TOOLS, createStrikeMcpServer } from "../src/server.js";

const noClient = (): StrikeClient => {
  throw new Error("no chain in this test");
};

const post = (body: unknown, accept = "application/json, text/event-stream") =>
  new Request("http://localhost/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept },
    body: JSON.stringify(body),
  });

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
};

describe("read-only mode", () => {
  it("registers only the read tools", async () => {
    const server = createStrikeMcpServer({ chainId: 31337, client: noClient, readOnly: true });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    const mcp = new Client({ name: "t", version: "0" });
    await mcp.connect(a);
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name)).toEqual([...READ_ONLY_TOOLS]);
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
    await mcp.close();
  });

  it("keeps every tool without readOnly", async () => {
    const server = createStrikeMcpServer({ chainId: 31337, client: noClient });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    const mcp = new Client({ name: "t", version: "0" });
    await mcp.connect(a);
    const names = (await mcp.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining([...READ_ONLY_TOOLS, "propose_epoch", "buy_options"]));
    await mcp.close();
  });

  it("serves the embedded skill text", async () => {
    const server = createStrikeMcpServer({
      chainId: 31337,
      client: noClient,
      readOnly: true,
      skillText: "# embedded",
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    const mcp = new Client({ name: "t", version: "0" });
    await mcp.connect(a);
    const res = await mcp.readResource({ uri: "strike://skill" });
    expect((res.contents[0] as { text: string }).text).toBe("# embedded");
    await mcp.close();
  });
});

describe("stateless HTTP handler", () => {
  it("initializes without a session id and answers in JSON", async () => {
    const res = await handleReadOnlyMcpRequest(post(initialize));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("mcp-session-id")).toBeNull();
    const json = (await res.json()) as { result: { serverInfo: { name: string } } };
    expect(json.result.serverInfo.name).toBe("strike");
  });

  it("lists the read tools on a fresh request, even for a client that only accepts JSON", async () => {
    const res = await handleReadOnlyMcpRequest(
      post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, "application/json"),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { result: { tools: { name: string }[] } };
    expect(json.result.tools.map((t) => t.name)).toEqual([...READ_ONLY_TOOLS]);
  });

  it("refuses write tools", async () => {
    const res = await handleReadOnlyMcpRequest(
      post({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "propose_epoch", arguments: { vault: "sTSLA-CC" } },
      }),
    );
    const json = (await res.json()) as { result?: { isError?: boolean }; error?: unknown };
    expect(json.error ?? json.result?.isError).toBeTruthy();
  });

  it("answers GET and DELETE with 405", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = await handleReadOnlyMcpRequest(new Request("http://localhost/api/mcp", { method }));
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    }
  });
});
