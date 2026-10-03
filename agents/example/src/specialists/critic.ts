import { BPS, MAX_PREMIUM_BPS, tenorYears } from "@strike/sdk";
import { capSize, targetDeltaBps as clampDelta } from "../strategy.js";
import { isNotProvided } from "../pipeline.js";
import type { MandateView, RiskCheck } from "../types.js";
import type { MarketBrief } from "./market.js";
import type { PlannerChoice } from "./plan.js";
import type { RiskRow, RiskTable } from "./risk.js";

// The critic: an independent second look at the planner's choice before anything is sent. It first adjusts the plan
// where the mandate or the profile says so (MODIFY: the delta into the band, the premium up to the floor, the size down
// to the profile's share), recording each change with the value before and after, then re-runs the mandate check on
// the changed plan through risk_check (the contract's previewProposal) and asks the risk engine for the exact
// proposal's numbers. Then it checks five rules. Any failed rule is a veto (FAIL): no proposal is sent, so no bond can
// be slashed for it, and the record says which rule failed with the measured value and the limit.

export type CriticRuleName = "market" | "mandate" | "cushion" | "yield" | "drift";

export interface CriticRule {
  rule: CriticRuleName;
  ok: boolean;
  /** False when the rule had nothing to compare (it then passes and says why in `measured`). */
  applicable: boolean;
  measured: string;
  limit: string;
}

/** One change the critic made to the plan, inside the mandate. */
export interface Modification {
  field: "targetDeltaBps" | "premiumBps" | "size";
  before: number | string;
  after: number | string;
  reason: string;
}

/** The break-even must be at least this many one-sigma moves (sigma x sqrt(tenor)) away from spot. */
export const CUSHION_SIGMAS = 0.5;
/** Largest gap between the yield risk_check reports and the one rebuilt from its fair value, premium and collateral. */
export const YIELD_TOLERANCE = 0.02;
/** Largest gap between the risk table's yield for the same rung and the exact dry run's. */
export const TABLE_YIELD_TOLERANCE = 0.1;
/** Largest strike or spot move between the risk table and the exact dry run. */
export const DRIFT_LIMIT = 0.005;

const pctText = (x: number, digits = 1) => `${(x * 100).toFixed(digits)}%`;
const dText = (bps: number) => (bps / BPS).toFixed(2);

/**
 * The mandate's adjustments to a plan: the delta clamped one point inside the band, the premium factor into
 * [minPremiumBps, 300%]. Each change is a {@link Modification}.
 */
export function mandateModifications(
  choice: PlannerChoice,
  mandate: MandateView,
): { choice: PlannerChoice; modifications: Modification[] } {
  const modifications: Modification[] = [];
  let next = choice;
  const delta = clampDelta(mandate, choice.targetDeltaBps / BPS);
  if (delta !== choice.targetDeltaBps) {
    modifications.push({
      field: "targetDeltaBps",
      before: choice.targetDeltaBps,
      after: delta,
      reason: `${dText(choice.targetDeltaBps)} delta is outside the mandate's band ${dText(mandate.minDeltaBps)} to ${dText(mandate.maxDeltaBps)}; moved one point inside it`,
    });
    next = { ...next, targetDeltaBps: delta, strike: null, size: null };
  }
  const premium = Math.min(Math.max(Math.round(choice.premiumBps), mandate.minPremiumBps), MAX_PREMIUM_BPS);
  if (premium !== choice.premiumBps) {
    modifications.push({
      field: "premiumBps",
      before: choice.premiumBps,
      after: premium,
      reason:
        premium > choice.premiumBps
          ? `the premium factor is below the mandate's floor of ${(mandate.minPremiumBps / 100).toFixed(0)}% of fair value; raised to it`
          : `the premium factor is above the protocol's cap of ${MAX_PREMIUM_BPS / 100}% of fair value; lowered to it`,
    });
    next = { ...next, premiumBps: premium };
  }
  return { choice: next, modifications };
}

