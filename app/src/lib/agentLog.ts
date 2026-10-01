// The weekly agent's decision records (docs/agent-log/*.json), read at runtime from the public GitHub API. The
// GitHub Actions job .github/workflows/agent.yml commits one per vault every Monday (propose) and Friday (settle);
// the schema is `DecisionRecord` in agents/example/src/record.ts (version 1).
//
// Everything here is pure except `fetchAgentLog`, and nothing is imported, so the e2e specs (which load as
// CommonJS) can unit-test the parser against fixture records.

export const AGENT_LOG_REPO = "Prashant-thakur77/Strike";
export const AGENT_LOG_BRANCH = "main";
export const AGENT_LOG_DIR = "docs/agent-log";

/** GitHub contents API listing of the folder (unauthenticated: 60 requests an hour per IP). */
export const AGENT_LOG_API = `https://api.github.com/repos/${AGENT_LOG_REPO}/contents/${AGENT_LOG_DIR}?ref=${AGENT_LOG_BRANCH}`;
/** The folder on GitHub, for people (and the fallback when the API is unavailable). */
export const AGENT_LOG_FOLDER_URL = `https://github.com/${AGENT_LOG_REPO}/tree/${AGENT_LOG_BRANCH}/${AGENT_LOG_DIR}`;
/** The workflow that writes the records. */
export const AGENT_WORKFLOW_URL = `https://github.com/${AGENT_LOG_REPO}/blob/${AGENT_LOG_BRANCH}/.github/workflows/agent.yml`;
/** The first live epoch, run by hand before the weekly job took over. */
export const FIRST_EPOCH_LOG_URL = `https://github.com/${AGENT_LOG_REPO}/blob/${AGENT_LOG_BRANCH}/docs/testnet-epochs/2026-09-29.md`;

/** Newest records kept. */
export const AGENT_LOG_LIMIT = 12;
/** How long a fetched log stays fresh (react-query staleTime). */
export const AGENT_LOG_STALE_MS = 10 * 60_000;
/** The only record schema this page understands (RECORD_VERSION in agents/example/src/record.ts). */
export const AGENT_LOG_VERSION = 1;

/** The weekly workflow's first scheduled run: the Friday settle run, 2 Oct 2026, 21:15 UTC. */
export const FIRST_RUN = Date.UTC(2026, 9, 2, 21, 15, 0);

/** agent.yml's two crons, as offsets from Monday 00:00 UTC: Monday 15:00 (propose) and Friday 21:15 (settle). */
const RUN_OFFSETS = [15 * 3_600_000, (4 * 24 + 21) * 3_600_000 + 15 * 60_000];

/** Block explorers for chains records can come from, when a record carries no link of its own. */
const EXPLORERS: Record<number, string> = {
  46630: "https://explorer.testnet.chain.robinhood.com",
  421614: "https://sepolia.arbiscan.io",
};

/* ================================================================ record types */

export type LogAction = "propose" | "reckless" | "settle";
export type LogStrategy = "default" | "claude" | "reckless";
export type LogStatus = "accepted" | "rejected" | "not-sent" | "settled" | "skipped" | "failed";
export type VaultKind = "covered-call" | "cash-secured-put";

export interface LogTx {
  label: string;
  hash: string;
  /** Block explorer link: the record's own, or one derived from the chain id; null when there is none. */
  url: string | null;
}

export interface LogMarket {
  spot: string | null;
  sigma: number | null;
  source: "epoch-open snapshot" | "live";
  openedAtIso: string | null;
  oracleStatus: string;
  marketOpen: boolean;
}

/** How a `claude` run reached Claude (absent in older records). */
export interface LogPlanner {
  kind: "api" | "claude-code";
  model: string;
  /** "Claude via API, model X" or "Claude via Claude Code CLI, model X". */
  label: string;
}

/** A candidate the planner dry-ran before choosing (records written so far carry only the final dry run). */
export interface LogCandidate {
  targetDeltaBps: number | null;
  premiumBps: number | null;
  ok: boolean;
  reason: string | null;
  strike: string | null;
  fairValue: string | null;
  yieldBps: number | null;
}

export interface LogDecision {
  strategy: LogStrategy;
  targetDeltaBps: number | null;
  premiumBps: number | null;
  reasoning: string;
  notes: string[];
  planner: LogPlanner | null;
  candidates: LogCandidate[];
}

