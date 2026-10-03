import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getStrikeChain, strikeExplorerUrl } from "@strike/sdk";
import { type PipelineStage, STAGE_TITLES, isNotProvided } from "./pipeline.js";
import type { Alternative, Confidence } from "./specialists/critic.js";
import type { Contradiction } from "./specialists/market.js";
import type { MandateView } from "./types.js";

// The agent's decision record: what it saw, what it decided and why, what it sent and what happened. `--log <dir>`
// writes one per run as markdown (for people) and JSON (for the app).

/** Bump when a field changes meaning. */
export const RECORD_VERSION = 1;

export type RecordAction = "propose" | "reckless" | "settle";

export interface RecordTx {
  /** What the transaction did, e.g. "openEpoch" or "proposeByDelta". */
  label: string;
  hash: string;
  /** Block explorer link (null on chains without one, such as the local devnet). */
  url: string | null;
}

export interface MarketInputs {
  /** Spot in USD per token (null when the feed has no price). */
  spot: string | null;
  /** Annualised implied volatility as a fraction (0.45 = 45%). */
  sigma: number | null;
  /**
   * "epoch-open snapshot": `EpochManager.epochs(vault)` openSpot and openSigma, taken when the running epoch opened
   * (what the contract judges proposals against). "live": the oracle spot and the underlying's current sigma.
   */
  source: "epoch-open snapshot" | "live";
  /** When the snapshot was taken (null for live inputs). */
  openedAtIso: string | null;
  oracleStatus: string;
  marketOpen: boolean;
}

/** The first mandate rule a candidate fails, with the value the contract measured and the limit it breaks. */
export interface RecordFailedRule {
  /** The contract's MandateGuard reason, e.g. "DeltaOutOfBand". */
  rule: string;
  /** What was measured, in words with units, e.g. "|delta| 0.4928". */
  measured: string;
  /** The limit it breaks, e.g. "0.10 to 0.35". */
  limit: string;
}

/**
 * A proposal the agent dry-ran with `risk_check` (the contract's own `previewProposal`) while deciding. Read by the
 * app (`app/src/lib/agentLog.ts` parseCandidate: targetDeltaBps, premiumBps, ok, reason, strike, fairValue,
 * yieldBps); the other fields are extra detail it ignores. A dry run that could not be read is an error entry
 * (`ok: false`, `reason: null`, `error` set, no measured values): nothing is recorded that was not dry-run.
 */
export interface RecordCandidate {
  /** "ladder": a rung of the agent's own sweep across the mandate's delta band; "planner": a call Claude made. */
  source: "ladder" | "planner";
  /** The target |delta| in bps of 1 the dry run solved the strike from (null when Claude passed a strike). */
  targetDeltaBps: number | null;
  /** The premium factor asked, in bps of Black-Scholes fair value. */
  premiumBps: number | null;
  /** The contract's verdict: would it accept this proposal. False for an error entry. */
  ok: boolean;
  /** The contract's MandateGuard reason ("None" when accepted); null for an error entry. */
  reason: string | null;
  strike: string | null;
  /** Black-Scholes fair value per option, USD. */
  fairValue: string | null;
  /** Fair value x premium factor: what one option sells for, USD. */
  premium: string | null;
  yieldBps: number | null;
  /** Measured |delta| of the solved strike. */
  delta: number | null;
  /** Options offered and the vault's capacity at that strike. */
  size: string | null;
  capacity: string | null;
  /** True for the candidate whose delta and premium became the proposal. */
  chosen: boolean;
  /** For a rejected candidate: the rule it fails, with the measured value and the limit. */
  failedRule: RecordFailedRule | null;
  /** The risk check's plain-words explanation (null for an error entry). */
  explanation: string | null;
  /** Why the dry run could not be read (error entries only). */
  error?: string;
  /** The arguments Claude passed to `risk_check` (planner entries only). */
  inputs?: Record<string, unknown>;
}

