import { type Hex, keccak256, toBytes } from "viem";

// Anchored decision records. An agent commits keccak256 of its record to the DecisionLog contract
// (`record(agentId, vault, epoch, recordHash, uri)`); anyone can fetch the published record, rebuild the bytes
// the hash covers and compare them with `latestHash(agentId, vault, epoch)`. The example agent's anchor.ts
// writes records this way; the app's "Why this strike" panel checks them.

/** Label of the anchoring transaction in a record's `transactions` list (it cannot be inside the bytes it hashes). */
export const ANCHOR_TX_LABEL = "DecisionLog.record";

/** Heading of the section a hand-written epoch log gains once it is anchored; the hash covers what is above it. */
export const ANCHOR_SECTION_HEADING = "## Anchored on-chain";

/** keccak256 of a string's UTF-8 bytes (`cast keccak "$(cat file)"` for a file without a trailing newline). */
export function hashText(text: string): Hex {
  return keccak256(toBytes(text));
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The exact bytes a JSON decision record's anchor hashes: the record without its `anchor` field and without the
 * DecisionLog.record transaction, as `JSON.stringify(record, null, 2)` plus a trailing newline (how the agent writes
 * the file; prettier may reflow the published copy, so the bytes are rebuilt from the parsed record, never hashed
 * from the file as served). Throws when `record` is not an object.
 */
export function unanchoredRecordJson(record: unknown): string {
  if (!isObj(record)) throw new TypeError("a decision record is a JSON object");
  const { anchor: _anchor, ...rest } = record;
  const out: Obj = { ...rest };
  if (Array.isArray(rest.transactions)) {
    out.transactions = rest.transactions.filter((t) => !(isObj(t) && t.label === ANCHOR_TX_LABEL));
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** The hash a JSON decision record (parsed, or its text) anchors: keccak256 of {@link unanchoredRecordJson}. */
export function decisionRecordHash(record: unknown): Hex {
  const parsed = typeof record === "string" ? JSON.parse(record) : record;
  return hashText(unanchoredRecordJson(parsed));
}

/**
 * The hash of a hand-written epoch log (markdown) anchored after the fact: everything above its
 * "## Anchored on-chain" heading, without the blank line that separates them, ending in one newline. A log without
 * that heading hashes whole (trailing whitespace trimmed to one newline).
 */
export function epochLogHash(markdown: string): Hex {
  const i = markdown.indexOf(`\n${ANCHOR_SECTION_HEADING}`);
  const body = i >= 0 ? markdown.slice(0, i) : markdown;
  return hashText(`${body.trimEnd()}\n`);
}

/** The `anchor` field of a published record, when present and well-formed. */
export interface DecisionRecordAnchor {
  contract: string;
  recordHash: Hex;
  uri: string;
  epoch: number;
  txHash: string;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export function recordAnchorOf(record: unknown): DecisionRecordAnchor | null {
  if (!isObj(record) || !isObj(record.anchor)) return null;
  const a = record.anchor;
  if (
    typeof a.contract !== "string" ||
    !ADDRESS_RE.test(a.contract) ||
    typeof a.recordHash !== "string" ||
    !HASH_RE.test(a.recordHash) ||
    typeof a.epoch !== "number" ||
    !Number.isInteger(a.epoch) ||
    a.epoch < 0
  ) {
    return null;
  }
  return {
    contract: a.contract,
    recordHash: a.recordHash.toLowerCase() as Hex,
    uri: typeof a.uri === "string" ? a.uri : "",
    epoch: a.epoch,
    txHash: typeof a.txHash === "string" && HASH_RE.test(a.txHash) ? a.txHash : "",
  };
}

/** What identifies the vault epoch a record is about. */
export interface RecordIdentity {
  chainId: number;
  vault: string;
  /** The series the run put on sale (null when nothing was accepted). */
  seriesId: string | null;
  /** The vault epoch the record was anchored under (null when the record is unanchored). */
  epoch: number | null;
}

/** The identity of a published record, or null when it names no chain or vault. */
export function recordIdentityOf(record: unknown): RecordIdentity | null {
  if (!isObj(record) || !isObj(record.chain) || !isObj(record.vault)) return null;
  const chainId = record.chain.id;
  const vault = record.vault.address;
  if (typeof chainId !== "number" || typeof vault !== "string" || !ADDRESS_RE.test(vault)) return null;
  const result = isObj(record.result) ? record.result : {};
  const seriesId = typeof result.seriesId === "string" && result.seriesId !== "" ? result.seriesId : null;
  return { chainId, vault, seriesId, epoch: recordAnchorOf(record)?.epoch ?? null };
}

/** A vault epoch as the chain shows it. */
export interface SeriesTarget {
  chainId: number;
  vault: string;
  epoch: bigint | number;
  /** The live (or last) series id; null between epochs once settlement cleared it. */
  seriesId?: bigint | string | null;
}

/**
 * How well a record fits a vault epoch: 0 when it is about another chain, vault or epoch; 1 when it was anchored
 * under this epoch; 2 when it also put this very series on sale. A rejected run and the accepted retry of the same
 * epoch both rank 1; only the retry ranks 2.
 */
export function recordMatchRank(record: RecordIdentity, target: SeriesTarget): 0 | 1 | 2 {
  if (record.chainId !== target.chainId) return 0;
  if (record.vault.toLowerCase() !== target.vault.toLowerCase()) return 0;
  const series = target.seriesId === undefined || target.seriesId === null ? null : String(target.seriesId);
  if (series !== null && record.seriesId !== null && record.seriesId === series) return 2;
  return record.epoch !== null && BigInt(record.epoch) === BigInt(target.epoch) ? 1 : 0;
}

/** The raw.githubusercontent.com address of a github.com file link (null for anything else). */
export function rawGithubUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.hostname !== "github.com") return null;
  const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/);
  return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}/${m[4]}` : null;
}
