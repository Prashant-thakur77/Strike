import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import * as pricing from "../../sdk/src/pricing";
import { parseRecordText, type LogRecord } from "../src/lib/agentLog";
import {
  buildLadder,
  decisionInputs,
  decisionPathFromUri,
  gradeLadder,
  hindsightTakeaway,
  isRecordName,
  ladderTargets,
  lossLine,
  recordReasonCode,
  scorecard,
  type DecisionInputs,
} from "../src/lib/decision";
import type { EpochTraceJson } from "../src/lib/epochTrace";
import { acknowledge, horizontalOverflow, settle } from "./helpers";

// The decision page (/app/decision/<chain>/<record>) for every record in docs/agent-log: v2 and v3, Robinhood Chain
// testnet and Arbitrum Sepolia, accepted and rejected. First the derivations without a browser (the scorecard with
// headroom, the ladder recomputed with the SDK's own pricing source and its self-check against each record's anchored
// dry run, the break-even and model odds, the grading at a settlement price), then the page, with GitHub's raw files
// served from this checkout (so it tests the records as committed) and the epoch trace answered by fixtures for the
// settled and pending states. The on-chain hash check is asserted when the chain's RPC answers. Set
// DECISION_SHOTS=<dir> to save full-page screenshots.

const REPO = join(__dirname, "..", "..");
const RAW = "https://raw.githubusercontent.com/Prashant-thakur77/Strike/main/";

interface Rec {
  chainId: number;
  path: string;
  name: string;
  status: "accepted" | "rejected";
  rpc: string;
}

const RH_RPC = process.env.E2E_TESTNET_RPC ?? "https://rpc.testnet.chain.robinhood.com";
const AS_RPC = process.env.E2E_ARB_SEPOLIA_RPC ?? "https://sepolia-rollup.arbitrum.io/rpc";

const RECORDS: Rec[] = [
  {
    chainId: 46630,
    path: "docs/agent-log",
    name: "2026-10-02-sTSLA-CSP-A2",
    status: "accepted",
    rpc: RH_RPC,
  },
  { chainId: 46630, path: "docs/agent-log", name: "2026-10-01-sTSLA-CC", status: "accepted", rpc: RH_RPC },
  { chainId: 46630, path: "docs/agent-log", name: "2026-10-01-sTSLA-CSP", status: "rejected", rpc: RH_RPC },
  {
    chainId: 421614,
    path: "docs/agent-log/arbitrum-sepolia",
    name: "2026-09-30-sTSLA-CC",
    status: "accepted",
    rpc: AS_RPC,
  },
  {
    chainId: 421614,
    path: "docs/agent-log/arbitrum-sepolia",
    name: "2026-09-30-sTSLA-CSP",
    status: "rejected",
    rpc: AS_RPC,
  },
];

const fileText = (rel: string) => readFileSync(join(REPO, rel), "utf8");
const load = (r: Rec): LogRecord => parseRecordText(fileText(`${r.path}/${r.name}.json`))!;
const inputs = (r: LogRecord): DecisionInputs => {
  const inp = decisionInputs(r);
  if ("missing" in inp) throw new Error(inp.missing);
  return inp;
};

async function rpcUp(rpc: string, chainId: number): Promise<boolean> {
  try {
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json()) as { result?: string };
    return json.result !== undefined && Number(json.result) === chainId;
  } catch {
    return false;
  }
}

/* ================================================================ the derivations */