/** The profile's size cap (its share of capacity), as a modification when it changes the size. */
export function sizeModification(
  size: string,
  capacity: string,
  share: number,
  profile: string,
): Modification | null {
  if (share >= 1) return null;
  const capped = capSize(size, capacity, share);
  if (capped === size) return null;
  return {
    field: "size",
    before: size,
    after: capped,
    reason: `profile "${profile}" offers at most ${Math.round(share * 100)}% of the vault's capacity (${capacity} options)`,
  };
}

/** The yield rebuilt from a dry run: premium per option over the collateral one option locks (spot for a call, strike for a put). */
export function rebuiltYieldBps(check: RiskCheck): number | null {
  const fair = Number(check.measured.fairValue);
  const collateral = check.isCall ? Number(check.spot) : Number(check.proposal.strike);
  if (!(fair >= 0) || !(collateral > 0)) return null;
  return ((fair * check.proposal.premiumBps) / BPS / collateral) * BPS;
}

/** The critic's five rules on the exact proposal. */
export function criticRules(input: {
  brief: MarketBrief;
  check: RiskCheck;
  /** The risk engine's numbers for the exact proposal (the critic's own read). */
  exact: RiskRow;
  /** The risk table's row for the same delta and premium factor, when it has one. */
  tableRow: RiskRow | null;
  table: RiskTable;
  failedRule: { rule: string; measured: string; limit: string } | null;
}): CriticRule[] {
  const { brief, check, exact, tableRow, table } = input;
  const rules: CriticRule[] = [];

  rules.push({
    rule: "market",
    ok: brief.go,
    applicable: true,
    measured: brief.go
      ? `go${brief.sessionWaived ? " (session waived by --ignore-session: a dry run evaluated as if the NYSE were open)" : ""}`
      : `no-go: ${brief.reasons.join("; ")}`,
    limit: "the market analyst's go",
  });

  rules.push({
    rule: "mandate",
    ok: check.ok,
    applicable: true,
    measured: check.ok
      ? `previewProposal accepts it (${check.reason})`
      : input.failedRule
        ? `${input.failedRule.rule}: ${input.failedRule.measured}`
        : `previewProposal rejects it (${check.reason})`,
    limit: input.failedRule?.limit ?? "every rule of the vault's mandate",
  });

  const oneSigma = table.sigma * Math.sqrt(tenorYears(table.tenorSeconds));
  const minCushion = CUSHION_SIGMAS * oneSigma;
  const stress = isNotProvided(exact.stress)
    ? `; the engine's ±30% stress costs not provided (${exact.stress.reason})`
    : `; the worst ±30% move (${exact.stress.worstShock > 0 ? "+" : ""}${pctText(exact.stress.worstShock, 0)}) would cost $${exact.stress.worstLossUsd}, ${pctText(exact.stress.shareOfCollateral)} of the collateral, against $${exact.stress.premiumIncomeUsd} of premium`;
  if (exact.breakEvenDistance === null || exact.breakEven === null) {
    rules.push({
      rule: "cushion",
      ok: false,
      applicable: true,
      measured: "no break-even: the exact dry run gave no strike or premium",
      limit: `at least ${pctText(minCushion)} from spot`,
    });
  } else {
    rules.push({
      rule: "cushion",
      ok: exact.breakEvenDistance >= minCushion,
      applicable: true,
      measured: `break-even $${exact.breakEven} is ${pctText(exact.breakEvenDistance)} ${table.isCall ? "above" : "below"} spot $${check.spot}${stress}`,
      limit: `at least ${pctText(minCushion)} (${CUSHION_SIGMAS} x the ${pctText(oneSigma)} one-sigma move to expiry)`,
    });
  }

  const rebuilt = rebuiltYieldBps(check);
  const reported = check.measured.yieldBps;
  const selfOk =
    rebuilt !== null && Math.abs(rebuilt - reported) <= Math.max(1, YIELD_TOLERANCE * Math.abs(reported));
  const tableYield = tableRow?.yieldBps ?? null;
  const tableOk =
    tableYield === null ||
    Math.abs(tableYield - reported) <= Math.max(1, TABLE_YIELD_TOLERANCE * Math.abs(reported));
  rules.push({
    rule: "yield",
    ok: selfOk && tableOk,
    applicable: true,
    measured: `risk_check reports ${(reported / 100).toFixed(2)}% of collateral; rebuilt from fair value $${check.measured.fairValue} x ${(check.proposal.premiumBps / 100).toFixed(0)}% over $${check.isCall ? check.spot : check.proposal.strike} it is ${rebuilt === null ? "not computable" : `${(rebuilt / 100).toFixed(2)}%`}${tableYield === null ? "" : `; the risk table had ${(tableYield / 100).toFixed(2)}% for this rung`}`,
    limit: `within ${pctText(YIELD_TOLERANCE, 0)} of the rebuilt yield${tableYield === null ? "" : ` and ${pctText(TABLE_YIELD_TOLERANCE, 0)} of the table's`}`,
  });

  if (!tableRow || tableRow.strike === null) {
    rules.push({
      rule: "drift",
      ok: true,
      applicable: false,
      measured: "not applicable: the risk table has no rung at this delta and premium factor to compare with",
      limit: `strike and spot within ${pctText(DRIFT_LIMIT)} of the risk table`,
    });
  } else {
    const k0 = Number(tableRow.strike);
    const k1 = Number(check.proposal.strike);
    const s0 = Number(table.spot);
    const s1 = Number(check.spot);
    const dk = k0 > 0 ? Math.abs(k1 - k0) / k0 : 1;
    const ds = s0 > 0 ? Math.abs(s1 - s0) / s0 : 1;
    rules.push({
      rule: "drift",
      ok: dk <= DRIFT_LIMIT && ds <= DRIFT_LIMIT,
      applicable: true,
      measured: `strike $${tableRow.strike} in the risk table, $${check.proposal.strike} now (${pctText(dk, 2)}); spot $${table.spot} then, $${check.spot} now (${pctText(ds, 2)})`,
      limit: `both within ${pctText(DRIFT_LIMIT)}`,
    });
  }
  return rules;
}

