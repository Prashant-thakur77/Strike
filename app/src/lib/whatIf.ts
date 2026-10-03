// More of the decision page, derived from one anchored record and nothing else (plus the settlement price once the
// series has settled):
//
//   - what-if branches: the proposal sent next to keeping cash, half the size and the rungs either side of it on the
//     ladder, valued for the whole vault; before settlement each shows its premium and the pricing model's fair value
//     of what holders could claim (labelled as model numbers), after it the payout at the settlement price;
//   - stress scenarios: the payout and the vault's net if the stock settles 5% to 30% against the position, with the
//     model's odds of settling there or further, arithmetic on the record's strike and premium;
//   - the agent's own changes before sending (the mandate guard and the rule profile), parsed from the notes the
//     agent code writes in a fixed form, with the value before and after;
//   - consistency checks: the places where the record could contradict itself or the chain, each checked.
//
// Pure, with type-only imports, so Playwright's CommonJS loader can test it (e2e/whatif.spec.ts).

import type { LogRecord } from "./agentLog";
import type { DecisionInputs, LadderRow, LossLine, Pricing } from "./decision";

const BPS = 10_000;
const YEAR = 31_536_000;

const usd = (x: number, frac = 2) =>
  `${x < 0 ? "−" : ""}$${Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: frac, maximumFractionDigits: frac })}`;

/** The option's payout per option, in USD, at a settlement price. */
export function payoutAt(strike: number, settlement: number, isCall: boolean): number {
  return isCall ? Math.max(settlement - strike, 0) : Math.max(strike - settlement, 0);
}

/** The model's odds that the stock settles at `level` or further against the position (below for a put). */
export function oddsBeyond(inp: DecisionInputs, level: number, pricing: Pick<Pricing, "normCdf">): number {
  const vol = inp.sigma * Math.sqrt(inp.tenorSeconds / YEAR);
  const d2 = (Math.log(inp.spot / level) - (vol * vol) / 2) / vol;
  return inp.isCall ? pricing.normCdf(d2) : pricing.normCdf(-d2);
}

/** The vault's collateral in USD at the snapshot (stock tokens are valued at the snapshot spot). */
export function collateralUsd(inp: DecisionInputs): number {
  return inp.isCall ? inp.collateral * inp.spot : inp.collateral;
}

/* ================================================================ what-if branches */

export type BranchKind = "sent" | "cash" | "half" | "nearer" | "farther";

export interface Branch {
  kind: BranchKind;
  /** "What if …" in plain words. */
  question: string;
  strike: number | null;
  options: number;
  premium: number;
  /** The model's fair value of what holders could claim (Black-Scholes, the price the pricer used), all options. */
  modelPayout: number;
  /** Premium minus the model's fair value: the model's expected result for depositors before fees. */
  modelNet: number;
  /** At the settlement price, when there is one. */
  payout: number | null;
  net: number | null;
  /** The mandate's verdict on this branch; null for keeping cash. */
  inside: boolean | null;
  reason: string | null;
  /** What actually happened. */
  actual: boolean;
}

export interface WhatIf {
  branches: Branch[];
  settlement: number | null;
  takeaway: string;
  /** Set when the record sold nothing, to say why the "sent" branch is hypothetical. */
  hypothetical: boolean;
}

function branchOf(
  kind: BranchKind,
  question: string,
  row: { strike: number; fairValue: number; premium: number; size: number },
  inp: DecisionInputs,
  settlement: number | null,
  verdict: { inside: boolean | null; reason: string | null },
  actual: boolean,
): Branch {
  const options = row.size;
  const premium = row.premium * options;
  const modelPayout = row.fairValue * options;
  const payout = settlement === null ? null : payoutAt(row.strike, settlement, inp.isCall) * options;
  return {
    kind,
    question,
    strike: row.strike,
    options,
    premium,
    modelPayout,
    modelNet: premium - modelPayout,
    payout,
    net: payout === null ? null : premium - payout,
    inside: verdict.inside,
    reason: verdict.reason,
    actual,
  };
}

const rowLabel = (r: LadderRow) =>
  r.target !== null ? `${r.target.toFixed(2)} delta` : `the ${usd(r.strike)} strike`;

