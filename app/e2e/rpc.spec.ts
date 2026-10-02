import { expect, test } from "@playwright/test";
import {
  MAX_BATCH,
  MAX_BODY_BYTES,
  MAX_UPSTREAM_BYTES,
  READ_METHODS,
  RpcCache,
  UpstreamHealth,
  cacheTtl,
  isChainError,
  proxyRpc,
  readBodyLimited,
  type RpcResponse,
  type Upstream,
} from "../src/lib/rpc/proxy";

// /api/rpc/<chainId>: the read-only JSON-RPC proxy in front of Alchemy. The first group tests its core with a mock
// fetch (no network, no key: KEY below is made up); the second calls the built route, which has no ALCHEMY_API_KEY
// in CI and so answers from the public RPC.

const KEY = "test-alchemy-key";
const ALCHEMY: Upstream = {
  provider: "alchemy",
  url: "https://robinhood-testnet.g.alchemy.com/v2",
  headers: { Authorization: `Bearer ${KEY}` },
};
const PUBLIC: Upstream = { provider: "public", url: "https://rpc.testnet.chain.robinhood.com" };

type Call = { url: string; auth: string | null; body: { id: number; method: string }[] };
type Answer = (url: string, req: { id: number; method: string; params?: unknown[] }) => unknown;

/** A fetch that records each upstream request and answers it with `respond(url)`. */
function upstreamRaw(respond: (url: string) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const parsed = JSON.parse(String(init?.body));
    calls.push({
      url,
      auth: new Headers(init?.headers).get("authorization"),
      body: Array.isArray(parsed) ? parsed : [parsed],
    });
    return respond(url);
  }) as typeof fetch;
  return { calls, fetchFn };
}

/** A fetch that answers each call of each upstream request with `answer(url, call)`. */
function upstream(answer: Answer) {
  let last: { url: string; parsed: unknown } = { url: "", parsed: null };
  const raw = upstreamRaw(async (url) => {
    const { parsed } = last;
    const body = (Array.isArray(parsed) ? parsed : [parsed]) as Parameters<Answer>[1][];
    const out = body.map((r) => ({ jsonrpc: "2.0", id: r.id, ...(answer(url, r) as object) }));
    return new Response(JSON.stringify(Array.isArray(parsed) ? out : out[0]), {
      headers: { "Content-Type": "application/json" },
    });
  });
  const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => {
    last = { url: String(input), parsed: JSON.parse(String(init?.body)) };
    return raw.fetchFn(input, init);
  }) as typeof fetch;
  return { calls: raw.calls, fetchFn };
}

const req = (id: number | string, method: string, params: unknown[] = []) => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
});
const body = (x: unknown) => JSON.stringify(x);
const pure = () => test.skip(test.info().project.name !== "desktop", "pure function: one project is enough");

