import type pg from "pg";
import { describe, expect, it } from "vitest";
import { buildApi } from "../src/api.js";
import { settingsFromEnv } from "../src/config.js";
import { RateLimiter } from "../src/rate-limit.js";
import { silent } from "./helpers.js";

describe("RateLimiter", () => {
  it("allows `max` requests per window per client, then refuses with the seconds left", () => {
    let t = 1_000_000;
    const rl = new RateLimiter({ max: 3, windowMs: 60_000, now: () => t });
    expect([1, 2, 3].map(() => rl.take("a").allowed)).toEqual([true, true, true]);
    const refused = rl.take("a");
    expect(refused).toMatchObject({ allowed: false, remaining: 0, retryAfterSeconds: 60 });
    t += 45_500;
    expect(rl.take("a").retryAfterSeconds).toBe(15);
    // another client has its own window
    expect(rl.take("b")).toMatchObject({ allowed: true, remaining: 2 });
    // the window ends, the count starts again
    t += 14_500;
    expect(rl.take("a")).toMatchObject({ allowed: true, remaining: 2 });
  });

  it("stays bounded: expired windows are swept and the oldest go first past maxClients", () => {
    let t = 0;
    const rl = new RateLimiter({ max: 1, windowMs: 1000, maxClients: 3, now: () => t });
    for (const k of ["a", "b", "c", "d", "e"]) rl.take(k);
    expect(rl.size).toBe(3);
    // "a" and "b" were evicted, so they start fresh; "e" is still counted
    expect(rl.take("e").allowed).toBe(false);
    t = 5000;
    rl.take("f");
    expect(rl.size).toBe(1);
  });

  it("is off when max is 0", () => {
    expect(new RateLimiter({ max: 0, windowMs: 1000 }).enabled).toBe(false);
  });
});

describe("HTTP API rate limit", () => {
  const fakePool = () => {
    const calls: string[] = [];
    const pool = {
      query: async (sql: string) => {
        calls.push(sql);
        return { rows: [] };
      },
    } as unknown as pg.Pool;
    return { pool, calls };
  };
  const api = (over: Partial<Parameters<typeof buildApi>[0]> = {}) => {
    const { pool, calls } = fakePool();
    const app = buildApi({
      pool,
      log: silent,
      chains: [46630],
      readyMaxLagBlocks: 100,
      readyMaxHeadAgeSeconds: 60,
      isWriter: () => false,
      rateLimitMax: 2,
      rateLimitWindowMs: 60_000,
      ...over,
    });
    return { app, calls };
  };

  it("answers 429 with Retry-After before touching the database, and leaves /health alone", async () => {
    const { app, calls } = api();
    const get = (url: string, remoteAddress = "10.0.0.1") =>
      app.inject({ method: "GET", url, remoteAddress });
    expect((await get("/ready")).statusCode).toBe(503); // not ready (no head yet), but served
    expect((await get("/agents")).statusCode).toBe(200);
    const queriesSoFar = calls.length;
    const refused = await get("/ready");
    expect(refused.statusCode).toBe(429);
    expect(refused.headers["retry-after"]).toBe("60");
    expect(refused.headers["ratelimit-remaining"]).toBe("0");
    expect(refused.json()).toMatchObject({ error: expect.stringContaining("rate limit exceeded") });
    expect(refused.headers["x-request-id"]).toBeTruthy();
    expect(calls.length).toBe(queriesSoFar);
    // every data route is limited, /health never is
    expect((await get("/events")).statusCode).toBe(429);
    for (let i = 0; i < 5; i++) expect((await get("/health")).statusCode).toBe(200);
    // another client is unaffected
    expect((await get("/agents", "10.0.0.2")).statusCode).toBe(200);
    await app.close();
  });

  it("counts the forwarded address only with trustProxy", async () => {
    const forwarded = (app: ReturnType<typeof api>["app"], ip: string) =>
      app.inject({
        method: "GET",
        url: "/agents",
        remoteAddress: "10.9.9.9",
        headers: { "x-forwarded-for": ip },
      });
    const direct = api();
    for (const ip of ["1.1.1.1", "1.1.1.2", "1.1.1.3"]) {
      // all three look like one client (the proxy), so the third is refused
      const r = await forwarded(direct.app, ip);
      expect(r.statusCode).toBe(ip === "1.1.1.3" ? 429 : 200);
    }
    const proxied = api({ trustProxy: true });
    for (const ip of ["1.1.1.1", "1.1.1.2", "1.1.1.3"]) {
      expect((await forwarded(proxied.app, ip)).statusCode).toBe(200);
    }
    await direct.app.close();
    await proxied.app.close();
  });

  it("is configured by the environment and can be turned off", async () => {
    expect(settingsFromEnv({})).toMatchObject({
      rateLimitMax: 120,
      rateLimitWindowMs: 60_000,
      trustProxy: false,
    });
    expect(
      settingsFromEnv({ RATE_LIMIT_MAX: "5", RATE_LIMIT_WINDOW_SECONDS: "10", TRUST_PROXY: "true" }),
    ).toMatchObject({ rateLimitMax: 5, rateLimitWindowMs: 10_000, trustProxy: true });
    expect(() => settingsFromEnv({ RATE_LIMIT_MAX: "-1" })).toThrow("invalid RATE_LIMIT_MAX");
    expect(() => settingsFromEnv({ TRUST_PROXY: "yes" })).toThrow("invalid TRUST_PROXY");
    const { app } = api({ rateLimitMax: 0 });
    for (let i = 0; i < 10; i++)
      expect((await app.inject({ method: "GET", url: "/agents" })).statusCode).toBe(200);
    await app.close();
  });
});
