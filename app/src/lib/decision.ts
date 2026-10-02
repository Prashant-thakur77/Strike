// The decision page (/app/decision/<chain>/<record>): everything it shows about one anchored decision record that is
// not printed in the record itself, derived from it deterministically.
//
//   - the mandate scorecard: the record's dry run measured against each rule, in MandateGuard.check order, with the
//     headroom left on each;
//   - the strike ladder: the same proposal recomputed at other target deltas from the record's own inputs (snapshot
//     spot and volatility, mandate, collateral, premium factor and expiry), each judged by the mandate's rules, after
//     a self-check that the recomputed chosen row reproduces the record's dry run;
//   - what would make the week lose: the break-even settlement price and the model's odds of exercise;
//   - in hindsight: each ladder row graded at the settlement price.
//
// Pure. The SDK's pricing is passed in (`Pricing`) rather than imported, so Playwright's CommonJS loader can test this
// file with the SDK's source (e2e/decision.spec.ts) and the page passes the SDK build.

import type { Mandate, ProposalPreview } from "@strike/sdk";
import { parseUnits } from "viem";
import {
  fmtDays,
  mandateRules,
  type MandateRule,
  type ProposalMeasures,
} from "../components/app/playground/model";
import type { LogRecord } from "./agentLog";
import { REASONS } from "./labels";

/** The SDK's pricing functions the page uses (`sdk/src/pricing.ts`). */
export interface Pricing {
  blackScholes(
    spot: number,
    strike: number,
    tenorSeconds: number,
    sigma: number,
    isCall: boolean,
  ): { price: number; delta: number };
  strikeForDelta(
    spot: number,
    targetDelta: number,
    tenorSeconds: number,
    sigma: number,
    isCall: boolean,
  ): number;
  roundStrikeToCent(
    strikeWad: bigint,
    isCall: boolean,
    targetDeltaBps: number,
    mandate: Pick<Mandate, "minDeltaBps" | "maxDeltaBps">,
  ): bigint;
  normCdf(x: number): number;
}

const BPS = 10_000;
/** MandateGuard.MAX_PREMIUM_BPS. */
const MAX_PREMIUM_BPS = 30_000;
/** Stock tokens and the WAD prices the records print. */
const DECIMALS = 18;

