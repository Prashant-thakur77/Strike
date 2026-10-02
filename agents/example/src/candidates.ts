import { BPS, MAX_PREMIUM_BPS } from "@strike/sdk";
import type { RecordCandidate, RecordFailedRule } from "./record.js";
import type { MandateView, RiskCheck } from "./types.js";

// The alternatives the agent dry-ran while deciding, as the decision record keeps them (`decision.candidates`).
// Two sources: a ladder of target deltas across the mandate's band that the agent sweeps itself, and the
// `risk_check` calls Claude made while planning. Both go through the MCP server's read-only `risk_check`, which is the
// contract's own `previewProposal`. Only what was actually dry-run is recorded; a read that fails is an error entry.

/** One `risk_check` call Claude made while planning: the arguments, and the result or the error. */
export interface PlannerCall {
  tool: "risk_check";
  input: Record<string, unknown>;
  /** The tool's structured result (null when it failed). */
  result: unknown;
  /** The tool's error text (null when it returned a result). */
  error: string | null;
}

/** The step of the ladder, in bps of delta. */
const LADDER_STEP_BPS = 500;
/** How far past each edge of the band the ladder goes. */
const LADDER_BEYOND_BPS = 500;
/** No rung below 0.01 delta, none above 0.49 (an at-the-money option is 0.50: no strike has more). */
const LADDER_MIN_BPS = 100;
const LADDER_MAX_BPS = 4900;
/** Most rungs a ladder may have: a wide band gets a wider step instead. */
const LADDER_MAX_RUNGS = 12;

/**
 * The target deltas to dry-run: a step apart across the mandate's band (always including both edges), one
 * `LADDER_BEYOND_BPS` past each edge, and `include` (the chosen delta, even when it is off the grid). Ascending.
 */
export function ladderDeltas(
  mandate: Pick<MandateView, "minDeltaBps" | "maxDeltaBps">,
  include: number[] = [],
): number[] {
  const lo = Math.max(LADDER_MIN_BPS, mandate.minDeltaBps);
  const hi = Math.min(LADDER_MAX_BPS, mandate.maxDeltaBps);
  const rungs = (step: number): Set<number> => {
    const set = new Set<number>([lo, hi]);
    for (let d = Math.ceil(lo / step) * step; d < hi; d += step) set.add(d);
    set.add(Math.max(LADDER_MIN_BPS, lo - LADDER_BEYOND_BPS));
    set.add(Math.min(LADDER_MAX_BPS, hi + LADDER_BEYOND_BPS));
    for (const d of include)
      if (Number.isInteger(d) && d >= LADDER_MIN_BPS && d <= LADDER_MAX_BPS) set.add(d);
    return set;
  };
  let step = LADDER_STEP_BPS;
  let set = rungs(step);
  while (set.size > LADDER_MAX_RUNGS && step < LADDER_MAX_BPS) {
    step *= 2;
    set = rungs(step);
  }
  return [...set].sort((a, b) => a - b);
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

const pct = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
const deltaText = (bps: number) => (bps / BPS).toFixed(2);
const days = (s: number) => `${(s / 86_400).toFixed(2).replace(/\.?0+$/, "")} days`;

/** One option's sale price: fair value x premium factor, to six decimals. Null when either is unknown. */
export function premiumPerOption(fairValue: string | null, premiumBps: number | null): string | null {
  if (fairValue === null || premiumBps === null) return null;
  const fair = Number(fairValue);
  if (!Number.isFinite(fair)) return null;
  return ((fair * premiumBps) / BPS)
    .toFixed(6)
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
}

/** Keep an error line short and free of URLs (an RPC URL may carry a provider key). */
export function cleanError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const oneLine = text
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/\s+/g, " ")
    .trim();
  return oneLine.length > 300 ? `${oneLine.slice(0, 297)}...` : oneLine || "unknown error";
}

/**
 * The first mandate rule a rejected proposal fails, with the measured value and the limit, from the contract's own
 * reason code (it names the first rule that failed, in MandateGuard's order). Null when the contract accepted it.
 */
