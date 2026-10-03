import * as prettier from "prettier";
import { describe, expect, it } from "vitest";
import { blackScholes } from "@strike/sdk";
import { recordHash, unanchoredJson, verifyAnchoredRecord } from "../src/anchor.js";
import { candidateFromCheck } from "../src/candidates.js";
import { Journal, marketInputs } from "../src/journal.js";
import { PIPELINE_STAGES, PipelineLog, notProvided } from "../src/pipeline.js";
import {
  type DecisionRecord,
  formatRecordJson,
  formatRecordMarkdown,
  recordBaseName,
} from "../src/record.js";
import {
  CUSHION_SIGMAS,
  alternatives,
  confidence,
  criticRules,
  mandateModifications,
  rebuiltYieldBps,
  sizeModification,
} from "../src/specialists/critic.js";
import {
  type MarketReads,
  marketBrief,
  nextSession,
  previousCloses,
  realisedVolatility,
  roundAt,
  utcLabel,
} from "../src/specialists/market.js";
import { claudeChoice, pickRung, ruleChoice } from "../src/specialists/plan.js";
import {
  type RiskEngineReader,
  type RiskRow,
  breakEven,
  exerciseProbability,
  riskRow,
  riskTable,
} from "../src/specialists/risk.js";
import {
  APPROVAL_TTL_MS,
  type ClaudePlan,
  type PipelineDeps,
  plannerContext,
  preflightChecks,
  rejectionCounts,
  runPipeline,
} from "../src/specialists/run.js";
import { PROFILES } from "../src/strategy.js";
import type { ProposeResult, RiskCheck, VaultState } from "../src/types.js";
import type { LlmUsage } from "../src/usage.js";

// The specialist pipeline: each specialist on fixtures (go / no-go, the risk table, every critic rule), the pipeline
// end to end on a fake MCP server and chain, and the record: hashed with and without `pipeline`, rendered, labelled.

const SAT = Date.parse("2026-10-03T05:21:54Z") / 1000; // a Saturday: NYSE closed
const MON_OPEN = Date.parse("2026-10-05T13:30:00Z") / 1000;
const MON = Date.parse("2026-10-05T15:02:11Z") / 1000; // Monday in session
const LAST_PRINT = Date.parse("2026-10-02T19:55:31Z") / 1000;

const mandate = {
  minDeltaBps: 1000,
  maxDeltaBps: 3500,
  minPremiumBps: 9500,
  minYieldBps: 5,
  maxShareSoldBps: 8000,
  minTenor: 86_400,
  maxTenor: 691_200,
  summary:
    "|delta| 0.10-0.35, premium >= 95% of fair value, yield >= 0.05% of collateral, size <= 80% of capacity, tenor 1-8 days",
};

/** Market reads of a normal Monday in session; override per case. */
function reads(over: Partial<MarketReads> = {}): MarketReads {
  return {
    chainId: 46630,
    now: MON,
    token: { symbol: "TSLA", address: "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E" },
    oracle: { status: "Ok", price: "370.448", updatedAt: MON - 120 },
    feed: {
      address: "0x5476cb08769f406dE95F6171AcC1F5FE88431230",
      maxPriceAge: 90_000,
      corporateActionGrace: 86_400,
    },
    session: {
      open: true,
      nextOpen: MON_OPEN + 86_400,
      nextClose: Date.parse("2026-10-05T20:00:00Z") / 1000,
    },
    sigma: { value: 0.6, min: 0.2, max: 2 },
    corporateAction: {
      uiMultiplier: "1000000000000000000",
      newUIMultiplier: "1000000000000000000",
      effectiveAt: 0,
    },
    sequencer: notProvided("no sequencer uptime feed is configured"),
    mirror: { roundId: "7", price: "370.448", updatedAt: MON - 120 },
    mainnet: {
      chainId: 4663,
      feed: "0x4A1166a659A55625345e9515b32adECea5547C38",
      roundId: "9",
      price: "370.448",
      updatedAt: MON - 120,
    },
    realised: {
      value: 0.55,
      closes: [
        { closeIso: "2026-10-01T20:00:00.000Z", price: 360 },
        { closeIso: "2026-10-02T20:00:00.000Z", price: 370.448 },
      ],
      returns: 10,
    },
    mcpSpot: "370.448",
    sources: [
      { kind: "contract", name: "StockOracle.status", address: "0x5BCdBFaB940BFAEF821392d7f58c670c2064989A" },
    ],
    ...over,
  };
}

/** The same Saturday the live dry run saw: closed until Monday, last print Friday 19:55 UTC. */
const weekend = (over: Partial<MarketReads> = {}) =>
  reads({
    now: SAT,
    oracle: { status: "Ok", price: "370.448", updatedAt: LAST_PRINT },
    session: { open: false, nextOpen: MON_OPEN, nextClose: Date.parse("2026-10-05T20:00:00Z") / 1000 },
    mirror: { roundId: "7", price: "370.448", updatedAt: LAST_PRINT },
    mainnet: { chainId: 4663, feed: "0x4A11", roundId: "9", price: "370.448", updatedAt: LAST_PRINT },
    ...over,
  });

