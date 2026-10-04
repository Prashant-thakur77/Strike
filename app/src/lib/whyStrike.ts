import { DRY_RUN_FOLDERS } from "./pipeline";
import {
  decisionRecordHash,
  deploymentsFor,
  epochLogHash,
  recordMatchRank,
  verifyDecisionAnchor,
  type AnchorTxStatus,
  type SeriesTarget,
} from "@strike/sdk";
import { getAddress, type Address, type Hex, type PublicClient } from "viem";
import {
  AGENT_LOG_BRANCH,
  AGENT_LOG_DIR,
  AGENT_LOG_REPO,
  parseRecordText,
  recordPageUrl,
  txLink,
  type LogRecord,
} from "./agentLog";
import type { VaultSummary } from "./reads";
import {
  RAW_BASE,
  WhyStrikeError,
  fetchRecordIndex,
  indexHas,
  listedRunNames,
  type Fetch,
  type RecordIndex,
} from "./recordIndex";

// "Why this strike" on the vault page: the agent's decision record for the vault's live (or last) epoch, fetched
// from GitHub without the API (raw.githubusercontent.com has no 60-an-hour limit), matched to the epoch by chain,
// vault and series or epoch, and checked against its own anchoring transaction: the DecisionRecorded event of a
// known DecisionLog for this agent, vault and epoch must carry the hash rebuilt from the file. `latestHash` is
// secondary (a settlement record anchored for the same epoch overwrites it).
//
// The record's file name is derived, then looked up: the agent names a record `<YYYY-MM-DD>-<vault symbol>[-N].json`
// after the UTC date its run started, and a propose run opens the epoch minutes later, so the epoch's `openedAt`
// gives the date (the day before and after are tried too, for runs that straddle midnight UTC). Only the names the
// published index lists (docs/agent-log/index.json, scripts/agent-log-index.mjs) are fetched, so a page never asks
// GitHub for a record that does not exist; without an index (a fork that has none) every candidate is tried.

export { RAW_BASE };
export const BLOB_BASE = `https://github.com/${AGENT_LOG_REPO}/blob/${AGENT_LOG_BRANCH}/`;

/** Where each chain's records live in the repository. */
export const RECORD_FOLDERS: Record<number, string> = {
  46630: AGENT_LOG_DIR,
  421614: `${AGENT_LOG_DIR}/arbitrum-sepolia`,
};

/** A second (third, ...) run on the same day gets a `-N` suffix; this many are looked for. */
export const MAX_RUNS_PER_DAY = 4;

/** How long a fetched record stays fresh (react-query staleTime), and how long a miss is remembered. */
export const WHY_STALE_MS = 10 * 60_000;

/**
 * Epochs run by hand before the agent wrote structured records, whose log was anchored after the fact: the hash
 * covers the log above its "Anchored on-chain" section (`epochLogHash`).
 */
export interface HandRunLog {
  chainId: number;
  vault: Address;
  epoch: number;
  path: string;
  contract: Address;
  txHash: Hex;
  /** When it ran, for people. */
  ran: string;
}

export const HAND_RUN_LOGS: HandRunLog[] = [
  {
    chainId: 46630,
    vault: "0xADFF7900dbe01E8170a750AB88e1f4eA8D9D1D4e",
    epoch: 1,
    path: "docs/testnet-epochs/2026-09-29.md",
    contract: "0xbF94f54fd0258ac59e2f54B70754dFAfFd245D93",
    txHash: "0x934ab96ba12a9ad501e20c8366fc338ab35d0550b88cc2d76fc5c39991c524c4",
    ran: "29 Sep 2026",
  },
];

/* ================================================================ which DecisionLog */

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The DecisionLog contracts a record on `chainId` may be anchored in: one per deployment of the chain (v2 and v3 on
 * Robinhood Chain testnet, v3 on Arbitrum Sepolia), the default deployment's first.
 */
export function knownDecisionLogs(chainId: number): Address[] {
  const out: Address[] = [];
  for (const d of deploymentsFor(chainId)) {
    if (d.decisionLog && !out.some((a) => same(a, d.decisionLog!))) out.push(getAddress(d.decisionLog));
  }
  return out;
}

/** "v2" or "v3" for a known DecisionLog, else null. */
export function decisionLogVersion(chainId: number, contract: string): string | null {
  return deploymentsFor(chainId).find((d) => d.decisionLog && same(d.decisionLog, contract))?.version ?? null;
}

/* ================================================================ file names */

/** "2026-10-01" for a unix time, in UTC. */
export function utcDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

