import { decisionRecordHash } from "@strike/sdk";
import * as prettier from "prettier";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { anchorRecord, recordHash, verifyAnchoredRecord } from "../src/anchor.js";
import {
  type PlannerCall,
  candidateFromCheck,
  cleanError,
  describeCandidate,
  failedRule,
  ladderDeltas,
  markChosen,
  plannerCandidates,
  premiumPerOption,
  runLadder,
} from "../src/candidates.js";
import { Journal } from "../src/journal.js";
import {
  type DecisionRecord,
  type RecordCandidate,
  formatRecordJson,
  formatRecordMarkdown,
  txUrl,
} from "../src/record.js";
import type { MandateView, RiskCheck, VaultState } from "../src/types.js";

// The alternatives the agent dry-ran, as the decision record keeps them: the ladder's shape, the chosen marker,
// Claude's captured calls, error entries, and that the record hash covers them.

const mandate: MandateView = {
  minDeltaBps: 1000,
  maxDeltaBps: 3500,
  minPremiumBps: 9500,
  minYieldBps: 5,
  maxShareSoldBps: 8000,
  minTenor: 86_400,
  maxTenor: 691_200,
  summary: "|delta| 0.10-0.35, premium >= 95% of fair value, yield >= 0.05% of collateral",
};
const NOW = "2026-10-05T15:02:11.000Z";
const EXPIRY = "2026-10-09T20:00:00.000Z";

/** A cash-secured put's risk_check: strikes fall as delta falls; the band decides the verdict. */
function check(targetDeltaBps: number, premiumBps = 10_800, over: Partial<RiskCheck> = {}): RiskCheck {
  const delta = Math.round((targetDeltaBps / 10_000) * 10_000) / 10_000;
  const strike = (372.61 * (1 - delta * 0.5)).toFixed(2);
  const inBand = targetDeltaBps >= mandate.minDeltaBps && targetDeltaBps <= mandate.maxDeltaBps;
  return {
    vaultSymbol: "sTSLA-CSP",
    isCall: false,
    proposal: { mode: "delta", strike, targetDeltaBps, expiryIso: EXPIRY, size: "0.419", premiumBps },
    ok: inBand,
    reason: inBand ? "None" : "DeltaOutOfBand",
    explanation: inBand ? "Inside the mandate: the contract would accept this proposal." : "outside the band",
    measured: { fairValue: "2.5118", delta, capacity: "0.52", yieldBps: 79.5 },
    spot: "372.61",
    suggestion: null,
    ...over,
  };
}

describe("ladderDeltas", () => {
  it("steps across the band and a little beyond each edge", () => {
    expect(ladderDeltas(mandate)).toEqual([500, 1000, 1500, 2000, 2500, 3000, 3500, 4000]);
  });

  it("always includes both edges, even off the step grid", () => {
    expect(ladderDeltas({ minDeltaBps: 1200, maxDeltaBps: 2700 })).toEqual([
      700, 1200, 1500, 2000, 2500, 2700, 3200,
    ]);
  });

  it("adds the chosen delta when it is off the grid, once", () => {
    expect(ladderDeltas(mandate, [1800])).toContain(1800);
    expect(ladderDeltas(mandate, [2000])).toEqual(ladderDeltas(mandate));
  });

  it("stays inside 0.01 to 0.49 and widens its step for a wide band", () => {
    const wide = ladderDeltas({ minDeltaBps: 200, maxDeltaBps: 4800 });
    expect(wide[0]).toBe(100);
    expect(wide.at(-1)).toBe(4900);
    expect(wide.length).toBeLessThanOrEqual(12);
    expect(wide).toEqual([...wide].sort((a, b) => a - b));
    expect(wide).toContain(200);
    expect(wide).toContain(4800);
  });
});

