import { AGENT_LOG_BRANCH, AGENT_LOG_DIR, AGENT_LOG_REPO } from "./agentLog";

// The index of published decision records (docs/agent-log/index.json, written by scripts/agent-log-index.mjs and
// rewritten by the weekly agent workflow when it commits records). The vault and decision pages read it before
// fetching a record and fetch only the files it lists, so the browser never asks GitHub for a record that does not
// exist (each miss was a 404 in its console). No runtime import from @strike/sdk here, so the logic tests can load it.

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Files from the repository on GitHub main, without the API (raw.githubusercontent.com has no 60-an-hour limit). */
export const RAW_BASE = `https://raw.githubusercontent.com/${AGENT_LOG_REPO}/${AGENT_LOG_BRANCH}/`;

/** The index, by repository path. */
export const RECORD_INDEX_PATH = `${AGENT_LOG_DIR}/index.json`;

/** How long a fetched index is kept: it changes when the agent commits records (twice a week). */
export const RECORD_INDEX_STALE_MS = 10 * 60_000;

export class WhyStrikeError extends Error {
  constructor(
    readonly kind: "network" | "http" | "rpc",
    message: string,
  ) {
    super(message);
    this.name = "WhyStrikeError";
  }
}

/** Folder (repository path) to the record file names in it. */
export type RecordIndex = Map<string, ReadonlySet<string>>;

/** The index's JSON, or null when it is not an index this page can read. */
export function parseRecordIndex(text: string): RecordIndex | null {
  try {
    const json = JSON.parse(text) as { version?: unknown; folders?: unknown };
    if (json.version !== 1 || !json.folders || typeof json.folders !== "object") return null;
    const out: RecordIndex = new Map();
    for (const [folder, files] of Object.entries(json.folders as Record<string, unknown>)) {
      if (!Array.isArray(files)) return null;
      out.set(folder, new Set(files.filter((f): f is string => typeof f === "string")));
    }
    return out;
  } catch {
    return null;
  }
}

/** Whether `file` may be fetched from `folder`: listed in the index, or anything when there is no index. */
export function indexHas(index: RecordIndex | null, folder: string, file: string): boolean {
  return index === null || (index.get(folder)?.has(file) ?? false);
}

/**
 * The runs the index lists for one day's base name (`2026-10-02-sTSLA-CC`): the base itself, then `-2`, `-3`, ... in
 * order, without the `.json`. Another vault whose symbol extends this one (`sTSLA-CC-X`) is not a run of it.
 */
export function listedRunNames(index: RecordIndex, folder: string, base: string): string[] {
  const files = index.get(folder);
  if (!files) return [];
  const runs: { name: string; n: number }[] = [];
  for (const f of files) {
    if (!f.endsWith(".json") || !f.startsWith(base)) continue;
    const name = f.slice(0, -".json".length);
    const rest = name.slice(base.length);
    const m = rest === "" ? ["", "1"] : /^-(\d+)$/.exec(rest);
    if (m) runs.push({ name, n: Number(m[1]) });
  }
  return runs.sort((a, b) => a.n - b.n).map((r) => r.name);
}

// Per fetch function, so tests that pass their own do not share an entry.
const indexCache = new WeakMap<Fetch, { at: number; index: Promise<RecordIndex | null> }>();

/**
 * The published record index from GitHub main; null when there is none (a 404, as in a fork without one) or it
 * cannot be read, so the caller falls back to trying each candidate name. Throws a `WhyStrikeError` only when
 * GitHub cannot be reached.
 */
export function fetchRecordIndex(
  fetchImpl: Fetch = fetch,
  signal?: AbortSignal,
): Promise<RecordIndex | null> {
  const hit = indexCache.get(fetchImpl);
  if (hit && Date.now() - hit.at < RECORD_INDEX_STALE_MS) return hit.index;
  const index = (async () => {
    let res: Response;
    try {
      res = await fetchImpl(RAW_BASE + RECORD_INDEX_PATH, { signal });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new WhyStrikeError("network", "GitHub could not be reached from this browser.");
    }
    if (!res.ok) return null;
    return parseRecordIndex(await res.text());
  })();
  const entry = { at: Date.now(), index };
  indexCache.set(fetchImpl, entry);
  // A failed fetch is not remembered (Try again must reach GitHub again).
  index.catch(() => {
    if (indexCache.get(fetchImpl) === entry) indexCache.delete(fetchImpl);
  });
  return index;
}
