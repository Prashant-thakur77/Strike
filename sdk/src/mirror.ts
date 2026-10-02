import {
  type Address,
  type Hex,
  type PublicClient,
  type Transport,
  createPublicClient,
  getAddress,
} from "viem";
import { epochManagerAbi } from "./abi/epochManager.js";
import { mirrorFeedAbi } from "./abi/mirrorFeed.js";
import { stockOracleAbi } from "./abi/stockOracle.js";
import { strikeVaultAbi } from "./abi/strikeVault.js";
import { getStrikeChain } from "./chains.js";
import { type StrikeDeployment, deploymentForEpochManager, deploymentsFor } from "./deployments.js";
import { StrikeError } from "./errors.js";
import { type RpcEndpoint, rpcEndpointsFor, transportFromEndpoints } from "./rpc.js";
import { type FeedRound, findSettlementRound } from "./settlement.js";

// The price mirror audit. Robinhood Chain testnet and Arbitrum Sepolia have no Chainlink stock feeds, so Strike reads
// MirrorFeeds there, which the keeper (scripts/keeper.sh) fills with rounds copied from the Robinhood Chain mainnet
// Chainlink feeds: the answer and the `updatedAt` of the mainnet round, nothing else. This module checks every
// testnet round against the mainnet feed: the mainnet round with the same `updatedAt` must exist and carry the same
// answer. What it cannot check is which rounds the keeper chose to push (it pushes the latest mainnet round when it
// runs); it reports the gaps instead, and for a settlement whether the round used is the first mainnet print at or
// after expiry, the one mainnet settlement would use.

/** Robinhood Chain mainnet: where the Chainlink stock feeds the MirrorFeeds copy live. */
export const MAINNET_FEEDS_CHAIN_ID = 4663;

/** Multicall3, at the same address on 4663, 46630 and 421614. */
export const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

/**
 * The Robinhood Chain mainnet Chainlink Standard proxies the keeper copies (scripts/keeper.sh MAINNET_FEED,
 * docs/research.md). Chainlink lists no NFLX feed on Robinhood Chain, so the NFLX MirrorFeed cannot be checked.
 */
export const MAINNET_CHAINLINK_FEEDS: Readonly<Record<string, Address>> = {
  TSLA: "0x4A1166a659A55625345e9515b32adECea5547C38",
  NVDA: "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15",
  AMZN: "0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C",
  PLTR: "0x820ABedFF239034956B7A9d2F0a331f9F075eB4c",
  AMD: "0x943A29E7ae51A4798823ca9eEd2ed533B2A22C72",
  SPY: "0x319724394D3A0e3669269846abE664Cd621f9f6A",
};

