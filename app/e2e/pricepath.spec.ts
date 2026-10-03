import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { parseRecordText } from "../src/lib/agentLog";
import { decisionInputs } from "../src/lib/decision";
import { oneSigmaRange, priceAt, pricePath, type AuditRound } from "../src/lib/pricePath";
import { acknowledge, horizontalOverflow } from "./helpers";

// The decision page's price path: the feed's rounds around the epoch from /api/mirror-audit (here a saved answer for
// Robinhood Chain testnet's TSLA feed, 3 October), with the strike, the break-even and the model's one-sigma range.

const REPO = join(__dirname, "..", "..");
const RAW = "https://raw.githubusercontent.com/Prashant-thakur77/Strike/main/";
const AUDIT = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "decision", "mirror-audit-46630.json"), "utf8"),
) as {
  feeds: { symbol: string; rounds: AuditRound[] }[];
};
const ROUNDS = AUDIT.feeds[0]!.rounds;
const A2 = "2026-10-02-sTSLA-CSP-A2";
const record = parseRecordText(readFileSync(join(REPO, "docs/agent-log", `${A2}.json`), "utf8"))!;

test.describe("price path logic", () => {
  test.skip(({ isMobile }) => isMobile, "pure logic runs once, on desktop");

  test("the window runs from a day before the epoch to three days after expiry, without deploy seeds", () => {
    const inp = decisionInputs(record);
    if ("missing" in inp) throw new Error(inp.missing);
    const path = pricePath(ROUNDS, inp.openedAt, inp.expiry);
    expect(path.points.length).toBeGreaterThan(0);
    for (const p of path.points) {
      expect(p.t).toBeGreaterThanOrEqual(inp.openedAt - 86_400);
      expect(p.t).toBeLessThanOrEqual(inp.expiry + 3 * 86_400);
      expect(p.status).not.toBe("deploy-seed");
    }
    expect(path.points.map((p) => p.t)).toEqual([...path.points.map((p) => p.t)].sort((a, b) => a - b));
    expect(path.unmatched).toBe(path.points.filter((p) => p.status !== "match").length);
    // The epoch-open snapshot is a round the feed carried.
    const atOpen = priceAt(path.points, inp.openedAt);
    expect(atOpen).not.toBeNull();
  });

  test("the one-sigma range is spot × e^(±σ√T)", () => {
    const r = oneSigmaRange(372.61, 0.6, 7 * 86_400);
    const s = 0.6 * Math.sqrt((7 * 86_400) / 31_536_000);
    expect(r.low).toBeCloseTo(372.61 * Math.exp(-s), 9);
    expect(r.high).toBeCloseTo(372.61 * Math.exp(s), 9);
    expect(priceAt([], 1)).toBeNull();
  });
});

async function open(page: Page, audit: "fixture" | "error") {
  await acknowledge(page);
  await page.route(`${RAW}**`, (route) => {
    const rel = decodeURIComponent(new URL(route.request().url()).pathname.split("/main/")[1] ?? "");
    try {
      return route.fulfill({
        status: 200,
        body: readFileSync(join(REPO, rel), "utf8"),
        contentType: "text/plain",
      });
    } catch {
      return route.fulfill({ status: 404, body: "404: Not Found" });
    }
  });
  await page.route("**/api/epoch-trace?**", (route) => route.abort());
  await page.route("**/api/mirror-audit?**", (route) =>
    audit === "fixture"
      ? route.fulfill({ json: AUDIT })
      : route.fulfill({ status: 502, json: { error: "Robinhood Chain testnet RPC unreachable" } }),
  );
  await page.goto(`/app/decision/46630/${A2}`);
  await expect(page.getByTestId("decision-page")).toBeVisible({ timeout: 60_000 });
}

test("decision page: the price path with every round in the window, and a table view", async ({ page }) => {
  await open(page, "fixture");
  const inp = decisionInputs(record);
  if ("missing" in inp) throw new Error(inp.missing);
  const n = pricePath(ROUNDS, inp.openedAt, inp.expiry).points.length;
  const chart = page.getByTestId("price-path");
  await expect(chart).toHaveAttribute("data-rounds", String(n));
  await expect(chart).toContainText("Strike $342.91");
  await expect(chart).toContainText("not a forecast");
  await chart.getByText("Show as a table").click();
  await expect(chart.getByTestId("price-path-row")).toHaveCount(n);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});

test("decision page: when the audit cannot be read, the price path says so", async ({ page }) => {
  await open(page, "error");
  await expect(page.getByTestId("price-path-error")).toContainText("RPC unreachable");
});