describe("market analyst", () => {
  it("says go on an open, fresh, quiet market, with every check's measured value and limit", () => {
    const b = marketBrief(reads());
    expect(b.go).toBe(true);
    expect(b.checks.map((c) => c.check)).toEqual([
      "session",
      "feed-status",
      "feed-fresh",
      "corporate-action",
      "sequencer",
      "sigma-bounds",
    ]);
    expect(b.checks.every((c) => c.ok && c.measured && c.limit)).toBe(true);
    expect(b.reasons).toEqual(["all 6 checks passed"]);
  });

  it("says no-go when the market is closed, until the next open read from the calendar", () => {
    const b = marketBrief(weekend());
    expect(b.go).toBe(false);
    expect(b.reasons).toEqual(["market closed until Mon 5 Oct 13:30 UTC"]);
    expect(b.session.nextOpenIso).toBe("2026-10-05T13:30:00Z");
  });

  it("says no-go on a stale feed, with the age against feedConfig.maxPriceAge", () => {
    const b = marketBrief(
      reads({ oracle: { status: "StalePrice", price: "370.448", updatedAt: MON - 100_000 } }),
    );
    expect(b.go).toBe(false);
    const fresh = b.checks.find((c) => c.check === "feed-fresh")!;
    expect(fresh.ok).toBe(false);
    expect(fresh.measured).toContain("27.8 h old");
    expect(fresh.limit).toContain("25.0 h");
  });

  it("says no-go while a corporate action is pending, from the oracle's status or the token's multiplier fields", () => {
    const byStatus = marketBrief(
      reads({ oracle: { status: "CorporateActionPending", price: null, updatedAt: null } }),
    );
    expect(byStatus.go).toBe(false);
    expect(byStatus.checks.find((c) => c.check === "corporate-action")!.ok).toBe(false);
    const scheduled = marketBrief(
      reads({ corporateAction: { uiMultiplier: "1", newUIMultiplier: "2", effectiveAt: MON + 3600 } }),
    );
    expect(scheduled.go).toBe(false);
    expect(scheduled.reasons[0]).toContain("corporate-action");
    const inGrace = marketBrief(
      reads({ corporateAction: { uiMultiplier: "2", newUIMultiplier: "2", effectiveAt: MON - 600 } }),
    );
    expect(inGrace.go).toBe(false);
  });

  it("says no-go when the sequencer is down or inside its grace period, and records a missing feed as not provided", () => {
    const down = marketBrief(
      reads({ sequencer: { feed: "0x1", up: false, startedAt: MON - 10, grace: 3600 } }),
    );
    expect(down.go).toBe(false);
    const grace = marketBrief(
      reads({ sequencer: { feed: "0x1", up: true, startedAt: MON - 60, grace: 3600 } }),
    );
    expect(grace.go).toBe(false);
    const none = marketBrief(reads());
    expect(none.sequencer).toEqual({ provided: false, reason: "no sequencer uptime feed is configured" });
    expect(none.checks.find((c) => c.check === "sequencer")!.measured).toContain("not provided");
  });

  it("says no-go on a sigma outside the admin's bounds, and a paused token", () => {
    expect(marketBrief(reads({ sigma: { value: 2.5, min: 0.2, max: 2 } })).go).toBe(false);
    expect(marketBrief(reads({ oracle: { status: "TokenPaused", price: null, updatedAt: null } })).go).toBe(
      false,
    );
  });

  it("--ignore-session waives the session check only, and says so; a stale feed is still a no-go", () => {
    const b = marketBrief(weekend(), { ignoreSession: true });
    expect(b.go).toBe(true);
    expect(b.sessionWaived).toBe(true);
    expect(b.checks.find((c) => c.check === "session")).toMatchObject({ ok: false, waived: true });
    expect(b.reasons[0]).toContain("waived by --ignore-session");
    const stale = marketBrief(weekend({ now: LAST_PRINT + 100_000 }), { ignoreSession: true });
    expect(stale.go).toBe(false);
  });

  it("compares inputs that should agree: the mirror against mainnet, the MCP spot against the oracle", () => {
    const agree = marketBrief(reads());
    expect(agree.contradictions.map((c) => c.agree)).toEqual([true, true, true]);
    expect(agree.contradictions[1]!.between[0]).toBe("pricer sigma (EpochManager)");
    const lag = marketBrief(
      reads({
        mainnet: {
          chainId: 4663,
          feed: "0x4A11",
          roundId: "10",
          price: "372.10",
          updatedAt: MON - 120 + 3600,
        },
      }),
    );
    expect(lag.contradictions[0]).toMatchObject({ agree: false });
    expect(lag.contradictions[0]!.measured).toContain("1.0 h after the mirror's last round");
    const spot = marketBrief(reads({ mcpSpot: "371.00" }));
    expect(spot.contradictions[2]).toMatchObject({ agree: false });
    const vol = marketBrief(reads({ realised: { value: 0.25, closes: [], returns: 10 } }));
    expect(vol.contradictions[1]).toMatchObject({
      agree: false,
      measured: "sigma 60.0% against realised 25.0% a year",
    });
    const missing = marketBrief(
      reads({ mainnet: notProvided("RPC down"), realised: notProvided("RPC down") }),
    );
    expect(missing.contradictions).toHaveLength(1);
    expect(missing.sigma.realised).toEqual({ provided: false, reason: "RPC down" });
    expect(missing.mainnet).toEqual({ provided: false, reason: "RPC down" });
  });

  it("computes realised volatility from daily closes, and finds each close's round by binary search", async () => {
    const closes = [100, 101, 99, 102, 100].map((price, i) => ({ closeIso: `d${i}`, price }));
    const r = realisedVolatility(closes)!;
    const rets = [1.01, 99 / 101, 102 / 99, 100 / 102].map(Math.log);
    const mean = rets.reduce((a, b) => a + b) / 4;
    const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / 3);
    expect(r.value).toBeCloseTo(sd * Math.sqrt(252), 12);
    expect(r.returns).toBe(4);
    expect(realisedVolatility(closes.slice(0, 2))).toBeNull();
    // Rounds 1..100 of phase 2, one every 600 s from t0, answer = 1000 + id.
    const base = 2n << 64n;
    const t0 = 1_000_000;
    let reads = 0;
    const getRound = async (id: bigint) => {
      reads++;
      const n = id - base;
      return [id, 1000n + n, 0n, BigInt(t0 + Number(n) * 600), id] as const;
    };
    expect(await roundAt(getRound, base + 100n, BigInt(t0 + 60_000), t0 + 30_100)).toBe(1050n);
    expect(reads).toBeLessThan(10);
    expect(await roundAt(getRound, base + 100n, BigInt(t0 + 60_000), t0 + 100)).toBeNull();
    expect(await roundAt(getRound, base + 100n, BigInt(t0 + 60_000), t0 + 99_999)).toBe(1100n);
  });

  it("lists the last sessions' closes from the calendar, oldest first", async () => {
    const isTradingDay = async (day: bigint) =>
      ![0, 6].includes(new Date(Number(day) * 86_400_000).getUTCDay());
    const sessionOf = async (day: bigint) => {
      const open = Number(day) * 86_400 + 13.5 * 3600;
      return [BigInt(open), BigInt(open + 6.5 * 3600)] as const;
    };
    const closes = await previousCloses(isTradingDay, sessionOf, SAT, 3);
    expect(closes.map((c) => new Date(c * 1000).toISOString())).toEqual([
      "2026-09-30T20:00:00.000Z",
      "2026-10-01T20:00:00.000Z",
      "2026-10-02T20:00:00.000Z",
    ]);
  });

  it("finds the next open and close from the calendar over a weekend", async () => {
    const open = (day: bigint) => Number(day) * 86_400 + 13.5 * 3600;
    const session = await nextSession(
      async (day) => ![0, 6].includes(new Date(Number(day) * 86_400_000).getUTCDay()),
      async (day) => [BigInt(open(day)), BigInt(open(day) + 6.5 * 3600)] as const,
      SAT,
    );
    expect(session.nextOpen).toBe(MON_OPEN);
    expect(utcLabel(session.nextOpen!)).toBe("Mon 5 Oct 13:30 UTC");
    expect(session.nextClose).toBe(MON_OPEN + 6.5 * 3600);
  });
});

