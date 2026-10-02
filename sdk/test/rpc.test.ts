import { createPublicClient } from "viem";
import { describe, expect, it } from "vitest";
import {
  ALCHEMY_NETWORKS,
  alchemyApiKey,
  describeRpc,
  isLocalRpcUrl,
  redactRpcUrl,
  rpcEndpointsFor,
  rpcTransportFor,
  rpcUrlFor,
  strikeChainIds,
} from "../src/index.js";

// A made-up key: the tests never need a real one.
const KEY = "test_KEY-0123456789abcdef";
const PUBLIC = {
  4663: "https://rpc.mainnet.chain.robinhood.com",
  46630: "https://rpc.testnet.chain.robinhood.com",
  421614: "https://sepolia-rollup.arbitrum.io/rpc",
  42161: "https://arb1.arbitrum.io/rpc",
} as const;

describe("rpcUrlFor", () => {
  it("uses the public RPC when nothing is configured", () => {
    for (const [id, url] of Object.entries(PUBLIC)) expect(rpcUrlFor(Number(id), {})).toBe(url);
  });

  it("uses STRIKE_RPC_URL over the public RPC", () => {
    expect(rpcUrlFor(46630, { STRIKE_RPC_URL: " https://rpc.example/x " })).toBe("https://rpc.example/x");
  });

  it("uses Alchemy for every Strike chain when ALCHEMY_API_KEY is set, over STRIKE_RPC_URL", () => {
    expect(rpcUrlFor(46630, { ALCHEMY_API_KEY: KEY })).toBe(
      `https://robinhood-testnet.g.alchemy.com/v2/${KEY}`,
    );
    expect(rpcUrlFor(4663, { ALCHEMY_API_KEY: KEY })).toBe(
      `https://robinhood-mainnet.g.alchemy.com/v2/${KEY}`,
    );
    expect(rpcUrlFor(421614, { ALCHEMY_API_KEY: KEY, STRIKE_RPC_URL: "https://rpc.example" })).toBe(
      `https://arb-sepolia.g.alchemy.com/v2/${KEY}`,
    );
    expect(rpcUrlFor(42161, { ALCHEMY_API_KEY: KEY })).toBe(`https://arb-mainnet.g.alchemy.com/v2/${KEY}`);
    for (const id of strikeChainIds) expect(ALCHEMY_NETWORKS[id]).toBeTruthy();
  });

  it("never sends a local devnet or fork to a live provider", () => {
    for (const url of ["http://127.0.0.1:8545", "http://localhost:8545", "http://[::1]:8545"]) {
      expect(rpcUrlFor(46630, { ALCHEMY_API_KEY: KEY, STRIKE_RPC_URL: url })).toBe(url);
      expect(rpcEndpointsFor(46630, { ALCHEMY_API_KEY: KEY, STRIKE_RPC_URL: url })).toEqual([
        { provider: "custom", url },
      ]);
    }
    expect(rpcUrlFor(31337, { ALCHEMY_API_KEY: KEY })).toBe("http://127.0.0.1:8545");
    expect(isLocalRpcUrl("https://rpc.testnet.chain.robinhood.com")).toBe(false);
  });

  it("ignores a key that is not a plain token", () => {
    for (const bad of ["", "   ", "${ALCHEMY_API_KEY}", "abc/def/ghi", "short", `"${KEY}"`]) {
      expect(alchemyApiKey({ ALCHEMY_API_KEY: bad })).toBeUndefined();
      expect(rpcUrlFor(46630, { ALCHEMY_API_KEY: bad })).toBe(PUBLIC[46630]);
    }
    expect(alchemyApiKey({ ALCHEMY_API_KEY: ` ${KEY}\n` })).toBe(KEY);
  });

  it("needs STRIKE_RPC_URL on a chain without a public RPC", () => {
    expect(() => rpcUrlFor(1, { ALCHEMY_API_KEY: KEY })).toThrow(/set STRIKE_RPC_URL/);
    expect(rpcUrlFor(1, { STRIKE_RPC_URL: "https://eth.example" })).toBe("https://eth.example");
  });
});

describe("rpcEndpointsFor", () => {
  it("puts Alchemy first with the key in a header, never in the URL, then the public RPC", () => {
    const eps = rpcEndpointsFor(46630, { ALCHEMY_API_KEY: KEY });
    expect(eps).toEqual([
      {
        provider: "alchemy",
        url: "https://robinhood-testnet.g.alchemy.com/v2",
        headers: { Authorization: `Bearer ${KEY}` },
      },
      { provider: "public", url: PUBLIC[46630] },
    ]);
    for (const e of eps) expect(e.url).not.toContain(KEY);
  });

  it("keeps STRIKE_RPC_URL between Alchemy and the public RPC", () => {
    const eps = rpcEndpointsFor(421614, { ALCHEMY_API_KEY: KEY, STRIKE_RPC_URL: "https://rpc.example" });
    expect(eps.map((e) => e.provider)).toEqual(["alchemy", "custom", "public"]);
  });

  it("moves the key of an Alchemy STRIKE_RPC_URL into the header and drops duplicates", () => {
    const url = `https://robinhood-testnet.g.alchemy.com/v2/${KEY}`;
    expect(rpcEndpointsFor(46630, { STRIKE_RPC_URL: url })[0]).toEqual({
      provider: "alchemy",
      url: "https://robinhood-testnet.g.alchemy.com/v2",
      headers: { Authorization: `Bearer ${KEY}` },
    });
    expect(rpcEndpointsFor(46630, { ALCHEMY_API_KEY: KEY, STRIKE_RPC_URL: url })).toHaveLength(2);
    expect(rpcEndpointsFor(46630, { STRIKE_RPC_URL: PUBLIC[46630] })).toHaveLength(1);
  });

  it("describes the endpoints without the key", () => {
    const text = describeRpc(rpcEndpointsFor(46630, { ALCHEMY_API_KEY: KEY }));
    expect(text).toBe(
      "Alchemy (robinhood-testnet), falling back to rpc.testnet.chain.robinhood.com (public)",
    );
    expect(text).not.toContain(KEY);
  });
});

