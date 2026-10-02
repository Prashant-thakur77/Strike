import {
  agentRegistryV3Abi,
  decisionLogAbi,
  epochManagerAbi,
  mirrorFeedAbi,
  strikeVaultAbi,
  vaultFactoryAbi,
} from "@strike/sdk";
import { type Abi, type Hex, decodeEventLog } from "viem";
import type { ContractKind } from "./config.js";

// Each contract kind's ABI, from @strike/sdk (the same ABIs the app's usage panel decodes with). The v3
// AgentRegistry's events are a superset of v2's with the same signatures, so one ABI decodes both.
export const ABIS: Readonly<Record<ContractKind, Abi>> = {
  epochManager: epochManagerAbi as Abi,
  vaultFactory: vaultFactoryAbi as Abi,
  agentRegistry: agentRegistryV3Abi as Abi,
  decisionLog: decisionLogAbi as Abi,
  vault: strikeVaultAbi as Abi,
  mirrorFeed: mirrorFeedAbi as Abi,
};

/** A log as the RPC returns it (the fields the indexer stores). */
export interface RawLog {
  address: Hex;
  topics: Hex[];
  data: Hex;
  blockNumber: bigint;
  blockHash: Hex;
  transactionHash: Hex;
  transactionIndex: number;
  logIndex: number;
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Decoded arguments as JSON: integers as decimal strings (exact), addresses lowercase, the rest as is. */
export function toJson(v: unknown): JsonValue {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string") return ADDRESS.test(v) ? v.toLowerCase() : v;
  if (typeof v === "number" || typeof v === "boolean" || v === null) return v;
  if (v === undefined) return null;
  if (Array.isArray(v)) return v.map(toJson);
  if (typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, toJson(x)]));
  }
  return String(v);
}

/** The event name and JSON arguments of a log, or null when it does not decode with its contract's ABI. */
export function decodeLog(
  log: Pick<RawLog, "topics" | "data">,
  kind: ContractKind,
): {
  eventName: string;
  args: { [k: string]: JsonValue };
} | null {
  if (!log.topics.length) return null;
  try {
    const d = decodeEventLog({
      abi: ABIS[kind],
      data: log.data,
      topics: log.topics as [Hex, ...Hex[]],
      strict: true,
    });
    const args = toJson(d.args ?? {});
    return {
      eventName: d.eventName ?? "",
      args: args && typeof args === "object" && !Array.isArray(args) ? args : {},
    };
  } catch {
    return null;
  }
}

/** Addresses of new vaults in a decoded log (VaultCreated or VaultRegistered), lowercase. */
export function vaultOf(
  kind: ContractKind,
  eventName: string,
  args: { [k: string]: JsonValue },
): string | null {
  const hit =
    (kind === "vaultFactory" && eventName === "VaultCreated") ||
    (kind === "epochManager" && eventName === "VaultRegistered");
  const v = hit ? args.vault : undefined;
  return typeof v === "string" && ADDRESS.test(v) ? v.toLowerCase() : null;
}