export interface RecordDecision {
  strategy: "default" | "claude" | "reckless";
  targetDeltaBps: number | null;
  premiumBps: number | null;
  /** The strategy's rule, or Claude's stated reasoning. */
  reasoning: string;
  /** Mandate guard corrections and fallbacks, in order. */
  notes: string[];
  /**
   * Who planned: with strategy "claude", how the agent reached Claude and the model; with strategy "default", the
   * rule-based profile (`--profile`). Absent in older records.
   */
  planner?: RecordPlanner;
  /**
   * The alternatives the agent dry-ran while deciding: Claude's own `risk_check` calls (source "planner", in call
   * order) then the ladder across the mandate's delta band (source "ladder", by delta). Absent in older records and
   * when nothing was dry-run. The record hash covers it like every other field.
   */
  candidates?: RecordCandidate[];
  /**
   * The specialist pipeline of a propose run: market analyst, risk analyst, strike planner, critic and contract, in
   * the order they ran, each with its inputs, output, verdict, sources, duration and who did it (src/pipeline.ts). A
   * stage the run never reached is "not-run" with the reason. Absent in older records and in reckless and settle runs.
   * Part of the hashed JSON like every other field.
   */
  pipeline?: PipelineStage[];
  /**
   * What the week could have been, with the model numbers it is graded on at settlement: the chosen strike, kept cash,
   * half the size, one ladder step nearer to spot and one farther (src/specialists/critic.ts).
   */
  alternatives?: Alternative[];
  /** Computed, not self-reported: the model odds that the chosen option expires worthless. */
  confidence?: Confidence | null;
  /** Inputs that should agree, compared: the mirror against the mainnet print, the MCP's spot against the oracle's. */
  contradictions?: Contradiction[];
}

/**
 * The planner: `--llm` through the Anthropic API or the Claude Code CLI on a Claude subscription, or a rule-based
 * profile ("rule", `model` is the profile's name).
 */
export interface RecordPlanner {
  kind: "api" | "claude-code" | "rule";
  model: string;
  /** "Claude via API, model X", "Claude via Claude Code CLI, model X" or "rule: conservative". */
  label: string;
}

export interface RecordDryRun {
  ok: boolean;
  reason: string;
  explanation: string;
  optionType: "call" | "put";
  strike: string;
  delta: number;
  targetDeltaBps: number | null;
  expiryIso: string;
  size: string;
  capacity: string;
  premiumBps: number;
  fairValue: string;
  yieldBps: number;
}

export type RecordStatus = "accepted" | "rejected" | "not-sent" | "settled" | "skipped" | "failed";

export interface RecordResult {
  status: RecordStatus;
  /** One sentence for people. */
  summary: string;
  seriesId?: string | null;
  strike?: string;
  expiryIso?: string;
  size?: string;
  /** MandateGuard reason of a rejection. */
  reason?: string;
  /** USDG slashed from the agent's bond. */
  slashed?: string;
  settlementPrice?: string | null;
  /** Paid to option holders, in the vault's collateral asset. */
  payout?: string;
  /** USDG premium the epoch collected, and the performance fee taken from it. */
  premium?: string;
  fee?: string;
  /** Who sent the settlement: this agent, or the keeper (or anyone) before it ran. */
  settledBy?: "agent" | "keeper";
  /**
   * A no-trade decision (status "not-sent"): the specialist that stopped the run and its reasons, e.g. the market
   * analyst's "market closed until Mon 5 Oct 13:30 UTC" or a critic veto.
   */
  noTrade?: { stage: string; reasons: string[]; codes?: string[] };
}

export interface RecordTrack {
  agentId: string;
  status: string;
  active: boolean;
  accepted: number;
  rejected: number;
  strikes: number;
  maxStrikes: number;
  bond: string;
  settledEpochs: number;
  cumulativePnl: string;
  claimableFees: string;
}

/** The record's on-chain anchor (`--anchor`): its hash committed to the DecisionLog contract. */
export interface RecordAnchor {
  /** DecisionLog contract. */
  contract: string;
  /** keccak256 of this JSON without `anchor` and without the DecisionLog.record transaction (anchor.ts). */
  recordHash: string;
  /** Where the record is published. */
  uri: string;
  /** The vault's epoch number the record was anchored under. */
  epoch: number;
  txHash: string;
}