/** A put risk_check at spot 370.448: the strike falls with the target delta; yield and fair value consistent. */
function fakeCheck(args: Record<string, unknown>, spot = 370.448): RiskCheck {
  const d = Number(args.targetDeltaBps ?? 2000);
  const premiumBps = Number(args.premiumBps ?? 10_000);
  const strike = Number((spot * (1 - ((4000 - d) / 4000) * 0.12)).toFixed(2));
  const fair = 3.47 * (d / 2000) ** 1.5;
  const capacity = 60 / strike;
  const size = args.size !== undefined ? String(args.size) : String((capacity * 0.8).toFixed(18));
  const deltaOk = d >= mandate.minDeltaBps && d <= mandate.maxDeltaBps;
  const premiumOk = premiumBps >= mandate.minPremiumBps;
  const ok = deltaOk && premiumOk;
  return {
    vaultSymbol: "sTSLA-CSP",
    isCall: false,
    proposal: {
      mode: "delta",
      strike: strike.toFixed(2),
      targetDeltaBps: d,
      expiryIso: "2026-10-09T20:00:00.000Z",
      size,
      premiumBps,
    },
    ok,
    reason: ok ? "None" : !premiumOk ? "PremiumBelowFair" : "DeltaOutOfBand",
    explanation: ok ? "Inside the mandate." : "Outside the mandate.",
    measured: {
      fairValue: fair.toFixed(4),
      delta: d / 10_000,
      capacity: capacity.toFixed(18),
      yieldBps: Number((((fair * premiumBps) / 10_000 / strike) * 10_000).toFixed(2)),
    },
    spot: String(spot),
    suggestion: null,
  };
}

/** The risk engine as a fixture: fixed greeks, the put payout at -30% for the stress. */
const engine: RiskEngineReader = {
  address: "0x61158d98C6C2b7cCb22755A098D0Da2BbCf2a4Ec",
  via: "EpochManager.pricer()",
  async greeks() {
    return { delta: -0.2, gamma: 0.0094, vega: 13.96, theta: -0.634 };
  },
  async scenarioLoss(_isCall, strike, soldWad, spot, shocks) {
    const losses = shocks.map((s) => {
      const shocked = (spot * (10n ** 18n + s)) / 10n ** 18n;
      return strike > shocked ? ((strike - shocked) * soldWad) / 10n ** 18n : 0n;
    });
    const worst = losses.reduce((a, b) => (b > a ? b : a), 0n);
    return { worst, losses };
  },
};

const blockTimeIso = new Date(SAT * 1000).toISOString();
const cand = (d: number, over: Record<string, unknown> = {}) =>
  candidateFromCheck("ladder", fakeCheck({ targetDeltaBps: d, ...over }), mandate, blockTimeIso);
const TENOR = Date.parse("2026-10-09T20:00:00Z") / 1000 - SAT;
const ctx = { spot: 370.448, sigma: 0.6, tenorSeconds: TENOR, isCall: false };

async function table(deltas = [500, 1000, 1500, 2000, 2500, 3000, 3500, 4000]) {
  return riskTable({
    ladder: deltas.map((d) => cand(d)),
    engine,
    spot: 370.448,
    sigma: 0.6,
    nowSec: SAT,
    expirySec: SAT + TENOR,
    isCall: false,
    premiumBps: 10_000,
  });
}

describe("risk analyst", () => {
  it("adds the engine's greeks, the ±30% stress, the break-even and the model odds to each rung", async () => {
    const row = await riskRow(cand(2000), ctx, engine);
    expect(row.greeks).toEqual({ delta: -0.2, gamma: 0.0094, vega: 13.96, theta: -0.634 });
    const strike = Number(row.strike);
    const size = Number(row.size);
    expect(row.stress).toMatchObject({ worstShock: -0.3 });
    const stress = row.stress as {
      worstLossUsd: string;
      shareOfCollateral: number;
      premiumIncomeUsd: string;
    };
    expect(Number(stress.worstLossUsd)).toBeCloseTo((strike - 370.448 * 0.7) * size, 4);
    expect(stress.shareOfCollateral).toBeCloseTo(1 - (370.448 * 0.7) / strike, 4);
    expect(Number(row.breakEven)).toBeCloseTo(strike - Number(row.premium), 5);
    expect(row.breakEvenDistance).toBeCloseTo((370.448 - Number(row.breakEven)) / 370.448, 6);
    expect(row.exerciseProbability).toBeGreaterThan(0.2);
    expect(row.exerciseProbability).toBeLessThan(0.3);
  });

  it("measures a covered call's stress in tokens of collateral at the shocked spot", async () => {
    const callEngine: RiskEngineReader = {
      ...engine,
      async scenarioLoss(_isCall, strike, soldWad, spot, shocks) {
        // USD value of what the vault pays holders: (S' - K) per option above the strike.
        const losses = shocks.map((sh) => {
          const shocked = (spot * (10n ** 18n + sh)) / 10n ** 18n;
          return shocked > strike ? ((shocked - strike) * soldWad) / 10n ** 18n : 0n;
        });
        return { worst: losses.reduce((a, b) => (b > a ? b : a), 0n), losses };
      },
    };
    const call = {
      ...cand(2000),
      strike: "390.00",
      size: "4",
      premium: "3.5",
    };
    const row = await riskRow(call, { ...ctx, isCall: true }, callEngine);
    expect(row.stress).toMatchObject({ worstShock: 0.3 });
    const stress = row.stress as { shareOfCollateral: number; worstLossUsd: string };
    const shocked = 370.448 * 1.3;
    expect(Number(stress.worstLossUsd)).toBeCloseTo((shocked - 390) * 4, 3);
    expect(stress.shareOfCollateral).toBeCloseTo((shocked - 390) / shocked, 6);
    expect(Number(row.breakEven)).toBeCloseTo(393.5, 6);
  });

  it("computes the model probability of exercise as N(d2), below a call's delta and above a put's |delta|", () => {
    const call = exerciseProbability(100, 105, 7 * 86_400, 0.6, true)!;
    const put = exerciseProbability(100, 95, 7 * 86_400, 0.6, false)!;
    expect(call).toBeLessThan(blackScholes(100, 105, 7 * 86_400, 0.6, true).delta);
    expect(put).toBeGreaterThan(Math.abs(blackScholes(100, 95, 7 * 86_400, 0.6, false).delta));
    expect(exerciseProbability(100, 95, 0, 0.6, false)).toBe(0);
    expect(exerciseProbability(0, 95, 100, 0.6, false)).toBeNull();
    expect(breakEven(100, 2, true)).toBe(102);
    expect(breakEven(100, 2, false)).toBe(98);
  });

  it("records an engine failure as not provided, never a default", async () => {
    const broken: RiskEngineReader = {
      ...engine,
      greeks: async () => {
        throw new Error("PricerInputOutOfRange(3)");
      },
      scenarioLoss: async () => {
        throw new Error("execution reverted");
      },
    };
    const row = await riskRow(cand(2000), ctx, broken);
    expect(row.greeks).toMatchObject({ provided: false });
    expect(row.stress).toMatchObject({ provided: false });
    expect(row.exerciseProbability).not.toBeNull(); // computed off-chain, still there
    const none = await riskRow(cand(2000), ctx, notProvided("no risk engine is deployed"));
    expect(none.greeks).toEqual({ provided: false, reason: "no risk engine is deployed" });
  });

  it("keeps a rung that could not be dry-run as an error row without numbers", async () => {
    const t = await riskTable({
      ladder: [{ ...cand(2000), ok: false, reason: null, strike: null, error: "rpc timeout" }],
      engine,
      spot: 370.448,
      sigma: 0.6,
      nowSec: SAT,
      expirySec: SAT + TENOR,
      isCall: false,
      premiumBps: 10_000,
    });
    expect(t.rows[0]).toMatchObject({ error: "rpc timeout", breakEven: null, exerciseProbability: null });
    expect(t.engine).toEqual({ address: engine.address, via: "EpochManager.pricer()" });
  });
});

