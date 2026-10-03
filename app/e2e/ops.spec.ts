import { expect, test } from "@playwright/test";

// Operations: a liveness route that touches nothing external, and the security headers every response carries.

test.skip(({ isMobile }) => isMobile, "HTTP checks run once, on desktop");

test("GET /api/health answers without reading a chain", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.status()).toBe(200);
  expect(res.headers()["cache-control"]).toBe("no-store");
  const body = (await res.json()) as { ok: boolean; service: string; commit: string | null; time: string };
  expect(body.ok).toBe(true);
  expect(body.service).toBe("strike-app");
  expect(Math.abs(Date.parse(body.time) - Date.now())).toBeLessThan(60_000);
});

test("pages and API routes send nosniff, a referrer policy and a permissions policy", async ({ request }) => {
  for (const path of ["/", "/app/lessons", "/api/health", "/llms.txt"]) {
    const h = (await request.get(path)).headers();
    expect(h["x-content-type-options"], path).toBe("nosniff");
    expect(h["referrer-policy"], path).toBe("strict-origin-when-cross-origin");
    expect(h["permissions-policy"], path).toContain("camera=()");
  }
});