export interface DecisionRecord {
  version: number;
  action: RecordAction;
  /** YYYY-MM-DD (UTC) of the chain time the run started at. */
  date: string;
  /** Chain time the run started at, ISO-8601 UTC. */
  chainTimeIso: string;
  chain: { id: number; name: string; explorer: string | null };
  agent: { agentId: string | null; signer: string | null };
  vault: {
    address: string;
    symbol: string;
    name: string;
    kind: "covered-call" | "cash-secured-put";
    underlying: string;
    collateral: string;
    collateralAsset: string;
    epochState: string;
    mandate: MandateView;
  };
  market: MarketInputs | null;
  decision: RecordDecision | null;
  dryRun: RecordDryRun | null;
  transactions: RecordTx[];
  result: RecordResult;
  trackRecord: RecordTrack | null;
  /** Present when the record was anchored on-chain (`--anchor`). */
  anchor?: RecordAnchor;
  /**
   * Present on a `--dry-run` record only: nothing was sent and the record is not anchored. `ignoreSession` marks a run
   * evaluated as if the NYSE were open (`--ignore-session`), which the agent never allows with a send.
   */
  run?: { dryRun: true; ignoreSession: boolean; note: string };
}

/** The chain's block explorer base URL from strike.config.json, or null (local devnet, unknown chain). */
export function explorerUrl(chainId: number): string | null {
  return strikeExplorerUrl(chainId);
}

/** A transaction's block explorer link, e.g. https://explorer.testnet.chain.robinhood.com/tx/0x... on 46630. */
export function txUrl(chainId: number, hash: string): string | null {
  const base = explorerUrl(chainId);
  return base ? `${base.replace(/\/$/, "")}/tx/${hash}` : null;
}

/** The chain's display name ("Robinhood Chain Testnet"), or "chain <id>". */
export function chainName(chainId: number): string {
  try {
    return getStrikeChain(chainId).name;
  } catch {
    return `chain ${chainId}`;
  }
}

/**
 * File name (without extension) of a record: `<YYYY-MM-DD>-<vault symbol>`, with `-dry-run` (or `-as-if-open-dry-run`
 * for `--ignore-session`) for a dry run.
 */
export function recordBaseName(record: Pick<DecisionRecord, "date" | "vault" | "run">): string {
  const symbol = record.vault.symbol.replace(/[^A-Za-z0-9._-]/g, "_");
  const suffix = record.run ? (record.run.ignoreSession ? "-as-if-open-dry-run" : "-dry-run") : "";
  return `${record.date}-${symbol}${suffix}`;
}

const pct = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
const deltaText = (bps: number) => (bps / 10_000).toFixed(2);
const kindText = (kind: DecisionRecord["vault"]["kind"]) =>
  kind === "covered-call" ? "covered call" : "cash-secured put";
const code = (s: string) => `\`${s}\``;
const txLink = (tx: RecordTx) => (tx.url ? `[${code(tx.hash)}](${tx.url})` : code(tx.hash));
/** One line of free text: collapse whitespace so a list item stays one item. */
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

const ACTION_TITLE: Record<RecordAction, string> = {
  propose: "weekly proposal",
  reckless: "reckless proposal (demo)",
  settle: "settlement",
};

const STATUS_TITLE: Record<RecordStatus, string> = {
  accepted: "Accepted",
  rejected: "Rejected on-chain",
  "not-sent": "Not sent",
  settled: "Settled",
  skipped: "Nothing to do",
  failed: "Stopped",
};

function marketSection(m: MarketInputs | null): string[] {
  if (!m) return ["Not read."];
  const when =
    m.source === "epoch-open snapshot"
      ? `snapshot taken when the epoch opened${m.openedAtIso ? ` (${m.openedAtIso})` : ""}; the contract judges proposals against it`
      : "live values: no epoch is running, so there is no opening snapshot";
  return [
    `- **Spot:** ${m.spot === null ? "no price" : `$${m.spot}`}`,
    `- **Implied volatility (sigma):** ${m.sigma === null ? "unknown" : `${(m.sigma * 100).toFixed(2)}% a year`}`,
    `- **Source:** ${when}`,
    `- **Oracle:** ${m.oracleStatus}; NYSE ${m.marketOpen ? "open" : "closed"} at the time of the run`,
  ];
}