export interface LogDryRun {
  ok: boolean;
  reason: string;
  explanation: string;
  optionType: "call" | "put" | null;
  strike: string | null;
  delta: number | null;
  size: string | null;
  capacity: string | null;
  premiumBps: number | null;
  fairValue: string | null;
  yieldBps: number | null;
}

/** The record's on-chain anchor (`--anchor`): its hash committed to the DecisionLog contract. */
export interface LogAnchor {
  contract: string;
  recordHash: string;
  uri: string | null;
  epoch: number;
  txHash: string | null;
}

export interface LogResult {
  status: LogStatus;
  summary: string;
  seriesId: string | null;
  strike: string | null;
  expiryIso: string | null;
  size: string | null;
  reason: string | null;
  slashed: string | null;
  settlementPrice: string | null;
  payout: string | null;
  premium: string | null;
  fee: string | null;
  settledBy: "agent" | "keeper" | null;
}

export interface LogTrack {
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

/** A validated decision record: the fields the page shows, with anything optional normalised to null. */
export interface LogRecord {
  version: 1;
  action: LogAction;
  date: string;
  chainTimeIso: string | null;
  chain: { id: number; name: string };
  agentId: string | null;
  vault: {
    address: string;
    symbol: string;
    name: string;
    kind: VaultKind;
    underlying: string;
    mandateSummary: string | null;
  };
  market: LogMarket | null;
  decision: LogDecision | null;
  dryRun: LogDryRun | null;
  transactions: LogTx[];
  result: LogResult;
  trackRecord: LogTrack | null;
  anchor: LogAnchor | null;
}

/** A record together with where it lives on GitHub. */
export interface LogEntry {
  /** File name without extension, e.g. "2026-10-05-sTSLA-CSP-2". */
  name: string;
  record: LogRecord;
  /** The human-readable .md on GitHub (the .json when no .md sits next to it). */
  recordUrl: string;
}

/** One `.json` record file from the folder listing. */
export interface LogFile {
  name: string;
  base: string;
  date: string;
  /** The `-N` suffix of a second (third, ...) run on the same day; 1 for the first. */
  run: number;
  downloadUrl: string;
  recordUrl: string;
}

export interface AgentLog {
  entries: LogEntry[];
  /** Record files found but not shown: unknown version, malformed, or unreadable. */
  skipped: number;
}

/* ================================================================ validation */

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const nonEmpty = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
function oneOf<T extends string>(v: unknown, values: readonly T[]): T | null {
  return typeof v === "string" && (values as readonly string[]).includes(v) ? (v as T) : null;
}
/** A decimal string as the agent writes amounts ("369", "-20.021371", "114.2008..."). */
const decimal = (v: unknown): string | null =>
  typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim()) ? v.trim() : null;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Only http(s) links from a record ever reach an href. */
export function safeHttpUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

/** A transaction's explorer link: the record's own if it is a web link, else the chain's Blockscout, else null. */
export function txLink(chainId: number, hash: string, url: unknown): string | null {
  const own = safeHttpUrl(url);
  if (own) return own;
  const base = EXPLORERS[chainId];
  return base && HASH_RE.test(hash) ? `${base}/tx/${hash}` : null;
}

function parseMarket(v: unknown): LogMarket | null {
  if (!isObj(v)) return null;
  const source = oneOf(v.source, ["epoch-open snapshot", "live"] as const);
  if (!source) return null;
  return {
    spot: decimal(v.spot),
    sigma: num(v.sigma),
    source,
    openedAtIso: str(v.openedAtIso),
    oracleStatus: str(v.oracleStatus) ?? "unknown",
    marketOpen: bool(v.marketOpen) ?? false,
  };
}

function parsePlanner(v: unknown): LogPlanner | null {
  if (!isObj(v)) return null;
  const kind = oneOf(v.kind, ["api", "claude-code"] as const);
  const model = nonEmpty(v.model);
  if (!kind || !model) return null;
  return {
    kind,
    model,
    label: nonEmpty(v.label) ?? `Claude via ${kind === "api" ? "API" : "Claude Code CLI"}, model ${model}`,
  };
}