describe("strike planner", () => {
  it("takes the profile's rung, else the nearest accepted one (ties further out of the money), else nothing", async () => {
    const t = await table();
    expect(pickRung(t.rows, 2000)?.targetDeltaBps).toBe(2000);
    expect(pickRung(t.rows, 4000)?.targetDeltaBps).toBe(3500);
    expect(pickRung(t.rows, 2250)?.targetDeltaBps).toBe(2000);
    expect(pickRung(t.rows, 2000, { below: 2000 })?.targetDeltaBps).toBe(1500);
    expect(pickRung(t.rows, 2000, { below: 1000 })).toBeNull();
    const choice = ruleChoice(t.rows, { targetDeltaBps: 2000, premiumBps: 10_000, reasoning: "" })!;
    expect(choice).toMatchObject({ targetDeltaBps: 2000, from: "ladder", strike: t.rows[3]!.strike });
  });

  it("matches Claude's delta to the ladder, or leaves the strike to the critic's exact dry run", async () => {
    const t = await table();
    expect(claudeChoice(t.rows, { targetDeltaBps: 2500, premiumBps: 10_200 })).toMatchObject({
      from: "ladder",
    });
    expect(claudeChoice(t.rows, { targetDeltaBps: 1800, premiumBps: 10_200 })).toMatchObject({
      from: "claude",
      strike: null,
      size: null,
    });
  });
});

/** The critic's inputs for a plan at `d` delta, with overrides. */
async function criticInput(
  d = 2000,
  over: { check?: RiskCheck; brief?: ReturnType<typeof marketBrief> } = {},
) {
  const t = await table();
  const check = over.check ?? fakeCheck({ targetDeltaBps: d, premiumBps: 10_000 });
  const c = candidateFromCheck("ladder", check, mandate, blockTimeIso);
  const exact = await riskRow(c, { ...ctx, spot: Number(check.spot) }, engine);
  return {
    brief: over.brief ?? marketBrief(reads()),
    check,
    exact,
    tableRow: t.rows.find((r) => r.targetDeltaBps === d) ?? null,
    table: t,
    failedRule: c.failedRule,
  };
}

const ruleOf = (rules: ReturnType<typeof criticRules>, name: string) => rules.find((r) => r.rule === name)!;

describe("critic", () => {
  it("passes a sound plan on all five rules", async () => {
    const rules = criticRules(await criticInput());
    // Every rule is evaluated, in priority order, each with a reason code and its numbers.
    expect(rules.map((r) => `${r.priority} ${r.rule} ${r.code}`)).toEqual([
      "P0 market MARKET_NO_GO",
      "P1 mandate MANDATE_REJECTED",
      "P2 cushion CUSHION_TOO_THIN",
      "P3 drift ANALYSIS_DRIFT",
      "P4 yield YIELD_MISMATCH",
    ]);
    expect(rules.every((r) => r.ok)).toBe(true);
    const cushion = ruleOf(rules, "cushion");
    expect(cushion.value).toBeGreaterThan(cushion.threshold!);
    expect(ruleOf(rules, "drift")).toMatchObject({ value: 0, threshold: 0.005 });
    expect(ruleOf(rules, "market")).toMatchObject({ value: 0, threshold: 0 });
  });

  it("vetoes when the market brief does not allow trading", async () => {
    const r = ruleOf(criticRules(await criticInput(2000, { brief: marketBrief(weekend()) })), "market");
    expect(r).toMatchObject({ ok: false, limit: "the market analyst's go" });
    expect(r.measured).toContain("market closed until Mon 5 Oct 13:30 UTC");
  });

  it("vetoes a plan the contract's previewProposal rejects, with the rule's measured value and limit", async () => {
    const r = ruleOf(criticRules(await criticInput(3800)), "mandate");
    expect(r).toMatchObject({ ok: false, measured: "DeltaOutOfBand: |delta| 0.38", limit: "0.10 to 0.35" });
  });

  it("vetoes a strike too close to spot for the one-sigma move, naming the stress loss", async () => {
    const r = ruleOf(criticRules(await criticInput(3500)), "cushion");
    expect(r.ok).toBe(false);
    expect(r.measured).toMatch(/break-even \$[\d.]+ is [\d.]+% below spot/);
    expect(r.measured).toContain("worst ±30% move (-30%) would cost $");
    expect(r.limit).toContain(`${CUSHION_SIGMAS} x the`);
  });

  it("vetoes a yield that does not match its own fair value, premium and collateral", async () => {
    const check = fakeCheck({ targetDeltaBps: 2000 });
    const bad = { ...check, measured: { ...check.measured, yieldBps: check.measured.yieldBps * 2 } };
    expect(rebuiltYieldBps(check)).toBeCloseTo(check.measured.yieldBps, 1);
    const r = ruleOf(criticRules(await criticInput(2000, { check: bad })), "yield");
    expect(r.ok).toBe(false);
  });

  it("vetoes drift between the risk table and the exact dry run (the spot moved), and says when it cannot compare", async () => {
    const moved = fakeCheck({ targetDeltaBps: 2000 }, 380);
    const r = ruleOf(criticRules(await criticInput(2000, { check: moved })), "drift");
    expect(r.ok).toBe(false);
    const input = await criticInput(2000);
    const na = ruleOf(criticRules({ ...input, tableRow: null }), "drift");
    expect(na).toMatchObject({ ok: true, applicable: false });
  });

  it("modifies inside the mandate, recording each change before and after", () => {
    const choice = {
      targetDeltaBps: 4200,
      premiumBps: 9000,
      desiredDeltaBps: 4200,
      strike: "360",
      size: "1",
      from: "claude" as const,
      reason: "",
    };
    const { choice: next, modifications } = mandateModifications(choice, mandate);
    expect(next).toMatchObject({ targetDeltaBps: 3400, premiumBps: 9500, strike: null, size: null });
    expect(modifications).toEqual([
      expect.objectContaining({ field: "targetDeltaBps", before: 4200, after: 3400 }),
      expect.objectContaining({ field: "premiumBps", before: 9000, after: 9500 }),
    ]);
    expect(sizeModification("0.138", "0.1727", 0.5, "conservative")).toMatchObject({
      field: "size",
      before: "0.138",
      after: "0.08635",
    });
    expect(sizeModification("0.05", "0.1727", 0.5, "conservative")).toBeNull();
    expect(sizeModification("0.138", "0.1727", 1, "default")).toBeNull();
  });

  it("lists the alternatives to grade, with what the agent did, and computes confidence as model odds", async () => {
    const input = await criticInput(2000);
    const alts = alternatives({ exact: input.exact, table: input.table, proposed: true });
    expect(alts.map((a) => a.name)).toEqual([
      "chosen strike",
      "kept cash",
      "half size",
      "one step nearer",
      "one step farther",
    ]);
    expect(alts.filter((a) => a.taken).map((a) => a.name)).toEqual(["chosen strike"]);
    expect(Number(alts[2]!.size)).toBeCloseTo(Number(alts[0]!.size) / 2, 5);
    expect(alts[3]!.targetDeltaBps).toBe(2500);
    expect(alts[4]!.targetDeltaBps).toBe(1500);
    const noTrade = alternatives({ exact: null, table: null, proposed: false });
    expect(noTrade).toEqual([expect.objectContaining({ name: "kept cash", taken: true })]);
    const c = confidence(input.exact, input.table)!;
    expect(c.kind).toBe("model odds");
    expect(c.worthlessProbability).toBeCloseTo(1 - input.exact.exerciseProbability!, 10);
    expect(c.basis).toContain("not self-reported");
  });
});