test.describe("rpc proxy core", () => {
  test("refuses every method outside the read allowlist, without calling upstream", async () => {
    pure();
    const { calls, fetchFn } = upstream(() => ({ result: "0x1" }));
    for (const method of [
      "eth_sendRawTransaction",
      "eth_sendTransaction",
      "eth_sign",
      "personal_sign",
      "eth_accounts",
      "eth_newFilter",
      "debug_traceTransaction",
      "admin_peers",
    ]) {
      const r = await proxyRpc(body(req(7, method, ["0x00"])), {
        upstreams: [ALCHEMY, PUBLIC],
        fetch: fetchFn,
      });
      expect(r.status).toBe(200);
      expect((r.body as RpcResponse).id).toBe(7);
      expect((r.body as RpcResponse).error?.code).toBe(-32601);
      expect((r.body as RpcResponse).error?.message).toContain("read-only");
    }
    expect(calls).toHaveLength(0);
    expect(READ_METHODS.has("eth_sendRawTransaction")).toBe(false);
    expect(READ_METHODS.size).toBe(15);
  });

  test("forwards the read methods to Alchemy with the key in a header, keeping ids and batch order", async () => {
    pure();
    const { calls, fetchFn } = upstream((_url, r) => ({ result: `${r.method}-ok` }));
    const batch = [...READ_METHODS].map((m, i) => req(i % 2 ? `s${i}` : i, m));
    batch.splice(3, 0, req(99, "eth_sendRawTransaction", ["0xdead"]));
    const r = await proxyRpc(body(batch), { upstreams: [ALCHEMY, PUBLIC], fetch: fetchFn });
    const out = r.body as RpcResponse[];
    expect(out.map((x) => x.id)).toEqual(batch.map((x) => x.id));
    expect(out[3]!.error?.code).toBe(-32601);
    expect(out.filter((x) => x.result).map((x) => x.result)).toEqual([...READ_METHODS].map((m) => `${m}-ok`));
    expect(r.served).toBe("alchemy");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(ALCHEMY.url);
    expect(calls[0]!.url).not.toContain(KEY);
    expect(calls[0]!.auth).toBe(`Bearer ${KEY}`);
    expect(calls[0]!.body.map((b) => b.method)).not.toContain("eth_sendRawTransaction");
  });

  test("falls back to the public RPC when Alchemy rate-limits, is down or the key is missing", async () => {
    pure();
    const limited = upstreamRaw(async (url) =>
      url.includes("alchemy")
        ? new Response(
            body({ jsonrpc: "2.0", id: null, error: { code: 429, message: "Too many requests" } }),
            {
              status: 429,
            },
          )
        : new Response(body({ jsonrpc: "2.0", id: 0, result: "0x20" }), {
            headers: { "Content-Type": "application/json" },
          }),
    );
    const r = await proxyRpc(body(req(1, "eth_blockNumber")), {
      upstreams: [ALCHEMY, PUBLIC],
      fetch: limited.fetchFn,
    });
    expect(r.body).toEqual({ jsonrpc: "2.0", id: 1, result: "0x20" });
    expect(r.served).toBe("public");
    expect(limited.calls.map((c) => [c.url, c.auth])).toEqual([
      [ALCHEMY.url, `Bearer ${KEY}`],
      [PUBLIC.url, null],
    ]);

    const failures: string[] = [];
    const down = upstreamRaw(async (url) => {
      if (url.includes("alchemy")) throw new TypeError("fetch failed");
      return new Response(body({ jsonrpc: "2.0", id: 0, result: "0xb626" }));
    });
    const r2 = await proxyRpc(body(req(2, "eth_chainId")), {
      upstreams: [ALCHEMY, PUBLIC],
      fetch: down.fetchFn,
      onUpstreamError: (p, reason) => failures.push(`${p}: ${reason}`),
    });
    expect((r2.body as RpcResponse).result).toBe("0xb626");
    expect(failures).toEqual(["alchemy: no answer"]);

    const keyless = upstream(() => ({ result: "0x1" }));
    const r3 = await proxyRpc(body(req(3, "eth_gasPrice")), { upstreams: [PUBLIC], fetch: keyless.fetchFn });
    expect(r3.served).toBe("public");
    expect(keyless.calls.map((c) => c.url)).toEqual([PUBLIC.url]);
  });

  test("retries only the calls Alchemy refused (a free-tier log range) and never a revert", async () => {
    pure();
    const { calls, fetchFn } = upstream((url, r) => {
      if (url.includes("alchemy") && r.method === "eth_getLogs")
        return {
          error: {
            code: -32600,
            message:
              "Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range.",
          },
        };
      if (r.method === "eth_call")
        return { error: { code: 3, message: "execution reverted", data: "0x08c379a0" } };
      return { result: url.includes("alchemy") ? "from-alchemy" : [] };
    });
    const r = await proxyRpc(
      body([
        req(1, "eth_blockNumber"),
        req(2, "eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x186a0" }]),
        req(3, "eth_call", [{ to: "0x01" }, "latest"]),
      ]),
      { upstreams: [ALCHEMY, PUBLIC], fetch: fetchFn },
    );
    const out = r.body as RpcResponse[];
    expect(out[0]).toEqual({ jsonrpc: "2.0", id: 1, result: "from-alchemy" });
    expect(out[1]).toEqual({ jsonrpc: "2.0", id: 2, result: [] });
    expect(out[2]!.error).toEqual({ code: 3, message: "execution reverted", data: "0x08c379a0" });
    expect(r.served).toBe("alchemy+public");
    expect(
      calls.map((c) => [c.url.includes("alchemy") ? "alchemy" : "public", c.body.map((b) => b.method)]),
    ).toEqual([
      ["alchemy", ["eth_blockNumber", "eth_getLogs", "eth_call"]],
      ["public", ["eth_getLogs"]],
    ]);
    expect(isChainError({ code: -32000, message: "execution reverted: TooSoon" })).toBe(true);
    expect(isChainError({ code: -32005, message: "limit exceeded" })).toBe(false);
  });

  test("answers 502 when no upstream answers, and relays the last provider error otherwise", async () => {
    pure();
    const dead = upstreamRaw(async () => new Response("<html>403 Forbidden</html>", { status: 403 }));
    const r = await proxyRpc(body(req(1, "eth_blockNumber")), {
      upstreams: [ALCHEMY, PUBLIC],
      fetch: dead.fetchFn,
    });
    expect(r.status).toBe(502);
    expect((r.body as RpcResponse).error?.code).toBe(-32603);
    expect(r.served).toBe("none");
    const limited = upstream(() => ({ error: { code: -32005, message: "rate limited" } }));
    const r2 = await proxyRpc(body(req(2, "eth_blockNumber")), {
      upstreams: [ALCHEMY, PUBLIC],
      fetch: limited.fetchFn,
    });
    expect(r2.status).toBe(200);
    expect((r2.body as RpcResponse).error).toEqual({ code: -32005, message: "rate limited" });
    expect(limited.calls).toHaveLength(2);
  });

  test("times out a hung upstream and moves on", async () => {
    pure();
    const hung = upstreamRaw(async (url) => {
      if (url.includes("alchemy")) await new Promise((r) => setTimeout(r, 5_000));
      return new Response(body({ jsonrpc: "2.0", id: 0, result: "0x5" }));
    });
    // The mock ignores the abort signal, so wrap it: reject as soon as the proxy aborts.
    const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
        hung.fetchFn(input, init).then(resolve, reject);
      })) as typeof fetch;
    const failures: string[] = [];
    const started = Date.now();
    const r = await proxyRpc(body(req(1, "eth_blockNumber")), {
      upstreams: [ALCHEMY, PUBLIC],
      fetch: fetchFn,
      timeoutMs: 200,
      onUpstreamError: (p, reason) => failures.push(`${p}: ${reason}`),
    });
    expect((r.body as RpcResponse).result).toBe("0x5");
    expect(failures).toEqual(["alchemy: timeout"]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("skips an upstream that gave no answer, refused the key or rate-limited for 30 s, never the last one", async () => {
    pure();
    let now = 0;
    const health = new UpstreamHealth(() => now);
    let alchemyMode: "down" | "401" | "ok" = "down";
    const { calls, fetchFn } = upstreamRaw(async (url) => {
      if (url.includes("alchemy")) {
        if (alchemyMode === "down") throw new TypeError("fetch failed");
        if (alchemyMode === "401")
          return new Response(
            body({ jsonrpc: "2.0", id: 0, error: { code: -32600, message: "Must be authenticated!" } }),
            {
              status: 401,
            },
          );
        return new Response(body({ jsonrpc: "2.0", id: 0, result: "0xa1" }));
      }
      if (url.includes("public-down")) throw new TypeError("fetch failed");
      return new Response(body({ jsonrpc: "2.0", id: 0, result: "0xb2" }));
    });
    const opts = { upstreams: [ALCHEMY, PUBLIC], fetch: fetchFn, health };
    const hosts = () => calls.map((c) => (c.url.includes("alchemy") ? "alchemy" : "public"));
    const ask = async () =>
      ((await proxyRpc(body(req(1, "eth_blockNumber")), opts)).body as RpcResponse).result;

    expect(await ask()).toBe("0xb2"); // Alchemy down: public answers, Alchemy is marked down
    expect(await ask()).toBe("0xb2"); // skipped: straight to public
    expect(hosts()).toEqual(["alchemy", "public", "public"]);
    now += 31_000;
    alchemyMode = "ok";
    expect(await ask()).toBe("0xa1"); // tried again after the cooldown
    alchemyMode = "401";
    expect(await ask()).toBe("0xb2"); // a refused key also trips it
    expect(await ask()).toBe("0xb2");
    expect(hosts()).toEqual(["alchemy", "public", "public", "alchemy", "alchemy", "public", "public"]);

    // A rate limit (429) trips it; a refused call (400, an eth_getLogs range) does not.
    for (const [status, skipped] of [
      [429, true],
      [400, false],
    ] as const) {
      const h = new UpstreamHealth(() => now);
      const seen = upstreamRaw(async (url) =>
        url.includes("alchemy")
          ? new Response(body({ jsonrpc: "2.0", id: 0, error: { code: -32005, message: "refused" } }), {
              status,
            })
          : new Response(body({ jsonrpc: "2.0", id: 0, result: "0xb2" })),
      );
      const o = { upstreams: [ALCHEMY, PUBLIC], fetch: seen.fetchFn, health: h };
      await proxyRpc(body(req(1, "eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x2" }])), o);
      await proxyRpc(body(req(2, "eth_blockNumber")), o);
      const alchemyCalls = seen.calls.filter((c) => c.url.includes("alchemy")).length;
      expect(alchemyCalls, `HTTP ${status}`).toBe(skipped ? 1 : 2);
    }

    // The last upstream is tried even while marked down.
    const lonely = { provider: "public" as const, url: "https://public-down.example" };
    const only = { upstreams: [lonely], fetch: fetchFn, health };
    await proxyRpc(body(req(1, "eth_blockNumber")), only);
    await proxyRpc(body(req(1, "eth_blockNumber")), only);
    expect(calls.filter((c) => c.url === lonely.url)).toHaveLength(2);
  });

  test("limits the body and the batch, and rejects malformed requests", async () => {
    pure();
    const { calls, fetchFn } = upstream(() => ({ result: "0x1" }));
    const opts = { upstreams: [PUBLIC], fetch: fetchFn };
    const big = body(req(1, "eth_call", [{ data: `0x${"00".repeat(MAX_BODY_BYTES)}` }, "latest"]));
    expect((await proxyRpc(big, opts)).status).toBe(413);
    const many = body(Array.from({ length: MAX_BATCH + 1 }, (_, i) => req(i, "eth_blockNumber")));
    expect((await proxyRpc(many, opts)).status).toBe(413);
    expect((await proxyRpc("{not json", opts)).status).toBe(400);
    expect((await proxyRpc("[]", opts)).status).toBe(400);
    const bad = (
      await proxyRpc(body([{ id: 1, method: "eth_blockNumber" }, req(2, "eth_call", {} as never), 5]), opts)
    ).body as RpcResponse[];
    expect(bad.map((b) => b.error?.code)).toEqual([-32600, -32602, -32600]);
    expect(calls).toHaveLength(0);

    const stream = (n: number) =>
      new ReadableStream<Uint8Array>({
        start(c) {
          for (let i = 0; i < n; i++) c.enqueue(new Uint8Array(1024).fill(32));
          c.close();
        },
      });
    expect(await readBodyLimited(stream(MAX_BODY_BYTES / 1024 + 1), MAX_BODY_BYTES)).toBeNull();
    expect((await readBodyLimited(stream(2), MAX_BODY_BYTES))?.length).toBe(2048);
  });

  test("answers a response-size error, without trying the next upstream, when an answer is over 4 MB", async () => {
    pure();
    const huge = `[${Array.from({ length: 50 }, () => JSON.stringify({ data: `0x${"ab".repeat(48 * 1024)}` })).join(",")}]`;
    const { calls, fetchFn } = upstreamRaw(
      async () =>
        new Response(`{"jsonrpc":"2.0","id":0,"result":${huge}}`, {
          headers: { "Content-Type": "application/json" },
        }),
    );
    expect(huge.length).toBeGreaterThan(MAX_UPSTREAM_BYTES);
    const r = await proxyRpc(body(req(1, "eth_getLogs", [{ fromBlock: "0x1", toBlock: "0xfffff" }])), {
      upstreams: [ALCHEMY, PUBLIC],
      fetch: fetchFn,
    });
    expect((r.body as RpcResponse).error?.code).toBe(-32005);
    expect((r.body as RpcResponse).error?.message).toMatch(/response size/i);
    expect(calls).toHaveLength(1);
  });

  test("reuses calls pinned to a block, never a read at latest or an error", async () => {
    pure();
    let now = 1_000;
    const cache = new RpcCache(500, () => now);
    const { calls, fetchFn } = upstream((_url, r) =>
      r.method === "eth_getBalance"
        ? { error: { code: -32603, message: "boom" } }
        : { result: `${r.method}-${calls.length}` },
    );
    const opts = { upstreams: [PUBLIC], fetch: fetchFn, cache, cacheScope: "46630" };
    const pinnedCall = req(1, "eth_call", [{ to: "0x01", data: "0x" }, "0x10"]);
    const latestCall = req(2, "eth_call", [{ to: "0x01", data: "0x" }, "latest"]);
    const logs = req(3, "eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x10", address: "0x01" }]);
    const first = (await proxyRpc(body([pinnedCall, latestCall, logs]), opts)).body as RpcResponse[];
    const second = await proxyRpc(body([pinnedCall, latestCall, logs]), opts);
    expect((second.body as RpcResponse[])[0]!.result).toBe(first[0]!.result);
    expect((second.body as RpcResponse[])[2]!.result).toBe(first[2]!.result);
    expect((second.body as RpcResponse[])[1]!.result).not.toBe(first[1]!.result);
    expect(second.served).toBe("public+cache");
    expect(calls.map((c) => c.body.length)).toEqual([3, 1]);
    now += 31_000; // past the 30 s TTL
    await proxyRpc(body(pinnedCall), opts);
    expect(calls).toHaveLength(3);
    await proxyRpc(body(req(4, "eth_getBalance", ["0x01", "0x10"])), opts);
    await proxyRpc(body(req(4, "eth_getBalance", ["0x01", "0x10"])), opts);
    expect(calls).toHaveLength(5);
    expect(cacheTtl("eth_getLogs", [{ fromBlock: "0x1", toBlock: "latest" }])).toBe(0);
    expect(cacheTtl("eth_getLogs", [{ blockHash: "0xabc" }])).toBeGreaterThan(0);
    expect(cacheTtl("eth_call", [{}, { blockHash: "0xabc" }])).toBeGreaterThan(0);
    expect(cacheTtl("eth_call", [{}])).toBe(0);
    expect(cacheTtl("eth_blockNumber", [])).toBe(0);
  });

  test("scrubs the key from anything relayed back", async () => {
    pure();
    const { fetchFn } = upstream(() => ({
      error: { code: -32000, message: `invalid key ${KEY} for this network` },
    }));
    const r = await proxyRpc(body(req(1, "eth_blockNumber")), {
      upstreams: [ALCHEMY],
      fetch: fetchFn,
      secrets: [KEY],
    });
    expect(JSON.stringify(r.body)).not.toContain(KEY);
    expect((r.body as RpcResponse).error?.message).toBe("invalid key *** for this network");
  });
});