/** A Chainlink aggregator proxy: round ids are `phaseId << 64 | aggregatorRound`. */
export const aggregatorProxyAbi = [
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
  {
    type: "function",
    name: "getRoundData",
    stateMutability: "view",
    inputs: [{ name: "roundId", type: "uint80" }],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  {
    type: "function",
    name: "description",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
] as const;

const effectiveAtAbi = [
  {
    type: "function",
    name: "effectiveAt",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

const AGGREGATOR_MASK = (1n << 64n) - 1n;

/**
 * The seed price (8 decimals) contracts/script/Deploy.s.sol pushes as round 1 of each MirrorFeed it creates, by chain
 * (`Stock(symbol, ..., seedPrice8, sigma)`). A round 1 equal to it, with no mainnet round at its timestamp, is the
 * deploy-time seed rather than a keeper push. Arbitrum Sepolia's feeds were seeded with the live mainnet round
 * instead (421614.json `testnetNote`), so their round 1 is checked like any other.
 */
export const DEPLOY_SEED_PRICES: Readonly<Record<number, Readonly<Record<string, bigint>>>> = {
  46630: {
    TSLA: 369_00000000n,
    AMZN: 225_00000000n,
    PLTR: 180_00000000n,
    NFLX: 1200_00000000n,
    AMD: 160_00000000n,
  },
  421614: { TSLA: 369_00000000n, NVDA: 224_00000000n },
};

/** What the audit found for one testnet round. */
export type MirrorRoundStatus =
  /** A mainnet round has the same `updatedAt` and the same answer. */
  | "match"
  /** No mainnet round was published at this `updatedAt`: the value was never printed by Chainlink. */
  | "no-mainnet-round"
  /** A mainnet round has this `updatedAt` but a different answer. */
  | "answer-differs"
  /** `updatedAt` is later than the mainnet chain's head: no mainnet round can have it yet. */
  | "future-timestamp"
  /**
   * Round 1, equal to the seed price contracts/script/Deploy.s.sol pushes when it creates the feed (before the
   * keeper's first run). Never a mainnet print, so it is listed but not counted as a keeper round.
   */
  | "deploy-seed"
  /** Not checked: the feed has no mainnet counterpart (Chainlink lists no NFLX feed), so it is not counted. */
  | "unchecked";

/** The statuses of keeper rounds, the ones an audit counts (every one but "deploy-seed" and "unchecked"). */
export type CheckedStatus = Exclude<MirrorRoundStatus, "unchecked" | "deploy-seed">;

export const MIRROR_ROUND_STATUSES: readonly CheckedStatus[] = [
  "match",
  "no-mainnet-round",
  "answer-differs",
  "future-timestamp",
];

/** A mainnet Chainlink round, with its proxy round id split into phase and aggregator round. */
export interface MainnetRound {
  roundId: bigint;
  phase: number;
  aggregatorRound: bigint;
  answer: bigint;
  updatedAt: bigint;
}

/** One testnet MirrorFeed round and its mainnet counterpart. */
export interface MirrorRoundCheck {
  roundId: bigint;
  answer: bigint;
  updatedAt: bigint;
  /** The `push` transaction (from the feed's AnswerUpdated log), when the logs could be read. */
  pushTx: Hex | null;
  pushBlock: bigint | null;
  status: MirrorRoundStatus;
  /** The mainnet round with the same `updatedAt` (with a different answer for "answer-differs"). */
  mainnet: MainnetRound | null;
  /** For "no-mainnet-round": the mainnet prints just before and just after this timestamp. */
  nearest?: { before: MainnetRound | null; after: MainnetRound | null };
}

/** The longest stretch between two consecutive pushes, and how many mainnet prints fell inside it. */
export interface MirrorGap {
  fromRound: bigint;
  toRound: bigint;
  from: bigint;
  to: bigint;
  seconds: bigint;
  /** Mainnet rounds published strictly between the two pushes (rounds the keeper did not mirror). */
  mainnetRoundsBetween: number;
}

export type MirrorCounts = Record<CheckedStatus, number>;

/** The audit of one MirrorFeed. */
export interface MirrorFeedAudit {
  symbol: string;
  testnetFeed: Address;
  /** The mainnet Chainlink proxy it copies; null when Chainlink has none (NFLX). */
  mainnetFeed: Address | null;
  testnetDecimals: number;
  mainnetDecimals: number | null;
  mainnetDescription: string | null;
  /** The feed's latest round, and the range audited. */
  latestRound: bigint;
  fromRound: bigint;
  toRound: bigint;
  rounds: MirrorRoundCheck[];
  /** Keeper rounds by status (the deploy seed and unchecked rounds are not counted). */
  counts: MirrorCounts;
  /** The deploy-time seed round, when the audited range includes it. */
  seed: MirrorRoundCheck | null;
  /** Mainnet prints between the first and the last audited push (inclusive), and how many were mirrored. */
  mainnetRoundsInWindow: number;
  /** Mainnet prints after the last audited push (published, not mirrored yet). */
  mainnetRoundsAfterLastPush: number;
  largestGap: MirrorGap | null;
  /** Why the feed could not be checked (no mainnet feed, decimals differ); its rounds are not counted. */
  unverifiable: string | null;
}

/** The audit of every MirrorFeed (or one symbol's) on a testnet. */
export interface MirrorAudit {
  chainId: number;
  mainnetChainId: number;
  /** Mainnet head when the audit ran: no genuine round can be later. */
  mainnetBlock: bigint;
  mainnetTime: bigint;
  testnetBlock: bigint;
  testnetTime: bigint;
  feeds: MirrorFeedAudit[];
  summary: {
    /** Rounds checked (feeds with a mainnet counterpart only). */
    rounds: number;
    matched: number;
    mismatched: number;
    counts: MirrorCounts;
    /** Feeds that could not be checked, with their round count. */
    unverifiable: { symbol: string; rounds: number; reason: string }[];
    /** Deploy-time seed rounds (round 1 of a feed, from Deploy.s.sol), listed apart from the keeper's rounds. */
    seeds: { symbol: string; roundId: bigint; answer: bigint; updatedAt: bigint }[];
    /** The longest gap between pushes over all feeds. */
    largestGap: (MirrorGap & { symbol: string }) | null;
  };
  /**
   * What each deployment's StockOracle reads for each listed token (`feedConfig(token).feed`), against the MirrorFeed
   * the deployment record names and this audit checks. Empty when the audit was given its own `feeds`.
   */
  oracleFeeds: OracleFeedCheck[];
  /**
   * Which StockOracle each deployment's EpochManager reads (`oracle()`), against the one the deployment record names
   * (an admin's `setOracle` to another contract would show here). Empty when the audit was given its own `feeds`.
   */
  managerOracles: ManagerOracleCheck[];
  /** Every checked round matched, and every EpochManager and oracle reads what was audited. */
  ok: boolean;
}

/** One deployment: the StockOracle its EpochManager reads, against the one the deployment record names. */
export interface ManagerOracleCheck {
  version: string | null;
  epochManager: Address;
  /** `EpochManager.oracle()`; null when it could not be read. */
  oracle: Address | null;
  expected: Address;
  same: boolean;
}

/** One token of one deployment: the feed its StockOracle reads, against the one the deployment record names. */
export interface OracleFeedCheck {
  version: string | null;
  stockOracle: Address;
  symbol: string;
  token: Address;
  /** `StockOracle.feedConfig(token).feed`; null when it could not be read. */
  feed: Address | null;
  expected: Address;
  same: boolean;
}

/** A MirrorFeed to audit and the mainnet proxy it copies. */
export interface MirrorFeedTarget {
  symbol: string;
  testnetFeed: Address;
  mainnetFeed: Address | null;
  /** Block to start the AnswerUpdated log scan from (the deployment block). */
  fromBlock?: bigint;
  /** Deploy.s.sol's seed price for this feed's round 1 (default from {@link DEPLOY_SEED_PRICES}). */
  seedPrice?: bigint;
}

type Env = Record<string, string | undefined>;
const processEnv = (): Env => (globalThis as { process?: { env?: Env } }).process?.env ?? {};

export interface MirrorClientOptions {
  /** Read the testnet through this client instead of the SDK's RPC transport. */
  testnetClient?: PublicClient;
  /** Read Robinhood Chain mainnet through this client. */
  mainnetClient?: PublicClient;
  /** Environment for the RPC transport (ALCHEMY_API_KEY, STRIKE_RPC_URL). Default: process.env. */
  env?: Env;
  /** Multicall3 address (default {@link MULTICALL3}). Reads fall back to single calls when it is absent. */
  multicallAddress?: Address;
  /** Rounds per multicall (default 150). */
  batchSize?: number;
  /** Attempts per read batch on an RPC error, with exponential backoff (default 4). */
  attempts?: number;
  /** Base backoff in ms (default 750). */
  backoffMs?: number;
}

export interface MirrorAuditOptions extends MirrorClientOptions {
  /** The testnet: 46630 (Robinhood Chain testnet) or 421614 (Arbitrum Sepolia). */
  chainId: number;
  /** One symbol (TSLA); default every MirrorFeed of the chain's deployments. */
  symbol?: string;
  /** First and last round to audit (default 1 and the latest). */
  fromRound?: bigint | number;
  toRound?: bigint | number;
  /** Only rounds published at or after this unix time. */
  since?: bigint | number;
  /** Only the last N rounds of each feed. */
  lastRounds?: number;
  /** Look up each push's transaction in the feed's logs (one eth_getLogs per feed). Default true. */
  pushTxs?: boolean;
  /** Audit these feeds instead of the chain's deployment records. */
  feeds?: MirrorFeedTarget[];
}

// ------------------------------------------------------------------ clients and reads

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry an RPC read with exponential backoff (rate limits: the mainnet public RPC answers 403 under load). */
async function withRetry<T>(fn: () => Promise<T>, attempts: number, backoffMs: number): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (i < attempts - 1) await sleep(backoffMs * 2 ** i);
    }
  }
  throw last;
}

/**
 * The RPC endpoints for reading `chainId`: the SDK's (Alchemy when ALCHEMY_API_KEY is set, then STRIKE_RPC_URL for
 * the testnet, then the public RPC), plus the chain's other public RPCs as further fallbacks (Robinhood Chain mainnet
 * has two). STRIKE_RPC_URL is the testnet's: it is not used for mainnet.
 */
export function mirrorRpcEndpoints(chainId: number, env: Env = processEnv()): RpcEndpoint[] {
  const ownEnv = chainId === MAINNET_FEEDS_CHAIN_ID ? { ...env, STRIKE_RPC_URL: undefined } : env;
  const out = rpcEndpointsFor(chainId, ownEnv);
  if (out.length === 1 && out[0]!.provider === "custom") return out; // a local devnet or fork
  let extra: readonly string[] = [];
  try {
    extra = getStrikeChain(chainId).rpcUrls.default.http;
  } catch {
    extra = [];
  }
  for (const url of extra) if (!out.some((e) => e.url === url)) out.push({ provider: "public", url });
  return out;
}

function clientFor(chainId: number, env: Env): PublicClient {
  const transport: Transport = transportFromEndpoints(mirrorRpcEndpoints(chainId, env), {
    retryCount: 3,
    retryDelay: 400,
    timeout: 20_000,
  });
  return createPublicClient({ chain: getStrikeChain(chainId), transport }) as PublicClient;
}

interface Reader {
  client: PublicClient;
  multicall: Address;
  batch: number;
  attempts: number;
  backoff: number;
  /** Set once multicall turned out to be unavailable on this chain. */
  noMulticall?: boolean;
}

function reader(client: PublicClient, o: MirrorClientOptions): Reader {
  return {
    client,
    multicall: o.multicallAddress ?? MULTICALL3,
    batch: o.batchSize ?? 150,
    attempts: o.attempts ?? 4,
    backoff: o.backoffMs ?? 750,
  };
}

type RoundTuple = readonly [bigint, bigint, bigint, bigint, bigint];

/** getRoundData for many ids: null for a round the feed does not have (a revert, or zeros as Chainlink returns). */
async function readRounds(r: Reader, feed: Address, ids: readonly bigint[]): Promise<(FeedRound | null)[]> {
  const out: (FeedRound | null)[] = [];
  const asRound = (id: bigint, t: RoundTuple | undefined): FeedRound | null =>
    t === undefined || t[3] === 0n ? null : { roundId: id, answer: t[1], updatedAt: t[3] };
  for (let i = 0; i < ids.length; i += r.batch) {
    const chunk = ids.slice(i, i + r.batch);
    const contracts = chunk.map((id) => ({
      address: feed,
      abi: aggregatorProxyAbi,
      functionName: "getRoundData" as const,
      args: [id] as const,
    }));
    let results: (FeedRound | null)[] | null = null;
    if (!r.noMulticall) {
      try {
        const res = await withRetry(
          async () => {
            const x = await r.client.multicall({
              contracts,
              allowFailure: true,
              multicallAddress: r.multicall,
            });
            // viem reports a failed aggregate call (a rate limit, no Multicall3 at the address) as every call
            // failing; the rounds read here exist (or read as zeros on a Chainlink proxy), so that is retried.
            if (x.length && x.every((y) => y.status === "failure")) {
              throw (x[0] as { error?: Error }).error ?? new Error("multicall failed");
            }
            return x;
          },
          r.attempts,
          r.backoff,
        );
        results = res.map((x, j) =>
          x.status === "success" ? asRound(chunk[j]!, x.result as RoundTuple) : null,
        );
      } catch {
        // No Multicall3 here (a bare devnet), or it kept failing: read one by one from now on.
        r.noMulticall = true;
      }
    }
    if (results === null) {
      results = [];
      for (const id of chunk) {
        results.push(
          await withRetry(
            async () => {
              try {
                const t = await r.client.readContract({
                  address: feed,
                  abi: aggregatorProxyAbi,
                  functionName: "getRoundData",
                  args: [id],
                });
                return asRound(id, t as RoundTuple);
              } catch (err) {
                if (isRevert(err)) return null;
                throw err;
              }
            },
            r.attempts,
            r.backoff,
          ),
        );
      }
    }
    out.push(...results);
  }
  return out;
}

/** A contract revert (the round does not exist), as opposed to a transport failure worth retrying. */
function isRevert(err: unknown): boolean {
  const text = `${(err as { name?: string })?.name ?? ""} ${(err as Error)?.message ?? ""}`;
  return /revert|ContractFunctionExecutionError|NoDataPresent/i.test(text);
}

async function read<T>(r: Reader, fn: () => Promise<T>): Promise<T> {
  return withRetry(fn, r.attempts, r.backoff);
}

async function headOf(r: Reader): Promise<{ block: bigint; time: bigint }> {
  const b = await read(r, () => r.client.getBlock({ blockTag: "latest" }));
  return { block: b.number ?? 0n, time: b.timestamp };
}

// ------------------------------------------------------------------ mainnet search

const toMainnet = (round: FeedRound): MainnetRound => ({
  roundId: round.roundId,
  phase: Number(round.roundId >> 64n),
  aggregatorRound: round.roundId & AGGREGATOR_MASK,
  answer: round.answer,
  updatedAt: round.updatedAt,
});

/**
 * The first aggregator round in [lo, hi] of `phase` with `updatedAt >= t`, or hi + 1 when there is none. Samples up
 * to 64 rounds per multicall and narrows the bracket, so a feed with thousands of rounds takes two or three calls.
 */
async function firstAtOrAfter(
  r: Reader,
  feed: Address,
  phase: bigint,
  lo: bigint,
  hi: bigint,
  t: bigint,
): Promise<bigint> {
  const base = phase << 64n;
  let a = lo;
  let b = hi + 1n; // the answer is in [a, b]
  while (a < b) {
    const span = b - a;
    const ids: bigint[] = [];
    if (span <= 64n) for (let x = a; x < b; x++) ids.push(x);
    else for (let k = 0n; k < 64n; k++) ids.push(a + (span * k) / 64n);
    const rounds = await readRounds(
      r,
      feed,
      ids.map((x) => base + x),
    );
    const i = rounds.findIndex((x) => x !== null && x.updatedAt >= t);
    if (span <= 64n) return i === -1 ? b : ids[i]!;
    if (i === -1) a = ids[ids.length - 1]! + 1n;
    else {
      b = ids[i]!;
      if (i > 0) a = ids[i - 1]! + 1n;
    }
  }
  return a;
}

/** The last aggregator round of an earlier phase (rounds are contiguous from 1): gallop, then bisect. */
async function lastRoundOfPhase(r: Reader, feed: Address, phase: bigint): Promise<bigint> {
  const base = phase << 64n;
  const exists = async (agg: bigint) => (await readRounds(r, feed, [base + agg]))[0] !== null;
  if (!(await exists(1n))) return 0n;
  let lo = 1n;
  let step = 1n;
  let hi = 0n;
  while (hi === 0n) {
    if (await exists(lo + step)) {
      lo += step;
      step *= 2n;
    } else hi = lo + step;
  }
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (await exists(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Every mainnet round with `updatedAt` in [from, to], oldest first, across phases (an aggregator upgrade starts a
 * new phase at aggregator round 1). Walks from the latest round's phase back as far as the window reaches.
 */
async function mainnetRoundsBetween(
  r: Reader,
  feed: Address,
  latest: FeedRound,
  from: bigint,
  to: bigint,
): Promise<MainnetRound[]> {
  const phases: MainnetRound[][] = [];
  let phase = latest.roundId >> 64n;
  let last = latest.roundId & AGGREGATOR_MASK;
  while (phase >= 0n && last >= 1n) {
    const start = await firstAtOrAfter(r, feed, phase, 1n, last, from);
    const found: MainnetRound[] = [];
    for (let a = start; a <= last; a += BigInt(r.batch)) {
      const end = a + BigInt(r.batch) - 1n < last ? a + BigInt(r.batch) - 1n : last;
      const ids: bigint[] = [];
      for (let x = a; x <= end; x++) ids.push((phase << 64n) + x);
      const rounds = await readRounds(r, feed, ids);
      let past = false;
      for (const round of rounds) {
        if (round === null) continue;
        if (round.updatedAt > to) {
          past = true;
          break;
        }
        found.push(toMainnet(round));
      }
      if (past) break;
    }
    phases.unshift(found);
    // Rounds before `start` in this phase predate the window, and so does every earlier phase.
    if (start > 1n || phase <= 1n) break;
    phase -= 1n;
    last = await lastRoundOfPhase(r, feed, phase);
  }
  return phases.flat();
}

// ------------------------------------------------------------------ classification (pure)

/** Classify testnet rounds against the mainnet rounds of their window. Pure: no I/O. */
export function classifyMirrorRounds(
  testnet: readonly { roundId: bigint; answer: bigint; updatedAt: bigint }[],
  mainnet: readonly MainnetRound[],
  mainnetTime: bigint,
): { status: CheckedStatus; mainnet: MainnetRound | null; nearest?: MirrorRoundCheck["nearest"] }[] {
  const byTime = new Map<bigint, MainnetRound[]>();
  for (const m of mainnet) byTime.set(m.updatedAt, [...(byTime.get(m.updatedAt) ?? []), m]);
  const sorted = [...mainnet].sort((a, b) =>
    a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0,
  );
  return testnet.map((t) => {
    if (t.updatedAt > mainnetTime) return { status: "future-timestamp" as const, mainnet: null };
    const same = byTime.get(t.updatedAt) ?? [];
    const exact = same.find((m) => m.answer === t.answer);
    if (exact) return { status: "match" as const, mainnet: exact };
    if (same.length) return { status: "answer-differs" as const, mainnet: same[0]! };
    let before: MainnetRound | null = null;
    let after: MainnetRound | null = null;
    for (const m of sorted) {
      if (m.updatedAt < t.updatedAt) before = m;
      else if (m.updatedAt > t.updatedAt) {
        after = m;
        break;
      }
    }
    return { status: "no-mainnet-round" as const, mainnet: null, nearest: { before, after } };
  });
}

/** The longest gap between consecutive pushes, with the mainnet prints that fell inside it. Pure. */
export function largestPushGap(
  rounds: readonly { roundId: bigint; updatedAt: bigint }[],
  mainnet: readonly { updatedAt: bigint }[],
): MirrorGap | null {
  let best: MirrorGap | null = null;
  for (let i = 1; i < rounds.length; i++) {
    const a = rounds[i - 1]!;
    const b = rounds[i]!;
    const seconds = b.updatedAt - a.updatedAt;
    if (best === null || seconds > best.seconds) {
      best = {
        fromRound: a.roundId,
        toRound: b.roundId,
        from: a.updatedAt,
        to: b.updatedAt,
        seconds,
        mainnetRoundsBetween: mainnet.filter((m) => m.updatedAt > a.updatedAt && m.updatedAt < b.updatedAt)
          .length,
      };
    }
  }
  return best;
}

const zeroCounts = (): MirrorCounts => ({
  match: 0,
  "no-mainnet-round": 0,
  "answer-differs": 0,
  "future-timestamp": 0,
});

// ------------------------------------------------------------------ the audit

/** The MirrorFeeds of a chain's deployments (shared feeds once), each with the mainnet proxy it copies. */
export function mirrorFeedTargets(chainId: number, symbol?: string): MirrorFeedTarget[] {
  const out = new Map<string, MirrorFeedTarget>();
  for (const d of deploymentsFor(chainId)) {
    for (const [sym, s] of Object.entries(d.stocks ?? {})) {
      if (symbol && sym.toUpperCase() !== symbol.toUpperCase()) continue;
      const key = s.feed.toLowerCase();
      const fromBlock = d.block !== undefined ? BigInt(d.block) : undefined;
      const prev = out.get(key);
      if (prev) {
        if (fromBlock !== undefined && (prev.fromBlock === undefined || fromBlock < prev.fromBlock))
          prev.fromBlock = fromBlock;
        continue;
      }
      out.set(key, {
        symbol: sym,
        testnetFeed: getAddress(s.feed),
        mainnetFeed: MAINNET_CHAINLINK_FEEDS[sym] ?? null,
        fromBlock,
      });
    }
  }
  return [...out.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

const big = (x: bigint | number | undefined): bigint | undefined => (x === undefined ? undefined : BigInt(x));

/** The push transaction of each round, from the feed's AnswerUpdated logs; an empty map when they cannot be read. */
async function pushTxs(
  r: Reader,
  feed: Address,
  fromBlock: bigint | undefined,
): Promise<Map<bigint, { tx: Hex; block: bigint }>> {
  const out = new Map<bigint, { tx: Hex; block: bigint }>();
  try {
    const logs = await read(r, () =>
      r.client.getContractEvents({
        address: feed,
        abi: mirrorFeedAbi,
        eventName: "AnswerUpdated",
        fromBlock: fromBlock ?? 0n,
        toBlock: "latest",
      }),
    );
    for (const l of logs) {
      const id = (l.args as { roundId?: bigint }).roundId;
      if (id !== undefined && l.transactionHash)
        out.set(id, { tx: l.transactionHash, block: l.blockNumber ?? 0n });
    }
  } catch {
    // A provider that refuses the range: rows show no transaction.
  }
  return out;
}

interface Ctx {
  chainId: number;
  testnet: Reader;
  mainnet: Reader;
  testnetHead: { block: bigint; time: bigint };
  mainnetHead: { block: bigint; time: bigint };
}

async function contextFor(o: MirrorClientOptions & { chainId: number }): Promise<Ctx> {
  const env = o.env ?? processEnv();
  const testnet = reader(o.testnetClient ?? clientFor(o.chainId, env), o);
  const mainnet = reader(o.mainnetClient ?? clientFor(MAINNET_FEEDS_CHAIN_ID, env), o);
  const testnetHead = await headOf(testnet);
  return { chainId: o.chainId, testnet, mainnet, testnetHead, mainnetHead: { block: 0n, time: 0n } };
}

/** Audit one feed. `mainnetHead` is read after the testnet rounds, so a genuine push can never be later than it. */
async function auditFeed(
  ctx: Ctx,
  target: MirrorFeedTarget,
  o: Pick<MirrorAuditOptions, "fromRound" | "toRound" | "since" | "lastRounds" | "pushTxs">,
): Promise<MirrorFeedAudit> {
  const t = ctx.testnet;
  const feed = target.testnetFeed;
  const [latestRound, testnetDecimals] = await Promise.all([
    read(t, () => t.client.readContract({ address: feed, abi: mirrorFeedAbi, functionName: "latestRound" })),
    read(t, () => t.client.readContract({ address: feed, abi: mirrorFeedAbi, functionName: "decimals" })),
  ]);
  let fromRound = big(o.fromRound) ?? 1n;
  let toRound = big(o.toRound) ?? latestRound;
  if (toRound > latestRound) toRound = latestRound;
  if (o.lastRounds !== undefined && o.lastRounds > 0) {
    const first = toRound - BigInt(o.lastRounds) + 1n;
    if (first > fromRound) fromRound = first;
  }
  if (fromRound < 1n) fromRound = 1n;
  const ids: bigint[] = [];
  for (let x = fromRound; x <= toRound; x++) ids.push(x);
  const [raw, txs] = await Promise.all([
    readRounds(t, feed, ids),
    o.pushTxs === false ? Promise.resolve(new Map()) : pushTxs(t, feed, target.fromBlock),
  ]);
  const since = big(o.since);
  const testnetRounds = raw.filter(
    (x): x is FeedRound => x !== null && (since === undefined || x.updatedAt >= since),
  );

  const base: Omit<MirrorFeedAudit, "rounds" | "counts" | "unverifiable" | "seed"> = {
    symbol: target.symbol,
    testnetFeed: feed,
    mainnetFeed: target.mainnetFeed,
    testnetDecimals: Number(testnetDecimals),
    mainnetDecimals: null,
    mainnetDescription: null,
    latestRound,
    fromRound,
    toRound,
    mainnetRoundsInWindow: 0,
    mainnetRoundsAfterLastPush: 0,
    largestGap: null,
  };
  const bare = (): MirrorRoundCheck[] =>
    testnetRounds.map((x) => ({
      roundId: x.roundId,
      answer: x.answer,
      updatedAt: x.updatedAt,
      pushTx: txs.get(x.roundId)?.tx ?? null,
      pushBlock: txs.get(x.roundId)?.block ?? null,
      status: "unchecked",
      mainnet: null,
    }));
  if (!target.mainnetFeed) {
    return {
      ...base,
      rounds: bare(),
      counts: zeroCounts(),
      seed: null,
      unverifiable: `Chainlink publishes no ${target.symbol} feed on Robinhood Chain mainnet`,
    };
  }

  const m = ctx.mainnet;
  const mf = target.mainnetFeed;
  const [latestTuple, mainnetDecimals, mainnetDescription] = await Promise.all([
    read(m, () =>
      m.client.readContract({ address: mf, abi: aggregatorProxyAbi, functionName: "latestRoundData" }),
    ),
    read(m, () => m.client.readContract({ address: mf, abi: aggregatorProxyAbi, functionName: "decimals" })),
    read(m, () =>
      m.client.readContract({ address: mf, abi: aggregatorProxyAbi, functionName: "description" }),
    ),
  ]);
  // The head is read after the testnet rounds and the mainnet feed's latest round.
  if (ctx.mainnetHead.time === 0n) ctx.mainnetHead = await headOf(m);
  const latest: FeedRound = { roundId: latestTuple[0], answer: latestTuple[1], updatedAt: latestTuple[3] };
  const withMainnet = { ...base, mainnetDecimals: Number(mainnetDecimals), mainnetDescription };
  if (Number(mainnetDecimals) !== Number(testnetDecimals)) {
    return {
      ...withMainnet,
      rounds: bare(),
      counts: zeroCounts(),
      seed: null,
      unverifiable: `decimals differ (testnet ${testnetDecimals}, mainnet ${mainnetDecimals}): answers cannot be compared`,
    };
  }

  const inPast = testnetRounds.filter((x) => x.updatedAt <= ctx.mainnetHead.time);
  let mainnetRounds: MainnetRound[] = [];
  if (inPast.length) {
    const from = inPast.reduce((a, x) => (x.updatedAt < a ? x.updatedAt : a), inPast[0]!.updatedAt);
    const lastPush = inPast.reduce((a, x) => (x.updatedAt > a ? x.updatedAt : a), 0n);
    const to = latest.updatedAt > lastPush ? latest.updatedAt : lastPush;
    mainnetRounds = await mainnetRoundsBetween(m, mf, latest, from, to);
  }
  const verdicts = classifyMirrorRounds(testnetRounds, mainnetRounds, ctx.mainnetHead.time);
  const seedPrice = target.seedPrice ?? DEPLOY_SEED_PRICES[ctx.chainId]?.[target.symbol];
  const rounds: MirrorRoundCheck[] = testnetRounds.map((x, i) => {
    const v = verdicts[i]!;
    const isSeed = v.status === "no-mainnet-round" && x.roundId === 1n && x.answer === seedPrice;
    return {
      roundId: x.roundId,
      answer: x.answer,
      updatedAt: x.updatedAt,
      pushTx: txs.get(x.roundId)?.tx ?? null,
      pushBlock: txs.get(x.roundId)?.block ?? null,
      ...v,
      status: isSeed ? "deploy-seed" : v.status,
    };
  });
  const counts = zeroCounts();
  for (const r of rounds) if (r.status !== "unchecked" && r.status !== "deploy-seed") counts[r.status]++;
  // Gaps and coverage are about the keeper: the deploy seed is left out.
  const keeper = rounds.filter((r) => r.status !== "deploy-seed");
  const first = keeper[0]?.updatedAt;
  const last = keeper[keeper.length - 1]?.updatedAt;
  return {
    ...withMainnet,
    rounds,
    counts,
    seed: rounds.find((r) => r.status === "deploy-seed") ?? null,
    mainnetRoundsInWindow:
      first === undefined || last === undefined
        ? 0
        : mainnetRounds.filter((x) => x.updatedAt >= first && x.updatedAt <= last).length,
    mainnetRoundsAfterLastPush:
      last === undefined ? 0 : mainnetRounds.filter((x) => x.updatedAt > last).length,
    largestGap: largestPushGap(keeper, mainnetRounds),
    unverifiable: null,
  };
}

/**
 * The feed each deployment's StockOracle actually reads for each listed token. The audit checks the MirrorFeeds the
 * deployment records name; this makes sure those are the ones settlement and sales read (an admin's `setFeed` to
 * another contract would show here).
 */
async function checkOracleFeeds(ctx: Ctx, chainId: number, symbol?: string): Promise<OracleFeedCheck[]> {
  const t = ctx.testnet;
  const out: OracleFeedCheck[] = [];
  for (const d of deploymentsFor(chainId)) {
    for (const [sym, s] of Object.entries(d.stocks ?? {})) {
      if (symbol && sym.toUpperCase() !== symbol.toUpperCase()) continue;
      let feed: Address | null = null;
      try {
        const cfg = (await read(t, () =>
          t.client.readContract({
            address: d.stockOracle,
            abi: stockOracleAbi,
            functionName: "feedConfig",
            args: [s.token],
          }),
        )) as { feed: Address };
        feed = getAddress(cfg.feed);
      } catch {
        feed = null;
      }
      out.push({
        version: d.version ?? null,
        stockOracle: getAddress(d.stockOracle),
        symbol: sym,
        token: getAddress(s.token),
        feed,
        expected: getAddress(s.feed),
        same: feed !== null && feed === getAddress(s.feed),
      });
    }
  }
  return out;
}

/** The StockOracle each deployment's EpochManager reads (`oracle()`), against the deployment record's. */
async function checkManagerOracles(ctx: Ctx, chainId: number): Promise<ManagerOracleCheck[]> {
  const t = ctx.testnet;
  const out: ManagerOracleCheck[] = [];
  for (const d of deploymentsFor(chainId)) {
    let oracle: Address | null = null;
    try {
      oracle = getAddress(
        (await read(t, () =>
          t.client.readContract({ address: d.epochManager, abi: epochManagerAbi, functionName: "oracle" }),
        )) as Address,
      );
    } catch {
      oracle = null;
    }
    out.push({
      version: d.version ?? null,
      epochManager: getAddress(d.epochManager),
      oracle,
      expected: getAddress(d.stockOracle),
      same: oracle !== null && oracle === getAddress(d.stockOracle),
    });
  }
  return out;
}

/** Run `fn` over `items`, at most `n` at a time, keeping order. */
async function mapLimit<T, U>(items: readonly T[], n: number, fn: (x: T) => Promise<U>): Promise<U[]> {
  const out: U[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/**
 * Check every round of a testnet's MirrorFeeds against Robinhood Chain mainnet Chainlink: for each round, the mainnet
 * round with the same `updatedAt` (searched across the proxy's phases) and the same answer. Read-only; no key. RPC
 * reads go through the SDK's transport (Alchemy when ALCHEMY_API_KEY is set, then the public RPCs), batched with
 * Multicall3 and retried with backoff.
 */
export async function auditMirror(opts: MirrorAuditOptions): Promise<MirrorAudit> {
  const targets = opts.feeds ?? mirrorFeedTargets(opts.chainId, opts.symbol);
  if (!targets.length) {
    throw new StrikeError(
      opts.symbol
        ? `no MirrorFeed for ${opts.symbol} on chain ${opts.chainId}`
        : `no MirrorFeeds on chain ${opts.chainId}`,
    );
  }
  const ctx = await contextFor(opts);
  const oracleFeeds = opts.feeds ? [] : await checkOracleFeeds(ctx, opts.chainId, opts.symbol);
  const managerOracles = opts.feeds ? [] : await checkManagerOracles(ctx, opts.chainId);
  // Two feeds at a time: the mainnet public RPC rate-limits bursts.
  const feeds = await mapLimit(targets, 2, (target) => auditFeed(ctx, target, opts));
  if (ctx.mainnetHead.time === 0n) ctx.mainnetHead = await headOf(ctx.mainnet);
  const counts = zeroCounts();
  let largestGap: MirrorAudit["summary"]["largestGap"] = null;
  const unverifiable: MirrorAudit["summary"]["unverifiable"] = [];
  const seeds: MirrorAudit["summary"]["seeds"] = [];
  for (const f of feeds) {
    if (f.seed)
      seeds.push({
        symbol: f.symbol,
        roundId: f.seed.roundId,
        answer: f.seed.answer,
        updatedAt: f.seed.updatedAt,
      });
    if (f.unverifiable) {
      unverifiable.push({ symbol: f.symbol, rounds: f.rounds.length, reason: f.unverifiable });
      continue;
    }
    for (const s of MIRROR_ROUND_STATUSES) counts[s] += f.counts[s];
    if (f.largestGap && (!largestGap || f.largestGap.seconds > largestGap.seconds))
      largestGap = { ...f.largestGap, symbol: f.symbol };
  }
  const rounds = MIRROR_ROUND_STATUSES.reduce((a, s) => a + counts[s], 0);
  return {
    chainId: opts.chainId,
    mainnetChainId: MAINNET_FEEDS_CHAIN_ID,
    mainnetBlock: ctx.mainnetHead.block,
    mainnetTime: ctx.mainnetHead.time,
    testnetBlock: ctx.testnetHead.block,
    testnetTime: ctx.testnetHead.time,
    feeds,
    oracleFeeds,
    managerOracles,
    summary: {
      rounds,
      matched: counts.match,
      mismatched: rounds - counts.match,
      counts,
      unverifiable,
      seeds,
      largestGap,
    },
    ok:
      rounds - counts.match === 0 && oracleFeeds.every((o) => o.same) && managerOracles.every((o) => o.same),
  };
}

// ------------------------------------------------------------------ settlement rounds

/** Where a series stands, as far as its settlement price goes. */
export type SettlementCheckStatus =
  /** Settled at a round that equals a mainnet Chainlink round. */
  | "verified"
  /** Settled (or about to be) at a round that does not equal a mainnet round, or the recorded price differs. */
  | "mismatch"
  /** Expired, not settled; the round settlement will use is on the feed and checked. */
  | "candidate-verified"
  /** Not settled; no round at or after expiry on the testnet feed yet. */
  | "not-printed"
  /** Settled without a price: no options were sold. */
  | "no-price"
  /** Cancelled: no settlement. */
  | "cancelled";

export interface SeriesSettlementCheck {
  seriesId: bigint;
  epoch: bigint | null;
  underlying: Address;
  symbol: string;
  expiry: bigint;
  settled: boolean;
  cancelled: boolean;
  sold: bigint;
  /** WAD; 0 until settled. */
  settlementPrice: bigint;
  /** The MirrorFeed the oracle reads for this token (StockOracle.feedConfig). */
  feed: Address;
  mainnetFeed: Address | null;
  /** The round settlement used (from SettlementPriceRecorded) or will use (the first round at or after expiry). */
  round: MirrorRoundCheck | null;
  roundSource: "recorded" | "candidate" | null;
  /** The SettlementPriceRecorded transaction. */
  recordTx: Hex | null;
  /** The recorded price equals the round's answer scaled to 18 decimals. */
  priceMatchesRound: boolean | null;
  /** The first mainnet print at or after expiry: what a settlement on mainnet would use. */
  firstMainnetAtOrAfterExpiry: MainnetRound | null;
  /** The testnet round is that same print (null until both exist). False means the keeper skipped earlier prints. */
  sameAsMainnetSettlement: boolean | null;
  /** Mainnet prints between expiry and the testnet round that the keeper did not mirror. */
  skippedMainnetRounds: number;
  status: SettlementCheckStatus;
  message: string;
}

export interface SettlementAudit {
  chainId: number;
  vault: Address;
  epochManager: Address;
  /** The StockOracle the EpochManager reads (`oracle()`), which settlement records the price through. */
  stockOracle: Address;
  /** The deployment record's StockOracle; settlement fails the audit when the two differ (an admin `setOracle`). */
  expectedStockOracle: Address;
  version: string | null;
  testnetTime: bigint;
  mainnetTime: bigint;
  series: SeriesSettlementCheck[];
  /** The EpochManager reads the recorded StockOracle and no series settled (or is about to) at a failing round. */
  ok: boolean;
}

export interface SettlementAuditOptions extends MirrorClientOptions {
  chainId: number;
  vault: Address;
}

const toWad = (answer: bigint, decimals: number): bigint =>
  decimals <= 18 ? answer * 10n ** BigInt(18 - decimals) : answer / 10n ** BigInt(decimals - 18);

function utc(t: bigint): string {
  return `${new Date(Number(t) * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function duration(s: bigint): string {
  const n = Number(s < 0n ? -s : s);
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

/**
 * The settlement round of each series a vault has sold, checked against mainnet Chainlink: the round recorded by
 * `StockOracle.SettlementPriceRecorded` for a settled series, or, before settlement, the round it will use (the first
 * MirrorFeed round at or after expiry, moved past an ERC-8056 corporate-action window as SafeStockFeed does). Also
 * says whether that round is the first mainnet print at or after expiry, which is what a mainnet settlement would use.
 */
export async function auditSettlement(opts: SettlementAuditOptions): Promise<SettlementAudit> {
  const ctx = await contextFor(opts);
  const t = ctx.testnet;
  const vault = getAddress(opts.vault);
  const manager = (await read(t, () =>
    t.client.readContract({ address: vault, abi: strikeVaultAbi, functionName: "manager" }),
  )) as Address;
  const dep: StrikeDeployment | null = deploymentForEpochManager(opts.chainId, manager);
  if (!dep)
    throw new StrikeError(`${vault} belongs to EpochManager ${manager}, not a known Strike deployment`);
  const fromBlock = dep.block !== undefined ? BigInt(dep.block) : 0n;

  const [proposed, epochState, managerOracle] = await Promise.all([
    read(t, () =>
      t.client.getContractEvents({
        address: dep.epochManager,
        abi: epochManagerAbi,
        eventName: "SeriesProposed",
        args: { vault },
        fromBlock,
        toBlock: "latest",
      }),
    ),
    read(t, () =>
      t.client.readContract({
        address: dep.epochManager,
        abi: epochManagerAbi,
        functionName: "epochs",
        args: [vault],
      }),
    ),
    read(t, () =>
      t.client.readContract({ address: dep.epochManager, abi: epochManagerAbi, functionName: "oracle" }),
    ),
  ]);
  // Settlement records the price through the oracle the EpochManager reads, so that is the one checked.
  const stockOracle = getAddress(managerOracle as Address);
  const seriesIds = new Map<bigint, bigint | null>();
  for (const l of proposed) {
    const a = l.args as { seriesId?: bigint; epoch?: bigint };
    if (a.seriesId !== undefined) seriesIds.set(a.seriesId, a.epoch ?? null);
  }
  const current = epochState[2];
  if (current !== 0n && !seriesIds.has(current)) seriesIds.set(current, null);

  const series: SeriesSettlementCheck[] = [];
  for (const [seriesId, epoch] of seriesIds) {
    const s = await read(t, () =>
      t.client.readContract({
        address: dep.epochManager,
        abi: epochManagerAbi,
        functionName: "getSeries",
        args: [seriesId],
      }),
    );
    series.push(await checkSeries(ctx, dep, stockOracle, seriesId, epoch, s, fromBlock));
  }
  series.sort((a, b) => (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : 0));
  if (ctx.mainnetHead.time === 0n) ctx.mainnetHead = await headOf(ctx.mainnet);
  return {
    chainId: opts.chainId,
    vault,
    epochManager: dep.epochManager,
    stockOracle,
    expectedStockOracle: getAddress(dep.stockOracle),
    version: dep.version ?? null,
    testnetTime: ctx.testnetHead.time,
    mainnetTime: ctx.mainnetHead.time,
    series,
    ok: stockOracle === getAddress(dep.stockOracle) && series.every((x) => x.status !== "mismatch"),
  };
}

type SeriesTuple = {
  underlying: Address;
  expiry: bigint;
  settled: boolean;
  cancelled: boolean;
  sold: bigint;
  settlementPrice: bigint;
};

async function checkSeries(
  ctx: Ctx,
  dep: StrikeDeployment,
  stockOracle: Address,
  seriesId: bigint,
  epoch: bigint | null,
  raw: unknown,
  fromBlock: bigint,
): Promise<SeriesSettlementCheck> {
  const t = ctx.testnet;
  const s = raw as SeriesTuple;
  const underlying = getAddress(s.underlying);
  const symbol =
    Object.entries(dep.stocks ?? {}).find(
      ([, v]) => v.token.toLowerCase() === underlying.toLowerCase(),
    )?.[0] ?? "?";
  const cfg = (await read(t, () =>
    t.client.readContract({
      address: stockOracle,
      abi: stockOracleAbi,
      functionName: "feedConfig",
      args: [underlying],
    }),
  )) as { feed: Address; corporateActionGrace: number | bigint; feedDecimals: number };
  const feed = getAddress(cfg.feed);
  const mainnetFeed = MAINNET_CHAINLINK_FEEDS[symbol] ?? null;
  const out: SeriesSettlementCheck = {
    seriesId,
    epoch,
    underlying,
    symbol,
    expiry: s.expiry,
    settled: s.settled,
    cancelled: s.cancelled,
    sold: s.sold,
    settlementPrice: s.settlementPrice,
    feed,
    mainnetFeed,
    round: null,
    roundSource: null,
    recordTx: null,
    priceMatchesRound: null,
    firstMainnetAtOrAfterExpiry: null,
    sameAsMainnetSettlement: null,
    skippedMainnetRounds: 0,
    status: "not-printed",
    message: "",
  };
  if (s.cancelled) return { ...out, status: "cancelled", message: "Cancelled: the series never settles." };
  if (s.settled && s.sold === 0n)
    return { ...out, status: "no-price", message: "Settled without a price: no options were sold." };

  // The round: recorded by the oracle, or the candidate.
  let roundId: bigint | null = null;
  if (s.settled) {
    const logs = await read(t, () =>
      t.client.getContractEvents({
        address: stockOracle,
        abi: stockOracleAbi,
        eventName: "SettlementPriceRecorded",
        args: { token: underlying, expiry: s.expiry },
        fromBlock,
        toBlock: "latest",
      }),
    );
    const log = logs[0];
    if (!log) {
      return {
        ...out,
        status: "mismatch",
        message: "Settled, but no SettlementPriceRecorded event was found for its token and expiry.",
      };
    }
    roundId = (log.args as { roundId: bigint }).roundId;
    out.recordTx = log.transactionHash ?? null;
    out.roundSource = "recorded";
  } else {
    if (ctx.testnetHead.time < s.expiry) {
      return {
        ...out,
        message: `Not settled yet; candidate round not yet printed (expires ${utc(s.expiry)}, in ${duration(s.expiry - ctx.testnetHead.time)}).`,
      };
    }
    const latestRound = await read(t, () =>
      t.client.readContract({ address: feed, abi: mirrorFeedAbi, functionName: "latestRoundData" }),
    );
    const latest: FeedRound = { roundId: latestRound[0], answer: latestRound[1], updatedAt: latestRound[3] };
    const getRound = async (id: bigint) => (await readRounds(t, feed, [id]))[0] ?? null;
    if (latest.updatedAt < s.expiry) {
      const pending = await firstMainnetAfter(ctx, mainnetFeed, s.expiry);
      return {
        ...out,
        firstMainnetAtOrAfterExpiry: pending,
        message:
          `Not settled yet; candidate round not yet printed (expired ${utc(s.expiry)}; the feed's latest round ` +
          `${latest.roundId} is from ${utc(latest.updatedAt)}).` +
          (pending
            ? ` Mainnet printed ${fmtAnswer(pending.answer, cfg.feedDecimals)} at ${utc(pending.updatedAt)}; the keeper has not mirrored it yet.`
            : " Mainnet has not printed after expiry either."),
      };
    }
    roundId = await findSettlementRound(latest, getRound, s.expiry);
    // SafeStockFeed: a print inside an ERC-8056 corporate-action window moves the target past the window.
    try {
      const at = await t.client.readContract({
        address: underlying,
        abi: effectiveAtAbi,
        functionName: "effectiveAt",
      });
      const grace = BigInt(cfg.corporateActionGrace);
      const first = await getRound(roundId);
      if (first && at !== 0n && first.updatedAt + grace > at && at + grace > first.updatedAt) {
        roundId = await findSettlementRound(latest, getRound, at + grace);
      }
    } catch {
      // a plain ERC-20: no corporate actions
    }
    out.roundSource = "candidate";
  }

  // Check that round against mainnet.
  const audit = await auditFeed(
    ctx,
    { symbol, testnetFeed: feed, mainnetFeed, fromBlock },
    { fromRound: roundId, toRound: roundId },
  );
  const round = audit.rounds[0] ?? null;
  out.round = round;
  if (round === null) return { ...out, status: "mismatch", message: `Round ${roundId} is not on the feed.` };
  if (s.settled) out.priceMatchesRound = s.settlementPrice === toWad(round.answer, cfg.feedDecimals);
  const firstMainnet = await firstMainnetAfter(ctx, mainnetFeed, s.expiry);
  out.firstMainnetAtOrAfterExpiry = firstMainnet;
  if (firstMainnet && round.mainnet) {
    out.sameAsMainnetSettlement = firstMainnet.roundId === round.mainnet.roundId;
    out.skippedMainnetRounds =
      firstMainnet.phase === round.mainnet.phase
        ? Number(round.mainnet.aggregatorRound - firstMainnet.aggregatorRound)
        : 0;
  }
  const price = fmtAnswer(round.answer, cfg.feedDecimals);
  const where = `round ${round.roundId} (${price} at ${utc(round.updatedAt)})`;
  if (audit.unverifiable) {
    return { ...out, status: "mismatch", message: `${where}: cannot be checked: ${audit.unverifiable}.` };
  }
  const verb = s.settled ? "Settled at" : "Expired, not settled yet; will settle at";
  if (round.status !== "match" || out.priceMatchesRound === false) {
    const why =
      out.priceMatchesRound === false
        ? "the recorded price is not that round's answer"
        : round.status === "answer-differs"
          ? `mainnet round ${round.mainnet?.roundId} at that time printed ${fmtAnswer(round.mainnet!.answer, cfg.feedDecimals)}`
          : round.status === "future-timestamp"
            ? "its timestamp is later than mainnet's head"
            : "mainnet Chainlink printed no round at that time";
    return { ...out, status: "mismatch", message: `${verb} ${where}: MISMATCH, ${why}.` };
  }
  const m = round.mainnet!;
  const same =
    out.sameAsMainnetSettlement === false
      ? ` Not the first mainnet print after expiry: mainnet printed ${out.skippedMainnetRounds} earlier round(s) from ${utc(firstMainnet!.updatedAt)} that the keeper did not mirror.`
      : out.sameAsMainnetSettlement
        ? " It is the first mainnet print at or after expiry, the round a mainnet settlement would use."
        : "";
  return {
    ...out,
    status: s.settled ? "verified" : "candidate-verified",
    message: `${verb} ${where}: equals mainnet Chainlink round ${m.roundId} (phase ${m.phase}, aggregator round ${m.aggregatorRound}).${same}`,
  };
}

/** The first mainnet round at or after `t` (searching earlier phases when needed), or null if none yet. */
async function firstMainnetAfter(
  ctx: Ctx,
  mainnetFeed: Address | null,
  t: bigint,
): Promise<MainnetRound | null> {
  if (!mainnetFeed) return null;
  const m = ctx.mainnet;
  const latest = await read(m, () =>
    m.client.readContract({ address: mainnetFeed, abi: aggregatorProxyAbi, functionName: "latestRoundData" }),
  );
  if (latest[3] < t) return null;
  let phase = latest[0] >> 64n;
  let last = latest[0] & AGGREGATOR_MASK;
  let best: bigint | null = null;
  while (last >= 1n) {
    const a = await firstAtOrAfter(m, mainnetFeed, phase, 1n, last, t);
    if (a <= last) best = (phase << 64n) + a;
    if (a > 1n || phase <= 1n) break;
    phase -= 1n;
    last = await lastRoundOfPhase(m, mainnetFeed, phase);
  }
  if (best === null) return null;
  const round = (await readRounds(m, mainnetFeed, [best]))[0];
  return round ? toMainnet(round) : null;
}

/** An answer with its feed decimals, as "443.21". */
export function fmtAnswer(answer: bigint, decimals: number): string {
  const neg = answer < 0n;
  const a = neg ? -answer : answer;
  const d = 10n ** BigInt(decimals);
  const frac = (a % d).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${a / d}${frac ? `.${frac}` : ""}`;
}