export function failedRule(
  check: RiskCheck,
  mandate: MandateView,
  blockTimeIso: string,
): RecordFailedRule | null {
  if (check.ok || check.reason === "None") return null;
  const rule = check.reason;
  const premiumBps = check.proposal.premiumBps;
  switch (rule) {
    case "TenorOutOfRange": {
      const tenor = (Date.parse(check.proposal.expiryIso) - Date.parse(blockTimeIso)) / 1000;
      return {
        rule,
        measured: `tenor ${Number.isFinite(tenor) ? days(tenor) : check.proposal.expiryIso}`,
        limit: `${days(mandate.minTenor)} to ${days(mandate.maxTenor)}`,
      };
    }
    case "InvalidExpiry":
      return { rule, measured: `expiry ${check.proposal.expiryIso}`, limit: "an NYSE session close" };
    case "ZeroSize":
      return { rule, measured: `size ${check.proposal.size}`, limit: "more than 0 options" };
    case "StrikeWrongSide":
      return {
        rule,
        measured: `strike $${check.proposal.strike} against spot $${check.spot}`,
        limit: check.isCall ? "a call strikes above spot" : "a put strikes below spot",
      };
    case "SizeTooLarge": {
      const max = (Number(check.measured.capacity) * mandate.maxShareSoldBps) / BPS;
      return {
        rule,
        measured: `size ${check.proposal.size} options`,
        limit: `${pct(mandate.maxShareSoldBps)} of capacity ${check.measured.capacity} = ${Number.isFinite(max) ? max : "?"} options`,
      };
    }
    case "PremiumBelowFair":
      return {
        rule,
        measured: `premium ${pct(premiumBps)} of fair value`,
        limit: `at least ${pct(mandate.minPremiumBps)}`,
      };
    case "PremiumAboveCap":
      return {
        rule,
        measured: `premium ${pct(premiumBps)} of fair value`,
        limit: `at most ${pct(MAX_PREMIUM_BPS)}`,
      };
    case "DeltaOutOfBand":
      return {
        rule,
        measured: `|delta| ${check.measured.delta}`,
        limit: `${deltaText(mandate.minDeltaBps)} to ${deltaText(mandate.maxDeltaBps)}`,
      };
    case "PremiumTooSmall":
      return {
        rule,
        measured: `yield ${pct(check.measured.yieldBps)} of collateral`,
        limit: `at least ${pct(mandate.minYieldBps)}`,
      };
    default:
      return { rule, measured: "see the explanation", limit: "the mandate" };
  }
}

/** An error entry: the dry run could not be read, so nothing but what was asked is recorded. */
function errorCandidate(
  source: RecordCandidate["source"],
  asked: { targetDeltaBps: number | null; premiumBps: number | null },
  error: string,
  inputs?: Record<string, unknown>,
): RecordCandidate {
  return {
    source,
    targetDeltaBps: asked.targetDeltaBps,
    premiumBps: asked.premiumBps,
    ok: false,
    reason: null,
    strike: null,
    fairValue: null,
    premium: null,
    yieldBps: null,
    delta: null,
    size: null,
    capacity: null,
    chosen: false,
    failedRule: null,
    explanation: null,
    error,
    ...(inputs ? { inputs } : {}),
  };
}

/** True when `v` has the parts of a RiskCheck a candidate is built from. */
function isRiskCheck(v: unknown): v is RiskCheck {
  if (!isObj(v) || typeof v.ok !== "boolean" || str(v.reason) === null) return false;
  return isObj(v.proposal) && isObj(v.measured) && str(v.proposal.strike) !== null;
}

/**
 * A candidate from a `risk_check` result. Anything that is not a complete result (a stub, a changed schema) becomes
 * an error entry rather than a half-filled row.
 */
export function candidateFromCheck(
  source: RecordCandidate["source"],
  raw: unknown,
  mandate: MandateView,
  blockTimeIso: string,
  opts: {
    inputs?: Record<string, unknown>;
    asked?: { targetDeltaBps: number | null; premiumBps: number | null };
  } = {},
): RecordCandidate {
  if (!isRiskCheck(raw)) {
    return errorCandidate(
      source,
      opts.asked ?? { targetDeltaBps: null, premiumBps: null },
      "the risk check returned no usable result",
      opts.inputs,
    );
  }
  const check = raw;
  const p = check.proposal;
  const m = check.measured;
  return {
    source,
    targetDeltaBps: num(p.targetDeltaBps),
    premiumBps: num(p.premiumBps),
    ok: check.ok,
    reason: check.reason,
    strike: str(p.strike),
    fairValue: str(m.fairValue),
    premium: premiumPerOption(str(m.fairValue), num(p.premiumBps)),
    yieldBps: num(m.yieldBps),
    delta: num(m.delta),
    size: str(p.size),
    capacity: str(m.capacity),
    chosen: false,
    failedRule: failedRule(check, mandate, blockTimeIso),
    explanation: str(check.explanation),
    ...(opts.inputs ? { inputs: opts.inputs } : {}),
  };
}