/** The agent's file-name form of a vault symbol (record.ts `recordBaseName`). */
export function safeSymbol(symbol: string): string {
  return symbol.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * Base names (without `-N.json`) a record for an epoch opened at `openedAt` may have, likeliest first: the day the
 * epoch opened, the day before (a run started before midnight UTC), the day after (a proposal sent the day after
 * the epoch was opened by someone else).
 */
export function candidateBaseNames(symbol: string, openedAt: number): string[] {
  const day = 86_400;
  const sym = safeSymbol(symbol);
  return [openedAt, openedAt - day, openedAt + day].map((t) => `${utcDate(t)}-${sym}`);
}

/* ================================================================ fetching */

export { WhyStrikeError };

const CACHE_PREFIX = "strike.why.v1:";

function cacheGet(url: string): string | null | undefined {
  try {
    const raw = window.sessionStorage.getItem(CACHE_PREFIX + url);
    if (raw === null) return undefined;
    const entry = JSON.parse(raw) as { text: string | null; at: number };
    // A hit never changes (records are never overwritten); a miss may turn into a record later.
    if (entry.text === null && Date.now() - entry.at > WHY_STALE_MS) return undefined;
    return entry.text;
  } catch {
    return undefined;
  }
}

function cacheSet(url: string, text: string | null) {
  try {
    window.sessionStorage.setItem(CACHE_PREFIX + url, JSON.stringify({ text, at: Date.now() }));
  } catch {
    // private mode, quota: the fetch simply repeats next time
  }
}

/** A file from the repository on GitHub main, by path; null when it is not there (404); throws otherwise. */
export async function fetchRepoFile(
  path: string,
  fetchImpl: Fetch = fetch,
  signal?: AbortSignal,
): Promise<string | null> {
  const url = RAW_BASE + path;
  const cached = cacheGet(url);
  if (cached !== undefined) return cached;
  let res: Response;
  try {
    res = await fetchImpl(url, { signal });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new WhyStrikeError("network", "GitHub could not be reached from this browser.");
  }
  if (res.status === 404) {
    cacheSet(url, null);
    return null;
  }
  if (!res.ok) throw new WhyStrikeError("http", `GitHub answered ${res.status}.`);
  const text = await res.text();
  cacheSet(url, text);
  return text;
}

/** A record file by path when the index lists it (null, without a request, when it does not). */
function fetchListed(
  index: RecordIndex | null,
  folder: string,
  file: string,
  fetchImpl: Fetch,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!indexHas(index, folder, file)) return Promise.resolve(null);
  return fetchRepoFile(`${folder}/${file}`, fetchImpl, signal);
}

/* ================================================================ the result */

export type AnchorStatus = "match" | "mismatch" | "bad-tx" | "no-anchor" | "unknown-contract" | "unreadable";

export interface AnchorCheck {
  status: AnchorStatus;
  /** How a match was found: the record's own anchoring transaction, or `latestHash` (no transaction named). */
  via: "tx" | "latestHash" | null;
  /** keccak256 rebuilt from the fetched file. */
  computed: Hex;
  /** The hash the anchor carries: the transaction's event (via tx), else `latestHash`; null when not read. */
  onchain: Hex | null;
  /** `DecisionLog.latestHash(agentId, vault, epoch)`, when read. */
  latest: Hex | null;
  /** The record's own anchor checks out, but a later record for this epoch was anchored after it (`latest`). */
  superseded: boolean;
  /** Why the named transaction is not this record's anchor (status `bad-tx`). */
  txProblem: AnchorTxStatus | null;
  /** The hash the record itself claims (JSON records only). */
  claimed: Hex | null;
  /** The DecisionLog read (the one holding the anchor, else the record's own, else the chain's). */
  contract: Address | null;
  version: string | null;
  agentId: string;
  epoch: number;
  txHash: string | null;
  txUrl: string | null;
  /** Why the chain could not be read. */
  error: string | null;
}

/** A run from the hand-written epoch log, read out of its narration. */
export interface HandRunParsed {
  /** The agent's "[2] Choose ..." line: the rule and why. */
  reasoning: string | null;
  /** The "[3] ..." lines: the strike the rule solved to, fair value, size. */
  strikeLines: string[];
  /** The "[4] Dry run" verdict line. */
  verdict: string | null;
  targetDelta: string | null;
  premiumPct: string | null;
  seriesId: string | null;
  strike: string | null;
  accepted: boolean | null;
  /** The contract's reason when it rejected. */
  reason: string | null;
}