/** One alternative of the week, with the model numbers it would be graded on once the series settles. */
export interface Alternative {
  name: "chosen strike" | "kept cash" | "half size" | "one step nearer" | "one step farther";
  /** True for what the agent actually did (the chosen strike when it proposed, kept cash when it did not). */
  taken: boolean;
  available: boolean;
  /** Why the alternative has no numbers (available false only). */
  reason?: string;
  targetDeltaBps: number | null;
  premiumBps: number | null;
  strike: string | null;
  /** Options; "0" for kept cash. */
  size: string;
  premiumPerOption: string | null;
  /** Premium if every option sold, USD. */
  premiumIncomeUsd: string;
  breakEven: string | null;
  /** Model odds of exercise (Black-Scholes, risk-neutral). */
  exerciseProbability: number | null;
  /** The engine's worst payout on the ±30% grid, USD. */
  stressLossUsd: string | null;
  /** Where the numbers come from. */
  source: string;
}

const half = (s: string) => usdText(Number(s) / 2);

const usdText = (n: number) =>
  n
    .toFixed(6)
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");

function fromRow(name: Alternative["name"], row: RiskRow, taken: boolean, source: string): Alternative {
  return {
    name,
    taken,
    available: true,
    targetDeltaBps: row.targetDeltaBps,
    premiumBps: row.premiumBps,
    strike: row.strike,
    size: row.size ?? "0",
    premiumPerOption: row.premium,
    premiumIncomeUsd: row.premium && row.size ? usdText(Number(row.premium) * Number(row.size)) : "0",
    breakEven: row.breakEven,
    exerciseProbability: row.exerciseProbability,
    stressLossUsd: isNotProvided(row.stress) ? null : row.stress.worstLossUsd,
    source,
  };
}