/**
 * The branches for one record. `rows` is the ladder (the agent's own dry runs, else the recomputed one); the rungs
 * either side of the sent one become "nearer" (higher |delta|, closer to the money) and "farther". Each rung is valued
 * at its own size, the largest the mandate allows at the sent proposal's share of capacity.
 */
export function whatIfBranches(
  r: LogRecord,
  inp: DecisionInputs,
  rows: LadderRow[] | null,
  settlement: number | null,
): WhatIf {
  const accepted = r.result.status === "accepted";
  const strike = inp.acceptedStrike ?? inp.dry.strike;
  const sentPremium = (inp.dry.fairValue * inp.dry.premiumBps) / BPS;
  const sentRow = { strike, fairValue: inp.dry.fairValue, premium: sentPremium, size: inp.dry.size };
  const sentInside = r.dryRun?.ok ?? accepted;
  const branches: Branch[] = [];
  branches.push(
    branchOf(
      "sent",
      accepted ? "The proposal it sent" : "What if the contract had accepted the proposal it sent?",
      sentRow,
      inp,
      settlement,
      { inside: sentInside, reason: sentInside ? null : (r.result.reason ?? r.dryRun?.reason ?? null) },
      accepted,
    ),
  );
  branches.push({
    kind: "cash",
    question: accepted
      ? "What if it had sold nothing and kept the collateral idle?"
      : "What happened: nothing was sold",
    strike: null,
    options: 0,
    premium: 0,
    modelPayout: 0,
    modelNet: 0,
    payout: settlement === null ? null : 0,
    net: settlement === null ? null : 0,
    inside: null,
    reason: null,
    actual: !accepted,
  });
  branches.push(
    branchOf(
      "half",
      "What if it had sold half as many options?",
      { ...sentRow, size: sentRow.size / 2 },
      inp,
      settlement,
      { inside: sentInside, reason: sentInside ? null : (r.result.reason ?? null) },
      false,
    ),
  );
  if (rows && rows.length > 1) {
    const sorted = [...rows].filter((x) => Number.isFinite(x.delta) || x.target !== null);
    // Order by |delta|, nearest the money last; the target when set, else the measured delta.
    const key = (x: LadderRow) => x.target ?? Math.abs(x.delta);
    sorted.sort((a, b) => key(a) - key(b));
    const i = sorted.findIndex((x) => x.sent);
    const add = (kind: "nearer" | "farther", row: LadderRow | undefined) => {
      if (!row || !Number.isFinite(row.size) || !(row.size > 0)) return;
      branches.push(
        branchOf(
          kind,
          kind === "nearer"
            ? `What if it had sold ${rowLabel(row)}, one rung nearer the money?`
            : `What if it had sold ${rowLabel(row)}, one rung farther from the money?`,
          row,
          inp,
          settlement,
          { inside: row.verdict.ok, reason: row.verdict.ok ? null : row.verdict.reason },
          false,
        ),
      );
    };
    if (i >= 0) {
      add("nearer", sorted[i + 1]);
      add("farther", sorted[i - 1]);
    }
  }
  return {
    branches,
    settlement,
    takeaway: whatIfTakeaway(branches, settlement, accepted),
    hypothetical: !accepted,
  };
}

/** One line from the numbers, in the vault's USD. */
export function whatIfTakeaway(branches: Branch[], settlement: number | null, accepted: boolean): string {
  const sent = branches.find((b) => b.kind === "sent")!;
  if (settlement === null) {
    if (!accepted)
      return "Nothing was sold, so there is nothing to grade; the rows show what each choice would have carried.";
    return `Not graded yet. Before settlement the only certain number is the premium, ${usd(sent.premium)} if every option is bought; the model values what holders could claim at ${usd(sent.modelPayout)}, so it expects ${usd(sent.modelNet)} for depositors before fees.`;
  }
  const at = `At the ${usd(settlement)} settlement`;
  if (!accepted)
    return `${at}, the proposal would have netted ${usd(sent.net!)} for the vault had it been accepted; it was not, so the vault sold nothing.`;
  const better = branches.filter(
    (b) => b.kind !== "sent" && b.inside !== false && b.net! > sent.net! + 0.005,
  );
  const cash = branches.find((b) => b.kind === "cash")!;
  const vsCash =
    sent.net! >= 0
      ? `selling the option earned depositors ${usd(sent.net!)} more than keeping cash`
      : `keeping cash would have saved depositors ${usd(-sent.net!)}`;
  if (better.length === 0) return `${at}, ${vsCash}, and no other branch inside the mandate did better.`;
  const best = better.reduce((a, b) => (b.net! > a.net! ? b : a));
  return `${at}, ${vsCash}; ${best === cash ? "keeping cash" : best.question.replace(/^What if it had /, "having ").replace(/\?$/, "")} would have earned ${usd(best.net! - sent.net!)} more.`;
}