test.describe("/api/rpc route", () => {
  test.beforeEach(() => pure());

  test("reports its provider and refuses unknown chains", async ({ request }) => {
    const res = await request.get("/api/rpc/46630");
    expect(res.status()).toBe(200);
    const status = (await res.json()) as { chainId: number; provider: string };
    expect(status.chainId).toBe(46630);
    // CI builds have no ALCHEMY_API_KEY; with one, the route says alchemy.
    expect(["alchemy", "public"]).toContain(status.provider);
    expect(JSON.stringify(status)).not.toMatch(/alchemy\.com|Bearer/);
    for (const path of ["/api/rpc/1", "/api/rpc/31337", "/api/rpc/abc", "/api/rpc/46630.5"]) {
      expect((await request.get(path)).status(), path).toBe(404);
      expect((await request.post(path, { data: req(1, "eth_chainId") })).status(), path).toBe(404);
    }
  });

  test("refuses sends and oversized bodies, without CORS headers", async ({ request }) => {
    const send = await request.post("/api/rpc/46630", { data: req(1, "eth_sendRawTransaction", ["0x02"]) });
    expect(send.status()).toBe(200);
    expect(((await send.json()) as RpcResponse).error?.code).toBe(-32601);
    expect(send.headers()["access-control-allow-origin"]).toBeUndefined();
    expect(send.headers()["cache-control"]).toBe("no-store");
    const big = await request.post("/api/rpc/46630", {
      headers: { "Content-Type": "application/json" },
      data: body(req(1, "eth_call", [{ data: `0x${"00".repeat(MAX_BODY_BYTES)}` }, "latest"])),
    });
    expect(big.status()).toBe(413);
  });

  test("answers a live batch for each chain", async ({ request }) => {
    for (const [id, hex] of [
      [46630, "0xb626"],
      [421614, "0x66eee"],
      [4663, "0x1237"],
    ] as const) {
      const res = await request.post(`/api/rpc/${id}`, {
        data: [req(1, "eth_chainId"), req("b", "eth_blockNumber")],
        timeout: 60_000,
      });
      expect(res.status()).toBe(200);
      const [chain, block] = (await res.json()) as RpcResponse[];
      // A public RPC may rate-limit CI; a refusal must still be a JSON-RPC error, never a leak or a crash.
      if (chain?.error || block?.error) {
        test
          .info()
          .annotations.push({ type: "rpc", description: `${id}: ${JSON.stringify([chain, block])}` });
        continue;
      }
      expect(chain).toEqual({ jsonrpc: "2.0", id: 1, result: hex });
      expect(Number(block!.result)).toBeGreaterThan(0);
      expect(["alchemy", "public", "alchemy+public", "public+cache", "alchemy+cache", "cache"]).toContain(
        res.headers()["x-strike-rpc"],
      );
    }
  });
});