function decisionSection(d: RecordDecision | null, action: RecordAction): string[] {
  if (!d) {
    return [
      action === "settle"
        ? "No decision to make: settlement follows the price feed's first print at or after expiry."
        : "The run stopped before a decision was made.",
    ];
  }
  const strategy = {
    default: "default strategy (deterministic)",
    claude: "Claude chose the plan (read-only Strike tools, then the agent's own mandate guard)",
    reckless: "reckless demo: an at-the-money strike, sent with force to show the contract rejecting it",
  }[d.strategy];
  const lines = [`- **Strategy:** ${strategy}`];
  if (d.planner) lines.push(`- **Planner:** ${d.planner.label}`);
  if (d.targetDeltaBps !== null) {
    lines.push(
      `- **Target:** ${deltaText(d.targetDeltaBps)} delta${d.premiumBps !== null ? ` at ${pct(d.premiumBps)} of Black-Scholes fair value` : ""}`,
    );
  }
  for (const n of d.notes) lines.push(`- **Note:** ${oneLine(n)}`);
  lines.push("", "Why:", "");
  for (const l of d.reasoning.trim().split("\n")) lines.push(l.trim() ? `> ${l.trimEnd()}` : ">");
  return lines;
}

function dryRunSection(r: RecordDryRun | null): string[] {
  if (!r) return ["No dry run."];
  const target = r.targetDeltaBps !== null ? `, solved from a ${deltaText(r.targetDeltaBps)} target` : "";
  return [
    `- **Verdict:** ${r.ok ? "inside the mandate" : "outside the mandate"} (${code(r.reason)}). ${oneLine(r.explanation)}`,
    `- **Proposal:** ${r.optionType} at strike $${r.strike} (|delta| ${r.delta}${target}), expiry ${r.expiryIso}, ${r.size} of ${r.capacity} options, premium ${pct(r.premiumBps)} of fair value`,
    `- **Fair value:** $${r.fairValue} per option, ${pct(r.yieldBps)} of collateral`,
  ];
}

/** A decimal string cut to six places (an 18-decimal token amount is unreadable in a sentence). */
const shortDecimal = (s: string) => s.replace(/(\.\d{6})\d+$/, "$1");

/** The alternatives the agent dry-ran, one list item each (empty when the record has none). */
function candidatesSection(d: RecordDecision | null): string[] {
  const cands = d?.candidates ?? [];
  if (cands.length === 0) return [];
  const lines: string[] = [];
  const planner = cands.filter((c) => c.source === "planner");
  const ladder = cands.filter((c) => c.source === "ladder");
  const item = (c: RecordCandidate): string => {
    const asked = c.targetDeltaBps !== null ? `${deltaText(c.targetDeltaBps)} delta` : "an explicit strike";
    const head = `**${asked}${c.premiumBps !== null ? ` at ${pct(c.premiumBps)} of fair value` : ""}**${c.chosen ? " (chosen)" : ""}`;
    if (c.error !== undefined) return `- ${head}: could not be dry-run (${oneLine(c.error)}).`;
    const parts = [
      c.strike ? `strike $${c.strike}` : null,
      c.delta !== null ? `|delta| ${c.delta}` : null,
      c.fairValue ? `fair value $${c.fairValue}` : null,
      c.premium ? `premium $${c.premium} per option` : null,
      c.yieldBps !== null ? `yield ${pct(c.yieldBps)} of collateral` : null,
      c.size && c.capacity ? `${shortDecimal(c.size)} of ${shortDecimal(c.capacity)} options` : null,
    ].filter((x): x is string => x !== null);
    const verdict = c.ok
      ? "inside the mandate"
      : c.failedRule
        ? `outside the mandate: ${code(c.failedRule.rule)}, ${c.failedRule.measured} against ${c.failedRule.limit}`
        : `outside the mandate${c.reason ? ` (${code(c.reason)})` : ""}`;
    return `- ${head}: ${parts.join(", ")}. ${verdict[0]?.toUpperCase()}${verdict.slice(1)}.`;
  };
  if (planner.length) {
    lines.push("Claude's own `risk_check` calls, in order:", "", ...planner.map(item), "");
  }
  if (ladder.length) {
    lines.push(
      "The agent's ladder: the same dry run at several target deltas across the mandate's band and a little beyond each edge, all at the chosen premium factor and the largest size the mandate allows:",
      "",
      ...ladder.map(item),
      "",
    );
  }
  lines.pop();
  return lines;
}

