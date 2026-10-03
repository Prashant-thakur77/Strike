import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";
import { normCdf as sdkNormCdf } from "../../sdk/src/pricing";
import { parseRecordText, type LogEntry } from "../src/lib/agentLog";
import {
  HEALTH_LABEL,
  filterLog,
  healthAlerts,
  logFilterCounts,
  noTradeCounts,
  noTrades,
  normCdf,
  rankStanding,
  REVIEW_MIN_SETTLED,
  reviewRecommendation,
  sampleVerdict,
  weekOf,
  weeklyReview,
  seriesHealth,
  type AgentStanding,
  type SeriesInput,
} from "../src/lib/agentHealth";
import { acknowledge, horizontalOverflow } from "./helpers";

// The agents page's live series health and alerts, performance with its sample-size statement, and the runs that
// sold nothing. First the logic on hand-made series and the committed records, then the page: its chain reads are
// live (any state of the week), and GitHub's listing is answered from this checkout's docs/agent-log.

const REPO = join(__dirname, "..", "..");
const LOG = join(REPO, "docs", "agent-log");
const API = "https://api.github.com/repos/Prashant-thakur77/Strike/contents/docs/agent-log?ref=main";
const RAW = "https://raw.githubusercontent.com/Prashant-thakur77/Strike/main/docs/agent-log";
const BLOB = "https://github.com/Prashant-thakur77/Strike/blob/main/docs/agent-log";
const cors = { "access-control-allow-origin": "*" };

const NOW = 1_791_000_000;
const put = (over: Partial<SeriesInput> = {}): SeriesInput => ({
  vault: "0x0000000000000000000000000000000000000001",
  symbol: "sTSLA-CSP",
  underlying: "TSLA",
  isCall: false,
  agentId: 2,
  strike: 342.91,
  spot: 372.61,
  spotUpdatedAt: NOW - 600,
  feedStatus: 0,
  expiry: NOW + 5 * 86_400,
  now: NOW,
  sold: 2,
  premium: 5.42,
  sigma: 0.6,
  settled: false,
  cancelled: false,
  ...over,
});

const committed = (): LogEntry[] =>
  readdirSync(LOG)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({
      name: f.replace(/\.json$/, ""),
      record: parseRecordText(readFileSync(join(LOG, f), "utf8"))!,
      recordUrl: `${BLOB}/${f}`,
    }));

