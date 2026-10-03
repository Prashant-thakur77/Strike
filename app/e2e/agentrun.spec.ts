import { expect, test } from "@playwright/test";
import {
  RUN_PROFILES,
  buildRun,
  profilePremium,
  runTargets,
  type RunInputs,
  type RunRung,
} from "../src/lib/agentRun";
import { verdictLabel } from "../src/lib/pipeline";
import { acknowledge, horizontalOverflow } from "./helpers";

// "Run the agent" on the playground: the example agent's rule stages run in the browser against a live vault and
// shown in the decision page's stage strip. First the stage logic on hand-made rungs, then the page against the live
// Robinhood Chain testnet vault (skipped when its RPC does not answer).

const MANDATE = { minDeltaBps: 1000, maxDeltaBps: 3500, minPremiumBps: 9500, maxShareSoldBps: 8000 };
const INP: RunInputs = {
  vault: "0xADFF7900dbe01E8170a750AB88e1f4eA8D9D1D4e",
  symbol: "sTSLA-CC",
  isCall: true,
  marketOpen: false,
  epochState: "Idle",
  feedOk: true,
  feedNote: "StockOracle.status: Ok",
  spot: 370.45,
  sigma: 0.6,
  mandate: MANDATE,
  tenorSeconds: 6 * 86_400,
  expiryIso: "2026-10-09T20:00:00.000Z",
  stockOracle: "0x0000000000000000000000000000000000000001",
  epochManager: "0x0000000000000000000000000000000000000002",
};
const rung = (bps: number, strike: number, ok = true, reason = "None"): RunRung => ({
  targetDeltaBps: bps,
  strike,
  size: 4,
  ok,
  reason,
  fairValue: 2.5,
  delta: bps / 10_000,
  yieldBps: 67,
  error: null,
});
const LADDER = [
  rung(500, 410, false, "DeltaOutOfBand"),
  rung(1000, 395),
  rung(1500, 386),
  rung(2000, 380),
  rung(2500, 375),
  rung(3000, 372),
  rung(3500, 370.5),
  rung(4000, 370.46, false, "DeltaOutOfBand"),
];

test.describe("agent run logic", () => {
  test.skip(({ isMobile }) => isMobile, "pure logic runs once, on desktop");

  test("the ladder spans the band and a step past each edge; premium is raised to the floor", () => {
    expect(runTargets(MANDATE)).toEqual([500, 1000, 1500, 2000, 2500, 3000, 3500, 4000]);
    expect(profilePremium(RUN_PROFILES[0]!, MANDATE)).toBe(10_000);
    expect(profilePremium({ ...RUN_PROFILES[0]!, premiumBps: 9000 }, MANDATE)).toBe(9500);
  });

  test("closed market and an idle epoch are waived, the profile's rung is chosen, the contract is not run", () => {
    const p = buildRun(INP, RUN_PROFILES[0]!, LADDER);
    expect(p.stages.map((s) => s.stage)).toEqual(["market", "risk", "planner", "critic", "contract"]);
    expect(p.run?.ignoreSession).toBe(true);
    expect(p.stages[0]!.summary).toContain("session and epoch waived");
    expect(p.stages[2]!.output.targetDeltaBps).toBe(2000);
    expect(verdictLabel(p.stages[4]!, p.noTrade)).toBe("Not run");
    const rules = p.stages[3]!.output.rules as { code: string; ok: boolean }[];
    expect(rules.map((r) => r.code)).toEqual(["MARKET_NO_GO", "MANDATE_REJECTED", "CUSHION_TOO_THIN"]);
    expect(p.confidence?.kind).toBe("model odds");
    const conservative = buildRun(INP, RUN_PROFILES[1]!, LADDER);
    expect(conservative.stages[2]!.output.targetDeltaBps).toBe(1500);
  });

  test("a strike too close to spot is vetoed by the cushion rule, and an unsafe feed stops the run", () => {
    const thin = buildRun(INP, { ...RUN_PROFILES[0]!, targetDelta: 0.35 }, LADDER);
    expect(thin.noTrade?.stage).toBe("critic");
    expect(thin.noTrade?.codes).toContain("CUSHION_TOO_THIN");
    const stale = buildRun(
      { ...INP, feedOk: false, feedNote: "the oracle reverts: StalePrice()" },
      RUN_PROFILES[0]!,
      [],
    );
    expect(stale.noTrade?.stage).toBe("market");
    expect(stale.stages.slice(1).every((s) => s.verdict === "not-run")).toBe(true);
    const none = buildRun(
      INP,
      RUN_PROFILES[0]!,
      LADDER.map((r) => ({ ...r, ok: false, reason: "PremiumBelowFair" })),
    );
    expect(none.noTrade?.stage).toBe("risk");
  });
});

test("the playground runs the agent's stages against the live vault and sends nothing", async ({ page }) => {
  await acknowledge(page);
  await page.goto("/app/playground");
  const button = page.getByTestId("agent-run-button");
  await expect(button).toBeEnabled({ timeout: 60_000 });
  await button.click();
  const strip = page.getByTestId("agent-run").getByTestId("pipeline");
  const failed = page.getByTestId("agent-run-error");
  await expect(strip.or(failed)).toBeVisible({ timeout: 90_000 });
  test.skip(await failed.isVisible(), "Robinhood Chain testnet RPC did not answer");
  await expect(strip.getByTestId("pipeline-chip")).toHaveCount(5);
  await expect(strip.getByTestId("pipeline-chip").last()).toContainText("Not run");
  await expect(strip.getByTestId("pipeline-run")).toContainText("does not carry token counts");
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});