const VERDICT_TEXT: Record<PipelineStage["verdict"], string> = {
  pass: "PASS",
  modify: "MODIFY",
  fail: "FAIL",
  "not-run": "NOT RUN",
};
const BY_TEXT: Record<PipelineStage["by"], string> = {
  rule: "agent code",
  claude: "Claude",
  contract: "the contract",
};
const share = (x: number) => `${(x * 100).toFixed(1)}%`;
type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj => (typeof v === "object" && v !== null ? (v as Obj) : {});
const asArr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : []);
const msText = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);

/** The lines under one stage: its checks, rows, choice, rules, narration and sources. */
function stageDetails(st: PipelineStage): string[] {
  const out: string[] = [];
  const o = st.output;
  if (st.stage === "market") {
    for (const c of asArr(o.checks)) {
      const state = c.ok ? "ok" : c.waived ? "failed, waived by --ignore-session (dry run)" : "failed";
      out.push(`${String(c.check)}: ${String(c.measured)}; limit: ${String(c.limit)} (${state})`);
    }
    if (isNotProvided(o.mainnet)) out.push(`mainnet Chainlink print: not provided (${o.mainnet.reason})`);
    const realised = asObj(o.sigma).realised;
    if (isNotProvided(realised)) out.push(`realised volatility: not provided (${realised.reason})`);
    else if (typeof asObj(realised).value === "number")
      out.push(
        `realised volatility: ${share(asObj(realised).value as number)} a year over ${String(asObj(realised).returns)} daily returns of mainnet Chainlink closes, against the pricer's sigma ${share(Number(asObj(o.sigma).value))}`,
      );
  } else if (st.stage === "risk") {
    for (const r of asArr(o.rows)) {
      if (r.targetDeltaBps === null || r.targetDeltaBps === undefined) continue;
      const head = `${deltaText(Number(r.targetDeltaBps))} delta`;
      if (typeof r.error === "string") {
        out.push(`${head}: could not be dry-run (${oneLine(r.error)})`);
        continue;
      }
      const parts = [
        `strike $${String(r.strike)}`,
        r.ok ? "inside the mandate" : `outside the mandate (${code(String(r.reason))})`,
        r.yieldBps !== null ? `yield ${pct(Number(r.yieldBps))}` : null,
        typeof r.exerciseProbability === "number"
          ? `model P(exercise) ${share(r.exerciseProbability)}`
          : null,
        r.breakEven
          ? `break-even $${String(r.breakEven)} (${share(Number(r.breakEvenDistance))} from spot)`
          : null,
      ].filter((x): x is string => x !== null);
      const stress = asObj(r.stress);
      parts.push(
        isNotProvided(stress)
          ? `stress not provided (${oneLine(stress.reason)})`
          : `worst ±30% payout $${String(stress.worstLossUsd)} (${share(Number(stress.shareOfCollateral))} of collateral)`,
      );
      const g = asObj(r.greeks);
      if (!isNotProvided(g) && typeof g.delta === "number")
        parts.push(
          `greeks per option: delta ${g.delta.toFixed(4)}, gamma ${Number(g.gamma).toFixed(5)}, vega ${Number(g.vega).toFixed(3)}, theta ${Number(g.theta).toFixed(3)} a day`,
        );
      out.push(`${head}: ${parts.join(", ")}`);
    }
    const engine = asObj(o.engine);
    if (isNotProvided(engine)) out.push(`Risk engine: not provided (${engine.reason})`);
    else if (typeof engine.address === "string")
      out.push(`Risk engine: ${code(engine.address)} (${String(engine.via)})`);
    const rej = asObj(o.rejections);
    if (Object.keys(rej).length)
      out.push(
        `Rejected by the dry run: ${Object.entries(rej)
          .map(([k, n]) => `${String(n)} ${k}`)
          .join(", ")}`,
      );
  } else if (st.stage === "planner") {
    if (typeof o.targetDeltaBps === "number")
      out.push(
        `Chose ${deltaText(o.targetDeltaBps)} delta at ${pct(Number(o.premiumBps))} of fair value${o.strike ? `, strike $${String(o.strike)}` : ""}${o.size ? `, ${shortDecimal(String(o.size))} options` : ""}`,
      );
  } else if (st.stage === "critic") {
    for (const m of asArr(o.modifications))
      out.push(
        `MODIFY ${String(m.field)}: ${String(m.before)} to ${String(m.after)} (${oneLine(String(m.reason))})`,
      );
    for (const r of asArr(o.rules)) {
      const state = r.ok ? (r.applicable === false ? "not applicable" : "ok") : "VETO";
      out.push(`${String(r.rule)}: ${oneLine(String(r.measured))}; limit: ${String(r.limit)} (${state})`);
    }
    const c = asObj(o.confidence);
    if (typeof c.worthlessProbability === "number")
      out.push(
        `Model odds the option expires worthless: ${share(c.worthlessProbability)} (${oneLine(String(c.basis))})`,
      );
  }
  if (st.sources.length) {
    const src = st.sources.map(
      (x) =>
        `${x.name}${x.address ? ` at ${code(x.address)}` : ""}${x.chainId ? ` (chain ${x.chainId})` : ""}`,
    );
    out.push(`Sources: ${src.join(", ")}`);
  }
  return out;
}