test.describe("health logic", () => {
  test.skip(({ isMobile }) => isMobile, "pure logic runs once, on desktop");

  test("a put out of the money, near the strike, in the money and past its break-even", () => {
    const out = seriesHealth(put());
    expect(out.state).toBe("out");
    expect(out.cushion).toBeCloseTo(1 - 342.91 / 372.61, 12);
    expect(out.breakEven).toBeCloseTo(342.91 - 5.42 / 2, 12);
    expect(out.intrinsic).toBe(0);
    expect(out.markNet).toBeCloseTo(-5.42, 12);
    expect(seriesHealth(put({ spot: 348 })).state).toBe("near");
    const itm = seriesHealth(put({ spot: 341 }));
    expect(itm.state).toBe("in");
    expect(itm.intrinsic).toBeCloseTo(1.91, 12);
    expect(itm.breakEvenCushion!).toBeGreaterThan(0); // 341 is above the 340.20 break-even
    const deep = seriesHealth(put({ spot: 330 }));
    expect(deep.breakEvenCushion!).toBeLessThan(0);
    expect(deep.markNet).toBeCloseTo(12.91 * 2 - 5.42, 9);
  });

  test("a call mirrors it, and expired, unsold and stale series say so", () => {
    const call = seriesHealth(put({ isCall: true, strike: 369.86, spot: 358.55 }));
    expect(call.state).toBe("out");
    expect(call.cushion).toBeCloseTo(369.86 / 358.55 - 1, 12);
    expect(call.breakEven).toBeCloseTo(369.86 + 2.71, 12);
    expect(seriesHealth(put({ isCall: true, strike: 369.86, spot: 375 })).state).toBe("in");
    expect(seriesHealth(put({ expiry: NOW - 60 })).state).toBe("expired");
    expect(seriesHealth(put({ expiry: NOW - 60 })).oddsItm).toBeNull();
    const unsold = seriesHealth(put({ sold: 0, premium: 0 }));
    expect([unsold.state, unsold.breakEven]).toEqual(["unsold", null]);
    expect(seriesHealth(put({ spotUpdatedAt: NOW - 26 * 3600 })).feedStale).toBe(true);
    expect(seriesHealth(put({ feedStatus: 3 })).feedStale).toBe(true);
    for (const st of ["out", "near", "in", "expired", "unsold"] as const)
      expect(HEALTH_LABEL[st]).toBeTruthy();
  });

  test("the model's odds use the same normal CDF as the SDK's pricer", () => {
    for (const x of [-3, -1.2, -0.3, 0, 0.4, 1.7, 2.9]) expect(normCdf(x)).toBeCloseTo(sdkNormCdf(x), 6);
    const h = seriesHealth(put());
    const vol = 0.6 * Math.sqrt((5 * 86_400) / 31_536_000);
    const d2 = (Math.log(372.61 / 342.91) - (vol * vol) / 2) / vol;
    expect(h.oddsItm!).toBeCloseTo(sdkNormCdf(-d2), 6);
  });

  test("alerts: past break-even first, then near, stale and an agent one strike from suspension", () => {
    const agents: AgentStanding[] = [
      {
        id: 1,
        label: "Agent 1",
        status: 1,
        strikes: 2,
        maxStrikes: 3,
        accepted: 1,
        rejected: 2,
        settledEpochs: 0,
        pnl: 0,
      },
      {
        id: 3,
        label: "Agent 3",
        status: 2,
        strikes: 3,
        maxStrikes: 3,
        accepted: 0,
        rejected: 3,
        settledEpochs: 0,
        pnl: 0,
      },
    ];
    const a = healthAlerts(
      [
        seriesHealth(put({ spot: 348 })),
        seriesHealth(put({ spot: 330, vault: "0x02" })),
        seriesHealth(put({ spotUpdatedAt: NOW - 30 * 3600, vault: "0x03" })),
        seriesHealth(put({ vault: "0x04" })),
      ],
      agents,
    );
    expect(a.map((x) => x.level)).toEqual(["alert", "alert", "watch", "watch", "watch"]);
    expect(a[0]!.text).toContain("past the $340.20 break-even");
    expect(a.some((x) => x.text.includes("one more rejected proposal suspends it"))).toBe(true);
    expect(a.some((x) => x.text.includes("30 h old"))).toBe(true);
    const expired = healthAlerts([seriesHealth(put({ expiry: NOW - 60, spot: 340 }))]);
    expect(expired[0]!.text).toContain(
      "is in the money against the $342.91 strike, but it is not the settlement price",
    );
    expect(healthAlerts([seriesHealth(put())], [])).toEqual([]);
  });

  test("performance: what a sample can say, and agents with settled epochs rank by PnL", () => {
    expect(sampleVerdict(0).level).toBe("none");
    expect(sampleVerdict(1).text).toContain("too few to tell skill from luck");
    expect(sampleVerdict(7).level).toBe("preliminary");
    expect(sampleVerdict(25).level).toBe("small");
    const base = { label: "", status: 1, strikes: 0, maxStrikes: 3 };
    const list: AgentStanding[] = [
      { ...base, id: 1, accepted: 5, rejected: 0, settledEpochs: 0, pnl: 0 },
      { ...base, id: 2, accepted: 1, rejected: 0, settledEpochs: 1, pnl: -3 },
      { ...base, id: 3, accepted: 1, rejected: 1, settledEpochs: 2, pnl: 4 },
    ];
    expect([...list].sort(rankStanding).map((x) => x.id)).toEqual([3, 2, 1]);
  });

  test("runs that sold nothing: every committed record that is not accepted or settled", () => {
    const entries = committed();
    const list = noTrades(entries);
    const expected = entries.filter((e) => !["accepted", "settled"].includes(e.record.result.status));
    expect(list).toHaveLength(expected.length);
    const c = noTradeCounts(list);
    expect(c.rejected + c["not-sent"] + c.skipped + c.failed).toBe(list.length);
    expect(list.find((n) => n.entry.name === "2026-10-01-sTSLA-CSP")!.kind).toBe("rejected");
    for (const n of list) expect(n.why.length).toBeGreaterThan(10);
  });
});

