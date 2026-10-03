import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import * as pricing from "../../sdk/src/pricing";
import { parseRecordText, type LogRecord } from "../src/lib/agentLog";
import {
  buildLadder,
  decisionInputs,
  lossLine,
  recordReasonCode,
  type DecisionInputs,
} from "../src/lib/decision";
import type { EpochTraceJson } from "../src/lib/epochTrace";
import {
  consistencyChecks,
  guardModifications,
  oddsBeyond,
  payoutAt,
  stressScenarios,
  whatIfBranches,
} from "../src/lib/whatIf";
import { acknowledge, horizontalOverflow } from "./helpers";

// The decision page's what-if branches, stress scenarios, the agent's own changes before sending (MODIFY) and the
// consistency checks, first as derivations on the committed records, then on the page with GitHub's raw files served
// from this checkout and the epoch trace answered by fixtures (before and after settlement).

const REPO = join(__dirname, "..", "..");
const RAW = "https://raw.githubusercontent.com/Prashant-thakur77/Strike/main/";
const A2 = "2026-10-02-sTSLA-CSP-A2";
const RECKLESS = "2026-10-01-sTSLA-CSP";
const CC = "2026-10-01-sTSLA-CC";

const load = (name: string, dir = "docs/agent-log"): LogRecord =>
  parseRecordText(readFileSync(join(REPO, dir, `${name}.json`), "utf8"))!;
const inputs = (r: LogRecord): DecisionInputs => {
  const inp = decisionInputs(r);
  if ("missing" in inp) throw new Error(inp.missing);
  return inp;
};
const ladderOf = (r: LogRecord) => buildLadder(inputs(r), pricing, recordReasonCode(r)).rows;

test.describe("what-if derivations", () => {
  test.skip(({ isMobile }) => isMobile, "pure derivations run once, on desktop");

  test("A2 before settlement: premium is certain, the payout is the model's fair value", () => {
    const r = load(A2);
    const inp = inputs(r);
    const w = whatIfBranches(r, inp, ladderOf(r), null);
    expect(w.branches.map((b) => b.kind)).toEqual(["sent", "cash", "half", "nearer", "farther"]);
    const sent = w.branches[0]!;
    const premium = (inp.dry.fairValue * inp.dry.premiumBps) / 10_000;
    expect(sent.actual).toBe(true);
    expect(sent.premium).toBeCloseTo(premium * inp.dry.size, 9);
    expect(sent.modelPayout).toBeCloseTo(inp.dry.fairValue * inp.dry.size, 9);
    // Sold at 108% of fair value: the model expects 8% of the fair value for depositors.
    expect(sent.modelNet / sent.modelPayout).toBeCloseTo(0.08, 9);
    expect(sent.payout).toBeNull();
    const cash = w.branches[1]!;
    expect([cash.premium, cash.modelNet, cash.options]).toEqual([0, 0, 0]);
    expect(w.branches[2]!.premium).toBeCloseTo(sent.premium / 2, 9);
    // Nearer the money: a higher strike for a put, a larger premium; farther: the reverse.
    expect(w.branches[3]!.strike!).toBeGreaterThan(sent.strike!);
    expect(w.branches[4]!.strike!).toBeLessThan(sent.strike!);
    expect(w.takeaway).toMatch(/^Not graded yet/);
  });

  test("A2 graded at a $338 settlement: payout below the $342.91 strike, takeaway against cash", () => {
    const r = load(A2);
    const inp = inputs(r);
    const w = whatIfBranches(r, inp, ladderOf(r), 338);
    const sent = w.branches[0]!;
    expect(payoutAt(342.91, 338, false)).toBeCloseTo(4.91, 9);
    expect(sent.payout!).toBeCloseTo(payoutAt(sent.strike!, 338, false) * inp.dry.size, 9);
    expect(sent.net!).toBeCloseTo(sent.premium - sent.payout!, 9);
    expect(w.takeaway).toMatch(
      /^At the \$338\.00 settlement, (selling the option earned|keeping cash would have)/,
    );
    // The cash branch is exactly zero once graded.
    expect(w.branches[1]!.net).toBe(0);
  });

  test("the rejected 1 October run: nothing was sold, so the sent branch is hypothetical", () => {
    const r = load(RECKLESS);
    const w = whatIfBranches(r, inputs(r), ladderOf(r), null);
    expect(w.hypothetical).toBe(true);
    expect(w.branches.find((b) => b.actual)!.kind).toBe("cash");
    expect(w.branches[0]!.inside).toBe(false);
    expect(w.branches[0]!.reason).toBe("DeltaOutOfBand");
  });

  test("stress: further moves pay out more and are less likely under the model", () => {
    for (const name of [A2, CC]) {
      const r = load(name);
      const inp = inputs(r);
      const loss = lossLine(inp, pricing);
      const s = stressScenarios(inp, loss, pricing);
      expect(s.map((x) => Math.abs(x.move))).toEqual([0.05, 0.1, 0.2, 0.3]);
      for (const x of s) {
        expect(Math.sign(x.move)).toBe(inp.isCall ? 1 : -1);
        expect(x.netPerOption).toBeCloseTo(loss.premium - payoutAt(loss.strike, x.settlement, inp.isCall), 9);
        expect(x.vaultNet).toBeCloseTo(x.netPerOption * inp.dry.size, 9);
        expect(x.odds).toBeCloseTo(oddsBeyond(inp, x.settlement, pricing), 12);
      }
      for (let i = 1; i < s.length; i++) {
        expect(s[i]!.netPerOption).toBeLessThanOrEqual(s[i - 1]!.netPerOption);
        expect(s[i]!.odds).toBeLessThan(s[i - 1]!.odds);
      }
      // At the break-even the model's odds of finishing beyond it equal the loss line's... at the strike.
      expect(oddsBeyond(inp, loss.strike, pricing)).toBeCloseTo(loss.probItm, 12);
    }
  });

  test("MODIFY: the agent's guard and profile notes become before and after; other notes are not changes", () => {
    for (const name of [A2, CC, RECKLESS]) expect(guardModifications(load(name))).toEqual([]);
    const r = load(A2);
    const notes = [
      "Claude via Claude Code CLI, model claude-opus-5.",
      'Profile "conservative" capped the size at 50% of capacity: 0.2 → 0.1.',
      "The first dry run was not compliant (DeltaOutOfBand): The option's |delta| is outside the mandate's delta band.",
      "Took the risk check's suggestion: 0.25 delta at 100% of fair value, size 0.4.",
    ];
    const mods = guardModifications({ ...r, decision: { ...r.decision!, notes } });
    expect(mods).toHaveLength(2);
    expect(mods[0]).toMatchObject({ rule: "Share of capacity", before: "0.2 options", after: "0.1 options" });
    expect(mods[1]!.rule).toBe("DeltaOutOfBand");
    expect(mods[1]!.after).toBe("0.25 delta at 100% of fair value, 0.4 options");
  });

  test("consistency: the committed records contradict neither themselves nor their anchors", () => {
    for (const name of [A2, CC, RECKLESS]) {
      const r = load(name);
      const checks = consistencyChecks(r, { anchor: "match", ladderMatches: true });
      expect(
        checks.filter((c) => c.ok === false),
        name,
      ).toEqual([]);
      expect(checks.find((c) => c.id === "verdict")!.ok).toBe(true);
    }
    // The reckless run set its strike directly: the delta check says so instead of passing or failing.
    expect(
      consistencyChecks(load(RECKLESS), { anchor: "match", ladderMatches: true }).find(
        (c) => c.id === "delta",
      )!.ok,
    ).toBe(null);
    // A hash that does not match is a contradiction.
    const bad = consistencyChecks(load(A2), { anchor: "mismatch", ladderMatches: true });
    expect(bad.find((c) => c.id === "anchor")!.ok).toBe(false);
  });
});