/** The specialist pipeline, one list item per stage (empty when the record has none). */
function pipelineSection(d: RecordDecision | null): string[] {
  const stages = d?.pipeline ?? [];
  if (stages.length === 0) return [];
  const lines = [
    "Each specialist has its own inputs and tools; every number below was computed from those tools. Claude's words, where present, are labelled as narration.",
    "",
  ];
  for (const st of stages) {
    const meta = st.verdict === "not-run" ? "" : ` (${BY_TEXT[st.by]}, ${msText(st.durationMs)})`;
    const summary = oneLine(st.summary).replace(/^not run: /, "");
    lines.push(
      `- **${STAGE_TITLES[st.stage]}${st.attempt > 1 ? ` (attempt ${st.attempt})` : ""}**${meta}: ${VERDICT_TEXT[st.verdict]}. ${summary[0]?.toUpperCase() ?? ""}${summary.slice(1)}`,
    );
    for (const l of stageDetails(st)) lines.push(`  - ${oneLine(l)}`);
    if (st.narration) {
      lines.push(`  - Narration by ${st.narration.label} (Claude's words, not a computed number):`, "");
      for (const l of st.narration.text.trim().split("\n"))
        lines.push(l.trim() ? `    > ${l.trimEnd()}` : "    >");
      lines.push("");
    }
  }
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** The alternatives to grade at settlement, and the contradictions checked. */
function alternativesSection(d: RecordDecision | null): string[] {
  const alts = d?.alternatives ?? [];
  if (alts.length === 0) return [];
  const lines: string[] = [
    "Model numbers for what the week could have been, to grade against the settlement price:",
    "",
  ];
  for (const a of alts) {
    if (!a.available) {
      lines.push(`- **${a.name}:** not available (${a.reason ?? "no numbers"})`);
      continue;
    }
    const parts = [
      a.strike ? `strike $${a.strike}` : "no option sold",
      `${shortDecimal(a.size)} options`,
      `premium $${a.premiumIncomeUsd}`,
      a.breakEven ? `break-even $${a.breakEven}` : null,
      a.exerciseProbability !== null ? `model P(exercise) ${share(a.exerciseProbability)}` : null,
      a.stressLossUsd !== null ? `worst ±30% payout $${a.stressLossUsd}` : null,
    ].filter((x): x is string => x !== null);
    lines.push(
      `- **${a.name}${a.taken ? " (what the agent did)" : ""}:** ${parts.join(", ")}. Source: ${oneLine(a.source)}.`,
    );
  }
  const cs = d?.contradictions ?? [];
  if (cs.length) {
    lines.push("", "Inputs that should agree, compared:", "");
    for (const c of cs)
      lines.push(
        `- ${c.between.join(" against ")}: ${c.agree ? "agree" : "DISAGREE"}. ${oneLine(c.measured)} (limit: ${c.limit}).`,
      );
  }
  return lines;
}

/** "No trade" for a no-trade decision, else the status's title. */
const resultTitle = (r: RecordResult) => (r.noTrade ? "No trade" : STATUS_TITLE[r.status]);

function resultSection(r: RecordResult): string[] {
  const lines = [`**${resultTitle(r)}.** ${oneLine(r.summary)}`];
  const facts: string[] = [];
  if (r.noTrade)
    facts.push(
      `- **Stopped by:** the ${(STAGE_TITLES[r.noTrade.stage as PipelineStage["stage"]] ?? r.noTrade.stage).toLowerCase()} (${r.noTrade.reasons.map(oneLine).join("; ")})`,
    );
  if (r.seriesId) facts.push(`- **Series:** ${code(r.seriesId)}`);
  if (r.strike) facts.push(`- **Strike:** $${r.strike}`);
  if (r.expiryIso) facts.push(`- **Expiry:** ${r.expiryIso}`);
  if (r.size) facts.push(`- **Size:** ${r.size} options`);
  if (r.reason) facts.push(`- **Reason:** ${code(r.reason)}`);
  if (r.slashed !== undefined) facts.push(`- **Slashed:** ${r.slashed} USDG from the agent's bond`);
  if (r.settlementPrice !== undefined)
    facts.push(
      `- **Settlement price:** ${r.settlementPrice === null ? "none (nothing was sold)" : `$${r.settlementPrice}`}`,
    );
  if (r.payout !== undefined) facts.push(`- **Paid to option holders:** ${r.payout}`);
  if (r.premium !== undefined) facts.push(`- **Premium collected:** ${r.premium} USDG`);
  if (r.fee !== undefined) facts.push(`- **Performance fee:** ${r.fee} USDG`);
  if (r.settledBy) facts.push(`- **Settled by:** ${r.settledBy === "agent" ? "this agent" : "the keeper"}`);
  return facts.length ? [...lines, "", ...facts] : lines;
}

function trackSection(t: RecordTrack | null): string[] {
  if (!t) return ["Not read."];
  return [
    `- **Agent #${t.agentId}:** ${t.status}${t.active ? "" : ", cannot propose"}`,
    `- **Proposals:** ${t.accepted} accepted, ${t.rejected} rejected; ${t.strikes}/${t.maxStrikes} strikes`,
    `- **Bond:** ${t.bond} USDG`,
    `- **Settled epochs:** ${t.settledEpochs}, cumulative depositor PnL ${t.cumulativePnl} USDG`,
    `- **Claimable fees:** ${t.claimableFees} USDG`,
  ];
}

/** The decision record as markdown (prettier-clean: lists and blockquotes only, no tables). */
export function formatRecordMarkdown(r: DecisionRecord): string {
  const v = r.vault;
  const lines = [
    `# ${v.symbol} ${ACTION_TITLE[r.action]}${r.run ? " (dry run)" : ""}, ${r.date}`,
    "",
    ...(r.run ? [`**Dry run.** ${r.run.note}`, ""] : []),
    `- **Date:** ${r.date} (chain time ${r.chainTimeIso})`,
    `- **Chain:** ${r.chain.name} (${r.chain.id})`,
    `- **Agent:** ${r.agent.agentId ? `#${r.agent.agentId}` : "unknown"}${r.agent.signer ? `, signer ${code(r.agent.signer)}` : ""}`,
    `- **Result:** ${resultTitle(r.result).toLowerCase()}`,
    "",
    "## Vault and mandate",
    "",
    `- **Vault:** ${v.symbol} (${v.name}), a ${kindText(v.kind)} vault on ${v.underlying}, ${code(v.address)}`,
    `- **Collateral:** ${v.collateral} ${v.collateralAsset}; epoch ${v.epochState} when the run started`,
    `- **Mandate:** ${v.mandate.summary}`,
    "",
    "## Market inputs",
    "",
    ...marketSection(r.market),
    "",
    "## Target delta and why",
    "",
    ...decisionSection(r.decision, r.action),
    "",
    "## Dry run",
    "",
    ...dryRunSection(r.dryRun),
    "",
    ...(r.decision?.pipeline?.length ? ["## Specialists", "", ...pipelineSection(r.decision), ""] : []),
    ...(r.decision?.alternatives?.length
      ? ["## Alternatives to grade at settlement", "", ...alternativesSection(r.decision), ""]
      : []),
    ...(r.decision?.candidates?.length
      ? ["## Alternatives it dry-ran", "", ...candidatesSection(r.decision), ""]
      : []),
    "## Transactions",
    "",
    ...(r.transactions.length
      ? r.transactions.map((t) => `- ${t.label}: ${txLink(t)}`)
      : ["None sent by this run."]),
    "",
    "## Result",
    "",
    ...resultSection(r.result),
    "",
    "## Track record afterwards",
    "",
    ...trackSection(r.trackRecord),
    "",
    ...(r.anchor
      ? [
          "## On-chain anchor",
          "",
          `- **Record hash:** ${code(r.anchor.recordHash)} (keccak256 of the JSON copy without this anchor)`,
          `- **DecisionLog:** ${code(r.anchor.contract)}, epoch ${r.anchor.epoch}`,
          `- **Transaction:** ${txLink({ label: "", hash: r.anchor.txHash, url: txUrl(r.chain.id, r.anchor.txHash) })}`,
          "",
        ]
      : []),
    "---",
    "",
    `Written by the Strike example agent (${code("--log")}). Machine-readable copy: [${recordBaseName(r)}.json](${recordBaseName(r)}.json).`,
    "",
  ];
  return lines.join("\n");
}

/** The decision record as pretty JSON with a trailing newline. */
export function formatRecordJson(r: DecisionRecord): string {
  return `${JSON.stringify(r, null, 2)}\n`;
}

/** Anchors a record about to be written as `jsonFileName`; returns the record with its anchor added. */
export type RecordAnchorer = (record: DecisionRecord, jsonFileName: string) => Promise<DecisionRecord>;

/**
 * Write `<dir>/<YYYY-MM-DD>-<symbol>.md` and `.json`. A second run on the same day for the same vault gets a `-2`
 * (`-3`, ...) suffix instead of overwriting the first record. With `anchor`, the record is anchored on-chain under
 * its final file name first; if that fails the record is still written, unanchored, and the error is returned.
 * Returns the paths written.
 */
export async function writeRecord(
  dir: string,
  record: DecisionRecord,
  anchor?: RecordAnchorer,
): Promise<{ md: string; json: string; anchorError?: string }> {
  await mkdir(dir, { recursive: true });
  const base = recordBaseName(record);
  let name = base;
  for (let n = 2; existsSync(join(dir, `${name}.md`)) || existsSync(join(dir, `${name}.json`)); n++) {
    name = `${base}-${n}`;
  }
  let anchorError: string | undefined;
  if (anchor) {
    try {
      record = await anchor(record, `${name}.json`);
    } catch (err) {
      anchorError = err instanceof Error ? err.message : String(err);
    }
  }
  // The markdown links its JSON by file name; keep the link right when a suffix was added.
  const md = formatRecordMarkdown(record).replace(
    `[${base}.json](${base}.json)`,
    `[${name}.json](${name}.json)`,
  );
  const paths = { md: join(dir, `${name}.md`), json: join(dir, `${name}.json`) };
  await writeFile(paths.md, md);
  await writeFile(paths.json, formatRecordJson(record));
  return anchorError === undefined ? paths : { ...paths, anchorError };
}