test.describe("derivations", () => {
  test("record names and links: only the chain's own folder, only record-shaped names", () => {
    expect(isRecordName("2026-10-02-sTSLA-CSP-A2")).toBe(true);
    expect(isRecordName("2026-10-02-sTSLA-CC-2")).toBe(true);
    expect(isRecordName("../secrets")).toBe(false);
    expect(isRecordName("2026-10-02-a/b")).toBe(false);
    expect(isRecordName("2026-10-02-x..y")).toBe(false);
    const gh = "https://github.com/Prashant-thakur77/Strike/blob/main/";
    expect(decisionPathFromUri(46630, `${gh}docs/agent-log/2026-10-02-sTSLA-CSP-A2.json`)).toBe(
      "/app/decision/46630/2026-10-02-sTSLA-CSP-A2",
    );
    expect(decisionPathFromUri(421614, `${gh}docs/agent-log/arbitrum-sepolia/2026-09-30-sTSLA-CC.json`)).toBe(
      "/app/decision/421614/2026-09-30-sTSLA-CC",
    );
    // A record in another chain's folder, the hand-run epoch log and nothing at all are not decision pages.
    expect(
      decisionPathFromUri(46630, `${gh}docs/agent-log/arbitrum-sepolia/2026-09-30-sTSLA-CC.json`),
    ).toBeNull();
    expect(decisionPathFromUri(46630, `${gh}docs/testnet-epochs/2026-09-29.md`)).toBeNull();
    expect(decisionPathFromUri(46630, null)).toBeNull();
    expect(decisionPathFromUri(1, `${gh}docs/agent-log/2026-10-02-sTSLA-CSP-A2.json`)).toBeNull();
  });

  test("the ladder spans one step below the band to one above it", () => {
    expect(ladderTargets({ minDeltaBps: 1000, maxDeltaBps: 2500 })).toEqual([
      0.05, 0.1, 0.15, 0.2, 0.25, 0.3,
    ]);
    expect(ladderTargets({ minDeltaBps: 1000, maxDeltaBps: 3500 })).toEqual([
      0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4,
    ]);
  });

  for (const rec of RECORDS) {
    test(`${rec.chainId} ${rec.name}: the recomputed sent row matches the anchored dry run`, () => {
      const r = load(rec);
      const inp = inputs(r);
      const ladder = buildLadder(inp, pricing, recordReasonCode(r));
      for (const i of ladder.check.items) {
        expect(Math.abs(i.recomputed - i.record), `${i.label}`).toBeLessThanOrEqual(i.tolerance);
      }
      expect(ladder.check.ok).toBe(true);
      expect(ladder.rows.filter((x) => x.sent)).toHaveLength(1);
      // Rows below the band's floor and above its ceiling break the delta band; rows inside pass every rule.
      for (const row of ladder.rows) {
        const bps = Math.floor(row.delta * 10_000 + 1e-9);
        const inside = bps >= inp.mandate.minDeltaBps && bps <= inp.mandate.maxDeltaBps;
        expect(row.verdict.ok, `${row.target} ${row.delta}`).toBe(inside);
        if (!inside) expect(row.verdict.reason).toBe("DeltaOutOfBand");
      }
      const sent = ladder.rows.find((x) => x.sent)!;
      expect(sent.verdict.ok).toBe(rec.status === "accepted");
    });
  }

  test("A2: break-even about $340.20, model odds of exercise about 17%", () => {
    const r = load(RECORDS[0]!);
    const l = lossLine(inputs(r), pricing);
    expect(l.isCall).toBe(false);
    expect(l.strike).toBe(342.91);
    expect(l.premium).toBeCloseTo(2.5118 * 1.08, 6);
    expect(l.breakEven.toFixed(2)).toBe("340.20");
    expect(l.distance).toBeCloseTo(340.197 / 372.6112 - 1, 4);
    expect(l.probItm).toBeGreaterThan(0.165);
    expect(l.probItm).toBeLessThan(0.175);
  });

  test("A2 scorecard: every rule passes, each with its limit and headroom", () => {
    const r = load(RECORDS[0]!);
    const rules = scorecard(inputs(r), r.vault.underlying, recordReasonCode(r));
    expect(rules.map((x) => x.reason)).toEqual([
      "ZeroSize",
      "TenorOutOfRange",
      "InvalidExpiry",
      "StrikeWrongSide",
      "SizeTooLarge",
      "PremiumBelowFair",
      "PremiumAboveCap",
      "DeltaOutOfBand",
      "PremiumTooSmall",
    ]);
    expect(rules.every((x) => x.mark === "pass")).toBe(true);
    const by = (reason: string) => rules.find((x) => x.reason === reason)!;
    expect(by("DeltaOutOfBand").limit).toBe("|Δ| 0.10 to 0.25");
    expect(by("DeltaOutOfBand").headroom).toEqual({ text: "0.05 above the floor", tone: "room" });
    expect(by("SizeTooLarge").headroom?.tone).toBe("tight");
    expect(by("PremiumBelowFair").headroom?.text).toBe("8 points above the floor");
    expect(by("StrikeWrongSide").headroom?.text).toBe("$29.70 (7.971%) below spot");
  });

  test("the rejected 1 Oct record: the delta band fails at |Δ| 0.4928, the rule after it is not reached", () => {
    const r = load(RECORDS[2]!);
    expect(recordReasonCode(r)).toBe(8);
    const rules = scorecard(inputs(r), r.vault.underlying, recordReasonCode(r));
    expect(rules.slice(0, 7).every((x) => x.mark === "pass")).toBe(true);
    const band = rules[7]!;
    expect(band.mark).toBe("fail");
    expect(band.measured).toBe("|Δ| 0.4928");
    expect(band.headroom).toEqual({ text: "0.1428 over the ceiling", tone: "over" });
    expect(rules[8]!.mark).toBe("skip");
    expect(rules[8]!.headroom).toBeNull();
    // The sent row sits in the ladder by its strike, outside the band; 0.10 to 0.35 would have passed.
    const ladder = buildLadder(inputs(r), pricing, 8);
    const sent = ladder.rows.find((x) => x.sent)!;
    expect(sent.target).toBeNull();
    expect(sent.verdict.reason).toBe("DeltaOutOfBand");
    expect(ladder.rows.filter((x) => x.verdict.ok).map((x) => x.target)).toEqual([
      0.1, 0.15, 0.2, 0.25, 0.3, 0.35,
    ]);
  });

  test("a dry run that does not match hides the ladder (self-check)", () => {
    const r = load(RECORDS[0]!);
    const inp = inputs(r);
    const off = { ...inp, dry: { ...inp.dry, fairValue: inp.dry.fairValue + 0.02 } };
    const ladder = buildLadder(off, pricing, 0);
    expect(ladder.check.ok).toBe(false);
    expect(ladder.check.items.find((i) => i.label === "Fair value")!.ok).toBe(false);
  });

  test("hindsight: premium minus payout per option, and a takeaway computed from the numbers", () => {
    const r = load(RECORDS[0]!);
    const inp = inputs(r);
    const ladder = buildLadder(inp, pricing, 0);
    // Above every strike: every put expires worthless and keeps its premium; the richest row inside the band wins.
    const high = gradeLadder(ladder.rows, 380, false, inp.spot);
    expect(high.every((g) => g.payout === 0)).toBe(true);
    expect(hindsightTakeaway(high, 380)).toMatch(
      /^At the \$380\.00 settlement, 0\.25 delta would have kept \$2\.52 per option more than the sent 0\.15 delta \(\$2\.71\), and 0\.10 delta \$1\.06 less\.$/,
    );
    // Below the sent strike: the sent put pays out; a further-out strike would have done better.
    const low = gradeLadder(ladder.rows, 338, false, inp.spot);
    const sent = low.find((g) => g.row.sent)!;
    expect(sent.payout).toBeCloseTo(342.91 - 338, 9);
    expect(sent.net).toBeCloseTo(sent.row.premium - (342.91 - 338), 9);
    expect(hindsightTakeaway(low, 338)).toContain("0.10 delta would have kept");
  });
});