function parseCandidate(v: unknown): LogCandidate | null {
  if (!isObj(v)) return null;
  const ok = bool(v.ok);
  if (ok === null) return null;
  return {
    targetDeltaBps: num(v.targetDeltaBps),
    premiumBps: num(v.premiumBps),
    ok,
    reason: nonEmpty(v.reason),
    strike: decimal(v.strike),
    fairValue: decimal(v.fairValue),
    yieldBps: num(v.yieldBps),
  };
}

function parseDecision(v: unknown): LogDecision | null {
  if (!isObj(v)) return null;
  // Older drafts of the agent called Claude's strategy "llm".
  const raw = v.strategy === "llm" ? "claude" : v.strategy;
  const strategy = oneOf(raw, ["default", "claude", "reckless"] as const);
  if (!strategy) return null;
  return {
    strategy,
    targetDeltaBps: num(v.targetDeltaBps),
    premiumBps: num(v.premiumBps),
    reasoning: str(v.reasoning)?.trim() ?? "",
    notes: Array.isArray(v.notes)
      ? v.notes.filter((n): n is string => typeof n === "string" && !!n.trim())
      : [],
    planner: parsePlanner(v.planner),
    candidates: Array.isArray(v.candidates)
      ? v.candidates.flatMap((c) => {
          const parsed = parseCandidate(c);
          return parsed ? [parsed] : [];
        })
      : [],
  };
}

function parseDryRun(v: unknown): LogDryRun | null {
  if (!isObj(v)) return null;
  const ok = bool(v.ok);
  if (ok === null) return null;
  return {
    ok,
    reason: str(v.reason) ?? "",
    explanation: str(v.explanation)?.trim() ?? "",
    optionType: oneOf(v.optionType, ["call", "put"] as const),
    strike: decimal(v.strike),
    delta: num(v.delta),
    size: decimal(v.size),
    capacity: decimal(v.capacity),
    premiumBps: num(v.premiumBps),
    fairValue: decimal(v.fairValue),
    yieldBps: num(v.yieldBps),
  };
}

function parseAnchor(v: unknown): LogAnchor | null {
  if (!isObj(v)) return null;
  const contract = str(v.contract);
  const recordHash = str(v.recordHash);
  const epoch = num(v.epoch);
  if (!contract || !ADDRESS_RE.test(contract) || !recordHash || !HASH_RE.test(recordHash) || epoch === null) {
    return null;
  }
  const txHash = str(v.txHash);
  return {
    contract,
    recordHash: recordHash.toLowerCase(),
    uri: safeHttpUrl(v.uri),
    epoch,
    txHash: txHash && HASH_RE.test(txHash) ? txHash : null,
  };
}

function parseResult(v: unknown): LogResult | null {
  if (!isObj(v)) return null;
  const status = oneOf(v.status, [
    "accepted",
    "rejected",
    "not-sent",
    "settled",
    "skipped",
    "failed",
  ] as const);
  if (!status) return null;
  return {
    status,
    summary: str(v.summary)?.trim() ?? "",
    seriesId: nonEmpty(v.seriesId),
    strike: decimal(v.strike),
    expiryIso: nonEmpty(v.expiryIso),
    size: decimal(v.size),
    reason: nonEmpty(v.reason),
    slashed: decimal(v.slashed),
    settlementPrice: decimal(v.settlementPrice),
    payout: nonEmpty(v.payout),
    premium: decimal(v.premium),
    fee: decimal(v.fee),
    settledBy: oneOf(v.settledBy, ["agent", "keeper"] as const),
  };
}

function parseTrack(v: unknown): LogTrack | null {
  if (!isObj(v)) return null;
  const accepted = num(v.accepted);
  const rejected = num(v.rejected);
  if (accepted === null || rejected === null) return null;
  return {
    agentId: str(v.agentId) ?? "?",
    status: str(v.status) ?? "Unknown",
    active: bool(v.active) ?? false,
    accepted,
    rejected,
    strikes: num(v.strikes) ?? 0,
    maxStrikes: num(v.maxStrikes) ?? 0,
    bond: decimal(v.bond) ?? "0",
    settledEpochs: num(v.settledEpochs) ?? 0,
    cumulativePnl: decimal(v.cumulativePnl) ?? "0",
    claimableFees: decimal(v.claimableFees) ?? "0",
  };
}

/**
 * Validate one parsed JSON record. Returns null for another schema version or anything missing the fields every
 * card needs (action, date, vault, result); optional sections that are malformed are dropped, not fatal.
 */