/** Claude's `risk_check` calls as candidates, in call order. */
export function plannerCandidates(
  calls: PlannerCall[],
  mandate: MandateView,
  blockTimeIso: string,
): RecordCandidate[] {
  return calls.map((c) => {
    const asked = { targetDeltaBps: num(c.input.targetDeltaBps), premiumBps: num(c.input.premiumBps) };
    if (c.error !== null || c.result === null || c.result === undefined) {
      return errorCandidate("planner", asked, c.error ?? "the call returned no result", c.input);
    }
    return candidateFromCheck("planner", c.result, mandate, blockTimeIso, { inputs: c.input, asked });
  });
}

/** Dry-runs one target delta; the agent's `mcp.call("risk_check", ...)`. */
export type RiskCheckCall = (args: { targetDeltaBps: number; premiumBps: number }) => Promise<unknown>;

/**
 * The ladder: dry-run each target delta (at one premium factor, the largest size the mandate allows) and keep the
 * contract's verdict for every rung. Rungs run one after another so a public RPC is not flooded. A rung that fails to
 * read becomes an error entry; this never throws.
 */
export async function runLadder(opts: {
  call: RiskCheckCall;
  mandate: MandateView;
  blockTimeIso: string;
  premiumBps: number;
  /** The delta the agent chose (it is always one of the rungs). */
  chosenDeltaBps: number | null;
  onRung?: (c: RecordCandidate) => void;
}): Promise<RecordCandidate[]> {
  const deltas = ladderDeltas(opts.mandate, opts.chosenDeltaBps === null ? [] : [opts.chosenDeltaBps]);
  const out: RecordCandidate[] = [];
  for (const targetDeltaBps of deltas) {
    const asked = { targetDeltaBps, premiumBps: opts.premiumBps };
    let c: RecordCandidate;
    try {
      c = candidateFromCheck("ladder", await opts.call(asked), opts.mandate, opts.blockTimeIso, { asked });
    } catch (err) {
      c = errorCandidate("ladder", asked, cleanError(err));
    }
    out.push(c);
    opts.onRung?.(c);
  }
  return out;
}

/**
 * Mark the candidate(s) whose delta and premium became the proposal. Every ladder rung at that delta; among
 * Claude's own calls, only the last accepted one that asked for exactly that (the one it went on to submit).
 */
export function markChosen(
  candidates: RecordCandidate[],
  chosen: { targetDeltaBps: number; premiumBps: number },
): RecordCandidate[] {
  const same = (c: RecordCandidate) =>
    c.targetDeltaBps === chosen.targetDeltaBps && c.premiumBps === chosen.premiumBps && c.error === undefined;
  let lastPlanner = -1;
  candidates.forEach((c, i) => {
    if (c.source === "planner" && c.ok && same(c)) lastPlanner = i;
  });
  return candidates.map((c, i) => ({
    ...c,
    chosen: c.source === "ladder" ? same(c) : i === lastPlanner,
  }));
}

/** One line for the console: "0.15 delta: inside the mandate, strike $342.91" or the rule it fails. */
export function describeCandidate(c: RecordCandidate): string {
  const head = c.targetDeltaBps !== null ? `${deltaText(c.targetDeltaBps)} delta` : "(strike given)";
  if (c.error !== undefined) return `${head}: could not dry-run (${c.error})`;
  const verdict = c.ok
    ? "inside the mandate"
    : c.failedRule
      ? `outside: ${c.failedRule.rule} (${c.failedRule.measured}, limit ${c.failedRule.limit})`
      : `outside: ${c.reason ?? "rejected"}`;
  return `${head}: ${verdict}${c.strike ? `, strike $${c.strike}` : ""}${c.chosen ? " [chosen]" : ""}`;
}