test.describe("week by week", () => {
  test.skip(({ isMobile }) => isMobile, "pure logic runs once, on desktop");

  test("weeks start on Monday; the committed records add up; no recommendation below five settled epochs", () => {
    expect(weekOf("2026-10-01")).toBe("2026-09-28");
    expect(weekOf("2026-10-04")).toBe("2026-09-28");
    expect(weekOf("2026-10-05")).toBe("2026-10-05");
    const entries = committed();
    const weeks = weeklyReview(entries);
    const sum = (k: "proposals" | "settled" | "waitingOrStopped") => weeks.reduce((n, w) => n + w[k], 0);
    expect(sum("proposals")).toBe(entries.filter((e) => e.record.action !== "settle").length);
    expect(sum("settled")).toBe(entries.filter((e) => e.record.result.status === "settled").length);
    expect(sum("proposals") + sum("settled") + sum("waitingOrStopped")).toBeGreaterThanOrEqual(
      entries.length,
    );
    const first = weeks.find((w) => w.week === "2026-09-28")!;
    expect(first.rejected).toBeGreaterThanOrEqual(1);
    expect(first.slashedUsdg).toBeGreaterThanOrEqual(10);
    expect(first.accepted).toBeGreaterThanOrEqual(2);
    expect(reviewRecommendation(0)).toMatch(/^No recommendation: 0 settled epochs/);
    expect(reviewRecommendation(REVIEW_MIN_SETTLED)).not.toMatch(/^No recommendation/);
  });
});

test.describe("decision log filter", () => {
  test.skip(({ isMobile }) => isMobile, "pure logic runs once, on desktop");

  test("kinds partition the committed records, and text narrows by vault, date or summary", () => {
    const entries = committed();
    const c = logFilterCounts(entries);
    expect(c.all).toBe(entries.length);
    expect(c.proposals + c.settlements).toBe(c.all);
    expect(filterLog(entries, "proposals").every((e) => e.record.action !== "settle")).toBe(true);
    expect(filterLog(entries, "nothing")).toHaveLength(noTrades(entries).length);
    const a2 = filterLog(entries, "all", "csp-a2");
    expect(a2.length).toBeGreaterThan(0);
    expect(a2.every((e) => e.record.vault.symbol === "sTSLA-CSP-A2")).toBe(true);
    expect(filterLog(entries, "proposals", "DeltaOutOfBand").map((e) => e.name)).toContain(
      "2026-10-01-sTSLA-CSP",
    );
    expect(filterLog(entries, "all", "no such text anywhere")).toEqual([]);
  });
});

/* ================================================================ the page */

async function serveLog(page: Page) {
  const files = readdirSync(LOG).filter((f) => f.endsWith(".json") || f.endsWith(".md"));
  await page.route(`${API}*`, (route: Route) =>
    route.fulfill({
      status: 200,
      headers: cors,
      contentType: "application/json",
      body: JSON.stringify(
        files.map((name) => ({
          name,
          path: `docs/agent-log/${name}`,
          type: "file",
          download_url: `${RAW}/${name}`,
          html_url: `${BLOB}/${name}`,
        })),
      ),
    }),
  );
  await page.route(`${RAW}/**`, (route: Route) => {
    const name = decodeURIComponent(
      route
        .request()
        .url()
        .slice(RAW.length + 1),
    );
    try {
      return route.fulfill({
        status: 200,
        headers: cors,
        contentType: "text/plain",
        body: readFileSync(join(LOG, name), "utf8"),
      });
    } catch {
      return route.fulfill({ status: 404, headers: cors, body: "404: Not Found" });
    }
  });
}

