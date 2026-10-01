import {
  type Address,
  type Hex,
  type PublicClient,
  TransactionReceiptNotFoundError,
  decodeEventLog,
  getAddress,
  keccak256,
  toBytes,
} from "viem";
import { decisionLogAbi } from "./abi/index.js";

// Anchored decision records. An agent commits keccak256 of its record to the DecisionLog contract
// (`record(agentId, vault, epoch, recordHash, uri)`, which emits DecisionRecorded); anyone can fetch the published
// record, rebuild the bytes the hash covers and check them against the record's own anchoring transaction
// ({@link verifyDecisionAnchor}). `latestHash(agentId, vault, epoch)` keeps only the newest anchor per epoch (a
// settlement record overwrites the proposal's), so it is secondary evidence. The example agent's anchor.ts writes
// records this way; the app's "Why this strike" panel checks them.

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

/* ================================================================ checking an anchor on-chain */

/** What a DecisionLog anchor must say for a record to verify. */
export interface AnchorExpectation {
  /** The DecisionLog contracts the anchor may come from (the deployed ones); any other emitter is refused. */
  decisionLogs: readonly string[];
  agentId: bigint;
  vault: string;
  epoch: bigint | number;
  /** keccak256 rebuilt from the published record ({@link decisionRecordHash} or {@link epochLogHash}). */
  recordHash: Hex;
}

/** A DecisionRecorded event, decoded. */
export interface DecisionRecordedEvent {
  emitter: Address;
  agentId: bigint;
  vault: Address;
  epoch: bigint;
  recordHash: Hex;
  uri: string;
  timestamp: bigint;
  logIndex: number | null;
}

/**
 * How a record's anchoring transaction checks out: `match` when it emitted DecisionRecorded from a known DecisionLog
 * for this agent, vault and epoch with the rebuilt hash; `hash-mismatch` when that event carries another hash (the
 * record changed after it was anchored); `wrong-emitter` when the only DecisionRecorded events come from an unknown
 * contract; `wrong-target` when a known DecisionLog anchored another agent, vault or epoch; `no-event` when the
 * transaction anchored nothing; `reverted`; `not-found` when the chain has no such transaction.
 */
export type AnchorTxStatus =
  "match" | "hash-mismatch" | "wrong-emitter" | "wrong-target" | "no-event" | "reverted" | "not-found";

export interface AnchorTxResult {
  status: AnchorTxStatus;
  /** The event the verdict is about (the matching one, else the closest), null when there is none. */
  event: DecisionRecordedEvent | null;
}

/** The parts of a transaction receipt the check reads (a viem `TransactionReceipt` fits). */
export interface AnchorReceipt {
  status: "success" | "reverted";
  logs: readonly { address: string; topics: readonly Hex[]; data: Hex; logIndex?: number | null }[];
}

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Every DecisionRecorded event in a receipt, whoever emitted it. */
export function decisionRecordedEvents(receipt: AnchorReceipt): DecisionRecordedEvent[] {
  const out: DecisionRecordedEvent[] = [];
  for (const log of receipt.logs) {
    if (log.topics.length === 0) continue;
    try {
      const { args } = decodeEventLog({
        abi: decisionLogAbi,
        eventName: "DecisionRecorded",
        topics: log.topics as [Hex, ...Hex[]],
        data: log.data,
      });
      out.push({
        emitter: getAddress(log.address),
        agentId: args.agentId,
        vault: getAddress(args.vault),
        epoch: args.epoch,
        recordHash: args.recordHash.toLowerCase() as Hex,
        uri: args.uri,
        timestamp: args.timestamp,
        logIndex: log.logIndex ?? null,
      });
    } catch {
      // another event
    }
  }
  return out;
}

/** Check a record's anchoring transaction receipt against what the record says (see {@link AnchorTxStatus}). */
export function checkAnchorReceipt(receipt: AnchorReceipt, expected: AnchorExpectation): AnchorTxResult {
  if (receipt.status !== "success") return { status: "reverted", event: null };
  const events = decisionRecordedEvents(receipt);
  if (events.length === 0) return { status: "no-event", event: null };
  const known = events.filter((e) => expected.decisionLogs.some((d) => sameAddress(d, e.emitter)));
  if (known.length === 0) return { status: "wrong-emitter", event: events[0]! };
  const epoch = BigInt(expected.epoch);
  const targets = known.filter(
    (e) => e.agentId === expected.agentId && sameAddress(e.vault, expected.vault) && e.epoch === epoch,
  );
  if (targets.length === 0) return { status: "wrong-target", event: known[0]! };
  const hash = expected.recordHash.toLowerCase();
  const hit = targets.find((e) => e.recordHash === hash);
  return hit ? { status: "match", event: hit } : { status: "hash-mismatch", event: targets[0]! };
}

/** The reads {@link verifyDecisionAnchor} makes (a viem `PublicClient` fits). */
export type AnchorReader = Pick<PublicClient, "getTransactionReceipt" | "readContract">;

