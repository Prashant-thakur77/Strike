import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getStrikeChain } from "@strike/sdk";
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

export interface RecordDecision {
  strategy: "default" | "claude" | "reckless";
  targetDeltaBps: number | null;
  premiumBps: number | null;
  /** The strategy's rule, or Claude's stated reasoning. */
  reasoning: string;
  /** Mandate guard corrections and fallbacks, in order. */
  notes: string[];
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
}

/** The chain's block explorer base URL, or null (local devnet, unknown chain). */
export function explorerUrl(chainId: number): string | null {
  try {
    return getStrikeChain(chainId).blockExplorers?.default.url ?? null;
  } catch {
    return null;
  }
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

/** File name (without extension) of a record: `<YYYY-MM-DD>-<vault symbol>`. */
export function recordBaseName(record: Pick<DecisionRecord, "date" | "vault">): string {
  const symbol = record.vault.symbol.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${record.date}-${symbol}`;
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

function resultSection(r: RecordResult): string[] {
  const lines = [`**${STATUS_TITLE[r.status]}.** ${oneLine(r.summary)}`];
  const facts: string[] = [];
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
    `# ${v.symbol} ${ACTION_TITLE[r.action]}, ${r.date}`,
    "",
    `- **Date:** ${r.date} (chain time ${r.chainTimeIso})`,
    `- **Chain:** ${r.chain.name} (${r.chain.id})`,
    `- **Agent:** ${r.agent.agentId ? `#${r.agent.agentId}` : "unknown"}${r.agent.signer ? `, signer ${code(r.agent.signer)}` : ""}`,
    `- **Result:** ${STATUS_TITLE[r.result.status].toLowerCase()}`,
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