test("agents page: live series health with alerts, performance and the runs that sold nothing", async ({
  page,
}) => {
  await acknowledge(page);
  await serveLog(page);
  await page.goto("/app/agents?chain=46630");
  // Live health: rows in any state of the week, or the empty state; each row's label matches its state.
  const health = page.getByTestId("health").or(page.getByTestId("health-error"));
  await expect(health).toBeVisible({ timeout: 90_000 });
  const rows = page.getByTestId("health-row");
  for (let i = 0; i < (await rows.count()); i++) {
    const st = (await rows.nth(i).getAttribute("data-state")) as keyof typeof HEALTH_LABEL;
    await expect(rows.nth(i)).toContainText(HEALTH_LABEL[st]);
  }
  const alerts = page.getByTestId("alerts");
  if (await alerts.count()) {
    const n = Number(await alerts.getAttribute("data-count"));
    await expect(page.getByTestId("alert")).toHaveCount(n);
    if (n === 0) await expect(page.getByTestId("alerts-empty")).toBeVisible();
  }
  // Performance: the statement follows the settled epochs the registries report.
  const perf = page.getByTestId("performance");
  await expect(perf).toBeVisible({ timeout: 60_000 });
  const settled = Number(await perf.getAttribute("data-settled"));
  await expect(page.getByTestId("performance-verdict")).toContainText(sampleVerdict(settled).text);
  expect(await page.getByTestId("performance-row").count()).toBeGreaterThan(0);
  // The leaderboard's PnL column says "no settled epoch" rather than a zero dressed up as a result.
  if (settled === 0) await expect(page.getByTestId("leaderboard-pnl").first()).toHaveText("no settled epoch");
  // Runs that sold nothing, from the committed records.
  const nt = page.getByTestId("notrade");
  await expect(nt).toBeVisible({ timeout: 60_000 });
  const listed = Number(await nt.getAttribute("data-count"));
  const shown = Number(await nt.getAttribute("data-shown"));
  expect(listed).toBeGreaterThan(0);
  // Proposal runs first (the rejected 1 October run among them); settle runs that waited sit behind a toggle.
  await expect(page.getByTestId("notrade-row")).toHaveCount(shown);
  await expect(nt.locator('[data-kind="rejected"]').first()).toContainText("DeltaOutOfBand");
  if (listed > shown) {
    await page.getByTestId("notrade-settle-toggle").click();
    await expect(page.getByTestId("notrade-row")).toHaveCount(listed);
  }
  // Week by week: one row per week the records cover, and the recommendation follows the settled epochs.
  const weekly = page.getByTestId("weekly");
  await expect(weekly).toBeVisible();
  const logEntries = committed()
    .sort((a, b) => b.name.localeCompare(a.name))
    .slice(0, 24);
  await expect(page.getByTestId("weekly-row")).toHaveCount(weeklyReview(logEntries).length);
  await expect(page.getByTestId("weekly-recommendation")).toHaveText(reviewRecommendation(settled));
  // The decision log's filters: proposals only, then a text filter, then a filter that matches nothing.
  const entries = committed()
    .sort((a, b) => b.name.localeCompare(a.name))
    .slice(0, 24);
  const counts = logFilterCounts(entries);
  const log = page.locator('[aria-label="Decision records, newest first"]');
  await page.locator('[data-filter="proposals"]').click();
  await expect(page.locator('[data-filter="proposals"]')).toHaveAttribute("aria-pressed", "true");
  await expect(log.locator(":scope > li")).toHaveCount(counts.proposals);
  await page.getByTestId("log-search").fill("DeltaOutOfBand");
  await expect(log.locator(":scope > li")).toHaveCount(
    filterLog(entries, "proposals", "DeltaOutOfBand").length,
  );
  await page.getByTestId("log-search").fill("no such text anywhere");
  await expect(page.getByTestId("log-no-match")).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});