describe("failedRule", () => {
  const rule = (c: RiskCheck) => failedRule(c, mandate, NOW);

  it("is null when the contract accepts", () => {
    expect(rule(check(2000))).toBeNull();
  });

  it("names the measured value and the limit for each mandate rule", () => {
    expect(rule(check(5000, 10_800, { reason: "DeltaOutOfBand", ok: false }))).toEqual({
      rule: "DeltaOutOfBand",
      measured: "|delta| 0.5",
      limit: "0.10 to 0.35",
    });
    expect(rule(check(2000, 10_800, { ok: false, reason: "PremiumTooSmall" }))).toEqual({
      rule: "PremiumTooSmall",
      measured: "yield 0.8% of collateral",
      limit: "at least 0.05%",
    });
    expect(rule(check(2000, 9000, { ok: false, reason: "PremiumBelowFair" }))).toEqual({
      rule: "PremiumBelowFair",
      measured: "premium 90% of fair value",
      limit: "at least 95%",
    });
    expect(rule(check(2000, 40_000, { ok: false, reason: "PremiumAboveCap" }))).toMatchObject({
      measured: "premium 400% of fair value",
      limit: "at most 300%",
    });
    expect(rule(check(2000, 10_800, { ok: false, reason: "SizeTooLarge" }))).toMatchObject({
      measured: "size 0.419 options",
      limit: "80% of capacity 0.52 = 0.416 options",
    });
    expect(rule(check(2000, 10_800, { ok: false, reason: "StrikeWrongSide" }))).toMatchObject({
      measured: expect.stringContaining("against spot $372.61"),
      limit: "a put strikes below spot",
    });
    expect(rule(check(2000, 10_800, { ok: false, reason: "TenorOutOfRange" }))).toEqual({
      rule: "TenorOutOfRange",
      measured: "tenor 4.21 days",
      limit: "1 days to 8 days",
    });
  });

  it("still names the rule for a reason it has no numbers for", () => {
    expect(rule(check(2000, 10_800, { ok: false, reason: "InvalidExpiry" }))?.rule).toBe("InvalidExpiry");
  });
});

