import "server-only";
import {
  aggregatorProxyAbi,
  epochManagerAbi,
  getStrikeChain,
  MAINNET_FEEDS_CHAIN_ID,
  marketCalendarAbi,
  mirrorFeedTargets,
  mirrorRpcEndpoints,
  stockOracleAbi,
  strikeVaultAbi,
  transportFromEndpoints,
} from "@strike/sdk";
import { createPublicClient, formatUnits, type Address, type PublicClient } from "viem";
import { scanLogs } from "./activity";
import { getAppChain, type AppChainId } from "./chains";
import { REPO_SLUG } from "./config";
import { chainDeployments, deploymentVersion, fromBlock, type Deployment } from "./deployment";
import { MIRROR_CHAINS, MIRROR_CHAIN_NAMES, formatAnswer, type MirrorChainId } from "./mirrorAudit";
import { getSeries, vaultAddresses } from "./reads";
import { serverReadTransport } from "./rpc/server";
import {
  SCHEDULES,
  scheduleState,
  type ChainStatusJson,
  type DeploymentStatusJson,
  type FeedStatusJson,
  type ScheduleStatusJson,
  type SettlementRefJson,
  type StatusJson,
} from "./status";
import { USAGE_MAX_RANGE } from "./usage/scan";

// Server side of the liveness card: per testnet, each MirrorFeed's latest round against the Robinhood Chain mainnet
// Chainlink print it copies, each deployment's vaults (epoch state, next expiry, last settlement with its
// transaction) and, from GitHub, whether the keeper and weekly-agent schedules are switched on. /api/status serves
// `readStatus()`; the CDN keeps the answer, so visitors never trigger these reads themselves.

/** How long an instance reuses a computed answer (the route's s-maxage matches). */
export const STATUS_TTL_MS = 5 * 60_000;
/** GitHub's run lists are cached longer: 60 unauthenticated requests an hour per IP. A failure is retried sooner. */
const GITHUB_TTL_MS = 10 * 60_000;
const GITHUB_ERROR_TTL_MS = 2 * 60_000;