export function parseRecord(json: unknown): LogRecord | null {
  if (!isObj(json) || json.version !== AGENT_LOG_VERSION) return null;
  const action = oneOf(json.action, ["propose", "reckless", "settle"] as const);
  const date = str(json.date);
  const vault = isObj(json.vault) ? json.vault : null;
  const result = parseResult(json.result);
  if (!action || !date || !DATE_RE.test(date) || !vault || !result) return null;
  const symbol = nonEmpty(vault.symbol);
  const kind = oneOf(vault.kind, ["covered-call", "cash-secured-put"] as const);
  if (!symbol || !kind) return null;
  const chain = isObj(json.chain) ? json.chain : {};
  const chainId = num(chain.id) ?? 0;
  const agent = isObj(json.agent) ? json.agent : {};
  const mandate = isObj(vault.mandate) ? vault.mandate : {};
  const txs = Array.isArray(json.transactions) ? json.transactions : [];
  return {
    version: 1,
    action,
    date,
    chainTimeIso: str(json.chainTimeIso),
    chain: { id: chainId, name: str(chain.name) ?? `chain ${chainId}` },
    agentId: str(agent.agentId),
    vault: {
      address: str(vault.address) ?? "",
      symbol,
      name: str(vault.name) ?? symbol,
      kind,
      underlying: str(vault.underlying) ?? "",
      mandateSummary: nonEmpty(mandate.summary),
    },
    market: parseMarket(json.market),
    decision: parseDecision(json.decision),
    dryRun: parseDryRun(json.dryRun),
    transactions: txs.flatMap((t): LogTx[] => {
      if (!isObj(t)) return [];
      const hash = nonEmpty(t.hash);
      if (!hash) return [];
      return [{ label: nonEmpty(t.label) ?? "Transaction", hash, url: txLink(chainId, hash, t.url) }];
    }),
    result,
    trackRecord: parseTrack(json.trackRecord),
    anchor: parseAnchor(json.anchor),
  };
}