const vaultState = (): VaultState => ({
  vault: {
    address: "0x1bc73c1B28F520E57982FAe6127477190FA53690",
    symbol: "sTSLA-CSP",
    name: "Strike TSLA Cash-Secured Put",
    kind: "cash-secured-put",
    epochState: "Idle",
    agentId: "1",
    underlying: { symbol: "TSLA" },
    asset: { symbol: "USDG" },
    totalAssets: "60",
    sigma: 0.6,
    mandate,
    series: null,
  },
  spot: { price: "370.448", status: "Ok", ok: true },
  marketOpen: false,
  blockTimeIso,
  nextExpiryIso: "2026-10-09T20:00:00.000Z",
  agent: { agentId: "1", active: true, bond: "70", strikes: 1 },
  nextStep: "Idle",
});

const accepted: ProposeResult = {
  submitted: true,
  accepted: true,
  reason: "None",
  explanation: "Accepted: series 42 is on sale.",
  seriesId: "42",
  strike: "347.67",
  size: "0.138",
  slashed: "0",
  txHash: `0x${"b".repeat(64)}`,
  openTxHash: `0x${"a".repeat(64)}`,
  agent: { bond: "70", strikes: 1, maxStrikes: 3, rejected: 1, active: true },
};

/** Run the pipeline on fakes; returns the outcome, the journal and the risk_check calls made. */
async function run(
  opts: Partial<Parameters<typeof runPipeline>[0]> = {},
  deps: Partial<PipelineDeps> & { market?: MarketReads } = {},
) {
  const journal = new Journal("propose", 46630, null);
  const state = vaultState();
  journal.vaultRead(state);
  const calls: Record<string, unknown>[] = [];
  let t = 0;
  const outcome = await runPipeline(
    { llm: false, profile: PROFILES.default!, targetDelta: 0.2, dryRun: true, ignoreSession: false, ...opts },
    {
      state,
      journal,
      riskCheck: async (args) => {
        calls.push(args);
        return fakeCheck(args);
      },
      readMarket: async () => deps.market ?? reads(),
      riskEngine: async () => engine,
      say: () => {},
      step: () => {},
      clock: () => (t += 5),
      ...deps,
    },
  );
  journal.market = marketInputs(state, null);
  return { outcome, journal, calls, record: journal.build()! };
}