export const WHAT_IF_CAVEAT =
  "Valued as if every option offered was bought, before fees. Model numbers use the record's snapshot spot and volatility; they are what the pricer expected, not a forecast. One week is noise, not a measure of skill.";

/* ================================================================ stress scenarios */

export interface Stress {
  /** The move from the snapshot spot, signed (−0.1 is 10% lower). */
  move: number;
  settlement: number;
  payoutPerOption: number;
  netPerOption: number;
  /** For the options in the record's dry run. */
  vaultNet: number;
  /** vaultNet over the collateral's USD value at the snapshot. */
  ofCollateral: number;
  /** The model's odds of settling at this level or further against the position. */
  odds: number;
}

/** The moves shown: against a put the stock falls, against a call it rises. */
export const STRESS_MOVES = [0.05, 0.1, 0.2, 0.3] as const;

export function stressScenarios(
  inp: DecisionInputs,
  loss: LossLine,
  pricing: Pick<Pricing, "normCdf">,
): Stress[] {
  const sign = inp.isCall ? 1 : -1;
  const coll = collateralUsd(inp);
  return STRESS_MOVES.map((m) => {
    const move = sign * m;
    const settlement = inp.spot * (1 + move);
    const payoutPerOption = payoutAt(loss.strike, settlement, inp.isCall);
    const netPerOption = loss.premium - payoutPerOption;
    const vaultNet = netPerOption * inp.dry.size;
    return {
      move,
      settlement,
      payoutPerOption,
      netPerOption,
      vaultNet,
      ofCollateral: coll > 0 ? vaultNet / coll : NaN,
      odds: oddsBeyond(inp, settlement, pricing),
    };
  });
}

/* ================================================================ the agent's own changes before sending */

export interface Modification {
  /** The mandate rule or plan field the change was about. */
  rule: string;
  by: string;
  before: string;
  after: string;
  note: string;
}

const NUM = String.raw`(\d+(?:\.\d+)?)`;
const PROFILE_CAP = new RegExp(
  `^Profile "([^"]+)" capped the size at (\\d+)% of capacity: ${NUM} → ${NUM}\\.?$`,
);
const FIRST_FAIL = /^The first dry run was not compliant \((\w+)\): (.*)$/;
const TOOK = new RegExp(
  `^Took the risk check's suggestion: ${NUM} delta at (\\d+(?:\\.\\d+)?%) of fair value, size ${NUM}\\.?$`,
);

/**
 * The agent's changes between planning and sending, from the notes its code writes (agents/example/src/index.ts):
 * the rule profile capping the size, and the mandate guard replacing a non-compliant first plan with the risk check's
 * suggestion. Other notes (the planner's name, fallbacks) are not changes and are left out.
 */