/** Parse a record from text; null (never a throw) for anything that is not a valid record. */
export function parseRecordText(text: string): LogRecord | null {
  try {
    return parseRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

/* ================================================================ folder listing */

const RECORD_FILE_RE = /^(\d{4}-\d{2}-\d{2})-(.+?)(?:-(\d+))?\.json$/;

/** A file's page on GitHub. */
export const recordPageUrl = (fileName: string) =>
  `https://github.com/${AGENT_LOG_REPO}/blob/${AGENT_LOG_BRANCH}/${AGENT_LOG_DIR}/${encodeURIComponent(fileName)}`;

/** Only files served from raw.githubusercontent.com are fetched. */
function rawUrl(v: unknown): string | null {
  const url = safeHttpUrl(v);
  return url && new URL(url).protocol === "https:" && new URL(url).hostname === "raw.githubusercontent.com"
    ? url
    : null;
}

/** Newest first: by date, then the later run of the same day, then by name. */
export function compareFiles(a: LogFile, b: LogFile): number {
  return b.date.localeCompare(a.date) || b.run - a.run || a.name.localeCompare(b.name);
}

/**
 * The record files in a GitHub contents API listing, newest first, at most `limit`. Anything that is not a
 * `<YYYY-MM-DD>-<symbol>[-N].json` file with a raw download link is ignored (README.md, the .md twins, folders).
 */
export function parseListing(json: unknown, limit = AGENT_LOG_LIMIT): LogFile[] {
  if (!Array.isArray(json)) return [];
  const names = new Set(json.flatMap((e) => (isObj(e) && typeof e.name === "string" ? [e.name] : [])));
  const files = json.flatMap((e): LogFile[] => {
    if (!isObj(e) || e.type !== "file" || typeof e.name !== "string") return [];
    const m = e.name.match(RECORD_FILE_RE);
    const downloadUrl = rawUrl(e.download_url);
    if (!m || !downloadUrl) return [];
    const base = e.name.slice(0, -".json".length);
    return [
      {
        name: e.name,
        base,
        date: m[1],
        run: m[3] ? Number(m[3]) : 1,
        downloadUrl,
        recordUrl: recordPageUrl(names.has(`${base}.md`) ? `${base}.md` : e.name),
      },
    ];
  });
  return files.sort(compareFiles).slice(0, Math.max(0, limit));
}

/** Newest first by chain time (the run order), falling back to the file order. */
export function sortEntries(entries: LogEntry[]): LogEntry[] {
  const t = (e: LogEntry) => {
    const ms = e.record.chainTimeIso ? Date.parse(e.record.chainTimeIso) : NaN;
    return Number.isFinite(ms) ? ms : Date.parse(`${e.record.date}T00:00:00Z`) || 0;
  };
  return [...entries].sort((a, b) => t(b) - t(a) || b.name.localeCompare(a.name));
}

/* ================================================================ fetching */

export type AgentLogErrorKind = "rate-limit" | "http" | "network";

export class AgentLogError extends Error {
  constructor(
    readonly kind: AgentLogErrorKind,
    message: string,
    /** When GitHub's rate limit resets (unix ms), if it said. */
    readonly resetAt: number | null = null,
  ) {
    super(message);
    this.name = "AgentLogError";
  }
}

/** The error a listing response maps to (null when it is usable: 2xx, or 404 for a folder that is not there yet). */
export function listingError(
  status: number,
  headers?: { get(name: string): string | null },
): AgentLogError | null {
  if ((status >= 200 && status < 300) || status === 404) return null;
  if (status === 403 || status === 429) {
    const reset = Number(headers?.get("x-ratelimit-reset"));
    return new AgentLogError(
      "rate-limit",
      "GitHub's limit for unauthenticated API requests was reached.",
      Number.isFinite(reset) && reset > 0 ? reset * 1000 : null,
    );
  }
  return new AgentLogError("http", `GitHub answered ${status}.`);
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * List docs/agent-log on GitHub and fetch the newest record files. Unreadable or invalid records are skipped and
 * counted; the listing failing (rate limit, network, other HTTP errors) throws an `AgentLogError`.
 */
export async function fetchAgentLog(fetchImpl: Fetch = fetch, signal?: AbortSignal): Promise<AgentLog> {
  let res: Response;
  try {
    res = await fetchImpl(AGENT_LOG_API, { headers: { accept: "application/vnd.github+json" }, signal });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new AgentLogError("network", "GitHub could not be reached.");
  }
  const err = listingError(res.status, res.headers);
  if (err) throw err;
  if (res.status === 404) return { entries: [], skipped: 0 };
  let listing: unknown;
  try {
    listing = await res.json();
  } catch {
    throw new AgentLogError("http", "GitHub sent a listing that is not JSON.");
  }
  const files = parseListing(listing);
  let unreadable = 0;
  const results = await Promise.all(
    files.map(async (f): Promise<LogEntry | null> => {
      try {
        const r = await fetchImpl(f.downloadUrl, { signal });
        if (!r.ok) {
          unreadable++;
          return null;
        }
        const record = parseRecordText(await r.text());
        return record ? { name: f.base, record, recordUrl: f.recordUrl } : null;
      } catch (e) {
        if (signal?.aborted) throw e;
        unreadable++;
        return null;
      }
    }),
  );
  const entries = results.filter((e): e is LogEntry => e !== null);
  // Every file failed to download: that is a network problem, not an empty log.
  if (files.length > 0 && unreadable === files.length) {
    throw new AgentLogError("network", "The record files could not be downloaded from GitHub.");
  }
  return { entries: sortEntries(entries), skipped: files.length - entries.length };
}

/* ================================================================ display helpers */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "2026-10-05" → "Mon 5 Oct 2026". */
export function fmtLogDate(date: string): string {
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return date;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) return date;
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

const nyExpiry = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** An ISO time in New York, where options expire: "Fri, Oct 9, 16:00 ET". */
export function fmtNyIso(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? `${nyExpiry.format(new Date(ms))} ET` : "—";
}

/** "propose" → "Propose", with the demo run named as such. */
export function actionLabel(a: LogAction): string {
  return { propose: "Propose", settle: "Settle", reckless: "Reckless demo" }[a];
}

/** The strategy for people: the rule-based default, or Claude when the run used `--llm`. */
export function strategyLabel(s: LogStrategy): string {
  return { default: "Rule-based", claude: "Claude", reckless: "Forced demo" }[s];
}

/**
 * Who planned the run, for people: Claude with how it was reached and the model ("Claude via Claude Code CLI,
 * model claude-opus-5"), the rule-based default with its rule, or the forced demo.
 */
export function plannerLabel(d: LogDecision): string {
  switch (d.strategy) {
    case "claude":
      return d.planner?.label ?? "Claude";
    case "default":
      return `Rule-based: ${d.targetDeltaBps === null ? "the default" : fmtDeltaBps(d.targetDeltaBps)} delta at ${fmtFactor(d.premiumBps ?? 10_000)} of fair value, clamped into the mandate`;
    case "reckless":
      return "Forced demo: an at-the-money strike, sent to show the contract rejecting it";
  }
}

export function kindLabel(k: VaultKind): string {
  return k === "covered-call" ? "Covered call" : "Cash-secured put";
}

export function kindTone(k: VaultKind): "call" | "put" {
  return k === "covered-call" ? "call" : "put";
}

/** Group thousands and trim to `maxFrac` decimals, keeping the sign: "-20.021371" → "−20.02". */
export function fmtDecimal(v: string | null, maxFrac = 2): string {
  if (v === null) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  const frac = n !== 0 && Math.abs(n) < 1 ? Math.max(maxFrac, 4) : maxFrac;
  const abs = Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: frac });
  return `${n < 0 && abs !== "0" ? "−" : ""}${abs}`;
}

/** A USD price: "369" → "$369.00". */
export function fmtPrice(v: string | null): string {
  if (v === null) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Annualised volatility as a fraction: 0.6 → "60.0%". */
export function fmtSigma(sigma: number | null): string {
  return sigma === null ? "—" : `${(sigma * 100).toFixed(1)}%`;
}

/** Delta in basis points: 2000 → "0.20". */
export function fmtDeltaBps(bps: number | null): string {
  return bps === null ? "—" : (bps / 10_000).toFixed(2);
}

/** Premium factor in basis points: 10000 → "100%", 9750 → "97.5%". */
export function fmtFactor(bps: number | null): string {
  return bps === null ? "—" : `${Number((bps / 100).toFixed(2))}%`;
}

/** Where the market inputs came from. */
export function sourceLabel(m: LogMarket): string {
  return m.source === "epoch-open snapshot" ? "Epoch-open snapshot" : "Live";
}

export type VerdictTone = "good" | "bad" | "neutral";

export interface Verdict {
  tone: VerdictTone;
  label: string;
  /** The contract's reason for a rejection (a MandateGuard error name). */
  reason: string | null;
  /** USDG slashed from the agent's bond. */
  slashed: string | null;
}

/** The contract's verdict on the run. */
export function verdictOf(r: LogResult): Verdict {
  const base = { reason: null, slashed: null };
  switch (r.status) {
    case "accepted":
      return { ...base, tone: "good", label: "Accepted" };
    case "settled":
      return { ...base, tone: "good", label: "Settled" };
    case "rejected":
      return { tone: "bad", label: "Rejected", reason: r.reason, slashed: r.slashed };
    case "failed":
      return { ...base, tone: "bad", label: "Stopped" };
    case "not-sent":
      return { ...base, tone: "neutral", label: "Not sent" };
    case "skipped":
      return { ...base, tone: "neutral", label: "Nothing to do" };
  }
}

/** Short form of a transaction hash for link text. */
export function shortHash(h: string): string {
  return h.length > 14 ? `${h.slice(0, 8)}…${h.slice(-4)}` : h;
}

/** When the next scheduled run is due: the first one, or the next Monday 15:00 or Friday 21:15 UTC after `now`. */
export function nextRun(now: number): { first: boolean; at: number } {
  if (now < FIRST_RUN) return { first: true, at: FIRST_RUN };
  const day = 86_400_000;
  const d = new Date(now);
  const monday =
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - ((d.getUTCDay() + 6) % 7) * day;
  for (const week of [0, 7 * day]) {
    for (const offset of RUN_OFFSETS) {
      if (monday + week + offset > now) return { first: false, at: monday + week + offset };
    }
  }
  return { first: false, at: monday + 7 * day + RUN_OFFSETS[0] };
}

/** "Monday 5 Oct, 15:00 UTC". */
export function fmtRunTime(ms: number): string {
  const d = new Date(ms);
  const day = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getUTCDay()];
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${day} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${hh}:${mm} UTC`;
}

/** "16:02 UTC" for a rate-limit reset. */
export function fmtUtcClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}
