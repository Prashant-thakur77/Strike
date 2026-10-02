import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type StrikeClient, deploymentsFor } from "@strike/sdk";
import { describe, expect, it } from "vitest";
import {
  McpTargetError,
  handleReadOnlyMcpRequest,
  mcpTarget,
  readOnlyClients,
  remoteChainIds,
} from "../src/http.js";
import { READ_ONLY_TOOLS, createStrikeMcpServer } from "../src/server.js";

const noClient = (): StrikeClient => {
  throw new Error("no chain in this test");
};

const post = (body: unknown, accept = "application/json, text/event-stream", query = "") =>
  new Request(`http://localhost/api/mcp${query}`, {
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

// The deployments in the SDK's map, read from it rather than copied, so a redeploy does not break these tests.
const emOf = (chainId: number, version: string) =>
  deploymentsFor(chainId).find((d) => d.version === version)!.epochManager;

describe("picking the chain and deployment per request", () => {
  const target = (query: string, options = {}) => mcpTarget(`http://localhost/api/mcp${query}`, options);

  it("defaults to the default chain and every deployment on it", () => {
    expect(target("")).toEqual({ chainId: 46630 });
    expect(target("", { chainId: 421614 })).toEqual({ chainId: 421614 });
    expect(target("?chainId=&version=")).toEqual({ chainId: 46630 });
  });

  it("reads ?chainId= and ?version= (v3, V3 or 3)", () => {
    expect(target("?chainId=421614")).toEqual({ chainId: 421614 });
    expect(target("?chainId=46630&version=v3")).toEqual({ chainId: 46630, version: "v3" });
    expect(target("?version=V2")).toEqual({ chainId: 46630, version: "v2" });
    expect(target("?chainId=421614&version=3")).toEqual({ chainId: 421614, version: "v3" });
    expect(target("", { version: "v3" })).toEqual({ chainId: 46630, version: "v3" });
  });

  it("serves the public chains with a deployment, not the local devnet", () => {
    expect(remoteChainIds()).toEqual(expect.arrayContaining([46630, 421614]));
    expect(remoteChainIds()).not.toContain(31337);
    for (const q of ["?chainId=31337", "?chainId=1", "?chainId=abc", "?chainId=46630.0"]) {
      expect(() => target(q), q).toThrow(McpTargetError);
    }
    expect(() => target("?chainId=1")).toThrow(
      /unknown chainId 1: this endpoint reads chains 46630, .*421614/,
    );
  });

  it("refuses a version the chain does not have, naming the ones it has", () => {
    expect(() => target("?chainId=421614&version=v2")).toThrow(/no v2 deployment on chain 421614; it has v3/);
    expect(() => target("?version=latest")).toThrow(/invalid version latest: use v2 or v3/);
  });

  it("builds one read client per deployment, the SDK's default first", () => {
    const all = readOnlyClients(46630);
    expect(all.map((d) => d.version)).toEqual(deploymentsFor(46630).map((d) => d.version));
    expect(all.map((d) => d.version)).toEqual(expect.arrayContaining(["v2", "v3"]));
    expect(all.map((d) => d.client.addresses.epochManager)).toEqual(
      deploymentsFor(46630).map((d) => d.epochManager),
    );
    const v3 = readOnlyClients(46630, undefined, 10_000, "v3");
    expect(v3).toHaveLength(1);
    expect(v3[0]!.client.addresses.epochManager).toBe(emOf(46630, "v3"));
    // Built once per deployment and reused by later requests on a warm instance.
    expect(readOnlyClients(46630)[1]!.client).toBe(all[1]!.client);
    expect(readOnlyClients(421614).map((d) => d.version)).toEqual(["v3"]);
  });
});

describe("the stateless handler with ?chainId= and ?version=", () => {
  const info = {
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: { name: "strike_info", arguments: {} },
  };
  const infoAt = async (query: string) => {
    const res = await handleReadOnlyMcpRequest(post(info, undefined, query));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { result: { structuredContent: Record<string, any> } };
    return json.result.structuredContent;
  };

  it("answers 400 with a JSON-RPC error for a chain or version it does not read", async () => {
    for (const query of ["?chainId=31337", "?chainId=421614&version=v2", "?version=v9"]) {
      const res = await handleReadOnlyMcpRequest(post(initialize, undefined, query));
      expect(res.status, query).toBe(400);
      const json = (await res.json()) as { error: { code: number; message: string } };
      expect(json.error.code).toBe(-32602);
      expect(json.error.message).toMatch(/unknown chainId|no v\d deployment/);
    }
  });

  it("reads every deployment of the default chain without a query (strike_info lists them)", async () => {
    const out = await infoAt("");
    expect(out).toMatchObject({ chainId: 46630, mode: "read-only", deployed: true });
    expect(out.deployments.map((d: any) => [d.version, d.epochManager, d.default])).toEqual(
      deploymentsFor(46630).map((d, i) => [d.version, d.epochManager, i === 0]),
    );
  });

  it("reads one deployment with ?version=, and another chain with ?chainId=", async () => {
    const v3 = await infoAt("?chainId=46630&version=v3");
    expect(v3.chainId).toBe(46630);
    expect(v3.deployments).toEqual([
      { chainId: 46630, version: "v3", epochManager: emOf(46630, "v3"), default: true },
    ]);
    const arb = await infoAt("?chainId=421614");
    expect(arb.chainId).toBe(421614);
    expect(arb.deployments).toEqual([
      { chainId: 421614, version: "v3", epochManager: emOf(421614, "v3"), default: true },
    ]);
  });

  it("gives a chain picked by query its own RPC endpoints when the host passes a function", async () => {
    const asked: number[] = [];
    const res = await handleReadOnlyMcpRequest(post(info, undefined, "?chainId=421614"), {
      chainId: 46630,
      rpcEndpoints: (chainId) => {
        asked.push(chainId);
        return [{ provider: "custom", url: `https://rpc.example/${chainId}` }];
      },
    });
    expect(res.status).toBe(200);
    expect(asked).toEqual([421614]);
  });
});