describe("redactRpcUrl", () => {
  it("hides keys, credentials and query values", () => {
    expect(redactRpcUrl(`https://arb-sepolia.g.alchemy.com/v2/${KEY}`)).toBe(
      "https://arb-sepolia.g.alchemy.com/v2/***",
    );
    expect(redactRpcUrl("https://user:pass@rpc.example/path?apikey=secret")).toBe(
      "https://***@rpc.example/path?apikey=***",
    );
    expect(redactRpcUrl(PUBLIC[46630])).toBe(`${PUBLIC[46630]}/`);
    expect(redactRpcUrl("not a url")).not.toContain("not a url");
  });
});

/** A fetch that records each request and answers with `answer(url, body)`. */
function mockFetch(answer: (url: string, body: { method: string; id: number }) => Response) {
  const calls: { url: string; auth: string | null; method: string }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body));
    const headers = new Headers(init?.headers);
    calls.push({ url, auth: headers.get("authorization"), method: body.method });
    return answer(url, body);
  }) as typeof fetch;
  return { calls, fetchFn };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("rpcTransportFor", () => {
  it("reads through Alchemy with the key in the Authorization header only", async () => {
    const { calls, fetchFn } = mockFetch((_url, b) => json({ jsonrpc: "2.0", id: b.id, result: "0x10" }));
    const client = createPublicClient({
      transport: rpcTransportFor(46630, { ALCHEMY_API_KEY: KEY }, { fetchFn, retryCount: 0 }),
    });
    expect(await client.getBlockNumber({ cacheTime: 0 })).toBe(16n);
    expect(calls).toEqual([
      { url: "https://robinhood-testnet.g.alchemy.com/v2", auth: `Bearer ${KEY}`, method: "eth_blockNumber" },
    ]);
  });

  it("falls back to the public RPC when Alchemy rate-limits or refuses a log range, without the header", async () => {
    const { calls, fetchFn } = mockFetch((url, b) => {
      if (url.includes("alchemy")) {
        if (b.method === "eth_getLogs")
          return json(
            {
              jsonrpc: "2.0",
              id: b.id,
              error: {
                code: -32600,
                message:
                  "Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range.",
              },
            },
            400,
          );
        return json({ jsonrpc: "2.0", id: b.id, error: { code: 429, message: "Too many requests" } }, 429);
      }
      return json({ jsonrpc: "2.0", id: b.id, result: b.method === "eth_getLogs" ? [] : "0x20" });
    });
    const client = createPublicClient({
      transport: rpcTransportFor(46630, { ALCHEMY_API_KEY: KEY }, { fetchFn, retryCount: 0 }),
    });
    expect(await client.getBlockNumber({ cacheTime: 0 })).toBe(32n);
    expect(await client.getLogs({ fromBlock: 1n, toBlock: 100_000n })).toEqual([]);
    expect(calls.map((c) => [c.url.includes("alchemy") ? "alchemy" : "public", c.method])).toEqual([
      ["alchemy", "eth_blockNumber"],
      ["public", "eth_blockNumber"],
      ["alchemy", "eth_getLogs"],
      ["public", "eth_getLogs"],
    ]);
    for (const c of calls.filter((c) => !c.url.includes("alchemy"))) expect(c.auth).toBeNull();
  });

  it("does not retry a revert on the public RPC", async () => {
    const { calls, fetchFn } = mockFetch((_url, b) =>
      json({ jsonrpc: "2.0", id: b.id, error: { code: 3, message: "execution reverted", data: "0x" } }),
    );
    const client = createPublicClient({
      transport: rpcTransportFor(46630, { ALCHEMY_API_KEY: KEY }, { fetchFn, retryCount: 0 }),
    });
    await expect(
      client.call({ to: "0x0000000000000000000000000000000000000001", data: "0x" }),
    ).rejects.toThrow(/revert/i);
    expect(calls).toHaveLength(1);
  });

  it("never puts the key in an error message", async () => {
    const { fetchFn } = mockFetch(() => new Response("upstream down", { status: 503 }));
    const client = createPublicClient({
      transport: rpcTransportFor(4663, { ALCHEMY_API_KEY: KEY }, { fetchFn, retryCount: 0 }),
    });
    const err = await client.getBlockNumber({ cacheTime: 0 }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).not.toContain(KEY);
    expect(JSON.stringify(err)).not.toContain(KEY);
  });
});
