import type { RiskRow } from "./risk.js";

// The strike planner: chooses one rung of the risk analyst's ladder inside the mandate. In rule mode the profile's
// target delta (default 0.20, conservative 0.15, clamped into the band) picks the rung; with --llm Claude chooses the
// delta and premium factor with read-only tools, given the market brief and the risk table. The planner only
// chooses: the critic then checks and, inside the mandate, adjusts what it chose.

/** What the planner hands the critic. */
export interface PlannerChoice {
  /** The target |delta| (bps of 1) and premium factor (bps of fair value) chosen. */
  targetDeltaBps: number;
  premiumBps: number;
  /** The delta the profile or Claude asked for, before picking a rung. */
  desiredDeltaBps: number;
  /** The ladder rung's strike and size (largest the mandate allows), or null when Claude chose an off-ladder delta. */
  strike: string | null;
  size: string | null;
  /** "ladder": a rung of the risk table; "claude": Claude's own delta (the critic dry-runs it exactly). */
  from: "ladder" | "claude";
  reason: string;
  /** Every rung the planner looked at, nearest to the desired delta first, with the dry run's verdict. */
  considered?: {
    targetDeltaBps: number;
    ok: boolean;
    reason: string | null;
    distanceBps: number;
    selected: boolean;
  }[];
}

/** The rungs ranked by distance from the desired delta (ties: the lower delta first), with the one selected. */
export function consideredRungs(
  rows: RiskRow[],
  desired: number,
  selected: number | null,
): NonNullable<PlannerChoice["considered"]> {
  return rows
    .filter((r) => r.targetDeltaBps !== null)
    .map((r) => ({
      targetDeltaBps: r.targetDeltaBps as number,
      ok: r.ok && r.error === undefined,
      reason: r.error !== undefined ? `could not be dry-run: ${r.error}` : r.reason,
      distanceBps: Math.abs((r.targetDeltaBps as number) - desired),
      selected: r.targetDeltaBps === selected,
    }))
    .sort((a, b) => a.distanceBps - b.distanceBps || a.targetDeltaBps - b.targetDeltaBps);
}

const dText = (bps: number) => (bps / 10_000).toFixed(2);

/**
 * The rung to take: an accepted rung at exactly `desired` if there is one, else the accepted rung nearest to it
 * (ties go to the lower delta, further out of the money). With `below`, only rungs under that delta count: the
 * retry after the critic vetoed a plan steps further out of the money. Null when no accepted rung qualifies.
 */
export function pickRung(rows: RiskRow[], desired: number, opts: { below?: number } = {}): RiskRow | null {
  const usable = rows.filter(
    (r) =>
      r.ok &&
      r.error === undefined &&
      r.targetDeltaBps !== null &&
      r.strike !== null &&
      (opts.below === undefined || r.targetDeltaBps < opts.below),
  );
  if (usable.length === 0) return null;
  const dist = (r: RiskRow) => Math.abs((r.targetDeltaBps as number) - desired);
  return usable.reduce((best, r) =>
    dist(r) < dist(best) ||
    (dist(r) === dist(best) && (r.targetDeltaBps as number) < (best.targetDeltaBps as number))
      ? r
      : best,
  );
}

/** The rule planner's choice: the profile's delta and premium factor, on the nearest accepted rung. */
export function ruleChoice(
  rows: RiskRow[],
  plan: { targetDeltaBps: number; premiumBps: number; reasoning: string },
  opts: { below?: number } = {},
): PlannerChoice | null {
  const rung = pickRung(rows, plan.targetDeltaBps, opts);
  if (!rung || rung.targetDeltaBps === null) return null;
  const exact = rung.targetDeltaBps === plan.targetDeltaBps;
  const why =
    opts.below !== undefined
      ? `Retry after the critic's veto: the accepted rung nearest ${dText(plan.targetDeltaBps)} delta below ${dText(opts.below)}, further out of the money.`
      : exact
        ? `The rung at the profile's ${dText(plan.targetDeltaBps)} delta, which the contract's dry run accepts.`
        : `The profile asks for ${dText(plan.targetDeltaBps)} delta, which the dry run does not accept; the nearest accepted rung is ${dText(rung.targetDeltaBps)}.`;
  return {
    targetDeltaBps: rung.targetDeltaBps,
    premiumBps: plan.premiumBps,
    desiredDeltaBps: plan.targetDeltaBps,
    strike: rung.strike,
    size: rung.size,
    from: "ladder",
    reason: why,
    considered: consideredRungs(rows, plan.targetDeltaBps, rung.targetDeltaBps),
  };
}

/** Claude's choice, matched to the ladder: the rung's strike and size when Claude chose a delta the ladder has. */
export function claudeChoice(
  rows: RiskRow[],
  plan: { targetDeltaBps: number; premiumBps: number },
): PlannerChoice {
  const rung = rows.find((r) => r.targetDeltaBps === plan.targetDeltaBps && r.error === undefined) ?? null;
  return {
    targetDeltaBps: plan.targetDeltaBps,
    premiumBps: plan.premiumBps,
    desiredDeltaBps: plan.targetDeltaBps,
    strike: rung?.strike ?? null,
    size: rung?.size ?? null,
    from: rung ? "ladder" : "claude",
    considered: consideredRungs(rows, plan.targetDeltaBps, rung ? plan.targetDeltaBps : null),
    reason: rung
      ? `Claude chose ${dText(plan.targetDeltaBps)} delta at ${(plan.premiumBps / 100).toFixed(0)}% of fair value, a rung of the ladder (its words are the narration).`
      : `Claude chose ${dText(plan.targetDeltaBps)} delta at ${(plan.premiumBps / 100).toFixed(0)}% of fair value, between the ladder's rungs; the critic dry-runs it exactly (its words are the narration).`,
  };
}