export function guardModifications(r: LogRecord): Modification[] {
  const notes = r.decision?.notes ?? [];
  const out: Modification[] = [];
  let firstFail: { reason: string; explanation: string } | null = null;
  for (const n of notes) {
    const cap = n.match(PROFILE_CAP);
    if (cap) {
      out.push({
        rule: "Share of capacity",
        by: `rule profile "${cap[1]}", at most ${cap[2]}% of capacity`,
        before: `${cap[3]} options`,
        after: `${cap[4]} options`,
        note: n,
      });
      continue;
    }
    const fail = n.match(FIRST_FAIL);
    if (fail) {
      firstFail = { reason: fail[1]!, explanation: fail[2]! };
      continue;
    }
    const took = n.match(TOOK);
    if (took) {
      out.push({
        rule: firstFail?.reason ?? "Mandate",
        by: "the agent's mandate guard (risk_check's suggestion)",
        before: firstFail
          ? `first plan failed ${firstFail.reason}: ${firstFail.explanation}`
          : "first plan not compliant",
        after: `${took[1]} delta at ${took[2]} of fair value, ${took[3]} options`,
        note: n,
      });
      firstFail = null;
    }
  }
  return out;
}

/* ================================================================ consistency checks */

export interface Consistency {
  id: string;
  label: string;
  /** true: consistent; false: a contradiction; null: could not be checked, with the reason in `detail`. */
  ok: boolean | null;
  detail: string;
}

/** |delta| a solved strike may differ from its target by: the strike is rounded to a cent (decision.ts). */
const DELTA_SLACK = 0.005;

export function consistencyChecks(
  r: LogRecord,
  opts: { anchor: "match" | "mismatch" | "unreadable" | string; ladderMatches: boolean | null },
): Consistency[] {
  const out: Consistency[] = [];
  out.push({
    id: "anchor",
    label: "The file is the one the agent anchored",
    ok: opts.anchor === "match" ? true : opts.anchor === "unreadable" ? null : false,
    detail:
      opts.anchor === "match"
        ? "keccak256 of the file equals the hash in its DecisionRecorded event"
        : opts.anchor === "unreadable"
          ? "the chain could not be read from this browser"
          : "the hash does not match its anchor",
  });
  const dry = r.dryRun;
  const st = r.result.status;
  if (dry && (st === "accepted" || st === "rejected")) {
    const agree = dry.ok === (st === "accepted");
    out.push({
      id: "verdict",
      label: "The contract's verdict agrees with the dry run",
      ok: agree,
      detail: agree
        ? `dry run ${dry.ok ? "inside the mandate" : `outside (${dry.reason})`}, contract ${st}${r.action === "reckless" ? " (sent with force on purpose)" : ""}`
        : `dry run said ${dry.ok ? "inside" : dry.reason}, the contract ${st} it`,
    });
  } else {
    out.push({
      id: "verdict",
      label: "The contract's verdict agrees with the dry run",
      ok: null,
      detail: dry ? `nothing was sent (${st})` : "the record has no dry run",
    });
  }
  const target = r.decision?.targetDeltaBps ?? null;
  if (target !== null && dry?.delta != null) {
    const gap = Math.abs(Math.abs(dry.delta) - target / BPS);
    out.push({
      id: "delta",
      label: "The dry run's |delta| is the delta the planner asked for",
      ok: gap <= DELTA_SLACK,
      detail: `asked ${(target / BPS).toFixed(2)}, dry run ${Math.abs(dry.delta).toFixed(4)} (allowed gap ${DELTA_SLACK}, the strike is rounded to a cent)`,
    });
  } else {
    out.push({
      id: "delta",
      label: "The dry run's |delta| is the delta the planner asked for",
      ok: null,
      detail:
        target === null ? "the strike was set directly, not by delta" : "the record has no dry run delta",
    });
  }
  if (st === "accepted" && r.result.strike && dry?.strike) {
    const gap = Math.abs(Number(r.result.strike) - Number(dry.strike));
    out.push({
      id: "strike",
      label: "The accepted strike is the dry run's strike",
      ok: gap <= 0.01 + 1e-9,
      detail: `accepted ${usd(Number(r.result.strike))}, dry run ${usd(Number(dry.strike))}${gap > 0 ? " (solved a block later, within a cent)" : ""}`,
    });
  }
  out.push({
    id: "ladder",
    label: "The ladder's chosen rung is the record's dry run",
    ok: opts.ladderMatches,
    detail:
      opts.ladderMatches === null
        ? "no ladder for this record (it lacks an input the ladder needs)"
        : opts.ladderMatches
          ? "same strike and fair value within tolerance"
          : "the chosen rung differs from the dry run",
  });
  return out;
}