const wad = (x: string | number) => parseUnits(typeof x === "number" ? x.toFixed(12) : x, DECIMALS);
const usd = (x: number) =>
  `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fixed = (x: number, frac: number) =>
  x.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: frac });
const pctPts = (bps: number, frac = 2) => `${fixed(bps / 100, frac)}`;

/* ================================================================ routes */

/** Chains whose records the page reads, with the folder each one's records live in. */
export const DECISION_CHAINS: Record<number, string> = {
  46630: "docs/agent-log",
  421614: "docs/agent-log/arbitrum-sepolia",
};

/** A record name as the agent writes it: `<YYYY-MM-DD>-<vault symbol>[-N]`, without `.json`. */
export function isRecordName(name: string): boolean {
  return /^\d{4}-\d{2}-\d{2}-[A-Za-z0-9._-]+$/.test(name) && !name.includes("..") && name.length <= 120;
}

/** The decision page of a record. */
export function decisionPath(chainId: number, name: string): string {
  return `/app/decision/${chainId}/${encodeURIComponent(name)}`;
}

/**
 * The decision page for a record's published URL (a DecisionRecorded event's `uri`, a record's `anchor.uri`): the
 * record must sit in the chain's own folder on GitHub. Null for anything else (the hand-run epoch log of 29 Sep).
 */
export function decisionPathFromUri(chainId: number, uri: string | null | undefined): string | null {
  const folder = DECISION_CHAINS[chainId];
  if (!folder || !uri) return null;
  const m = uri.match(
    /^https:\/\/(?:github\.com\/[^/]+\/[^/]+\/blob|raw\.githubusercontent\.com\/[^/]+\/[^/]+)\/[^/]+\/(.+)\/([^/]+)\.json$/,
  );
  if (!m || m[1] !== folder) return null;
  const name = decodeURIComponent(m[2]!);
  return isRecordName(name) ? decisionPath(chainId, name) : null;
}

/* ================================================================ the record's numbers */

/** The inputs every derived section needs, read from the record; null with the reason when one is missing. */
export interface DecisionInputs {
  isCall: boolean;
  spot: number;
  sigma: number;
  mandate: Mandate;
  /** Unix seconds: when the epoch opened (the snapshot the dry run priced against). */
  openedAt: number;
  expiry: number;
  tenorSeconds: number;
  premiumBps: number;
  /** Vault collateral in whole units (USDG for puts, stock tokens for calls). */
  collateral: number;
  /** Share of the mandate's maximum size the agent sold (1 = all of it). */
  sizeShare: number;
  /** The dry run's numbers, as the record states them. */
  dry: {
    strike: number;
    fairValue: number;
    delta: number;
    size: number;
    capacity: number;
    premiumBps: number;
    yieldBps: number | null;
  };
  /** The |delta| the planner targeted, or null when the strike was set directly (the reckless demo). */
  targetDelta: number | null;
  /** The strike the contract accepted, when it did (it can be a cent off the dry run's: solved a block later). */
  acceptedStrike: number | null;
}

const isoSeconds = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
};

export function decisionInputs(r: LogRecord): DecisionInputs | { missing: string } {
  const m = r.market;
  const d = r.dryRun;
  const mandate = r.vault.mandate;
  if (!m || m.spot === null || m.sigma === null) return { missing: "the record has no market snapshot" };
  if (!mandate) return { missing: "the record does not state the mandate in the contract's units" };
  if (!d || d.strike === null || d.fairValue === null || d.delta === null || d.premiumBps === null)
    return { missing: "the record has no complete dry run" };
  if (d.size === null || d.capacity === null) return { missing: "the dry run has no size and capacity" };
  if (r.vault.collateral === null) return { missing: "the record does not state the vault's collateral" };
  const openedAt = isoSeconds(m.openedAtIso);
  const expiry = isoSeconds(d.expiryIso ?? r.result.expiryIso);
  if (openedAt === null || expiry === null) return { missing: "the record has no epoch-open time or expiry" };
  const spot = Number(m.spot);
  const capacity = Number(d.capacity);
  const size = Number(d.size);
  const maxSize = (capacity * mandate.maxShareSoldBps) / BPS;
  return {
    isCall: r.vault.kind === "covered-call",
    spot,
    sigma: m.sigma,
    mandate,
    openedAt,
    expiry,
    tenorSeconds: expiry - openedAt,
    premiumBps: d.premiumBps,
    collateral: Number(r.vault.collateral),
    sizeShare: maxSize > 0 ? size / maxSize : 0,
    dry: {
      strike: Number(d.strike),
      fairValue: Number(d.fairValue),
      delta: Math.abs(d.delta),
      size,
      capacity,
      premiumBps: d.premiumBps,
      yieldBps: d.yieldBps,
    },
    targetDelta:
      r.decision?.targetDeltaBps !== null && r.decision?.targetDeltaBps !== undefined
        ? r.decision.targetDeltaBps / BPS
        : null,
    acceptedStrike:
      r.result.status === "accepted" && r.result.strike !== null ? Number(r.result.strike) : null,
  };
}

/** The contract's reason code for the record's verdict: 0 when accepted, the rejection's or the dry run's otherwise. */
export function recordReasonCode(r: LogRecord): number | null {
  if (r.result.status === "accepted") return 0;
  const name = r.result.status === "rejected" ? r.result.reason : (r.dryRun?.reason ?? null);
  if (!name) return null;
  const i = REASONS.findIndex((x) => x.name === name);
  return i >= 0 ? i : null;
}

/* ================================================================ 1. the mandate scorecard */

export type HeadroomTone = "room" | "tight" | "over";

export interface ScoredRule extends MandateRule {
  /** The limit the rule sets, in the rule's units. */
  limit: string;
  /** How far the measured value sits from the nearest edge (null for yes-or-no rules and rules not reached). */
  headroom: { text: string; tone: HeadroomTone } | null;
}

/** The record's dry run as the playground's `ProposalMeasures`, measured from the epoch open. */
export function recordMeasures(inp: DecisionInputs, underlying: string): ProposalMeasures {
  const preview: ProposalPreview = {
    reason: "None",
    reasonCode: 0,
    accepted: true,
    fairValue: wad(inp.dry.fairValue),
    delta: wad(inp.isCall ? inp.dry.delta : -inp.dry.delta),
    capacity: wad(inp.dry.capacity),
  };
  return {
    isCall: inp.isCall,
    spot: wad(inp.spot),
    strike: wad(inp.dry.strike),
    expiry: BigInt(inp.expiry),
    now: BigInt(inp.openedAt),
    size: wad(inp.dry.size),
    premiumBps: inp.dry.premiumBps,
    preview,
    underlyingDecimals: DECIMALS,
    symbol: underlying || "token",
  };
}

const tone = (left: number, eps = 1e-9): HeadroomTone =>
  left < -eps ? "over" : left <= eps ? "tight" : "room";

/** The rules in check order, marked against the record's verdict, each with its limit and headroom. */
export function scorecard(inp: DecisionInputs, underlying: string, reasonCode: number | null): ScoredRule[] {
  const md = inp.mandate;
  const rules = mandateRules(md, recordMeasures(inp, underlying), reasonCode);
  const tenor = inp.tenorSeconds;
  const absBps = Math.floor(inp.dry.delta * BPS + 1e-9);
  const yieldBps =
    ((inp.dry.fairValue * inp.dry.premiumBps) / BPS / (inp.isCall ? inp.spot : inp.dry.strike)) * BPS;
  const usedBps = inp.dry.capacity > 0 ? (inp.dry.size / inp.dry.capacity) * BPS : 0;
  return rules.map((rule): ScoredRule => {
    let limit = "";
    let head: ScoredRule["headroom"] = null;
    switch (rule.reason) {
      case "ZeroSize":
        limit = "> 0 options";
        break;
      case "TenorOutOfRange": {
        limit = `${fmtDays(md.minTenor)} to ${fmtDays(md.maxTenor)}`;
        const toMin = tenor - md.minTenor;
        const toMax = md.maxTenor - tenor;
        head =
          toMin < 0
            ? { text: `${fmtDays(-toMin)} short of the floor`, tone: "over" }
            : toMax < 0
              ? { text: `${fmtDays(-toMax)} over the cap`, tone: "over" }
              : toMax <= toMin
                ? { text: `${fmtDays(toMax)} under the cap`, tone: tone(toMax) }
                : { text: `${fmtDays(toMin)} over the floor`, tone: tone(toMin) };
        break;
      }
      case "InvalidExpiry":
        limit = "16:00 New York on a trading day";
        break;
      case "StrikeWrongSide": {
        limit = inp.isCall ? "strike > spot" : "strike < spot";
        const gap = inp.isCall ? inp.dry.strike - inp.spot : inp.spot - inp.dry.strike;
        head = {
          text: `${usd(Math.abs(gap))} (${fixed((Math.abs(gap) / inp.spot) * 100, 3)}%) ${
            gap > 0 ? (inp.isCall ? "above" : "below") : "on the wrong side of"
          } spot`,
          tone: tone(gap, 0.005),
        };
        break;
      }
      case "SizeTooLarge": {
        limit = `≤ ${pctPts(md.maxShareSoldBps)}% of capacity`;
        const left = md.maxShareSoldBps - usedBps;
        head = {
          text:
            Math.abs(left) < 0.5
              ? `${pctPts(usedBps, 1)}% used: at the limit`
              : left > 0
                ? `${pctPts(usedBps, 1)}% used, ${pctPts(left, 1)} points to spare`
                : `${pctPts(usedBps, 1)}% used, ${pctPts(-left, 1)} points over`,
          tone: Math.abs(left) < 0.5 ? "tight" : tone(left),
        };
        break;
      }
      case "PremiumBelowFair": {
        limit = `≥ ${pctPts(md.minPremiumBps)}% of fair value`;
        const left = inp.dry.premiumBps - md.minPremiumBps;
        head = {
          text:
            left >= 0 ? `${pctPts(left)} points above the floor` : `${pctPts(-left)} points under the floor`,
          tone: tone(left),
        };
        break;
      }
      case "PremiumAboveCap": {
        limit = `≤ ${pctPts(MAX_PREMIUM_BPS)}% of fair value`;
        const left = MAX_PREMIUM_BPS - inp.dry.premiumBps;
        head = {
          text: left >= 0 ? `${pctPts(left)} points under the cap` : `${pctPts(-left)} points over the cap`,
          tone: tone(left),
        };
        break;
      }
      case "DeltaOutOfBand": {
        limit = `|Δ| ${(md.minDeltaBps / BPS).toFixed(2)} to ${(md.maxDeltaBps / BPS).toFixed(2)}`;
        const toMin = absBps - md.minDeltaBps;
        const toMax = md.maxDeltaBps - absBps;
        const f = (bps: number) => (bps / BPS).toFixed(4).replace(/0{1,2}$/, "");
        head =
          toMax < 0
            ? { text: `${f(-toMax)} over the ceiling`, tone: "over" }
            : toMin < 0
              ? { text: `${f(-toMin)} under the floor`, tone: "over" }
              : toMin <= toMax
                ? { text: `${f(toMin)} above the floor`, tone: tone(toMin) }
                : { text: `${f(toMax)} under the ceiling`, tone: tone(toMax) };
        break;
      }
      case "PremiumTooSmall": {
        limit = `≥ ${pctPts(md.minYieldBps, 3)}% of collateral`;
        const left = yieldBps - md.minYieldBps;
        head = {
          text:
            left >= 0
              ? `${pctPts(left, 3)} points above the floor`
              : `${pctPts(-left, 3)} points under the floor`,
          tone: tone(left),
        };
        break;
      }
    }
    return { ...rule, limit, headroom: rule.mark === "skip" ? null : head };
  });
}

/* ================================================================ 2. the strike ladder */

export interface RowVerdict {
  ok: boolean;
  /** The first rule the row breaks, in check order (a MandateGuard reason name). */
  reason: string | null;
  measured: string | null;
  bound: string | null;
}

export interface LadderRow {
  /** The |delta| the row targets; null for a strike set directly (the sent row of the reckless demo). */
  target: number | null;
  strike: number;
  /** Strike over spot, minus one (negative below spot). */
  distance: number;
  /** Model |delta| at the cent-rounded strike. */
  delta: number;
  fairValue: number;
  /** Premium per option: fair value × the premium factor. */
  premium: number;
  /** Premium over the collateral one option locks, in bps. */
  yieldBps: number;
  size: number;
  capacity: number;
  verdict: RowVerdict;
  /** The row the agent sent. */
  sent: boolean;
}

export interface SelfCheckItem {
  label: string;
  record: number;
  recomputed: number;
  tolerance: number;
  ok: boolean;
}

export interface Ladder {
  rows: LadderRow[];
  check: { ok: boolean; items: SelfCheckItem[] };
}

/** Self-check tolerances: the strike to the cent, fair value within half a cent, |delta| within the record's rounding. */
export const LADDER_TOLERANCE = { strike: 0.01, fairValue: 0.005, delta: 0.0005, sizeRel: 1e-6 } as const;

export const LADDER_TOLERANCE_TEXT =
  "strike within $0.01, fair value within $0.005 per option, |Δ| within 0.0005 and size within one part in a million";

/** Target deltas from one 0.05 step below the band's floor to one above its ceiling. */
export function ladderTargets(mandate: Pick<Mandate, "minDeltaBps" | "maxDeltaBps">, step = 0.05): number[] {
  const lo = Math.max(step, Math.ceil((mandate.minDeltaBps / BPS - step) / step - 1e-9) * step);
  const hi = Math.min(0.45, Math.floor((mandate.maxDeltaBps / BPS + step) / step + 1e-9) * step);
  const out: number[] = [];
  for (let t = lo; t <= hi + 1e-9; t += step) out.push(Math.round(t * 100) / 100);
  return out;
}

/** The first mandate rule a recomputed row breaks, in MandateGuard.check order. */
export function judgeRow(
  inp: DecisionInputs,
  row: Pick<LadderRow, "strike" | "delta" | "fairValue" | "size" | "capacity">,
  expiryOk: boolean,
): RowVerdict {
  const md = inp.mandate;
  const fail = (reason: string, measured: string, bound: string): RowVerdict => ({
    ok: false,
    reason,
    measured,
    bound,
  });
  if (!(row.size > 0)) return fail("ZeroSize", "0 options", "> 0");
  if (inp.tenorSeconds < md.minTenor || inp.tenorSeconds > md.maxTenor)
    return fail(
      "TenorOutOfRange",
      fmtDays(inp.tenorSeconds),
      `${fmtDays(md.minTenor)} to ${fmtDays(md.maxTenor)}`,
    );
  if (!expiryOk) return fail("InvalidExpiry", "not a session close", "16:00 New York");
  if (inp.isCall ? row.strike <= inp.spot : row.strike >= inp.spot)
    return fail(
      "StrikeWrongSide",
      `strike ${usd(row.strike)}`,
      `${inp.isCall ? ">" : "<"} spot ${usd(inp.spot)}`,
    );
  if (row.size > (row.capacity * md.maxShareSoldBps) / BPS + 1e-12)
    return fail(
      "SizeTooLarge",
      `${fixed((row.size / row.capacity) * 100, 1)}% of capacity`,
      `≤ ${pctPts(md.maxShareSoldBps)}%`,
    );
  if (inp.premiumBps < md.minPremiumBps)
    return fail("PremiumBelowFair", `${pctPts(inp.premiumBps)}%`, `≥ ${pctPts(md.minPremiumBps)}%`);
  if (inp.premiumBps > MAX_PREMIUM_BPS)
    return fail("PremiumAboveCap", `${pctPts(inp.premiumBps)}%`, `≤ ${pctPts(MAX_PREMIUM_BPS)}%`);
  const absBps = Math.floor(row.delta * BPS + 1e-9);
  if (absBps < md.minDeltaBps || absBps > md.maxDeltaBps)
    return fail(
      "DeltaOutOfBand",
      `|Δ| ${row.delta.toFixed(4)}`,
      `${(md.minDeltaBps / BPS).toFixed(2)} to ${(md.maxDeltaBps / BPS).toFixed(2)}`,
    );
  const coll = inp.isCall ? inp.spot : row.strike;
  if (row.fairValue * inp.premiumBps < md.minYieldBps * coll)
    return fail(
      "PremiumTooSmall",
      `${fixed(((row.fairValue * inp.premiumBps) / BPS / coll) * 100, 3)}%`,
      `≥ ${pctPts(md.minYieldBps, 3)}%`,
    );
  return { ok: true, reason: null, measured: null, bound: null };
}

/** One row of the ladder at a strike (already rounded to a cent). */
function rowAt(
  inp: DecisionInputs,
  pricing: Pricing,
  strike: number,
  target: number | null,
  expiryOk: boolean,
): LadderRow {
  const q = pricing.blackScholes(inp.spot, strike, inp.tenorSeconds, inp.sigma, inp.isCall);
  const premium = (q.price * inp.premiumBps) / BPS;
  const coll = inp.isCall ? inp.spot : strike;
  const capacity = inp.isCall ? inp.collateral : inp.collateral / strike;
  const size = ((capacity * inp.mandate.maxShareSoldBps) / BPS) * inp.sizeShare;
  const base = {
    target,
    strike,
    distance: strike / inp.spot - 1,
    delta: Math.abs(q.delta),
    fairValue: q.price,
    premium,
    yieldBps: (premium / coll) * BPS,
    size,
    capacity,
    sent: false,
  };
  return { ...base, verdict: judgeRow(inp, base, expiryOk) };
}

/** The cent-rounded strike `proposeByDelta` would solve for a target |delta|, by the SDK's solver. */
export function strikeAtDelta(inp: DecisionInputs, pricing: Pricing, target: number): number {
  const raw = pricing.strikeForDelta(inp.spot, target, inp.tenorSeconds, inp.sigma, inp.isCall);
  const cents = pricing.roundStrikeToCent(wad(raw), inp.isCall, Math.round(target * BPS), inp.mandate);
  return Number(cents / 10n ** 16n) / 100;
}

/**
 * The ladder, recomputed from the record's inputs with the SDK's pricing: one row per target delta (and the sent row
 * when its strike was set directly), each judged by the mandate's rules, and the self-check of the sent row against
 * the record's own dry run.
 */
export function buildLadder(inp: DecisionInputs, pricing: Pricing, reasonCode: number | null): Ladder {
  // A dry run that failed before the strike rules (tenor, expiry) fails every row the same way.
  const expiryOk = reasonCode !== 3;
  const targets = ladderTargets(inp.mandate);
  if (inp.targetDelta !== null && !targets.some((t) => Math.abs(t - inp.targetDelta!) < 1e-9)) {
    targets.push(inp.targetDelta);
  }
  targets.sort((a, b) => a - b);
  const rows = targets.map((t) => {
    const row = rowAt(inp, pricing, strikeAtDelta(inp, pricing, t), t, expiryOk);
    if (inp.targetDelta !== null && Math.abs(t - inp.targetDelta) < 1e-9) row.sent = true;
    return row;
  });
  if (inp.targetDelta === null) {
    const sent = rowAt(inp, pricing, inp.dry.strike, null, expiryOk);
    sent.sent = true;
    rows.push(sent);
    rows.sort((a, b) => a.delta - b.delta);
  }
  const sent = rows.find((r) => r.sent)!;
  const item = (label: string, record: number, recomputed: number, tolerance: number): SelfCheckItem => ({
    label,
    record,
    recomputed,
    tolerance,
    ok: Math.abs(record - recomputed) <= tolerance + 1e-12,
  });
  const items = [
    item("Strike", inp.dry.strike, sent.strike, LADDER_TOLERANCE.strike),
    item("Fair value", inp.dry.fairValue, sent.fairValue, LADDER_TOLERANCE.fairValue),
    item("|Δ|", inp.dry.delta, sent.delta, LADDER_TOLERANCE.delta),
    item("Size", inp.dry.size, sent.size, Math.max(inp.dry.size * LADDER_TOLERANCE.sizeRel, 1e-12)),
  ];
  return { rows, check: { ok: items.every((i) => i.ok), items } };
}

/* ================================================================ 3. what would make this week lose */

export interface LossLine {
  /** The settlement price past which the option pays out more than its premium. */
  breakEven: number;
  /** Break-even over the snapshot spot, minus one. */
  distance: number;
  strike: number;
  premium: number;
  fairValue: number;
  premiumBps: number;
  /** The model's probability the option finishes in the money: N(d2) for a call, N(−d2) for a put. */
  probItm: number;
  delta: number;
  isCall: boolean;
  spot: number;
  sigma: number;
}

/**
 * Break-even and model odds for the strike the record sold (the accepted strike, else the dry run's): a put loses
 * money for depositors below strike − premium, a call above strike + premium. The odds use the snapshot's volatility
 * and the tenor from the epoch open, the inputs the pricer used.
 */
export function lossLine(inp: DecisionInputs, pricing: Pricing): LossLine {
  const strike = inp.acceptedStrike ?? inp.dry.strike;
  const premium = (inp.dry.fairValue * inp.dry.premiumBps) / BPS;
  const breakEven = inp.isCall ? strike + premium : strike - premium;
  const vol = inp.sigma * Math.sqrt(inp.tenorSeconds / 31_536_000);
  const d2 = (Math.log(inp.spot / strike) - (vol * vol) / 2) / vol;
  return {
    breakEven,
    distance: breakEven / inp.spot - 1,
    strike,
    premium,
    fairValue: inp.dry.fairValue,
    premiumBps: inp.dry.premiumBps,
    probItm: inp.isCall ? pricing.normCdf(d2) : pricing.normCdf(-d2),
    delta: inp.dry.delta,
    isCall: inp.isCall,
    spot: inp.spot,
    sigma: inp.sigma,
  };
}

/* ================================================================ 5. in hindsight */

export interface GradedRow {
  row: LadderRow;
  payout: number;
  /** Premium minus payout, per option sold. */
  net: number;
  /** Net over the collateral one option locks. */
  netPct: number;
}

/** Each ladder row's result per option at the settlement price: premium minus payout. */
export function gradeLadder(
  rows: LadderRow[],
  settlement: number,
  isCall: boolean,
  spot: number,
): GradedRow[] {
  return rows.map((row) => {
    const payout = isCall ? Math.max(settlement - row.strike, 0) : Math.max(row.strike - settlement, 0);
    const net = row.premium - payout;
    return { row, payout, net, netPct: net / (isCall ? spot : row.strike) };
  });
}

const signedUsd = (x: number) => `${x < 0 ? "−" : ""}${usd(Math.abs(x))}`;
const deltaLabel = (r: LadderRow) =>
  r.target !== null ? `${r.target.toFixed(2)} delta` : `the ${usd(r.strike)} strike`;

/**
 * One line from the numbers: how the sent row compares with the best and worst rows the mandate allowed, per option.
 */
export function hindsightTakeaway(graded: GradedRow[], settlement: number): string {
  const at = `At the ${usd(settlement)} settlement`;
  const sent = graded.find((g) => g.row.sent);
  if (!sent) return `${at}, no row was sent.`;
  const inside = graded.filter((g) => g.row.verdict.ok);
  if (!sent.row.verdict.ok) {
    if (inside.length === 0) return `${at}, no row was inside the mandate.`;
    const best = inside.reduce((a, b) => (b.net > a.net ? b : a));
    return `${at}, the sent strike was outside the mandate, so nothing was sold; the best row inside it, ${deltaLabel(best.row)}, would have netted ${signedUsd(best.net)} per option.`;
  }
  const best = inside.reduce((a, b) => (b.net > a.net + 1e-9 ? b : a));
  const worst = inside.reduce((a, b) => (b.net < a.net - 1e-9 ? b : a));
  const eps = 0.005;
  if (best.net - sent.net < eps) {
    return `${at}, the sent strike netted ${signedUsd(sent.net)} per option, the most of the rows inside the mandate${
      sent.net - worst.net >= eps
        ? `; ${deltaLabel(worst.row)} would have kept ${usd(sent.net - worst.net)} less`
        : ""
    }.`;
  }
  return `${at}, ${deltaLabel(best.row)} would have kept ${usd(best.net - sent.net)} per option more than the sent ${deltaLabel(sent.row)} (${signedUsd(sent.net)})${
    worst !== sent && sent.net - worst.net >= eps
      ? `, and ${deltaLabel(worst.row)} ${usd(sent.net - worst.net)} less`
      : ""
  }.`;
}

export const HINDSIGHT_CAVEAT =
  "Per option sold. One week is noise, not a measure of skill, and other strikes would have sold differently: another number of options, to other buyers or none.";

/* ================================================================ the agent's own ladder (decision.candidates) */

/**
 * The ladder the agent itself dry-ran (`decision.candidates` with source "ladder"), as ladder rows: the contract's own
 * numbers and verdicts, part of the anchored record. Entries whose dry run could not be read are left out. Empty for
 * records written before the field.
 */
export function recordedLadder(r: LogRecord, spot: number | null): LadderRow[] {
  const cands = (r.decision?.candidates ?? []).filter((c) => c.source === "ladder");
  return cands.flatMap((c): LadderRow[] => {
    if (c.error !== null || c.strike === null || c.fairValue === null) return [];
    const strike = Number(c.strike);
    const fairValue = Number(c.fairValue);
    const premium = c.premium !== null ? Number(c.premium) : (fairValue * (c.premiumBps ?? BPS)) / BPS;
    return [
      {
        target: c.targetDeltaBps !== null ? c.targetDeltaBps / BPS : null,
        strike,
        distance: spot ? strike / spot - 1 : NaN,
        delta: c.delta ?? NaN,
        fairValue,
        premium,
        yieldBps: c.yieldBps ?? NaN,
        size: c.size !== null ? Number(c.size) : NaN,
        capacity: c.capacity !== null ? Number(c.capacity) : NaN,
        verdict: c.ok
          ? { ok: true, reason: null, measured: null, bound: null }
          : {
              ok: false,
              reason: c.failedRule?.rule ?? c.reason,
              measured: c.failedRule?.measured ?? null,
              bound: c.failedRule?.limit ?? null,
            },
        sent: c.chosen,
      },
    ];
  });
}