const missing = (name: Alternative["name"], reason: string): Alternative => ({
  name,
  taken: false,
  available: false,
  reason,
  targetDeltaBps: null,
  premiumBps: null,
  strike: null,
  size: "0",
  premiumPerOption: null,
  premiumIncomeUsd: "0",
  breakEven: null,
  exerciseProbability: null,
  stressLossUsd: null,
  source: "none",
});

/**
 * The alternatives to grade at settlement: the chosen strike (the critic's exact dry run), kept cash, half the size,
 * and the ladder rungs one step nearer to spot and one step farther from it (the risk table's numbers, at the
 * ladder's premium factor). `proposed` says whether the agent went ahead (else kept cash is what it did).
 */
export function alternatives(input: {
  exact: RiskRow | null;
  table: RiskTable | null;
  proposed: boolean;
}): Alternative[] {
  const out: Alternative[] = [];
  const { exact, table } = input;
  if (exact)
    out.push(
      fromRow("chosen strike", exact, input.proposed, "the critic's exact dry run and risk engine read"),
    );
  out.push({
    name: "kept cash",
    taken: !input.proposed,
    available: true,
    targetDeltaBps: null,
    premiumBps: null,
    strike: null,
    size: "0",
    premiumPerOption: null,
    premiumIncomeUsd: "0",
    breakEven: null,
    exerciseProbability: null,
    stressLossUsd: "0",
    source: "no option sold: no premium, no payout",
  });
  if (!exact || !table) return out;
  const h = fromRow(
    "half size",
    exact,
    false,
    "the chosen strike at half the size: premium and stress loss halved",
  );
  h.size = half(h.size);
  h.premiumIncomeUsd = half(h.premiumIncomeUsd);
  if (h.stressLossUsd !== null) h.stressLossUsd = half(h.stressLossUsd);
  out.push(h);
  const d = exact.targetDeltaBps;
  const rungs = table.rows.filter(
    (r) => r.targetDeltaBps !== null && r.error === undefined && r.strike !== null,
  );
  const nearer =
    d === null
      ? undefined
      : rungs
          .filter((r) => (r.targetDeltaBps as number) > d)
          .sort((a, b) => (a.targetDeltaBps as number) - (b.targetDeltaBps as number))[0];
  const farther =
    d === null
      ? undefined
      : rungs
          .filter((r) => (r.targetDeltaBps as number) < d)
          .sort((a, b) => (b.targetDeltaBps as number) - (a.targetDeltaBps as number))[0];
  const src = (r: RiskRow) =>
    `the risk table's ${dText(r.targetDeltaBps as number)} delta rung at ${((r.premiumBps ?? 0) / 100).toFixed(0)}% of fair value${r.ok ? "" : `, which the mandate rejects (${r.reason})`}`;
  out.push(
    nearer
      ? fromRow("one step nearer", nearer, false, src(nearer))
      : missing("one step nearer", "the ladder has no rung nearer to spot"),
  );
  out.push(
    farther
      ? fromRow("one step farther", farther, false, src(farther))
      : missing("one step farther", "the ladder has no rung farther from spot"),
  );
  return out;
}

/** Computed confidence: the model odds that the option expires worthless (the vault keeps the whole premium). */
export interface Confidence {
  worthlessProbability: number;
  kind: "model odds";
  basis: string;
}

export function confidence(exact: RiskRow, table: RiskTable): Confidence | null {
  if (exact.exerciseProbability === null) return null;
  return {
    worthlessProbability: 1 - exact.exerciseProbability,
    kind: "model odds",
    basis: `Black-Scholes N(d2), risk-neutral with a zero rate, at the pricer's sigma ${(table.sigma * 100).toFixed(1)}% and ${(table.tenorSeconds / 86_400).toFixed(2)} days to expiry: model odds, not a forecast and not self-reported`,
  };
}
