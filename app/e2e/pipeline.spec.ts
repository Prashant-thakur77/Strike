import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  DRY_RUNS,
  DRY_RUN_FOLDERS,
  gradeAlternative,
  notProvided,
  pipelineOf,
  sourceUrl,
  stripStages,
  verdictLabel,
} from "../src/lib/pipeline";
import { acknowledge, horizontalOverflow } from "./helpers";

// The specialist pipeline on the decision page (decision D45): the stage strip with every stage's verdict, the stage
// cards (market checks, risk table, planner, critic rules and confidence, contract preflight), the no-trade banner,
// Claude's narration kept apart, the agent's alternatives, and the dry runs (never anchored). The committed dry-run
// records are the fixtures, served from this checkout in place of raw.githubusercontent.com.

const REPO = join(__dirname, "..", "..");
const RAW = "https://raw.githubusercontent.com/Prashant-thakur77/Strike/main/";
const raw = (chainId: number, name: string) =>
  JSON.parse(readFileSync(join(REPO, DRY_RUN_FOLDERS[chainId]!, `${name}.json`), "utf8")) as unknown;
const CLOSED = "2026-10-03-sTSLA-CSP-dry-run";
const OPEN = "2026-10-03-sTSLA-CSP-as-if-open-dry-run";
const CLAUDE = "2026-10-03-sTSLA-CSP-as-if-open-claude-dry-run";

test.describe("pipeline logic", () => {
  test.skip(({ isMobile }) => isMobile, "pure logic runs once, on desktop");

  test("every listed dry run parses, with all five stages in order", () => {
    for (const d of DRY_RUNS) {
      const p = pipelineOf(raw(d.chainId, d.name))!;
      expect(p, d.name).not.toBeNull();
      expect(p.run?.dryRun).toBe(true);
      expect(stripStages(p).map((s) => s.stage)).toEqual(["market", "risk", "planner", "critic", "contract"]);
    }
  });

  test("a weekend run: the market analyst's fail reads 'No trade' and the rest 'Not run'", () => {
    const p = pipelineOf(raw(46630, CLOSED))!;
    expect(p.noTrade).toMatchObject({ stage: "market", codes: ["MARKET_CLOSED"] });
    expect(p.stages.map((s) => verdictLabel(s, p.noTrade))).toEqual([
      "No trade",
      "Not run",
      "Not run",
      "Not run",
      "Not run",
    ]);
    expect(p.run?.ignoreSession).toBe(false);
  });

  test("as if open: every stage passes and the contract is not run; Claude's narration is kept apart", () => {
    const p = pipelineOf(raw(46630, OPEN))!;
    expect(p.stages.map((s) => verdictLabel(s, p.noTrade))).toEqual([
      "PASS",
      "PASS",
      "PASS",
      "PASS",
      "Not run",
    ]);
    expect(p.run?.ignoreSession).toBe(true);
    expect(p.confidence?.kind).toBe("model odds");
    expect(p.stages.every((s) => s.narration === null)).toBe(true);
    const c = pipelineOf(raw(46630, CLAUDE))!;
    const planner = c.stages.find((s) => s.stage === "planner")!;
    expect(planner.by).toBe("claude");
    expect(planner.narration?.label).toContain("Claude");
    expect(planner.narration!.text.length).toBeGreaterThan(40);
  });

  test("alternatives are graded as premium income minus the payout on their size; kept cash is zero", () => {
    const p = pipelineOf(raw(46630, OPEN))!;
    expect(p.alternatives.map((a) => a.name)).toEqual([
      "chosen strike",
      "kept cash",
      "half size",
      "one step nearer",
      "one step farther",
    ]);
    const chosen = p.alternatives[0]!;
    expect(gradeAlternative(chosen, 400, false)).toBeCloseTo(chosen.premiumIncomeUsd!, 9);
    expect(gradeAlternative(chosen, 330, false)).toBeCloseTo(
      chosen.premiumIncomeUsd! - chosen.size! * (chosen.strike! - 330),
      9,
    );
    expect(gradeAlternative(p.alternatives[1]!, 330, false)).toBe(0);
    expect(gradeAlternative({ ...chosen, strike: 300 }, 330, true)).toBeCloseTo(
      chosen.premiumIncomeUsd! - chosen.size! * 30,
      9,
    );
  });

  test("sources link to the explorer of their own chain; a record before the pipeline has none", () => {
    const p = pipelineOf(raw(46630, OPEN))!;
    const mainnet = p.stages[0]!.sources.find((s) => s.chainId === 4663)!;
    expect(sourceUrl(mainnet, 46630)).toMatch(/^https:\/\/robinhoodchain\.blockscout\.com\/address\/0x/);
    const local = p.stages[0]!.sources.find((s) => s.kind === "contract" && s.chainId === null)!;
    expect(sourceUrl(local, 46630)).toMatch(
      /^https:\/\/explorer\.testnet\.chain\.robinhood\.com\/address\/0x/,
    );
    expect(sourceUrl({ kind: "mcp", name: "vault_state", address: null, chainId: null }, 46630)).toBeNull();
    const a2 = JSON.parse(readFileSync(join(REPO, "docs/agent-log/2026-10-02-sTSLA-CSP-A2.json"), "utf8"));
    expect(pipelineOf(a2)).toBeNull();
    expect(notProvided({ provided: false, reason: "no feed" })).toBe("no feed");
    expect(notProvided({ provided: true })).toBeNull();
  });
});