export type WhyStrike =
  | { kind: "none"; reason: "no-folder" | "no-epoch" | "not-found" }
  | {
      kind: "record";
      record: LogRecord;
      /** File name without extension. */
      name: string;
      folder: string;
      /** The human-readable .md on GitHub, and the .json the hash covers. */
      recordUrl: string;
      jsonUrl: string;
      anchor: AnchorCheck;
    }
  | { kind: "log"; log: HandRunParsed; source: HandRunLog; url: string; anchor: AnchorCheck };

/**
 * Check a rebuilt hash on the chain (`verifyDecisionAnchor` in the SDK): by the record's own anchoring transaction
 * when it names one (its DecisionRecorded event must come from a known DecisionLog, for this agent, vault and epoch,
 * with this hash), with `latestHash` read as secondary information; else by `latestHash` on the DecisionLog the
 * record names, or on every known DecisionLog of the chain.
 */
export async function checkAnchor(
  client: PublicClient,
  chainId: number,
  computed: Hex,
  opts: {
    vault: Address;
    agentId: bigint;
    epoch: number;
    claimed: Hex | null;
    contract: string | null;
    txHash: string | null;
  },
): Promise<AnchorCheck> {
  const known = knownDecisionLogs(chainId);
  const named = opts.contract ? known.find((k) => same(k, opts.contract!)) : undefined;
  const base = {
    computed,
    claimed: opts.claimed,
    agentId: opts.agentId.toString(),
    epoch: opts.epoch,
    txHash: opts.txHash,
    txUrl: opts.txHash ? txLink(chainId, opts.txHash, null) : null,
    error: null,
    via: null,
    onchain: null,
    latest: null,
    superseded: false,
    txProblem: null,
  };
  if (opts.contract && !named) {
    return { ...base, status: "unknown-contract", contract: getAddress(opts.contract), version: null };
  }
  const contracts = named ? [named] : known;
  if (contracts.length === 0) return { ...base, status: "no-anchor", contract: null, version: null };
  try {
    const r = await verifyDecisionAnchor(client, {
      decisionLogs: contracts,
      agentId: opts.agentId,
      vault: opts.vault,
      epoch: opts.epoch,
      recordHash: computed,
      txHash: opts.txHash,
    });
    const contract = r.decisionLog ?? contracts[0]!;
    return {
      ...base,
      status: r.status,
      via: r.via,
      onchain: r.tx?.event?.recordHash ?? r.latestHash,
      latest: r.latestHash,
      superseded: r.superseded,
      txProblem: r.status === "bad-tx" ? (r.tx?.status ?? null) : null,
      contract,
      version: decisionLogVersion(chainId, contract),
    };
  } catch (e) {
    const first = contracts[0]!;
    return {
      ...base,
      status: "unreadable",
      contract: first,
      version: decisionLogVersion(chainId, first),
      error: e instanceof Error ? e.message.split("\n")[0]! : String(e),
    };
  }
}

/* ================================================================ the hand-run log */

/**
 * Read one vault's run out of the hand-written epoch log: the block that reads the vault with `symbol`, and its
 * numbered steps. Null when the log has no run for that vault.
 */