const short = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).split("\n")[0]!.slice(0, 200);
const usd = (wad: bigint) =>
  `$${Number(formatUnits(wad, 18)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function mainnetClient(): PublicClient {
  return createPublicClient({
    chain: getStrikeChain(MAINNET_FEEDS_CHAIN_ID),
    transport: transportFromEndpoints(
      mirrorRpcEndpoints(MAINNET_FEEDS_CHAIN_ID, { ALCHEMY_API_KEY: process.env.ALCHEMY_API_KEY }),
      { retryCount: 2 },
    ),
  }) as PublicClient;
}

type Round = readonly [bigint, bigint, bigint, bigint, bigint];

/** Every MirrorFeed of the chain (shared feeds once) with its latest round and mainnet's latest print. */
async function readFeeds(
  client: PublicClient,
  mainnet: PublicClient,
  chainId: MirrorChainId,
  dep: Deployment,
  mainnetRounds: Map<string, Promise<Round | null>>,
): Promise<FeedStatusJson[]> {
  return Promise.all(
    mirrorFeedTargets(chainId).map(async (t): Promise<FeedStatusJson> => {
      const token = (dep.stocks as Record<string, { token: Address }> | undefined)?.[t.symbol]?.token;
      const base = {
        symbol: t.symbol,
        feed: t.testnetFeed,
        mainnetFeed: t.mainnetFeed,
      };
      try {
        let m: Promise<Round | null> | null = null;
        if (t.mainnetFeed) {
          const key = t.mainnetFeed.toLowerCase();
          if (!mainnetRounds.has(key)) {
            mainnetRounds.set(
              key,
              mainnet
                .readContract({
                  address: t.mainnetFeed,
                  abi: aggregatorProxyAbi,
                  functionName: "latestRoundData",
                })
                .catch(() => null),
            );
          }
          m = mainnetRounds.get(key)!;
        }
        const [round, decimals, cfg, mRound] = await Promise.all([
          client.readContract({
            address: t.testnetFeed,
            abi: aggregatorProxyAbi,
            functionName: "latestRoundData",
          }),
          client.readContract({ address: t.testnetFeed, abi: aggregatorProxyAbi, functionName: "decimals" }),
          token
            ? client
                .readContract({
                  address: dep.stockOracle,
                  abi: stockOracleAbi,
                  functionName: "feedConfig",
                  args: [token],
                })
                .catch(() => null)
            : Promise.resolve(null),
          m ?? Promise.resolve(null),
        ]);
        return {
          ...base,
          roundId: round[0].toString(),
          price: formatAnswer(round[1], decimals),
          updatedAt: Number(round[3]),
          maxPriceAge: cfg ? Number(cfg.maxPriceAge) : null,
          mainnet: mRound
            ? {
                roundId: mRound[0].toString(),
                price: formatAnswer(mRound[1], decimals),
                updatedAt: Number(mRound[3]),
              }
            : null,
          // The testnet's latest round is mainnet's latest print (the keeper copies updatedAt and answer as they are).
          mirrored: mRound ? round[3] >= mRound[3] : null,
        };
      } catch (err) {
        return {
          ...base,
          roundId: "",
          price: "",
          updatedAt: 0,
          maxPriceAge: null,
          mainnet: null,
          mirrored: null,
          error: short(err),
        };
      }
    }),
  );
}

/** Each vault's epoch state, the selling series' expiry and its last EpochSettled or EpochAborted. */
async function readDeployment(
  client: PublicClient,
  dep: Deployment,
  head: bigint,
): Promise<DeploymentStatusJson> {
  const em = { address: dep.epochManager, abi: epochManagerAbi } as const;
  const events = epochManagerAbi.filter(
    (x) => x.type === "event" && (x.name === "EpochSettled" || x.name === "EpochAborted"),
  );
  const [vaults, logs] = await Promise.all([
    vaultAddresses(client, dep),
    scanLogs({
      from: fromBlock(dep),
      to: head,
      maxRange: USAGE_MAX_RANGE,
      fetchLogs: (from, to) =>
        client.getLogs({ address: dep.epochManager, events, fromBlock: from, toBlock: to, strict: true }),
    }),
  ]);
  const lastOf = new Map<string, (typeof logs)[number]>();
  for (const l of logs) {
    const v = String((l.args as { vault?: string }).vault ?? "").toLowerCase();
    const prev = lastOf.get(v);
    if (
      !prev ||
      (l.blockNumber ?? 0n) > (prev.blockNumber ?? 0n) ||
      (l.blockNumber === prev.blockNumber && (l.logIndex ?? 0) > (prev.logIndex ?? 0))
    )
      lastOf.set(v, l);
  }
  const blocks = [
    ...new Set([...lastOf.values()].map((l) => l.blockNumber).filter((b): b is bigint => b !== null)),
  ];
  const times = new Map(
    await Promise.all(
      blocks.map(async (b) => [b, Number((await client.getBlock({ blockNumber: b })).timestamp)] as const),
    ),
  );

  const rows = await Promise.all(
    vaults.map(async (vault) => {
      const v = { address: vault, abi: strikeVaultAbi } as const;
      const [symbol, isCall, epoch, ep] = await Promise.all([
        client.readContract({ ...v, functionName: "symbol" }),
        client.readContract({ ...v, functionName: "isCall" }),
        client.readContract({ ...v, functionName: "currentEpoch" }),
        client.readContract({ ...em, functionName: "epochs", args: [vault] }),
      ]);
      const [state, , seriesId] = ep;
      const series = state === 2 && seriesId !== 0n ? await getSeries(client, dep, seriesId) : null;
      const l = lastOf.get(vault.toLowerCase());
      let lastSettlement: SettlementRefJson | null = null;
      if (l) {
        const a = l.args as { epoch?: bigint; settlementPrice?: bigint };
        lastSettlement = {
          epoch: String(a.epoch ?? ""),
          kind: l.eventName === "EpochSettled" ? "settled" : "aborted",
          tx: l.transactionHash ?? "",
          time: l.blockNumber !== null ? (times.get(l.blockNumber) ?? null) : null,
          price: a.settlementPrice ? usd(a.settlementPrice) : null,
        };
      }
      return {
        address: vault,
        symbol,
        isCall,
        state,
        epoch: epoch.toString(),
        expiry: series ? Number(series.expiry) : null,
        lastSettlement,
      };
    }),
  );
  return { version: deploymentVersion(dep) || "v?", epochManager: dep.epochManager, vaults: rows };
}

async function readChain(
  chainId: MirrorChainId,
  mainnet: PublicClient,
  mainnetRounds: Map<string, Promise<Round | null>>,
) {
  const chain = getAppChain(chainId as AppChainId);
  const deps = chainDeployments(chainId);
  const dep = deps[0];
  const out: ChainStatusJson = {
    chainId,
    chainName: MIRROR_CHAIN_NAMES[chainId],
    explorer: chain.blockExplorers?.default.url ?? "",
    blockTime: 0,
    tradingDay: null,
    marketOpen: null,
    feeds: [],
    deployments: [],
    errors: [],
  };
  if (!dep) return { ...out, errors: ["No Strike deployment on this chain"] };
  const client = createPublicClient({
    chain,
    transport: serverReadTransport(chainId as AppChainId, { retryCount: 2 }),
  }) as PublicClient;
  const block = await client.getBlock();
  out.blockTime = Number(block.timestamp);
  const today = BigInt(Math.floor(out.blockTime / 86_400));
  const [tradingDay, marketOpen, feeds, deployments] = await Promise.all([
    client
      .readContract({
        address: dep.marketCalendar,
        abi: marketCalendarAbi,
        functionName: "isTradingDay",
        args: [today],
      })
      .catch(() => null),
    client
      .readContract({ address: dep.stockOracle, abi: stockOracleAbi, functionName: "isMarketOpen" })
      .catch(() => null),
    readFeeds(client, mainnet, chainId, dep, mainnetRounds),
    Promise.allSettled(deps.map((d) => readDeployment(client, d, block.number))),
  ]);
  out.tradingDay = tradingDay;
  out.marketOpen = marketOpen;
  out.feeds = feeds;
  deployments.forEach((r, i) => {
    if (r.status === "fulfilled") out.deployments.push(r.value);
    else out.errors.push(`${deploymentVersion(deps[i]) || "v?"}: ${short(r.reason)}`);
  });
  return out;
}

// ------------------------------------------------------------------ GitHub

const githubCache = new Map<string, { at: number; ttl: number; runs: unknown[] | null; error?: string }>();

async function workflowRuns(workflow: string): Promise<{ runs: unknown[] | null; error?: string }> {
  const hit = githubCache.get(workflow);
  if (hit && Date.now() - hit.at < hit.ttl) return hit;
  let entry: { at: number; ttl: number; runs: unknown[] | null; error?: string };
  try {
    const token = process.env.GITHUB_TOKEN;
    const res = await fetch(
      `https://api.github.com/repos/${REPO_SLUG}/actions/workflows/${workflow}/runs?per_page=30`,
      {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "strike-options-status",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(10_000),
        cache: "no-store",
      },
    );
    if (!res.ok) {
      const limited = res.status === 403 || res.status === 429;
      entry = {
        at: Date.now(),
        ttl: GITHUB_ERROR_TTL_MS,
        runs: null,
        error: `HTTP ${res.status}${limited ? ", rate limit" : ""}`,
      };
    } else {
      const body = (await res.json()) as { workflow_runs?: unknown[] };
      entry = { at: Date.now(), ttl: GITHUB_TTL_MS, runs: body.workflow_runs ?? [] };
    }
  } catch (err) {
    entry = { at: Date.now(), ttl: GITHUB_ERROR_TTL_MS, runs: null, error: short(err) };
  }
  githubCache.set(workflow, entry);
  return entry;
}