describe("the ladder", () => {
  const dryRuns: number[] = [];
  const call = async (args: { targetDeltaBps: number; premiumBps: number }) => {
    dryRuns.push(args.targetDeltaBps);
    if (args.targetDeltaBps === 4000) throw new Error("RPC https://rpc.example/v2/SECRETKEY timed out");
    return check(args.targetDeltaBps, args.premiumBps);
  };

  it("dry-runs every rung and keeps the contract's verdict, the first failed rule and an error entry", async () => {
    dryRuns.length = 0;
    const seen: number[] = [];
    const ladder = await runLadder({
      call,
      mandate,
      blockTimeIso: NOW,
      premiumBps: 10_800,
      chosenDeltaBps: 1500,
      onRung: (c) => seen.push(c.targetDeltaBps ?? -1),
    });
    expect(dryRuns).toEqual([500, 1000, 1500, 2000, 2500, 3000, 3500, 4000]);
    expect(seen).toEqual(dryRuns);
    expect(ladder.every((c) => c.source === "ladder" && c.premiumBps === 10_800)).toBe(true);

    const below = ladder[0];
    expect(below).toMatchObject({
      targetDeltaBps: 500,
      ok: false,
      reason: "DeltaOutOfBand",
      failedRule: { rule: "DeltaOutOfBand", measured: "|delta| 0.05", limit: "0.10 to 0.35" },
    });
    const inside = ladder[2];
    expect(inside).toMatchObject({
      targetDeltaBps: 1500,
      ok: true,
      reason: "None",
      failedRule: null,
      fairValue: "2.5118",
      premium: "2.712744",
      yieldBps: 79.5,
      size: "0.419",
      capacity: "0.52",
    });
    expect(inside?.strike).toMatch(/^\d+\.\d+$/);
  });

  it("turns a read that fails into an error entry without values, and never leaks a URL", async () => {
    const ladder = await runLadder({
      call,
      mandate,
      blockTimeIso: NOW,
      premiumBps: 10_800,
      chosenDeltaBps: null,
    });
    const err = ladder.at(-1);
    expect(err).toMatchObject({
      source: "ladder",
      targetDeltaBps: 4000,
      ok: false,
      reason: null,
      strike: null,
      fairValue: null,
      premium: null,
      yieldBps: null,
      failedRule: null,
      explanation: null,
      error: "RPC <url> timed out",
    });
    expect(JSON.stringify(err)).not.toContain("SECRETKEY");
    expect(describeCandidate(err!)).toContain("could not dry-run");
  });

  it("never throws when every rung fails", async () => {
    const ladder = await runLadder({
      call: async () => {
        throw new Error("down");
      },
      mandate,
      blockTimeIso: NOW,
      premiumBps: 10_000,
      chosenDeltaBps: 2000,
    });
    expect(ladder).toHaveLength(8);
    expect(ladder.every((c) => c.error === "down")).toBe(true);
  });

  it("records an incomplete tool result as an error entry, not a half-filled row", () => {
    const c = candidateFromCheck("ladder", { ok: true }, mandate, NOW, {
      asked: { targetDeltaBps: 2000, premiumBps: 10_000 },
    });
    expect(c).toMatchObject({
      ok: false,
      targetDeltaBps: 2000,
      error: "the risk check returned no usable result",
    });
  });

  it("marks the chosen rung, and only that one", async () => {
    const ladder = await runLadder({
      call,
      mandate,
      blockTimeIso: NOW,
      premiumBps: 10_800,
      chosenDeltaBps: 1500,
    });
    const marked = markChosen(ladder, { targetDeltaBps: 1500, premiumBps: 10_800 });
    expect(marked.filter((c) => c.chosen).map((c) => c.targetDeltaBps)).toEqual([1500]);
    // A different premium factor, or an error entry, is not the chosen candidate.
    expect(markChosen(ladder, { targetDeltaBps: 1500, premiumBps: 10_000 }).some((c) => c.chosen)).toBe(
      false,
    );
    expect(markChosen(ladder, { targetDeltaBps: 4000, premiumBps: 10_800 }).some((c) => c.chosen)).toBe(
      false,
    );
  });

  it("formats a premium to six decimals and trims zeros", () => {
    expect(premiumPerOption("2.5118", 10_800)).toBe("2.712744");
    expect(premiumPerOption("3", 10_000)).toBe("3");
    expect(premiumPerOption(null, 10_000)).toBeNull();
    expect(cleanError(new Error("a  b\n https://x.test/k?key=1 c"))).toBe("a b <url> c");
  });
});

describe("Claude's captured risk_check calls", () => {
  const calls: PlannerCall[] = [
    {
      tool: "risk_check",
      input: { vault: "0xV", targetDeltaBps: 1500, premiumBps: 10_800 },
      result: check(1500),
      error: null,
    },
    { tool: "risk_check", input: { vault: "0xV", targetDeltaBps: 5000 }, result: check(5000), error: null },
    {
      tool: "risk_check",
      input: { vault: "0xV", targetDeltaBps: 1500, premiumBps: 10_800 },
      result: check(1500),
      error: null,
    },
    { tool: "risk_check", input: { vault: "0xV", targetDeltaBps: 2500 }, result: null, error: "tool error" },
  ];

  it("keeps each call's inputs and result, in call order, and an error for a failed call", () => {
    const cands = plannerCandidates(calls, mandate, NOW);
    expect(cands.map((c) => [c.source, c.targetDeltaBps, c.ok])).toEqual([
      ["planner", 1500, true],
      ["planner", 5000, false],
      ["planner", 1500, true],
      ["planner", 2500, false],
    ]);
    expect(cands[0]?.inputs).toEqual({ vault: "0xV", targetDeltaBps: 1500, premiumBps: 10_800 });
    expect(cands[1]?.failedRule?.rule).toBe("DeltaOutOfBand");
    expect(cands[3]).toMatchObject({ error: "tool error", targetDeltaBps: 2500, reason: null, strike: null });
  });

  it("marks only the last accepted call that asked for the chosen delta and premium", () => {
    const marked = markChosen(plannerCandidates(calls, mandate, NOW), {
      targetDeltaBps: 1500,
      premiumBps: 10_800,
    });
    expect(marked.map((c) => c.chosen)).toEqual([false, false, true, false]);
  });
});

