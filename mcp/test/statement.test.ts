import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type StrikeClient, epochManagerAbi } from "@strike/sdk";
import {
  type Hex,
  type PublicClient,
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  toHex,
} from "viem";
import { afterEach, describe, expect, it } from "vitest";
import accepted from "../../docs/agent-log/2026-10-01-sTSLA-CC.json" with { type: "json" };
import { createStrikeMcpServer } from "../src/server.js";

// wallet_statement and explain_decision: the statement of an empty wallet over a fake chain (both testnets answer,
// nothing found), and questions about the published 1 October covered-call record, given as JSON or fetched by its
// repository path (fake fetch), plus the refusals.

const EMPTY = "0x000000000000000000000000000000000000dEaD";

/** A chain with no Strike events: every EpochManager has no vault, every token is 6-decimal USDG. */
function emptyChain(): PublicClient {
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      if (method === "eth_chainId") return toHex(46630);
      if (method === "eth_blockNumber") return toHex(400_000_000n);
      if (method === "eth_getLogs") return [];
      if (method === "eth_call") {
        const [{ data }] = params as [{ data: Hex }];
        for (const abi of [epochManagerAbi, erc20Abi] as const) {
          try {
            const { functionName } = decodeFunctionData({ abi, data } as never) as { functionName: string };
            const result = { vaultCount: 0n, symbol: "USDG", decimals: 6 }[functionName];
            if (result !== undefined) return encodeFunctionResult({ abi, functionName, result } as never);
          } catch {
            // try the next ABI
          }
        }
      }
      throw new Error(`unmocked ${method}`);
    },
  });
  return createPublicClient({ transport }) as PublicClient;
}

let mcp: Client | undefined;
afterEach(async () => {
  await mcp?.close();
  mcp = undefined;
});

async function connect(opts: { fetch?: typeof fetch } = {}) {
  const chain = emptyChain();
  const server = createStrikeMcpServer({
    chainId: 46630,
    readOnly: true,
    client: () => ({}) as StrikeClient,
    publicClientFor: () => chain,
    fetch: opts.fetch,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  mcp = new Client({ name: "strike-test", version: "0.0.0" });
  await mcp.connect(a);
  await mcp.listTools();
  return mcp;
}

const call = async (c: Client, name: string, args: Record<string, unknown>) =>
  (await c.callTool({ name, arguments: args })) as CallToolResult;

describe("wallet_statement", () => {
  it("is read-only and gives an empty wallet an empty statement over both testnets", async () => {
    const c = await connect();
    const { tools } = await c.listTools();
    expect(tools.find((t) => t.name === "wallet_statement")?.annotations?.readOnlyHint).toBe(true);
    const r = await call(c, "wallet_statement", { address: EMPTY, format: "csv" });
    expect(r.isError).toBeFalsy();
    const s = r.structuredContent as Record<string, unknown>;
    expect(s.rows).toEqual([]);
    expect(s.rowCount).toBe(0);
    expect((s.sources as { chainId: number }[]).map((x) => x.chainId)).toEqual([46630, 421614]);
    expect(String(s.csv).split("\r\n")[0]).toMatch(/^date_utc,chain_id,/);
  });

  it("refuses a bad address or date range", async () => {
    const c = await connect();
    expect((await call(c, "wallet_statement", { address: "0x12" })).isError).toBe(true);
    const r = await call(c, "wallet_statement", { address: EMPTY, from: "2026-10-02", to: "2026-10-01" });
    expect(r.isError).toBe(true);
  });
});

describe("explain_decision", () => {
  it("answers from a record given as JSON, citing each field, with the hash checked", async () => {
    const c = await connect();
    const r = await call(c, "explain_decision", { question: "Why this strike?", record: accepted });
    const a = r.structuredContent as Record<string, unknown>;
    expect(a.refused).toBe(false);
    expect(a.hashMatches).toBe(true);
    expect(a.answer).toContain("$369.37 [dryRun.strike]");
    expect(a.source).toBe("given");
    expect(a.anchorCheck).toBeNull();
  });

  it("fetches a record by its repository path from Strike's repository only", async () => {
    const asked: string[] = [];
    const fakeFetch = (async (url: string) => {
      asked.push(url);
      return new Response(JSON.stringify(accepted), { status: 200 });
    }) as typeof fetch;
    const c = await connect({ fetch: fakeFetch });
    const r = await call(c, "explain_decision", {
      question: "Was it within the mandate?",
      url: "docs/agent-log/2026-10-01-sTSLA-CC.json",
    });
    expect(asked).toEqual([
      "https://raw.githubusercontent.com/Prashant-thakur77/Strike/main/docs/agent-log/2026-10-01-sTSLA-CC.json",
    ]);
    expect((r.structuredContent as { answer: string }).answer).toContain("inside the mandate [dryRun.ok]");
    const blob = await call(c, "explain_decision", {
      question: "what happened?",
      url: "https://github.com/Prashant-thakur77/Strike/blob/main/docs/agent-log/2026-10-01-sTSLA-CC.json",
    });
    expect(blob.isError).toBeFalsy();
    for (const url of [
      "https://example.com/record.json",
      "docs/agent-log/../../.env.json",
      "file:///etc/passwd",
    ]) {
      const bad = await call(c, "explain_decision", { question: "why?", url });
      expect(bad.isError, url).toBe(true);
    }
    expect(asked).toHaveLength(2);
  });

  it("refuses a question the record cannot answer", async () => {
    const c = await connect();
    const r = await call(c, "explain_decision", { question: "Will TSLA go up tomorrow?", record: accepted });
    const a = r.structuredContent as { refused: boolean; citations: unknown[]; answer: string };
    expect(a.refused).toBe(true);
    expect(a.citations).toEqual([]);
    expect(a.answer).toMatch(/^This record does not answer that\./);
  });

  it("offers an explain_decision prompt that keeps the model to the cited fields", async () => {
    const c = await connect();
    const { prompts } = await c.listPrompts();
    expect(prompts.map((p) => p.name)).toContain("explain_decision");
    const p = await c.getPrompt({
      name: "explain_decision",
      arguments: { record: "docs/agent-log/2026-10-01-sTSLA-CC.json", question: "Why this strike?" },
    });
    const text = (p.messages[0]!.content as { text: string }).text;
    expect(text).toContain('url "docs/agent-log/2026-10-01-sTSLA-CC.json"');
    expect(text).toContain("Answer only from the tool's answer and citations.");
  });
});
