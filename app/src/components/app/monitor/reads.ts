import { createPublicClient, parseAbi, type Address, type PublicClient } from "viem";
import { robinhood } from "viem/chains";
import {
  MONITOR_CHAIN_ID,
  MONITOR_TOKENS,
  type MonitorToken,
  type RoundData,
  type TokenReads,
} from "@/lib/monitor";
import { readTransport } from "@/lib/rpc/client";

// Own mainnet client: the monitor never follows the app's selected chain (wagmi), it always reads chain 4663.
let client: PublicClient | null = null;

export function monitorClient(): PublicClient {
  client ??= createPublicClient({
    chain: robinhood,
    transport: readTransport(MONITOR_CHAIN_ID, { timeout: 20_000, retryCount: 2 }),
  }) as PublicClient;
  return client;
}

const abi = parseAbi([
  // Robinhood stock token: pause layers (Robinhood-specific) and ERC-8056.
  "function paused() view returns (bool)",
  "function oraclePaused() view returns (bool)",
  "function uiMultiplier() view returns (uint256)",
  "function newUIMultiplier() view returns (uint256)",
  "function effectiveAt() view returns (uint256)",
  // Chainlink AggregatorV3.
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  // Multicall3: block context of the same call, so the verdict uses the block's timestamp like `status()` does.
  "function getCurrentBlockTimestamp() view returns (uint256)",
  "function getBlockNumber() view returns (uint256)",
]);

type Fn =
  | "paused"
  | "oraclePaused"
  | "uiMultiplier"
  | "newUIMultiplier"
  | "effectiveAt"
  | "decimals"
  | "latestRoundData"
  | "getCurrentBlockTimestamp"
  | "getBlockNumber";

interface Call {
  address: Address;
  abi: typeof abi;
  functionName: Fn;
}

type Outcome = { status: "success"; result: unknown } | { status: "failure"; error: unknown };

const TOKEN_FNS = ["paused", "oraclePaused", "uiMultiplier", "newUIMultiplier", "effectiveAt"] as const;
const FEED_FNS = ["decimals", "latestRoundData"] as const;
const PER_TOKEN = TOKEN_FNS.length + FEED_FNS.length;

export interface TokenRow {
  token: MonitorToken;
  reads: TokenReads;
  /** How many of the token's reads failed (0 when everything answered). */
  failed: number;
}

export interface MonitorSnapshot {
  blockNumber: bigint;
  /** Block timestamp: the `block.timestamp` the verdicts are evaluated at. */
  blockTimestamp: bigint;
  /** Local wall-clock ms when the snapshot arrived (for ticking ages between refreshes). */
  fetchedAt: number;
  /** "multicall" when batched through Multicall3 in one eth_call, else "parallel". */
  mode: "multicall" | "parallel";
  rows: TokenRow[];
}

function tokenCalls(t: MonitorToken): Call[] {
  return [
    ...TOKEN_FNS.map((functionName) => ({ address: t.token, abi, functionName })),
    ...FEED_FNS.map((functionName) => ({ address: t.feed, abi, functionName })),
  ];
}

async function readParallel(c: PublicClient, calls: Call[]): Promise<Outcome[]> {
  const settled = await Promise.allSettled(calls.map((call) => c.readContract(call)));
  return settled.map((s) =>
    s.status === "fulfilled"
      ? { status: "success", result: s.value }
      : { status: "failure", error: s.reason },
  );
}

function value<T>(o: Outcome | undefined): T | null {
  return o && o.status === "success" ? (o.result as T) : null;
}

function toRound(o: Outcome | undefined): RoundData | null {
  const r = value<readonly [bigint, bigint, bigint, bigint, bigint]>(o);
  if (!r) return null;
  const [roundId, answer, startedAt, updatedAt, answeredInRound] = r;
  return { roundId, answer, startedAt, updatedAt, answeredInRound };
}

/** One snapshot of every monitored token. Multicall3 when the chain has it, parallel reads otherwise. */
export async function readMonitor(c: PublicClient = monitorClient()): Promise<MonitorSnapshot> {
  const calls = MONITOR_TOKENS.flatMap(tokenCalls);
  const multicall3 = c.chain?.contracts?.multicall3?.address;

  let outcomes: Outcome[] | null = null;
  let blockNumber: bigint | null = null;
  let blockTimestamp: bigint | null = null;
  let mode: MonitorSnapshot["mode"] = "parallel";

  if (multicall3) {
    try {
      const ctx: Call[] = [
        { address: multicall3, abi, functionName: "getBlockNumber" },
        { address: multicall3, abi, functionName: "getCurrentBlockTimestamp" },
      ];
      const res = (await c.multicall({ contracts: [...ctx, ...calls], allowFailure: true })) as Outcome[];
      blockNumber = value<bigint>(res[0]);
      blockTimestamp = value<bigint>(res[1]);
      outcomes = res.slice(ctx.length);
      mode = "multicall";
    } catch {
      outcomes = null; // fall through to parallel reads
    }
  }
  if (!outcomes) {
    const [res, block] = await Promise.all([readParallel(c, calls), c.getBlock({ blockTag: "latest" })]);
    outcomes = res;
    blockNumber = block.number;
    blockTimestamp = block.timestamp;
    mode = "parallel";
  } else if (blockNumber === null || blockTimestamp === null) {
    const block = await c.getBlock({ blockTag: "latest" });
    blockNumber = block.number;
    blockTimestamp = block.timestamp;
  }

  const rows = MONITOR_TOKENS.map((token, i) => {
    const o = outcomes.slice(i * PER_TOKEN, (i + 1) * PER_TOKEN);
    const reads: TokenReads = {
      paused: value<boolean>(o[0]),
      oraclePaused: value<boolean>(o[1]),
      uiMultiplier: value<bigint>(o[2]),
      newUIMultiplier: value<bigint>(o[3]),
      effectiveAt: value<bigint>(o[4]),
      feedDecimals: value<number>(o[5]) ?? 8,
      round: toRound(o[6]),
    };
    return { token, reads, failed: o.filter((x) => x.status === "failure").length };
  });

  if (rows.every((r) => r.failed === PER_TOKEN)) {
    throw new Error("Robinhood Chain mainnet did not answer any read. The RPC may be down or rate-limiting.");
  }
  return { blockNumber, blockTimestamp, fetchedAt: Date.now(), mode, rows };
}