/* ================================================================ the page */

async function serveRaw(page: Page) {
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
  await page.route("**/api/mirror-audit?**", (route) => route.fulfill({ json: { feeds: [] } }));
}

async function openDry(page: Page, chainId: number, name: string) {
  await acknowledge(page);
  await serveRaw(page);
  await page.goto(`/app/decision/${chainId}/${name}?dry=1`);
  const root = page.getByTestId("decision-page");
  await expect(root).toBeVisible({ timeout: 60_000 });
  await expect(root).toHaveAttribute("data-dry-run", "true");
  return root;
}

test("a weekend dry run: the no-trade banner, the strip and no anchor check", async ({ page }) => {
  await openDry(page, 46630, CLOSED);
  await expect(page.getByTestId("pipeline-no-trade")).toContainText(
    "No trade: stopped by the market analyst",
  );
  await expect(page.getByTestId("pipeline-no-trade")).toContainText("MARKET_CLOSED");
  const chips = page.getByTestId("pipeline-chip");
  await expect(chips).toHaveCount(5);
  await expect(chips.nth(0)).toContainText("No trade");
  for (let i = 1; i < 5; i++) await expect(chips.nth(i)).toContainText("Not run");
  // The market analyst's card opens first (the stage that stopped the run), with its checks.
  await expect(page.getByTestId("pipeline-stage")).toHaveAttribute("data-stage", "market");
  await expect(page.getByTestId("market-check").first()).toContainText("MARKET_CLOSED");
  await chips.nth(2).click();
  await expect(page.getByTestId("pipeline-summary")).toContainText("not run");
  await expect(page.getByTestId("decision-dry-run-anchor")).toContainText("not anchored");
  await expect(page.getByRole("region", { name: "Key figures" })).toContainText("Dry run");
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});

test("an as-if-open dry run: the risk table, the critic's rules and confidence, the alternatives", async ({
  page,
}) => {
  await openDry(page, 46630, OPEN);
  await expect(page.getByTestId("pipeline-as-if-open")).toContainText(
    "Evaluated as if the NYSE were open (dry run)",
  );
  const chips = page.getByTestId("pipeline-chip");
  await chips.nth(1).click();
  const rows = page.getByTestId("risk-row");
  await expect(rows).toHaveCount(8);
  await expect(page.locator('[data-testid="risk-row"][data-sent]')).toContainText("0.20");
  await expect(page.locator('[data-testid="risk-row"]').first()).toContainText("DeltaOutOfBand");
  await chips.nth(3).click();
  const rules = page.getByTestId("critic-rule");
  await expect(rules).toHaveCount(5);
  await expect(rules.first()).toContainText("P0");
  await expect(rules.last()).toContainText("P4");
  await expect(page.getByTestId("critic-confidence")).toContainText("Model odds it expires worthless");
  await chips.nth(4).click();
  await expect(page.getByTestId("contract-preflight")).toHaveCount(3);
  const alts = page.getByTestId("decision-whatif");
  await expect(alts).toHaveAttribute("data-source", "agent");
  await expect(alts.getByTestId("whatif-row")).toHaveCount(5);
  await expect(alts.locator('tr[data-kind="kept cash"]')).toContainText("taken");
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});

test("the Claude-planned dry run keeps Claude's words in a narration box", async ({ page }) => {
  await openDry(page, 46630, CLAUDE);
  await page.getByTestId("pipeline-chip").nth(2).click();
  await expect(page.getByTestId("pipeline-stage")).toContainText("by Claude");
  await expect(page.getByTestId("pipeline-narration")).toContainText("Claude's words, not a computed number");
});

test("a record from before the pipeline says it was not recorded", async ({ page }) => {
  await acknowledge(page);
  await serveRaw(page);
  await page.goto("/app/decision/46630/2026-10-02-sTSLA-CSP-A2");
  await expect(page.getByTestId("decision-page")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("pipeline-not-recorded")).toContainText("Not recorded");
  await expect(page.getByTestId("pipeline-chip")).toHaveCount(0);
});

test("the agents page links every dry run", async ({ page }) => {
  await acknowledge(page);
  await page.goto("/app/agents?chain=46630");
  const links = page.getByTestId("dry-run-link");
  await expect(links).toHaveCount(DRY_RUNS.length);
  for (const [i, d] of DRY_RUNS.entries())
    await expect(links.nth(i).getByRole("link")).toHaveAttribute(
      "href",
      `/app/decision/${d.chainId}/${d.name}?dry=1`,
    );
});
