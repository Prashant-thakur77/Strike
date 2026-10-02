import {
  decisionLogAbi,
  getDeployment,
  getStrikeChain,
  rpcEndpointsFor,
  strikeVaultAbi,
  transportFromEndpoints,
} from "@strike/sdk";
import {
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  getAddress,
  keccak256,
  toBytes,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { epochSnapshot, readClient } from "./chain.js";
import { type DecisionRecord, type RecordAction, formatRecordJson } from "./record.js";

export type { RecordAnchor } from "./record.js";

// `--anchor`: commit each decision record's keccak256 hash to the DecisionLog contract, with the record's public URL,
// signed by the agent's signer key. Anyone can then check that the published JSON is the one the agent anchored.
//
// The hash covers the record as it was before anchoring: the JSON without its `anchor` field and without the
// DecisionLog.record transaction (which cannot be inside the bytes it hashes). `unanchoredJson` rebuilds exactly
// those bytes from the published file.

/** Label of the anchoring transaction in the record's transactions list. */
export const ANCHOR_TX_LABEL = "DecisionLog.record";

/** Where the weekly workflow publishes decision records (docs/agent-log on main). */
export const DEFAULT_RECORD_BASE_URL =
  "https://github.com/Prashant-thakur77/Strike/blob/main/docs/agent-log/";

/** keccak256 of a string's UTF-8 bytes (`cast keccak "$(cat file)"` for a file without a trailing newline). */
export function hashText(text: string): Hex {
  return keccak256(toBytes(text));
}

/** The exact JSON the anchor hashes: the record without its anchor field and anchoring transaction. */
export function unanchoredJson(record: DecisionRecord): string {
  const { anchor: _anchor, ...rest } = record;
  return formatRecordJson({
    ...rest,
    transactions: record.transactions.filter((t) => t.label !== ANCHOR_TX_LABEL),
  });
}

/** Hash to anchor for a record (and to check a published one against `anchor.recordHash`). */
export function recordHash(record: DecisionRecord): Hex {
  return hashText(unanchoredJson(record));
}

/** True when a published record's anchor hash matches its contents. */
export function verifyAnchoredRecord(json: string): boolean {
  const record = JSON.parse(json) as DecisionRecord;
  return record.anchor !== undefined && recordHash(record) === record.anchor.recordHash;
}

/** Public URL of a record file. */
export function recordUrl(fileName: string, base = DEFAULT_RECORD_BASE_URL): string {
  return `${base.endsWith("/") ? base : `${base}/`}${fileName}`;
}

/**
 * The vault epoch a record belongs to. `currentEpoch` counts epochs opened so far; a propose or reckless run that
 * leaves the vault Idle (nothing was opened, or it stopped before opening) was deciding about the next epoch.
 */
export function anchorEpoch(action: RecordAction, currentEpoch: bigint, state: string): bigint {
  return action !== "settle" && state === "Idle" ? currentEpoch + 1n : currentEpoch;
}

export interface AnchorRequest {
  agentId: bigint;
  vault: Address;
  epoch: bigint;
  recordHash: Hex;
  uri: string;
}

/** Sends DecisionLog.record and returns the mined transaction's hash. */
export type AnchorSender = (req: AnchorRequest) => Promise<Hex>;

/** DecisionLog address: STRIKE_DECISION_LOG, else the chain's deployment record. */
export function decisionLogAddress(chainId: number, env: NodeJS.ProcessEnv = process.env): Address {
  const override = env.STRIKE_DECISION_LOG;
  if (override) return getAddress(override);
  const deployed = getDeployment(chainId).decisionLog;
  if (!deployed) throw new Error(`no DecisionLog deployed on chain ${chainId}: set STRIKE_DECISION_LOG`);
  return getAddress(deployed);
}

/**
 * A sender signing with STRIKE_AGENT_PRIVATE_KEY (the agent's signer) on STRIKE_CHAIN_ID, over the SDK's endpoints
 * (Alchemy when ALCHEMY_API_KEY is set, then STRIKE_RPC_URL, then the public RPC).
 */
export function chainAnchorSender(
  chainId: number,
  contract: Address,
  env: NodeJS.ProcessEnv = process.env,
): AnchorSender {
  const key = env.STRIKE_AGENT_PRIVATE_KEY;
  if (!key) throw new Error("--anchor needs STRIKE_AGENT_PRIVATE_KEY (the agent's signer key)");
  const base = getStrikeChain(chainId);
  const endpoints = rpcEndpointsFor(chainId, env);
  const chain = { ...base, rpcUrls: { default: { http: [endpoints[0]!.url] } } };
  const account = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as Hex);
  const transport = transportFromEndpoints(endpoints);
  const wallet = createWalletClient({ account, chain, transport });
  const client = createPublicClient({ chain, transport });
  return async (req) => {
    const { request } = await client.simulateContract({
      account,
      address: contract,
      abi: decisionLogAbi,
      functionName: "record",
      args: [req.agentId, req.vault, req.epoch, req.recordHash, req.uri],
    });
    const hash = await wallet.writeContract(request);
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`DecisionLog.record reverted (tx ${hash})`);
    return hash;
  };
}

/** The vault's epoch number for a record, read from the chain after the run. */
export async function readAnchorEpoch(
  chainId: number,
  vault: string,
  action: RecordAction,
  env: NodeJS.ProcessEnv = process.env,
): Promise<bigint> {
  const strike = readClient({ ...env, STRIKE_CHAIN_ID: String(chainId) });
  const current = await strike.viem.publicClient.readContract({
    address: getAddress(vault),
    abi: strikeVaultAbi,
    functionName: "currentEpoch",
  });
  const snapshot = await epochSnapshot(strike, vault);
  return anchorEpoch(action, BigInt(current), snapshot.state);
}

/**
 * Anchor a record about to be written as `fileName`: hash it, send DecisionLog.record, and return the record with
 * the anchor and its transaction added (the caller writes that).
 */
export async function anchorRecord(
  record: DecisionRecord,
  fileName: string,
  opts: {
    contract: Address;
    epoch: bigint;
    send: AnchorSender;
    baseUrl?: string;
    txUrl: (h: string) => string | null;
  },
): Promise<DecisionRecord> {
  const agentId = record.agent.agentId;
  if (!agentId) throw new Error("the record has no agent id to anchor under");
  const hash = recordHash(record);
  const uri = recordUrl(fileName, opts.baseUrl);
  const txHash = await opts.send({
    agentId: BigInt(agentId),
    vault: getAddress(record.vault.address),
    epoch: opts.epoch,
    recordHash: hash,
    uri,
  });
  return {
    ...record,
    transactions: [...record.transactions, { label: ANCHOR_TX_LABEL, hash: txHash, url: opts.txUrl(txHash) }],
    anchor: { contract: opts.contract, recordHash: hash, uri, epoch: Number(opts.epoch), txHash },
  };
}