/* ================================================================ the page */

async function serveRaw(page: Page) {
  await page.route(`${RAW}**`, async (route) => {
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
}

function trace(r: LogRecord, settlementPrice: string | null): EpochTraceJson {
  const expiry = Math.floor(Date.parse(r.result.expiryIso ?? r.dryRun!.expiryIso!) / 1000);
  return {
    chainId: 46630,
    vault: r.vault.address,
    explorer: "",
    now: settlementPrice ? expiry + 3600 : expiry - 86_400,
    epochs: [
      {
        epoch: String(r.anchor!.epoch),
        current: true,
        status: settlementPrice ? "settled" : "selling",
        seriesId: r.result.seriesId,
        expiry,
        settlementPrice,
        steps: [],
      },
    ],
  };
}

async function open(page: Page, name: string, settlementPrice: string | null) {
  const r = load(name);
  await acknowledge(page);
  await serveRaw(page);
  await page.route("**/api/epoch-trace?**", (route) => route.fulfill({ json: trace(r, settlementPrice) }));
  await page.goto(`/app/decision/46630/${name}`);
  await expect(page.getByTestId("decision-page")).toBeVisible({ timeout: 60_000 });
}

test("decision page before settlement: model-only branches, stress, no changes, no contradictions, sources", async ({
  page,
}) => {
  await open(page, A2, null);
  const w = page.getByTestId("decision-whatif");
  await expect(w).toHaveAttribute("data-state", "model");
  await expect(w.getByTestId("whatif-row")).toHaveCount(5);
  await expect(w.locator('tr[data-kind="sent"]')).toHaveAttribute("data-sent", "true");
  await expect(page.getByTestId("whatif-takeaway")).toContainText("Not graded yet");
  await expect(w).toContainText("Model net");
  await expect(page.getByTestId("whatif-caveat")).toContainText("not a forecast");
  await expect(page.getByTestId("decision-stress").getByTestId("stress-row")).toHaveCount(4);
  await expect(page.getByTestId("decision-stress")).toContainText("−10%");
  await expect(page.getByTestId("decision-modifications")).toHaveAttribute("data-count", "0");
  await expect(page.getByTestId("decision-modifications")).toContainText("None");
  const c = page.getByTestId("decision-consistency");
  await expect(c.getByTestId("consistency-check")).toHaveCount(5);
  await expect(c.locator('[data-ok="false"]')).toHaveCount(0);
  expect(await page.getByTestId("section-source").count()).toBeGreaterThanOrEqual(6);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});

test("decision page after settlement: the branches are graded at the settlement price", async ({ page }) => {
  await open(page, A2, "338");
  const w = page.getByTestId("decision-whatif");
  await expect(w).toHaveAttribute("data-state", "graded");
  await expect(page.getByTestId("whatif-takeaway")).toContainText("At the $338.00 settlement");
  await expect(w).toContainText("Payout at $338.00");
  await expect(w.locator('tr[data-kind="cash"]')).toContainText("$0.00");
});

test("decision page of a rejected run: nothing sold is what happened, the sent branch is hypothetical", async ({
  page,
}) => {
  await open(page, RECKLESS, null);
  const w = page.getByTestId("decision-whatif");
  await expect(w).toHaveAttribute("data-state", "not-sold");
  await expect(w.locator('tr[data-kind="cash"]')).toHaveAttribute("data-sent", "true");
  await expect(w.locator('tr[data-kind="sent"]')).toContainText("outside: DeltaOutOfBand");
  await expect(page.getByTestId("decision-consistency").locator('[data-ok="false"]')).toHaveCount(0);
});