// ---- the record: shape, hashing and markdown ---------------------------------------------------------------------

const vaultState = (): VaultState => ({
  vault: {
    address: "0xADFF7900dbe01E8170a750AB88e1f4eA8D9D1D4e",
    symbol: "sTSLA-CSP",
    name: "Strike TSLA Cash-Secured Put",
    kind: "cash-secured-put",
    epochState: "Idle",
    agentId: "2",
    underlying: { symbol: "TSLA" },
    asset: { symbol: "USDG" },
    totalAssets: "100",
    sigma: 0.6,
    mandate,
    series: null,
  },
  spot: { price: "372.61", status: "Ok", ok: true },
  marketOpen: true,
  blockTimeIso: NOW,
  nextExpiryIso: EXPIRY,
  agent: { agentId: "2", active: true, bond: "60", strikes: 0 },
  nextStep: "Idle and ready",
});

async function recordWithCandidates(withCandidates: boolean): Promise<DecisionRecord> {
  const j = new Journal("propose", 46630, "0x26b277b434B1670f207Afd8946edA9AF78A613Ff");
  j.vaultRead(vaultState());
  j.decided({
    strategy: "claude",
    targetDeltaBps: 1500,
    premiumBps: 10_800,
    reasoning: "Far enough out of the money.",
    notes: [],
    planner: { kind: "api", model: "claude-opus-5", label: "Claude via API, model claude-opus-5" },
  });
  j.dryRan(check(1500));
  if (withCandidates) {
    j.plannerDryRuns(
      plannerCandidates(
        [
          {
            tool: "risk_check",
            input: { vault: "0xV", targetDeltaBps: 1500, premiumBps: 10_800 },
            result: check(1500),
            error: null,
          },
        ],
        mandate,
        NOW,
      ),
    );
    j.ladderDryRuns(
      await runLadder({
        call: async (a) =>
          a.targetDeltaBps === 4000
            ? Promise.reject(new Error("rpc down"))
            : check(a.targetDeltaBps, a.premiumBps),
        mandate,
        blockTimeIso: NOW,
        premiumBps: 10_800,
        chosenDeltaBps: 1500,
      }),
    );
    j.chose({ targetDeltaBps: 1500, premiumBps: 10_800 });
  }
  j.finish({
    status: "not-sent",
    summary: "Dry run only (--dry-run): the proposal passed the risk check and was not sent.",
  });
  const r = j.build();
  if (!r) throw new Error("no record");
  return r;
}