export function parseHandRunLog(text: string, symbol: string): HandRunParsed | null {
  const blocks = text.split(/^== /m);
  const block = blocks.find((b) =>
    new RegExp(`\\[1\\] Read the vault\\n\\s*${escapeRe(symbol)} \\(`).test(b),
  );
  if (!block) return null;
  const step = (n: number) => {
    const m = block.match(new RegExp(`\\[${n}\\][^\\n]*\\n((?:[ \\t]+[^\\n]*\\n?)*)`));
    return m
      ? m[1]!
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
      : [];
  };
  const choose = step(2);
  const reasoning = choose.join(" ") || null;
  const strikeLines = step(3);
  const verdictLine = step(4).find((l) => l.startsWith("Verdict:")) ?? null;
  const accepted = /Accepted: series \d+ is on sale/.test(block)
    ? true
    : /REJECTED it: \w+/.test(block)
      ? false
      : null;
  return {
    reasoning,
    strikeLines,
    // "None. Inside the mandate: ..." → the words; the reason code stays when it is a rejection.
    verdict: verdictLine ? verdictLine.replace(/^Verdict:\s*(None\.\s*)?/, "") : null,
    targetDelta: reasoning?.match(/Target (0\.\d+) delta/)?.[1] ?? null,
    premiumPct: reasoning?.match(/Price at (\d+(?:\.\d+)?)% of/)?.[1] ?? null,
    seriesId: block.match(/Accepted: series (\d+) is on sale/)?.[1] ?? null,
    strike: block.match(/is on sale \(strike \$(\d+(?:\.\d+)?)/)?.[1] ?? null,
    accepted,
    reason: block.match(/REJECTED it: (\w+)/)?.[1] ?? null,
  };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* ================================================================ putting it together */

/** Newest first by chain time, then by name. */
function newest(a: { record: LogRecord; name: string }, b: { record: LogRecord; name: string }): number {
  const t = (r: LogRecord) => (r.chainTimeIso ? Date.parse(r.chainTimeIso) : NaN) || 0;
  return t(b.record) - t(a.record) || b.name.localeCompare(a.name);
}

/**
 * Without an index: the first run of each candidate day in parallel, then the `-N` retries of the days that had one,
 * until one is missing. `consider` returns false for a missing file.
 */
async function probeRuns(
  bases: string[],
  folder: string,
  consider: (name: string, text: string | null) => boolean,
  fetchImpl: Fetch,
  signal?: AbortSignal,
): Promise<void> {
  const firsts = await Promise.all(
    bases.map(async (base) =>
      consider(base, await fetchRepoFile(`${folder}/${base}.json`, fetchImpl, signal)),
    ),
  );
  await Promise.all(
    bases.map(async (base, i) => {
      if (!firsts[i]) return;
      for (let n = 2; n <= MAX_RUNS_PER_DAY; n++) {
        const name = `${base}-${n}`;
        if (!consider(name, await fetchRepoFile(`${folder}/${name}.json`, fetchImpl, signal))) break;
      }
    }),
  );
}

/**
 * The decision record for a vault's current epoch (live, or the last one once settled) and its anchor check.
 * Throws a `WhyStrikeError` only when GitHub cannot be reached; a chain that cannot be read makes the anchor
 * "unreadable" instead, so the record still shows.
 */
export async function loadWhyStrike(
  client: PublicClient,
  chainId: number,
  vault: VaultSummary,
  fetchImpl: Fetch = fetch,
  signal?: AbortSignal,
): Promise<WhyStrike> {
  const folder = RECORD_FOLDERS[chainId];
  if (!folder) return { kind: "none", reason: "no-folder" };
  if (vault.currentEpoch === 0n) return { kind: "none", reason: "no-epoch" };

  const target: SeriesTarget = {
    chainId,
    vault: vault.address,
    epoch: vault.currentEpoch,
    seriesId: vault.series?.id ?? null,
  };
  const bases = candidateBaseNames(vault.symbol, Number(vault.openedAt));
  const index = await fetchRecordIndex(fetchImpl, signal);
  const found: { record: LogRecord; name: string; text: string; rank: 1 | 2 }[] = [];
  const consider = (name: string, text: string | null) => {
    if (text === null) return false;
    const record = parseRecordText(text);
    if (!record) return true;
    const rank = recordMatchRank(
      {
        chainId: record.chain.id,
        vault: record.vault.address,
        seriesId: record.result.seriesId,
        epoch: record.anchor?.epoch ?? null,
      },
      target,
    );
    if (rank !== 0) found.push({ record, name, text, rank });
    return true;
  };
  if (index) {
    // Every run the index lists for the candidate days, in parallel.
    const names = bases.flatMap((base) => listedRunNames(index, folder, base));
    const texts = await Promise.all(
      names.map((name) => fetchRepoFile(`${folder}/${name}.json`, fetchImpl, signal)),
    );
    names.forEach((name, i) => consider(name, texts[i]!));
  } else {
    await probeRuns(bases, folder, consider, fetchImpl, signal);
  }

  if (found.length > 0) {
    // The record that put the live series on sale; else the newest run of the epoch that made a decision.
    found.sort(
      (a, b) => b.rank - a.rank || (a.record.decision ? 0 : 1) - (b.record.decision ? 0 : 1) || newest(a, b),
    );
    const best = found[0]!;
    const r = best.record;
    const anchor = await checkAnchor(client, chainId, decisionRecordHash(best.text), {
      vault: vault.address,
      agentId: r.agentId && /^\d+$/.test(r.agentId) ? BigInt(r.agentId) : vault.agentId,
      epoch: r.anchor?.epoch ?? Number(vault.currentEpoch),
      claimed: (r.anchor?.recordHash as Hex | undefined) ?? null,
      contract: r.anchor?.contract ?? null,
      txHash: r.anchor?.txHash ?? r.transactions.find((t) => t.label === "DecisionLog.record")?.hash ?? null,
    });
    const md = await fetchListed(index, folder, `${best.name}.md`, fetchImpl, signal).catch(() => null);
    const page = (file: string) =>
      folder === AGENT_LOG_DIR ? recordPageUrl(file) : `${BLOB_BASE}${folder}/${encodeURIComponent(file)}`;
    return {
      kind: "record",
      record: r,
      name: best.name,
      folder,
      recordUrl: page(md ? `${best.name}.md` : `${best.name}.json`),
      jsonUrl: page(`${best.name}.json`),
      anchor,
    };
  }

  const hand = HAND_RUN_LOGS.find(
    (h) => h.chainId === chainId && same(h.vault, vault.address) && BigInt(h.epoch) === vault.currentEpoch,
  );
  if (hand) {
    const text = await fetchRepoFile(hand.path, fetchImpl, signal);
    const log = text === null ? null : parseHandRunLog(text, vault.symbol);
    if (text !== null && log) {
      const anchor = await checkAnchor(client, chainId, epochLogHash(text), {
        vault: vault.address,
        agentId: vault.agentId,
        epoch: hand.epoch,
        claimed: null,
        contract: hand.contract,
        txHash: hand.txHash,
      });
      return { kind: "log", log, source: hand, url: BLOB_BASE + hand.path, anchor };
    }
  }
  return { kind: "none", reason: "not-found" };
}

/* ================================================================ one record, by name (the decision page) */

/** A dry run's anchor slot: not anchored by design, so nothing on-chain was read. */
function unanchored(text: string, epoch: number, agentId: string): AnchorCheck {
  return {
    status: "unreadable",
    via: null,
    computed: decisionRecordHash(text),
    onchain: null,
    latest: null,
    superseded: false,
    txProblem: null,
    claimed: null,
    contract: null,
    version: null,
    agentId,
    epoch,
    txHash: null,
    txUrl: null,
    error: "a dry run is not anchored",
  };
}

export type NamedRecord =
  | { kind: "not-found" }
  | { kind: "invalid"; why: string }
  | {
      kind: "record";
      record: LogRecord;
      name: string;
      folder: string;
      recordUrl: string;
      jsonUrl: string;
      anchor: AnchorCheck;
      /** The record's JSON as published (the specialist pipeline is read from it: lib/pipeline.ts). */
      raw: unknown;
      /** A specialist-pipeline dry run (docs/agent-log/dry-runs): never anchored, so no anchor was checked. */
      dryRun: boolean;
    };

/**
 * A decision record by its file name in the chain's folder (`<YYYY-MM-DD>-<vault symbol>[-N]`), fetched from GitHub
 * and checked against its own anchoring transaction like `loadWhyStrike` does. Throws a `WhyStrikeError` only when
 * GitHub cannot be reached.
 */
export async function loadRecordByName(
  client: PublicClient,
  chainId: number,
  name: string,
  fetchImpl: Fetch = fetch,
  signal?: AbortSignal,
  dryRun = false,
): Promise<NamedRecord> {
  const folder = dryRun ? DRY_RUN_FOLDERS[chainId] : RECORD_FOLDERS[chainId];
  if (!folder) return { kind: "not-found" };
  const index = await fetchRecordIndex(fetchImpl, signal);
  const text = await fetchListed(index, folder, `${name}.json`, fetchImpl, signal);
  if (text === null) return { kind: "not-found" };
  const record = parseRecordText(text);
  if (!record) return { kind: "invalid", why: "The file is not a decision record this page can read." };
  if (record.chain.id !== chainId) {
    return { kind: "invalid", why: `The record is from chain ${record.chain.id}, not ${chainId}.` };
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(record.vault.address)) {
    return { kind: "invalid", why: "The record names no vault address." };
  }
  const agentId = record.agentId && /^\d+$/.test(record.agentId) ? BigInt(record.agentId) : 0n;
  const anchor = dryRun
    ? unanchored(text, record.anchor?.epoch ?? 0, record.agentId ?? "")
    : await checkAnchor(client, chainId, decisionRecordHash(text), {
        vault: getAddress(record.vault.address),
        agentId,
        epoch: record.anchor?.epoch ?? 0,
        claimed: (record.anchor?.recordHash as Hex | undefined) ?? null,
        contract: record.anchor?.contract ?? null,
        txHash:
          record.anchor?.txHash ??
          record.transactions.find((t) => t.label === "DecisionLog.record")?.hash ??
          null,
      });
  const md = await fetchListed(index, folder, `${name}.md`, fetchImpl, signal).catch(() => null);
  const page = (file: string) =>
    folder === AGENT_LOG_DIR ? recordPageUrl(file) : `${BLOB_BASE}${folder}/${encodeURIComponent(file)}`;
  return {
    kind: "record",
    record,
    name,
    folder,
    recordUrl: page(md ? `${name}.md` : `${name}.json`),
    jsonUrl: page(`${name}.json`),
    anchor,
    raw: JSON.parse(text) as unknown,
    dryRun,
  };
}