/** Fetch a transaction's receipt and check it ({@link checkAnchorReceipt}); `not-found` when the chain has none. */
export async function verifyAnchorTx(
  client: Pick<PublicClient, "getTransactionReceipt">,
  txHash: Hex,
  expected: AnchorExpectation,
): Promise<AnchorTxResult> {
  let receipt: AnchorReceipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash });
  } catch (e) {
    if (e instanceof TransactionReceiptNotFoundError) return { status: "not-found", event: null };
    throw e;
  }
  return checkAnchorReceipt(receipt, expected);
}

const ZERO_HASH = `0x${"0".repeat(64)}` as Hex;

/**
 * The outcome of checking a published record against the chain.
 *
 * - `match`: the hash is anchored. By its own transaction (`via: "tx"`) when the record names one, else by
 *   `latestHash` (`via: "latestHash"`).
 * - `mismatch`: the anchor carries another hash: the record changed after it was anchored.
 * - `bad-tx`: the transaction the record names is not a DecisionLog anchor of this record (`tx.status` says why).
 * - `no-anchor`: no transaction named and `latestHash` is zero.
 */
export interface DecisionAnchorCheck {
  status: "match" | "mismatch" | "bad-tx" | "no-anchor";
  via: "tx" | "latestHash";
  /** The DecisionLog the verdict is about (the anchor's emitter, else the first known one that answered). */
  decisionLog: Address | null;
  /** The transaction check, when a transaction was named and found. */
  tx: AnchorTxResult | null;
  /** `latestHash(agentId, vault, epoch)` on that DecisionLog; null when it could not be read. */
  latestHash: Hex | null;
  /**
   * True when the record's own transaction anchors it but `latestHash` now holds another hash: a later record for the
   * same epoch (a settlement record, a correction) was anchored after it. Not a failure.
   */
  superseded: boolean;
}

/**
 * Check a published record's hash on-chain. With the record's anchoring transaction (`txHash`): fetch its receipt,
 * find the DecisionRecorded event of a known DecisionLog and compare agent, vault, epoch and hash (primary), then
 * read `latestHash` for the same key (secondary: a different value means a later record exists). Without one, or when
 * the chain does not know the transaction: compare with `latestHash` on each known DecisionLog (the first non-zero
 * answer counts). Throws when the chain cannot be read at all.
 */
export async function verifyDecisionAnchor(
  client: AnchorReader,
  expected: AnchorExpectation & { txHash?: string | null },
): Promise<DecisionAnchorCheck> {
  const hash = expected.recordHash.toLowerCase();
  const readLatest = (contract: string): Promise<Hex> =>
    client.readContract({
      address: getAddress(contract),
      abi: decisionLogAbi,
      functionName: "latestHash",
      args: [expected.agentId, getAddress(expected.vault), BigInt(expected.epoch)],
    }) as Promise<Hex>;

  let txError: unknown = null;
  if (expected.txHash && /^0x[0-9a-fA-F]{64}$/.test(expected.txHash)) {
    try {
      const tx = await verifyAnchorTx(client, expected.txHash as Hex, expected);
      if (tx.status !== "not-found") {
        const emitter = tx.event?.emitter ?? null;
        const knownEmitter =
          emitter && expected.decisionLogs.some((d) => sameAddress(d, emitter)) ? emitter : null;
        const latest = knownEmitter ? await readLatest(knownEmitter).catch(() => null) : null;
        const status =
          tx.status === "match" ? "match" : tx.status === "hash-mismatch" ? "mismatch" : "bad-tx";
        return {
          status,
          via: "tx",
          decisionLog: knownEmitter ?? emitter,
          tx,
          latestHash: latest,
          superseded:
            status === "match" && latest !== null && latest !== ZERO_HASH && latest.toLowerCase() !== hash,
        };
      }
    } catch (e) {
      txError = e; // the receipt could not be read: fall back to latestHash
    }
  }

  const reads = await Promise.all(
    expected.decisionLogs.map(async (c) => {
      try {
        return { c: getAddress(c), hash: await readLatest(c), error: null as unknown };
      } catch (e) {
        return { c: getAddress(c), hash: null, error: e };
      }
    }),
  );
  const hit = reads.find((r) => r.hash !== null && r.hash !== ZERO_HASH);
  if (hit?.hash) {
    return {
      status: hit.hash.toLowerCase() === hash ? "match" : "mismatch",
      via: "latestHash",
      decisionLog: hit.c,
      tx: null,
      latestHash: hit.hash,
      superseded: false,
    };
  }
  if (!reads.some((r) => r.hash !== null)) {
    const err = reads.find((r) => r.error !== null)?.error ?? txError;
    if (err) throw err;
  }
  return {
    status: "no-anchor",
    via: "latestHash",
    decisionLog: reads[0]?.c ?? null,
    tx: null,
    latestHash: reads.length > 0 ? ZERO_HASH : null,
    superseded: false,
  };
}