async function readSchedules(): Promise<ScheduleStatusJson[]> {
  return Promise.all(
    SCHEDULES.map(async (s) => {
      const { runs, error } = await workflowRuns(s.workflow);
      return {
        name: s.name,
        ...scheduleState(s.workflow, runs as Parameters<typeof scheduleState>[1], error),
      };
    }),
  );
}

// ------------------------------------------------------------------ the answer

/** Read both testnets, mainnet's latest prints and the schedules. A chain whose reads fail carries `errors`. */
export async function computeStatus(): Promise<StatusJson> {
  const mainnet = mainnetClient();
  const mainnetRounds = new Map<string, Promise<Round | null>>();
  const [chains, schedules] = await Promise.all([
    Promise.all(
      MIRROR_CHAINS.map((id) =>
        readChain(id, mainnet, mainnetRounds).catch((err): ChainStatusJson => ({
          chainId: id,
          chainName: MIRROR_CHAIN_NAMES[id],
          explorer: getAppChain(id as AppChainId).blockExplorers?.default.url ?? "",
          blockTime: 0,
          tradingDay: null,
          marketOpen: null,
          feeds: [],
          deployments: [],
          errors: [short(err)],
        })),
      ),
    ),
    readSchedules(),
  ]);
  return { generatedAt: new Date().toISOString(), chains, schedules };
}

let cached: { at: number; value: StatusJson } | null = null;
let inflight: Promise<StatusJson> | null = null;

/** {@link computeStatus}, reused for {@link STATUS_TTL_MS}; concurrent callers share one read. */
export async function readStatus(): Promise<StatusJson> {
  if (cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.value;
  if (!inflight) {
    inflight = computeStatus()
      .then((value) => {
        // A chain that failed is retried after a minute instead of five.
        const partial = value.chains.some((c) => c.errors.length);
        cached = { at: Date.now() - (partial ? STATUS_TTL_MS - 60_000 : 0), value };
        return value;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}
