import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Settings } from "../src/config.js";
import { IndexerService } from "../src/service.js";
import type { StateReader } from "../src/tvl.js";
import { Writer } from "../src/writer.js";
import {
  FakeChain,
  POPULATED_EVENTS,
  SERIES_ID,
  addrs,
  chainSpec,
  deploymentSpec,
  freshDb,
  populate,
  silent,
} from "./helpers.js";

const settings = (databaseUrl: string, over: Partial<Settings> = {}): Settings => ({
  databaseUrl,
  host: "127.0.0.1",
  port: 0,
  confirmations: 5n,
  pollIntervalMs: 50,
  maxRange: 10_000n,
  readyMaxLagBlocks: 100,
  readyMaxHeadAgeSeconds: 60,
  tvlIntervalMs: 0,
  chains: [],
  logLevel: "silent",
  shutdownTimeoutMs: 5000,
  poolMax: 4,
  rateLimitMax: 0,
  rateLimitWindowMs: 60_000,
  trustProxy: false,
  ...over,
});

const state: StateReader = {
  usdgDecimals: async () => 6,
  vaultValue: async () => ({
    blockNumber: 1n,
    isCall: false,
    totalAssets: 1n,
    assetDecimals: 6,
    spotPrice: null,
    tvlUsd: 1,
  }),
};