describe("the pipeline end to end", () => {
  it("stops at the market analyst on a weekend: a recorded no-trade, the other four stages not run", async () => {
    const { outcome, record, calls } = await run({}, { market: weekend() });
    expect(outcome).toEqual({
      kind: "no-trade",
      stage: "market",
      reasons: ["market closed until Mon 5 Oct 13:30 UTC"],
    });
    expect(calls).toHaveLength(0);
    const p = record.decision!.pipeline!;
    expect(p.map((s) => [s.stage, s.verdict])).toEqual([
      ["market", "fail"],
      ["risk", "not-run"],
      ["planner", "not-run"],
      ["critic", "not-run"],
      ["contract", "not-run"],
    ]);
    expect(p[4]!.summary).toContain("no proposal was sent");
    expect(record.result).toMatchObject({
      status: "not-sent",
      reason: "no-trade",
      noTrade: { stage: "market", reasons: ["market closed until Mon 5 Oct 13:30 UTC"] },
    });
    expect(record.decision!.alternatives).toEqual([
      expect.objectContaining({ name: "kept cash", taken: true }),
    ]);
  });

  it("runs every specialist on an open market and stops before the contract on a dry run", async () => {
    const { outcome, record } = await run();
    expect(outcome.kind).toBe("dry-run");
    const p = record.decision!.pipeline!;
    expect(p.map((s) => s.stage)).toEqual([...PIPELINE_STAGES]);
    expect(p.map((s) => s.verdict)).toEqual(["pass", "pass", "pass", "pass", "not-run"]);
    expect(p.every((s) => s.by === (s.stage === "contract" ? "contract" : "rule"))).toBe(true);
    expect(p.slice(0, 4).every((s) => s.durationMs > 0 && s.sources.length > 0)).toBe(true);
    // The risk analyst counts the rejections by reason; the planner lists every rung it looked at.
    expect(p[1]!.output.rejections).toEqual({ DeltaOutOfBand: 2 });
    const considered = p[2]!.output.considered as { targetDeltaBps: number; selected: boolean }[];
    expect(considered[0]).toMatchObject({ targetDeltaBps: 2000, selected: true });
    expect(considered.filter((c) => c.selected)).toHaveLength(1);
    // The contract stage keeps the payload, bound to the critic's proposal by a digest.
    const pre = p[4]!.inputs.preflight as {
      proposalDigest: string;
      checks: { check: string; ok: boolean }[];
    };
    expect(pre.proposalDigest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(pre.checks.map((c) => [c.check, c.ok])).toEqual([
      ["binding", true],
      ["approval-age", true],
      ["live-only", true],
    ]);
    expect(record.decision!.candidates!.filter((c) => c.chosen).map((c) => c.targetDeltaBps)).toEqual([2000]);
    expect(record.dryRun).toMatchObject({ ok: true, targetDeltaBps: 2000 });
    expect(record.decision!.confidence?.kind).toBe("model odds");
    expect(record.decision!.contradictions).toHaveLength(3);
    expect(record.result.status).toBe("not-sent");
  });

  it("sends through the contract when it is not a dry run, and records the contract's verdict", async () => {
    const sent: Record<string, unknown>[] = [];
    const { outcome, record } = await run(
      { dryRun: false },
      {
        propose: async (args) => {
          sent.push(args);
          return accepted;
        },
      },
    );
    expect(outcome.kind).toBe("sent");
    expect(sent).toEqual([expect.objectContaining({ targetDeltaBps: 2000, premiumBps: 10_000 })]);
    expect(record.decision!.pipeline!.at(-1)).toMatchObject({
      stage: "contract",
      verdict: "pass",
      by: "contract",
    });
    expect(record.result.status).toBe("accepted");
    expect(record.decision!.alternatives!.find((a) => a.taken)?.name).toBe("chosen strike");
  });

  it("records the conservative profile's size cap as a MODIFY and re-runs the mandate check on it", async () => {
    const { record, calls } = await run({ profile: PROFILES.conservative! });
    const critic = record.decision!.pipeline!.find((s) => s.stage === "critic")!;
    expect(critic.verdict).toBe("modify");
    const mods = critic.output.modifications as { field: string; before: string; after: string }[];
    expect(mods).toEqual([expect.objectContaining({ field: "size" })]);
    expect(Number(mods[0]!.after)).toBeLessThan(Number(mods[0]!.before));
    expect(calls.at(-1)).toMatchObject({ size: mods[0]!.after }); // the last check is on the changed plan
    expect(record.dryRun!.size).toBe(mods[0]!.after);
    // The note keeps the wording the app's what-if page parses.
    expect(record.decision!.notes).toContain(
      `Profile "conservative" capped the size at 50% of capacity: ${mods[0]!.before} → ${mods[0]!.after}.`,
    );
  });

  it("retries one rung further out after a cushion veto, then passes", async () => {
    // Saturday's tenor to Friday 9 Oct: the 0.34 rung's break-even is inside half a one-sigma move.
    const { record, outcome } = await run({ targetDelta: 0.34 }, { market: reads({ now: SAT }) });
    expect(outcome.kind).toBe("dry-run");
    const p = record.decision!.pipeline!;
    expect(p.map((s) => `${s.stage}${s.attempt}:${s.verdict}`)).toEqual([
      "market1:pass",
      "risk1:pass",
      "planner1:pass",
      "critic1:fail",
      "planner2:pass",
      "critic2:pass",
      "contract1:not-run",
    ]);
    expect(p[3]!.output.veto as string[]).toEqual(["cushion"]);
    expect(record.decision!.targetDeltaBps).toBeLessThan(3400);
    expect(record.decision!.notes.join(" ")).toContain("the planner retried further out of the money");
  });

  it("makes a yield veto a no-trade without a retry (a stale analysis is not fixed by another rung)", async () => {
    const { outcome, record } = await run(
      {},
      {
        // The ladder dry-runs without a size; the critic's exact dry run passes the rung's size. Only that one
        // reports a yield its own fair value, premium and collateral do not give.
        riskCheck: async (args) => {
          const c = fakeCheck(args);
          return args.size === undefined
            ? c
            : { ...c, measured: { ...c.measured, yieldBps: c.measured.yieldBps * 3 } };
        },
      },
    );
    expect(outcome).toMatchObject({ kind: "no-trade", stage: "critic" });
    expect(record.decision!.pipeline!.map((s) => s.verdict)).toEqual([
      "pass",
      "pass",
      "pass",
      "fail",
      "not-run",
    ]);
    expect(record.result.noTrade!.reasons[0]).toMatch(/^yield: /);
  });

  it("with --llm, Claude chooses and its words are labelled narration; the numbers stay the tools'", async () => {
    let context = "";
    const claude: ClaudePlan = {
      plan: {
        targetDeltaBps: 2500,
        premiumBps: 10_000,
        reasoning: "0.25 earns more and stays inside the band.",
      },
      kind: "claude-code",
      model: "claude-opus-5",
      label: "Claude via Claude Code CLI, model claude-opus-5",
      calls: [
        {
          tool: "risk_check",
          input: { targetDeltaBps: 2500, premiumBps: 10_000 },
          result: fakeCheck({ targetDeltaBps: 2500 }),
          error: null,
        },
      ],
    };
    const { record } = await run(
      { llm: true },
      {
        planClaude: async (c) => {
          context = c;
          return claude;
        },
      },
    );
    const planner = record.decision!.pipeline!.find((s) => s.stage === "planner")!;
    expect(planner.by).toBe("claude");
    expect(planner.narration).toEqual({
      by: "claude",
      label: "Claude via Claude Code CLI, model claude-opus-5",
      text: "0.25 earns more and stays inside the band.",
    });
    expect(planner.output).toMatchObject({ targetDeltaBps: 2500, from: "ladder" });
    for (const s of record.decision!.pipeline!.filter((x) => x.stage !== "planner"))
      expect(s.narration).toBeUndefined();
    expect(JSON.parse(context).riskTable.rows).toHaveLength(8);
    expect(record.decision!.strategy).toBe("claude");
    expect(record.decision!.candidates!.some((c) => c.source === "planner")).toBe(true);
    expect(record.decision!.contradictions!.at(-1)).toMatchObject({
      between: ["Claude's own risk_check of its plan", "the critic's exact dry run"],
      agree: true,
    });
    const md = formatRecordMarkdown(record);
    expect(md).toContain(
      "Narration by Claude via Claude Code CLI, model claude-opus-5 (Claude's words, not a computed number):",
    );
  });

  it("records what Claude used: decision.llm and the planner stage's usage; rule mode has no llm field", async () => {
    const usage: LlmUsage = {
      planner: "claude-code",
      model: "claude-opus-5",
      calls: 4,
      inputTokens: 11,
      outputTokens: 1_900,
      cacheReadTokens: 50_000,
      cacheCreationTokens: 12_000,
      costUsd: 0.31,
      durationMs: 33_000,
      source: "Claude Code stream-json result message",
    };
    const claude: ClaudePlan = {
      plan: { targetDeltaBps: 2500, premiumBps: 10_000, reasoning: "0.25 earns more." },
      kind: "claude-code",
      model: "claude-opus-5",
      label: "Claude via Claude Code CLI, model claude-opus-5",
      calls: [],
      usage,
    };
    const { record } = await run({ llm: true }, { planClaude: async () => claude });
    expect(record.decision!.llm).toEqual(usage);
    const planner = record.decision!.pipeline!.find((s) => s.stage === "planner")!;
    expect(planner.usage).toEqual(usage);
    for (const s of record.decision!.pipeline!.filter((x) => x.stage !== "planner"))
      expect(s.usage).toBeUndefined();
    expect(unanchoredJson(record)).toContain('"inputTokens": 11');
    const md = formatRecordMarkdown(record);
    expect(md).toContain("- **Claude usage:** 4 calls, 11 input tokens, 1,900 output tokens");
    expect(md).toContain("  - Claude usage: 4 calls");
    // Without the field the hash is the one older agents would compute.
    const { llm: _l, ...rest } = record.decision!;
    expect(recordHash({ ...record, decision: rest })).not.toBe(recordHash(record));
    expect(unanchoredJson({ ...record, decision: rest })).not.toContain('"llm"');

    const rule = await run({ llm: false });
    expect(rule.record.decision!.llm).toBeUndefined();
    expect(unanchoredJson(rule.record)).not.toContain('"llm"');
    expect(rule.record.decision!.pipeline!.every((s) => s.usage === undefined)).toBe(true);
  });

  it("keeps the tokens Claude spent when it gave no plan and the rule planner chose", async () => {
    const usage: LlmUsage = {
      planner: "api",
      model: "claude-opus-5",
      calls: 2,
      inputTokens: 900,
      outputTokens: { provided: false, reason: "2 of 2 API responses did not report output_tokens" },
      durationMs: 4_000,
      source: "Messages API usage objects, summed over 2 responses",
    };
    const { record } = await run(
      { llm: true },
      { planClaude: async () => ({ plan: null, reason: "Claude submitted no plan", calls: [], usage }) },
    );
    expect(record.decision!.llm).toEqual(usage);
    expect(record.decision!.pipeline!.find((s) => s.stage === "planner")!.usage).toEqual(usage);
    expect(formatRecordMarkdown(record)).toContain("output tokens not provided");
  });

  it("with --llm and no plan from Claude, the rule planner chooses and the record says why", async () => {
    const { record } = await run(
      { llm: true },
      { planClaude: async () => ({ plan: null, reason: "no credentials", calls: [] }) },
    );
    const planner = record.decision!.pipeline!.find((s) => s.stage === "planner")!;
    expect(planner.by).toBe("rule");
    expect(planner.narration).toBeUndefined();
    expect(record.decision!.notes.join(" ")).toContain("Claude gave no plan (no credentials)");
  });

  it("records the no-trade's reason codes: the market's and the critic's", async () => {
    const closed = await run({}, { market: weekend() });
    expect(closed.record.result.noTrade!.codes).toEqual(["MARKET_CLOSED"]);
    const stale = await run(
      {},
      { market: reads({ oracle: { status: "StalePrice", price: "370.448", updatedAt: MON - 100_000 } }) },
    );
    expect(stale.record.result.noTrade!.codes).toEqual(["FEED_STALE"]);
  });

  it("does not send when the critic's approval has gone stale, and records the preflight", async () => {
    let t = 0;
    const sent: unknown[] = [];
    const { outcome, record } = await run(
      { dryRun: false },
      {
        clock: () => (t += 61_000), // two readings between the critic's pass and the send: 122 s
        propose: async (a) => {
          sent.push(a);
          return accepted;
        },
      },
    );
    expect(sent).toHaveLength(0);
    expect(outcome).toMatchObject({ kind: "no-trade", stage: "contract" });
    expect(record.result.noTrade).toMatchObject({ stage: "contract", codes: ["APPROVAL_EXPIRED"] });
    expect(record.result.summary).toContain("the preflight before sending stopped the run");
    const contract = record.decision!.pipeline!.at(-1)!;
    expect(contract).toMatchObject({ stage: "contract", verdict: "not-run" });
    expect(contract.summary).toContain("approval-age");
  });

  it("checks the payload against the critic's proposal, the approval's age and dry-run-only flags", () => {
    const approved = {
      targetDeltaBps: 2000,
      premiumBps: 10_000,
      size: "0.1",
      expiryIso: "2026-10-09T20:00:00.000Z",
    };
    const args = { vault: "0x1", targetDeltaBps: 2000, premiumBps: 10_000, size: "0.1" };
    const ok = preflightChecks({ args, approved, approvedAgeMs: 1000, ignoreSession: false, sending: true });
    expect(ok.checks.every((c) => c.ok)).toBe(true);
    const bad = preflightChecks({
      args: { ...args, size: "0.2" },
      approved,
      approvedAgeMs: APPROVAL_TTL_MS + 1,
      ignoreSession: true,
      sending: true,
    });
    expect(bad.checks.map((c) => [c.code, c.ok])).toEqual([
      ["PAYLOAD_MISMATCH", false],
      ["APPROVAL_EXPIRED", false],
      ["DRY_RUN_FLAG_ON_SEND", false],
    ]);
    expect(bad.proposalDigest).toBe(ok.proposalDigest); // the digest is of what the critic approved
  });

  it("counts the risk table's rejections by reason, with unreadable rungs apart", async () => {
    const t = await table();
    expect(rejectionCounts(t.rows)).toEqual({ DeltaOutOfBand: 2 });
    expect(rejectionCounts([{ ...t.rows[1]!, ok: false, error: "x" }])).toEqual({ unreadable: 1 });
  });

  it("stops at the risk analyst when no rung is inside the mandate (an empty vault), naming the rejections", async () => {
    const { outcome, record } = await run(
      {},
      {
        riskCheck: async (args) => {
          const c = fakeCheck(args);
          return { ...c, ok: false, reason: "ZeroSize", measured: { ...c.measured, capacity: "0" } };
        },
      },
    );
    expect(outcome).toEqual({
      kind: "no-trade",
      stage: "risk",
      reasons: ["no rung of the ladder is inside the mandate (8 ZeroSize)"],
    });
    expect(record.result.noTrade!.codes).toEqual(["NO_RUNG_IN_MANDATE"]);
    expect(record.decision!.pipeline!.map((s) => s.verdict)).toEqual([
      "pass",
      "fail",
      "not-run",
      "not-run",
      "not-run",
    ]);
  });

  it("holds the conservative profile to a wider cushion", async () => {
    const input = await criticInput(3000);
    expect(ruleOf(criticRules(input), "cushion").ok).toBe(true);
    const strict = ruleOf(
      criticRules({ ...input, cushionSigmas: PROFILES.conservative!.cushionSigmas }),
      "cushion",
    );
    expect(strict.ok).toBe(false);
    expect(strict.limit).toContain("0.75 x the");
  });

  it("records a stage that fails to read as fail, the rest as not run, and stops the run", async () => {
    const journal = new Journal("propose", 46630, null);
    journal.vaultRead(vaultState());
    await expect(
      runPipeline(
        { llm: false, profile: PROFILES.default!, targetDelta: 0.2, dryRun: true, ignoreSession: false },
        {
          state: vaultState(),
          journal,
          riskCheck: async (a) => fakeCheck(a),
          readMarket: async () => {
            throw new Error("rpc https://key@x down");
          },
          riskEngine: async () => engine,
          say: () => {},
          step: () => {},
        },
      ),
    ).rejects.toThrow("Market analyst: rpc <url> down");
    expect(journal.pipeline!.map((s) => s.verdict)).toEqual([
      "fail",
      "not-run",
      "not-run",
      "not-run",
      "not-run",
    ]);
  });

  it("gives Claude only computed numbers as context", async () => {
    const t = await table();
    const c = JSON.parse(plannerContext(marketBrief(reads()), t));
    expect(c.marketBrief.go).toBe(true);
    expect(Object.keys(c.riskTable.rows[0])).toEqual([
      "targetDeltaBps",
      "ok",
      "reason",
      "strike",
      "yieldBps",
      "exerciseProbability",
      "breakEvenDistance",
      "stressShareOfCollateral",
    ]);
  });
});

describe("the record with a pipeline", () => {
  const recordOf = async (): Promise<DecisionRecord> =>
    (await run({ ignoreSession: true }, { market: weekend() })).record;

  it("hashes with the pipeline, and a record without one keeps its hash", async () => {
    const r = await recordOf();
    expect(unanchoredJson(r)).toContain('"pipeline"');
    const { pipeline: _p, alternatives: _a, confidence: _c, contradictions: _x, ...old } = r.decision!;
    const older = { ...r, decision: old };
    expect(recordHash(older)).not.toBe(recordHash(r));
    expect(unanchoredJson(older)).not.toContain('"pipeline"');
    const anchored = {
      ...r,
      anchor: {
        contract: `0x${"1".repeat(40)}`,
        recordHash: recordHash(r),
        uri: "u",
        epoch: 3,
        txHash: `0x${"c".repeat(64)}`,
      },
    };
    expect(verifyAnchoredRecord(formatRecordJson(anchored))).toBe(true);
    const tampered = structuredClone(anchored);
    tampered.decision!.pipeline![0]!.verdict = "fail";
    expect(verifyAnchoredRecord(formatRecordJson(tampered))).toBe(false);
  });

  it("labels a dry run and an --ignore-session run in the record and the file name", async () => {
    const r = await recordOf();
    expect(r.decision!.pipeline![0]!.output.sessionWaived).toBe(true);
    const j = new Journal("propose", 46630, null);
    j.vaultRead(vaultState());
    j.run = { dryRun: true, ignoreSession: true, note: "Dry run with --ignore-session." };
    j.finish({ status: "not-sent", summary: "x" });
    const built = j.build()!;
    expect(recordBaseName(built)).toBe("2026-10-03-sTSLA-CSP-as-if-open-dry-run");
    expect(recordBaseName({ ...built, run: { dryRun: true, ignoreSession: false, note: "" } })).toBe(
      "2026-10-03-sTSLA-CSP-dry-run",
    );
    expect(recordBaseName({ ...built, run: undefined })).toBe("2026-10-03-sTSLA-CSP");
    const claude = { kind: "claude-code" as const, model: "m", label: "Claude via Claude Code CLI, model m" };
    const byClaude = { ...built, decision: { ...built.decision!, planner: claude } };
    expect(recordBaseName(byClaude)).toBe("2026-10-03-sTSLA-CSP-as-if-open-claude-dry-run");
    expect(recordBaseName({ ...byClaude, run: undefined })).toBe("2026-10-03-sTSLA-CSP");
    expect(formatRecordMarkdown(built)).toContain("weekly proposal (dry run)");
  });

  it("renders a Specialists section and the alternatives, prettier-clean", async () => {
    const r = await recordOf();
    const md = formatRecordMarkdown(r);
    expect(md).toContain("## Specialists");
    expect(md).toContain("- **Market analyst** (agent code, 5 ms): PASS.");
    expect(md).toContain("failed, waived by --ignore-session (dry run)");
    expect(md).toContain("- **Contract**: NOT RUN.");
    expect(md).toContain("## Alternatives to grade at settlement");
    expect(md).toContain("**kept cash (what the agent did):**");
    expect(md).toContain("Model odds the option expires worthless:");
    expect(await prettier.format(md, { parser: "markdown", proseWrap: "preserve" })).toBe(md);
    const noTrade = formatRecordMarkdown((await run({}, { market: weekend() })).record);
    expect(noTrade).toContain("**No trade.**");
    expect(noTrade).toContain(
      "- **Risk analyst**: NOT RUN. The market analyst stopped the run before this stage",
    );
    expect(noTrade).not.toContain("undefined");
    expect(noTrade).toContain(
      "- **Stopped by:** the market analyst (market closed until Mon 5 Oct 13:30 UTC)",
    );
    expect(await prettier.format(noTrade, { parser: "markdown", proseWrap: "preserve" })).toBe(noTrade);
  });

  it("keeps a reckless or settle record free of pipeline fields", () => {
    const j = new Journal("settle", 46630, null);
    j.vaultRead(vaultState());
    j.finish({ status: "skipped", summary: "nothing" });
    const json = formatRecordJson(j.build()!);
    for (const k of ["pipeline", "alternatives", "confidence", "contradictions", '"run"'])
      expect(json).not.toContain(k);
  });

  it("a pipeline log times its stages and fills the ones never reached", async () => {
    let t = 100;
    const log = new PipelineLog(() => (t += 7));
    await log.run(async () => ({
      stage: "market",
      attempt: 1,
      verdict: "pass",
      summary: "go",
      inputs: {},
      output: {},
      sources: [],
      by: "rule",
    }));
    log.close("not run: test");
    expect(log.stages.map((s) => [s.stage, s.verdict, s.durationMs])).toEqual([
      ["market", "pass", 7],
      ["risk", "not-run", 0],
      ["planner", "not-run", 0],
      ["critic", "not-run", 0],
      ["contract", "not-run", 0],
    ]);
  });
});

export type { RiskRow };