/* ================================================================ the page */

/** Serve the repository's raw files from this checkout. */
async function serveRaw(page: Page, override?: (path: string, text: string) => string) {
  await page.route(`${RAW}**`, async (route) => {
    const rel = decodeURIComponent(new URL(route.request().url()).pathname.split("/main/")[1] ?? "");
    let text: string;
    try {
      text = fileText(rel);
    } catch {
      return route.fulfill({ status: 404, body: "404: Not Found" });
    }
    return route.fulfill({
      status: 200,
      body: override ? override(rel, text) : text,
      contentType: "text/plain",
    });
  });
}

function traceFixture(rec: Rec, r: LogRecord, settlementPrice: string | null): EpochTraceJson {
  const expiry = Math.floor(Date.parse(r.result.expiryIso ?? r.dryRun!.expiryIso!) / 1000);
  return {
    chainId: rec.chainId,
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

async function openDecision(page: Page, rec: Rec) {
  await acknowledge(page);
  await page.goto(`/app/decision/${rec.chainId}/${rec.name}`);
  const root = page.getByTestId("decision-page");
  await expect(root).toBeVisible({ timeout: 60_000 });
  return root;
}

for (const rec of RECORDS) {
  test(`decision page ${rec.chainId} ${rec.name}: scorecard, ladder, break-even and the hash check`, async ({
    page,
  }, info) => {
    const r = load(rec);
    await serveRaw(page);
    await page.route("**/api/epoch-trace?**", (route) => route.fulfill({ json: traceFixture(rec, r, null) }));
    const root = await openDecision(page, rec);
    await expect(root).toHaveAttribute("data-status", rec.status);
    await expect(page.getByTestId("decision-verdict")).toHaveText(
      rec.status === "accepted" ? "Accepted" : "Rejected",
    );

    // 02: the nine rules in check order, with limits and headroom.
    const rules = page.getByTestId("decision-scorecard").locator("li");
    await expect(rules).toHaveCount(9);
    if (rec.status === "accepted") {
      await expect(rules.locator("[data-mark=pass]").first()).toBeVisible();
      expect(await page.getByTestId("decision-scorecard").locator("li[data-mark=pass]").count()).toBe(9);
    } else {
      const band = rules.nth(7);
      await expect(band).toHaveAttribute("data-mark", "fail");
      await expect(band).toContainText(/\|Δ\| 0\.49\d\d/);
      await expect(band.getByTestId("rule-headroom")).toContainText("over the ceiling");
      await expect(rules.nth(8)).toHaveAttribute("data-mark", "skip");
    }
    await expect(page.getByTestId("decision-scorecard").getByTestId("rule-headroom").first()).toBeVisible();

    // 03: the ladder, labelled, self-checked, with one sent row.
    const ladder = page.getByTestId("decision-ladder");
    await expect(ladder).toHaveAttribute("data-check", "match");
    await expect(page.getByTestId("ladder-label")).toHaveText(
      "Recomputed from the anchored inputs, not part of the agent's record.",
    );
    await expect(page.getByTestId("ladder-check")).toContainText("matches the record's dry run");
    await expect(ladder.locator("tr[data-sent]")).toHaveCount(1);
    await expect(ladder.locator("tr[data-sent]").getByTestId("ladder-sent")).toHaveText("sent");
    await expect(ladder.locator("tr[data-sent]")).toContainText(`$${Number(r.dryRun!.strike).toFixed(2)}`);
    await expect(ladder.locator("tr[data-ok=false]").first()).toContainText("DeltaOutOfBand");

    // 04: break-even and model odds.
    await expect(page.getByTestId("loss-breakeven")).toContainText(/settles (below|above) \$\d{3}\.\d{2}/);
    await expect(page.getByTestId("loss-label")).toHaveText("Model odds, not a forecast.");
    if (rec.status === "rejected") await expect(page.getByTestId("loss-hypothetical")).toBeVisible();

    // 05: rejected records have nothing to grade; accepted ones wait for settlement in this fixture.
    await expect(page.getByTestId("decision-hindsight")).toHaveAttribute(
      "data-state",
      rec.status === "accepted" ? "pending" : "not-sold",
    );

    // The backtest is context, kept apart from the reasoning.
    await expect(page.getByTestId("decision-backtest")).toContainText("Context, not the agent's reasoning");
    await expect(page.getByTestId("decision-backtest").getByRole("link")).toHaveAttribute(
      "href",
      "/app/backtest#bt-delta",
    );

    // 06: the hash check, when the chain answers.
    if (await rpcUp(rec.rpc, rec.chainId)) {
      await expect(page.getByTestId("why-anchor")).toHaveAttribute("data-status", "match", {
        timeout: 60_000,
      });
    }
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

    const dir = process.env.DECISION_SHOTS;
    if (dir) {
      mkdirSync(dir, { recursive: true });
      await settle(page, 800);
      await page.screenshot({
        path: join(dir, `${info.project.name}-decision-${rec.chainId}-${rec.name}.png`),
        fullPage: true,
      });
    }
  });
}

test("in hindsight: after settlement every row is graded at the settlement price", async ({ page }, info) => {
  const rec = RECORDS[0]!;
  const r = load(rec);
  await serveRaw(page);
  await page.route("**/api/epoch-trace?**", (route) => route.fulfill({ json: traceFixture(rec, r, "338") }));
  await openDecision(page, rec);
  const h = page.getByTestId("decision-hindsight");
  await expect(h).toHaveAttribute("data-state", "graded");
  await expect(page.getByTestId("hindsight-takeaway")).toContainText("At the $338.00 settlement");
  await expect(page.getByTestId("hindsight-caveat")).toContainText("One week is noise");
  await expect(page.getByTestId("hindsight-caveat")).toContainText(
    "other strikes would have sold differently",
  );
  const rows = h.getByTestId("graded-row");
  await expect(rows).toHaveCount(6);
  await expect(h.locator("tr[data-sent]")).toContainText("$4.9100"); // payout 342.91 − 338
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  const dir = process.env.DECISION_SHOTS;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    await h.scrollIntoViewIfNeeded();
    await settle(page, 600);
    await h.screenshot({ path: join(dir, `${info.project.name}-decision-hindsight-fixture.png`) });
  }
});

test("a record whose dry run the recomputation cannot reproduce: the ladder is hidden and says why", async ({
  page,
}) => {
  const rec = RECORDS[0]!;
  await serveRaw(page, (path, text) =>
    path.endsWith(`${rec.name}.json`) ? text.replace('"fairValue": "2.5118"', '"fairValue": "2.6118"') : text,
  );
  await page.route("**/api/epoch-trace?**", (route) => route.abort());
  await openDecision(page, rec);
  const ladder = page.getByTestId("decision-ladder");
  await expect(ladder).toHaveAttribute("data-check", "mismatch");
  await expect(page.getByTestId("ladder-check")).toContainText("so the ladder is hidden");
  await expect(ladder.locator("table")).toHaveCount(0);
  await expect(page.getByTestId("decision-hindsight")).toHaveAttribute("data-state", "no-ladder");
});

test("an unknown record name and a malformed one", async ({ page, request }) => {
  await serveRaw(page);
  await acknowledge(page);
  await page.goto("/app/decision/46630/2026-01-01-sNOPE");
  await expect(page.getByTestId("decision-empty")).toContainText("No such decision record.");
  expect((await request.get("/app/decision/46630/..%2Fsecrets")).status()).toBe(404);
  expect((await request.get("/app/decision/1/2026-10-02-sTSLA-CSP-A2")).status()).toBe(404);
});

test("the epoch trace links its proposal, record and settlement steps to the decision page", async ({
  page,
}) => {
  const rec = RECORDS[0]!;
  test.skip(!(await rpcUp(rec.rpc, rec.chainId)), "Robinhood Chain testnet RPC unreachable");
  const r = load(rec);
  const uri = r.anchor!.uri!;
  const trace: EpochTraceJson = {
    ...traceFixture(rec, r, null),
    epochs: [
      {
        ...traceFixture(rec, r, null).epochs[0]!,
        steps: [
          {
            kind: "record",
            title: "Decision record anchored",
            facts: [],
            tx: null,
            time: null,
            tone: "neutral",
            record: { uri, hash: r.anchor!.recordHash, agentId: "2" },
          },
          { kind: "accepted", title: "Proposal accepted", facts: [], tx: null, time: null, tone: "good" },
        ],
      },
    ],
  };
  await page.route("**/api/epoch-trace?**", (route) => route.fulfill({ json: trace }));
  await acknowledge(page);
  await page.goto(`/app/vault/${r.vault.address}?chain=${rec.chainId}`);
  const links = page.locator("section#trace").getByTestId("trace-decision");
  await expect(links).toHaveCount(2, { timeout: 60_000 });
  await expect(links.first()).toHaveAttribute("href", `/app/decision/46630/${rec.name}`);
  await expect(links.nth(1)).toHaveText("Why this strike, and why not the others");
});