describe("HTTP API", () => {
  let db: Awaited<ReturnType<typeof freshDb>>;
  let svc: IndexerService;
  const fake = new FakeChain(46630, 1100n);
  const a = addrs("api");
  populate(fake, a, 1000n);
  const spec = {
    source: "test",
    root: "/",
    chains: [chainSpec(46630, [deploymentSpec(46630, "v3", a, 1000n)])],
  };

  beforeAll(async () => {
    db = await freshDb();
    svc = new IndexerService({
      settings: settings(db.url),
      spec,
      log: silent,
      readers: new Map([[46630, fake]]),
      states: new Map([[46630, state]]),
      retryBaseDelayMs: 1,
    });
    await svc.migrate();
  });
  afterAll(async () => {
    await svc.stop("test done");
    await db.drop();
  });

  it("GET /health answers without the database and echoes a request id", async () => {
    const r = await svc.api.inject({ method: "GET", url: "/health", headers: { "x-request-id": "req-123" } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: "ok", writer: false });
    expect(r.headers["x-request-id"]).toBe("req-123");
    const g = await svc.api.inject({
      method: "GET",
      url: "/health",
      headers: { "x-request-id": "bad id with spaces" },
    });
    expect(g.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("GET /ready is 503 before the first head is read", async () => {
    const r = await svc.api.inject({ method: "GET", url: "/ready" });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({
      ready: false,
      db: { ok: true },
      chains: [{ chainId: 46630, ok: false }],
    });
  });

  it("GET /ready reports each chain's lag, and is 200 within the threshold", async () => {
    expect(await svc.ensureWriter()).toBe(true);
    await svc.round();
    const r = await svc.api.inject({ method: "GET", url: "/ready" });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({ ready: true, writer: true, db: { ok: true } });
    expect(body.chains[0]).toMatchObject({
      chainId: 46630,
      ok: true,
      headBlock: 1100,
      lagBlocks: 5,
      maxLagBlocks: 100,
      deployments: [{ id: "46630-v3", lastIndexedBlock: 1095, lagBlocks: 5 }],
    });
    expect(body.chains[0].headAgeSeconds).toBeLessThan(5);
  });

  it("GET /ready is 503 with the numbers when a chain falls behind", async () => {
    fake.head = 1500n;
    fake.failNext = 100; // the RPC stops answering getLogs: the head moves, the cursor does not
    await svc.round();
    const r = await svc.api.inject({ method: "GET", url: "/ready" });
    expect(r.statusCode).toBe(503);
    const c = r.json().chains[0];
    expect(c).toMatchObject({
      ok: false,
      headBlock: 1500,
      lagBlocks: 405,
      lastError: expect.stringContaining("socket hang up"),
    });
    expect(c.reasons).toEqual(["lag 405 > 100 blocks"]);
    fake.failNext = 0;
    await svc.round();
    const ok = await svc.api.inject({ method: "GET", url: "/ready" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().chains[0]).toMatchObject({ lagBlocks: 5, lastError: null });
  });

  it("GET /events pages through every event, newest first, without repeats", async () => {
    const seen: string[] = [];
    const times: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `/events?limit=7${cursor ? `&cursor=${cursor}` : ""}`;
      const r = await svc.api.inject({ method: "GET", url });
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body.events.length).toBeLessThanOrEqual(7);
      for (const e of body.events) {
        seen.push(`${e.txHash}:${e.logIndex}`);
        times.push(Date.parse(e.blockTime) * 1e4 + e.logIndex);
      }
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(Math.ceil(POPULATED_EVENTS / 7));
    expect(seen).toHaveLength(POPULATED_EVENTS);
    expect(new Set(seen).size).toBe(POPULATED_EVENTS);
    expect([...times].sort((x, y) => y - x)).toEqual(times);
  });

  it("GET /events filters by type, vault and chain", async () => {
    const buys = (await svc.api.inject({ method: "GET", url: "/events?type=OptionsBought" })).json();
    expect(buys.events).toHaveLength(1);
    expect(buys.events[0]).toMatchObject({
      event: "OptionsBought",
      args: { seriesId: SERIES_ID.toString() },
    });
    const two = (
      await svc.api.inject({ method: "GET", url: "/events?type=EpochOpened,EpochAborted" })
    ).json();
    expect(two.events.map((e: { event: string }) => e.event).sort()).toEqual([
      "EpochAborted",
      "EpochOpened",
      "EpochOpened",
    ]);
    const put = (await svc.api.inject({ method: "GET", url: `/events?vault=${a.putVault}` })).json();
    // Emitted by the put vault (deposit, request, withdrawal) or naming it (created, opened, rejected, aborted).
    expect(put.events).toHaveLength(7);
    const none = (await svc.api.inject({ method: "GET", url: "/events?chain=421614" })).json();
    expect(none).toEqual({ events: [], nextCursor: null });
  });

  it("GET /events refuses bad parameters with 400", async () => {
    for (const q of [
      "limit=0",
      "limit=501",
      "vault=0x123",
      "cursor=nope",
      "type=DROP%20TABLE",
      "chain=abc",
      "deployment=x",
    ]) {
      const r = await svc.api.inject({ method: "GET", url: `/events?${q}` });
      expect(r.statusCode, q).toBe(400);
      expect(r.json().error).toBeTruthy();
    }
  });

  it("GET /agents and GET /epochs read the derived views", async () => {
    const agents = (await svc.api.inject({ method: "GET", url: "/agents" })).json().agents;
    expect(agents).toEqual([
      expect.objectContaining({
        deployment: "46630-v3",
        agentId: "1",
        erc8004Id: "114",
        bonded: "60000000",
        slashed: "10000000",
        proposalsAccepted: 1,
        proposalsRejected: 1,
        decisionRecords: 1,
      }),
    ]);
    const epochs = (await svc.api.inject({ method: "GET", url: "/epochs" })).json().epochs;
    expect(epochs.map((e: { state: string }) => e.state).sort()).toEqual(["aborted", "settled"]);
    const settled = (await svc.api.inject({ method: "GET", url: "/epochs?state=settled" })).json().epochs;
    expect(settled).toEqual([
      expect.objectContaining({
        vault: a.callVault.toLowerCase(),
        epoch: 1,
        seriesId: SERIES_ID.toString(),
        settlementPrice: "380000000000000000000",
      }),
    ]);
    expect((await svc.api.inject({ method: "GET", url: "/epochs?state=weird" })).statusCode).toBe(400);
  });

  it("GET /stats has the app's /api/stats shape", async () => {
    const r = await svc.api.inject({ method: "GET", url: "/stats" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["access-control-allow-origin"]).toBe("*");
    const s = r.json();
    expect(Object.keys(s).sort()).toEqual([
      "deployments",
      "errors",
      "generatedAt",
      "indexer",
      "outside",
      "total",
    ]);
    expect(s.deployments[0]).toMatchObject({
      key: "46630-v3",
      fromBlock: 1000,
      toBlock: 1495,
      buys: 1,
      vaults: 2,
    });
  });
});

describe("service lifecycle", () => {
  it("serves HTTP, then stops on request: API closed, writer lock released", async () => {
    const db = await freshDb();
    const fake = new FakeChain(46630, 1100n);
    const a = addrs("life");
    populate(fake, a, 1000n);
    const spec = {
      source: "test",
      root: "/",
      chains: [chainSpec(46630, [deploymentSpec(46630, "v3", a, 1000n)])],
    };
    const svc = new IndexerService({
      settings: settings(db.url),
      spec,
      log: silent,
      readers: new Map([[46630, fake]]),
      states: new Map([[46630, state]]),
    });
    const address = await svc.start();
    expect(address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    // The loop takes the lock and indexes.
    for (let i = 0; i < 100 && !(await fetch(`${address}/ready`)).ok; i++)
      await new Promise((r) => setTimeout(r, 50));
    expect((await fetch(`${address}/ready`)).status).toBe(200);
    expect(svc.writer.held).toBe(true);

    // A second instance on the same database stays a reader.
    const other = new Writer(db.url, silent);
    expect(await other.acquire()).toBe(false);

    await svc.stop("SIGTERM");
    await expect(fetch(`${address}/health`)).rejects.toThrow();
    expect(await other.acquire()).toBe(true);
    await other.release();
    await db.drop();
  });
});
