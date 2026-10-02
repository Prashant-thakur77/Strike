import type dns from "node:dns";
import { describe, expect, it } from "vitest";
import { cachingLookup, createRpcFetch } from "../src/net.js";

const ADDRS: dns.LookupAddress[] = [
  { address: "2606:4700::1", family: 6 },
  { address: "104.20.46.209", family: 4 },
];

function counting(fail = false) {
  const calls: string[] = [];
  const lookupAll = (host: string, cb: (err: Error | null, a: dns.LookupAddress[]) => void) => {
    calls.push(host);
    setTimeout(() => (fail ? cb(new Error("getaddrinfo EAI_AGAIN"), []) : cb(null, ADDRS)), 20);
  };
  return { calls, lookupAll };
}

const call = (lookup: ReturnType<typeof cachingLookup>, opts: dns.LookupOptions) =>
  new Promise<{ err: Error | null; address: unknown; family?: number }>((resolve) =>
    lookup("rpc.example", opts, (err, address, family) => resolve({ err, address, family })),
  );

describe("RPC DNS cache", () => {
  it("looks a host up once for a burst of connections, then serves the cache", async () => {
    const c = counting();
    const lookup = cachingLookup({ lookupAll: c.lookupAll });
    const burst = await Promise.all(Array.from({ length: 16 }, () => call(lookup, { all: true })));
    expect(c.calls).toHaveLength(1);
    for (const r of burst) expect(r.address).toEqual(ADDRS);
    await call(lookup, { all: true });
    expect(c.calls).toHaveLength(1);
  });

  it("answers the single-address form and filters by family", async () => {
    const lookup = cachingLookup({ lookupAll: counting().lookupAll });
    expect(await call(lookup, {})).toEqual({ err: null, address: "2606:4700::1", family: 6 });
    expect(await call(lookup, { family: 4 })).toEqual({ err: null, address: "104.20.46.209", family: 4 });
    expect((await call(lookup, { family: 4, all: true })).address).toEqual([ADDRS[1]]);
  });

  it("expires entries and never caches a failure", async () => {
    const bad = counting(true);
    const failing = cachingLookup({ lookupAll: bad.lookupAll });
    expect((await call(failing, {})).err?.message).toContain("EAI_AGAIN");
    expect((await call(failing, {})).err).toBeTruthy();
    expect(bad.calls).toHaveLength(2);

    const c = counting();
    const short = cachingLookup({ lookupAll: c.lookupAll, ttlMs: 10 });
    await call(short, {});
    await new Promise((r) => setTimeout(r, 30));
    await call(short, {});
    expect(c.calls).toHaveLength(2);
  });

  it("fetches through the pooled agent", async () => {
    const { createServer } = await import("node:http");
    const srv = createServer((_req, res) => res.end('{"jsonrpc":"2.0","id":1,"result":"0x1"}'));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    try {
      const f = createRpcFetch();
      const res = await f(`http://localhost:${port}`, { method: "POST", body: "{}" });
      expect(await res.json()).toEqual({ jsonrpc: "2.0", id: 1, result: "0x1" });
    } finally {
      srv.closeAllConnections();
      await new Promise((r) => srv.close(r));
    }
  });
});