describe("candidates in the decision record", () => {
  it("adds decision.candidates (Claude's calls, then the ladder) with the chosen marked", async () => {
    const r = await recordWithCandidates(true);
    const cands = r.decision?.candidates ?? [];
    expect(cands.map((c) => c.source)).toEqual(["planner", ...Array(8).fill("ladder")]);
    expect(cands.filter((c) => c.chosen).map((c) => [c.source, c.targetDeltaBps])).toEqual([
      ["planner", 1500],
      ["ladder", 1500],
    ]);
    expect(Object.keys(JSON.parse(formatRecordJson(r)).decision)).toEqual([
      "strategy",
      "targetDeltaBps",
      "premiumBps",
      "reasoning",
      "notes",
      "planner",
      "candidates",
    ]);
  });

  it("writes every field the app's parser reads, with the types it expects", async () => {
    const r = JSON.parse(formatRecordJson(await recordWithCandidates(true)));
    const decimal = /^-?\d+(\.\d+)?$/;
    for (const c of r.decision.candidates as Record<string, unknown>[]) {
      expect(typeof c.ok).toBe("boolean");
      expect(c.targetDeltaBps === null || typeof c.targetDeltaBps === "number").toBe(true);
      expect(c.premiumBps === null || typeof c.premiumBps === "number").toBe(true);
      expect(c.reason === null || typeof c.reason === "string").toBe(true);
      for (const k of ["strike", "fairValue"]) expect(c[k] === null || decimal.test(String(c[k]))).toBe(true);
      expect(c.yieldBps === null || typeof c.yieldBps === "number").toBe(true);
    }
  });

  it("leaves the record exactly as before when nothing was dry-run", async () => {
    const r = await recordWithCandidates(false);
    expect(r.decision).not.toHaveProperty("candidates");
    expect(formatRecordJson(r)).not.toContain("candidates");
  });

  it("hashes with the candidates, and an old record (no field) keeps its hash", async () => {
    const withC = await recordWithCandidates(true);
    const without = await recordWithCandidates(false);
    expect(recordHash(withC)).not.toBe(recordHash(without));
    // The agent's hash and the SDK's (what the app's browser check uses) agree, with and without the field.
    expect(decisionRecordHash(formatRecordJson(withC))).toBe(recordHash(withC));
    expect(decisionRecordHash(formatRecordJson(without))).toBe(recordHash(without));
    // Changing one candidate changes the hash: they are covered, not decoration.
    const edited = structuredClone(withC);
    (edited.decision?.candidates?.[3] as { strike: string | null }).strike = "1.00";
    expect(recordHash(edited)).not.toBe(recordHash(withC));
    // Removing the field gives the old record's hash back.
    const stripped = structuredClone(withC);
    if (stripped.decision) delete stripped.decision.candidates;
    expect(recordHash(stripped)).toBe(recordHash(without));
  });

  it("anchors the record with its candidates and the anchored copy verifies", async () => {
    const r = await recordWithCandidates(true);
    const anchored = await anchorRecord(r, "x.json", {
      contract: "0x3D1F4B2eC0f1f0b5c0a9a9C9b8a8d0d7e6f5a4b3",
      epoch: 3n,
      send: async () => `0x${"c".repeat(64)}` as `0x${string}`,
      txUrl: (h) => txUrl(46630, h),
    });
    expect(anchored.anchor?.recordHash).toBe(recordHash(r));
    expect(verifyAnchoredRecord(formatRecordJson(anchored))).toBe(true);
    const tampered = JSON.parse(formatRecordJson(anchored));
    tampered.decision.candidates[1].ok = !tampered.decision.candidates[1].ok;
    expect(verifyAnchoredRecord(JSON.stringify(tampered))).toBe(false);
  });

  it("lists them in the markdown, with the rule, the measured value and the limit, and is prettier-clean", async () => {
    const r = await recordWithCandidates(true);
    const md = formatRecordMarkdown(r);
    expect(md).toContain("## Alternatives it dry-ran");
    expect(md).toContain("Claude's own `risk_check` calls, in order:");
    expect(md).toContain("**0.15 delta at 108% of fair value** (chosen): strike $");
    expect(md).toContain("Outside the mandate: `DeltaOutOfBand`, |delta| 0.05 against 0.10 to 0.35.");
    expect(md).toContain("premium $2.712744 per option");
    expect(
      formatRecordMarkdown({
        ...r,
        decision: r.decision && {
          ...r.decision,
          candidates: [{ ...(r.decision.candidates?.[1] as RecordCandidate), size: "0.153031945418606133" }],
        },
      }),
    ).toContain("0.153031 of 0.52 options");
    expect(md).toContain("**0.40 delta at 108% of fair value**: could not be dry-run (rpc down).");
    expect(formatRecordMarkdown(await recordWithCandidates(false))).not.toContain("Alternatives it dry-ran");
    const options = (await prettier.resolveConfig(join(process.cwd(), "docs/agent-log/x.md"))) ?? {};
    expect(await prettier.format(md, { ...options, filepath: "docs/agent-log/x.md" })).toBe(md);
    const json = formatRecordJson(r);
    expect(await prettier.format(json, { ...options, filepath: "docs/agent-log/x.json" })).toBe(json);
  });
});
