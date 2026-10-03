import "server-only";
import {
  agentRegistryAbi,
  epochManagerAbi,
  feeManagerAbi,
  mirrorFeedAbi,
  optionTokenAbi,
  stockOracleAbi,
  strikeVaultAbi,
} from "@strike/sdk";
import {
  createPublicClient,
  decodeEventLog,
  erc20Abi,
  getAddress,
  type Abi,
  type Address,
  type Log,
  type PublicClient,
} from "viem";
import { scanLogs } from "./activity";
import { CHAIN_META, getAppChain, type AppChainId } from "./chains";
import { chainDeployments, deploymentVersion, fromBlock, type Deployment } from "./deployment";
import {
  buildAgents,
  buildOptions,
  replayVault,
  sortActivity,
  totalsOf,
  units,
  valueSeries,
  type AgentInput,
  type LogSource,
  type OptionInput,
  type PLog,
  type PricePoint,
  type VaultInput,
  type VaultReplay,
  fromIndexer,
  type IndexerEvent,
} from "./portfolioLedger";
import { buildPortfolio, type ChainStatus, type HoldingInput, type PortfolioJson } from "./portfolioView";
import { marketStatus } from "./reads";
import { serverReadTransport } from "./rpc/server";
import { USAGE_MAX_RANGE, usageChainIds } from "./usage/scan";

// Server side of /app/portfolio and GET /api/portfolio: every Strike deployment's logs (from the indexer when
// STRIKE_INDEXER_URL is set, else one getLogs scan per contract group over the public RPC, shared by every address
// for a minute), today's state for the wallet in a few Multicall3 calls per deployment, then the pure arithmetic in
// portfolioLedger.ts. Block times are read only for the blocks the wallet's own rows need and kept for good.

export const LOGS_TTL_MS = 60_000;
export const PORTFOLIO_TTL_MS = 30_000;
const MULTICALL_BYTES = 24_000;

export class PortfolioInputError extends Error {}

export function parseAddress(param: string | null): Address {
  if (!param || !/^0x[0-9a-fA-F]{40}$/.test(param.trim()))
    throw new PortfolioInputError(`address must be a 0x address of 40 hex characters (got "${param ?? ""}")`);
  return getAddress(param.trim());
}

/* ================================================================ clients */

const clients = new Map<number, PublicClient>();
function clientFor(chainId: AppChainId): PublicClient {
  let c = clients.get(chainId);
  if (!c) {
    c = createPublicClient({
      chain: getAppChain(chainId),
      transport: serverReadTransport(chainId, { retryCount: 2, batch: { batchSize: 10, wait: 25 } }),
    }) as PublicClient;
    clients.set(chainId, c);
  }
  return c;
}

export const depKey = (chainId: number, dep: Deployment) => `${chainId}-${deploymentVersion(dep) || "v?"}`;

/* ================================================================ logs */

interface DepLogs {
  logs: PLog[];
  vaults: string[];
  source: "indexer" | "rpc";
}

const ABI: Record<LogSource, Abi> = {
  vault: strikeVaultAbi as Abi,
  epochManager: epochManagerAbi as Abi,
  agentRegistry: agentRegistryAbi as Abi,
  feeManager: feeManagerAbi as Abi,
  feed: mirrorFeedAbi as Abi,
};

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** The indexer's JSON encoding: bigints as decimal strings, addresses lower case. */
function toJson(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string") return ADDRESS.test(v) ? v.toLowerCase() : v;
  if (Array.isArray(v)) return v.map(toJson);
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, toJson(x)]));
  return v;
}

function decode(log: Log, source: LogSource, chainId: number, deployment: string): PLog | null {
  try {
    const d = decodeEventLog({ abi: ABI[source], data: log.data, topics: log.topics, strict: true });
    return {
      chainId,
      deployment,
      address: log.address.toLowerCase(),
      source,
      event: d.eventName ?? "",
      args: toJson(d.args ?? {}) as Record<string, unknown>,
      block: Number(log.blockNumber ?? 0n),
      logIndex: log.logIndex ?? 0,
      tx: log.transactionHash ?? "0x",
      time: null,
    };
  } catch {
    return null;
  }
}

function coreSources(dep: Deployment): Map<string, LogSource> {
  const m = new Map<string, LogSource>([
    [dep.epochManager.toLowerCase(), "epochManager"],
    [dep.agentRegistry.toLowerCase(), "agentRegistry"],
    [dep.feeManager.toLowerCase(), "feeManager"],
  ]);
  for (const { feed } of Object.values(dep.stocks)) m.set(feed.toLowerCase(), "feed");
  return m;
}

async function rpcScan(
  client: PublicClient,
  dep: Deployment,
  addresses: string[],
  head: bigint,
): Promise<Log[]> {
  if (!addresses.length) return [];
  return scanLogs<Log>({
    from: fromBlock(dep),
    to: head,
    maxRange: USAGE_MAX_RANGE,
    fetchLogs: (fromBlock, toBlock) =>
      client.getLogs({ address: addresses as Address[], fromBlock, toBlock }) as Promise<Log[]>,
  });
}

async function readLogsRpc(chainId: AppChainId, dep: Deployment): Promise<DepLogs> {
  const client = clientFor(chainId);
  const key = depKey(chainId, dep);
  const head = await client.getBlockNumber();
  const sources = coreSources(dep);
  const core = (await rpcScan(client, dep, [...sources.keys()], head)).flatMap((l) => {
    const d = decode(l, sources.get(l.address.toLowerCase())!, chainId, key);
    return d ? [d] : [];
  });
  const vaults = vaultList(dep, core);
  const vaultLogs = (await rpcScan(client, dep, vaults, head)).flatMap((l) => {
    const d = decode(l, "vault", chainId, key);
    return d ? [d] : [];
  });
  return { logs: [...core, ...vaultLogs], vaults, source: "rpc" };
}

function vaultList(dep: Deployment, core: PLog[]): string[] {
  const set = new Set<string>();
  for (const v of Object.values(dep.vaults ?? {}))
    if (typeof v === "string" && ADDRESS.test(v)) set.add(v.toLowerCase());
  for (const l of core)
    if (l.source === "epochManager" && l.event === "VaultRegistered")
      set.add(String(l.args.vault).toLowerCase());
  return [...set];
}

/** The indexer's /events for one deployment, every page (oldest pages last), as PLogs with their block times. */
async function readLogsIndexer(base: string, chainId: AppChainId, dep: Deployment): Promise<DepLogs> {
  const key = depKey(chainId, dep);
  const out: PLog[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 200; page++) {
    const url = new URL("/events", base);
    url.searchParams.set("deployment", key);
    url.searchParams.set("limit", "500");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`indexer ${res.status} for ${key}`);
    const body = (await res.json()) as { events: IndexerEvent[]; nextCursor: string | null };
    for (const e of body.events) {
      const p = fromIndexer(e, chainId, key);
      if (p) out.push(p);
    }
    cursor = body.nextCursor;
    if (!cursor) break;
  }
  // The indexer does not read the FeeManager: its logs (fees credited and claimed) come from the RPC.
  const client = clientFor(chainId);
  const head = await client.getBlockNumber();
  const fees = (await rpcScan(client, dep, [dep.feeManager.toLowerCase()], head)).flatMap((l) => {
    const d = decode(l, "feeManager", chainId, key);
    return d ? [d] : [];
  });
  const core = out.filter((l) => l.source !== "vault");
  return { logs: [...out, ...fees], vaults: vaultList(dep, core), source: "indexer" };
}

const logCache = new Map<string, { at: number; value: Promise<DepLogs> }>();

function depLogs(chainId: AppChainId, dep: Deployment): Promise<DepLogs> {
  const key = depKey(chainId, dep);
  const hit = logCache.get(key);
  if (hit && Date.now() - hit.at < LOGS_TTL_MS) return hit.value;
  const base = process.env.STRIKE_INDEXER_URL;
  const value = (base ? readLogsIndexer(base, chainId, dep) : readLogsRpc(chainId, dep)).catch((err) => {
    logCache.delete(key);
    throw err;
  });
  logCache.set(key, { at: Date.now(), value });
  return value;
}

/* ================================================================ block times */

const blockTimes = new Map<string, number>();

async function fillTimes(chainId: AppChainId, logs: PLog[]): Promise<void> {
  const client = clientFor(chainId);
  const need = [...new Set(logs.filter((l) => l.time === null).map((l) => l.block))].filter(
    (b) => !blockTimes.has(`${chainId}:${b}`),
  );
  // JSON-RPC batches of 10 (the transport's batch size), a few at a time, so the public RPC never sees a burst.
  for (let i = 0; i < need.length; i += 30) {
    const chunk = need.slice(i, i + 30);
    const blocks = await Promise.all(chunk.map((n) => client.getBlock({ blockNumber: BigInt(n) })));
    for (const b of blocks) blockTimes.set(`${chainId}:${Number(b.number)}`, Number(b.timestamp));
  }
  for (const l of logs) if (l.time === null) l.time = blockTimes.get(`${chainId}:${l.block}`) ?? null;
}

/* ================================================================ multicall */

interface Call {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

async function multicall(client: PublicClient, calls: Call[]): Promise<unknown[]> {
  if (!calls.length) return [];
  // A chain without Multicall3 (a fresh anvil devnet): the same reads one by one.
  if (!client.chain?.contracts?.multicall3) {
    const each = await Promise.allSettled(calls.map((c) => client.readContract(c as never)));
    return each.map((r) => (r.status === "fulfilled" ? r.value : undefined));
  }
  const res = await client.multicall({
    contracts: calls as never,
    allowFailure: true,
    batchSize: MULTICALL_BYTES,
  });
  return (res as { status: string; result?: unknown }[]).map((r) =>
    r.status === "success" ? r.result : undefined,
  );
}

const big = (x: unknown): bigint => (typeof x === "bigint" ? x : 0n);
const num = (x: unknown): number => (typeof x === "number" ? x : typeof x === "bigint" ? Number(x) : 0);

/* ================================================================ one deployment */

interface DepRead {
  vaults: { input: VaultInput; logs: PLog[]; manager: string }[];
  options: OptionInput[];
  optionRaw: Map<string, bigint>;
  agents: AgentInput[];
  holdings: HoldingInput[];
  logs: PLog[];
  source: "indexer" | "rpc";
  now: number;
}

async function readDeploymentFor(chainId: AppChainId, dep: Deployment, account: Address): Promise<DepRead> {
  const client = clientFor(chainId);
  const key = depKey(chainId, dep);
  const version = deploymentVersion(dep);
  const acct = account.toLowerCase();
  const [{ logs, vaults, source }, block] = await Promise.all([depLogs(chainId, dep), client.getBlock()]);
  const now = Number(block.timestamp);
  const em = { address: dep.epochManager, abi: epochManagerAbi as Abi };
  const reg = { address: dep.agentRegistry, abi: agentRegistryAbi as Abi };

  // 1. The wallet in every vault, the vaults' state, balances, feeds, the registry's size.
  const V = 18;
  const calls1: Call[] = [];
  for (const v of vaults) {
    const c = { address: v as Address, abi: strikeVaultAbi as Abi };
    calls1.push(
      { ...c, functionName: "symbol" },
      { ...c, functionName: "decimals" },
      { ...c, functionName: "isCall" },
      { ...c, functionName: "asset" },
      { ...c, functionName: "underlying" },
      { ...c, functionName: "totalAssets" },
      { ...c, functionName: "totalSupply" },
      { ...c, functionName: "currentEpoch" },
      { ...c, functionName: "lastProcessedEpoch" },
      { ...c, functionName: "locked" },
      { ...c, functionName: "balanceOf", args: [account] },
      { ...c, functionName: "pendingPremium", args: [account] },
      { ...c, functionName: "depositRequests", args: [account] },
      { ...c, functionName: "redeemRequests", args: [account] },
      { ...c, functionName: "claimableDepositShares", args: [account] },
      { ...c, functionName: "claimableRedeemAssets", args: [account] },
      { ...em, functionName: "epochs", args: [v] },
      { ...em, functionName: "vaultConfig", args: [v] },
    );
  }
  const stocks = Object.entries(dep.stocks);
  const usdg = { address: dep.usdg, abi: erc20Abi as Abi };
  const tail: Call[] = [
    { ...usdg, functionName: "decimals" },
    { ...usdg, functionName: "balanceOf", args: [account] },
    { ...reg, functionName: "agentCount" },
    ...stocks.flatMap(([, s]): Call[] => [
      { address: s.token, abi: erc20Abi as Abi, functionName: "balanceOf", args: [account] },
      { address: s.token, abi: erc20Abi as Abi, functionName: "decimals" },
      { address: s.feed, abi: mirrorFeedAbi as Abi, functionName: "decimals" },
      { address: s.feed, abi: mirrorFeedAbi as Abi, functionName: "latestRoundData" },
      { address: dep.stockOracle, abi: stockOracleAbi as Abi, functionName: "status", args: [s.token] },
      { ...em, functionName: "underlyings", args: [s.token] },
    ]),
  ];
  const r1 = await multicall(client, [...calls1, ...tail]);
  const t = r1.slice(vaults.length * V);
  const usdgDecimals = num(t[0]) || 6;
  const usdgBalance = big(t[1]);
  const agentCount = Number(big(t[2]));
  const stockInfo = new Map<
    string,
    {
      symbol: string;
      token: string;
      balance: bigint;
      decimals: number;
      feedDecimals: number;
      feedNow: number;
      spot: number;
      sigma: number | null;
      feed: string;
    }
  >();
  stocks.forEach(([symbol, s], i) => {
    const o = 3 + i * 6;
    const fd = num(t[o + 2]) || 8;
    const round = t[o + 3] as readonly unknown[] | undefined;
    const status = t[o + 4] as readonly unknown[] | undefined;
    const u = t[o + 5] as readonly unknown[] | undefined;
    stockInfo.set(s.token.toLowerCase(), {
      symbol,
      token: s.token.toLowerCase(),
      balance: big(t[o]),
      decimals: num(t[o + 1]) || 18,
      feedDecimals: fd,
      feedNow: round ? units(big(round[1]), fd) : 0,
      spot: status ? units(big(status[1]), 18) : 0,
      sigma: u && big(u[2]) > 0n ? units(big(u[2]), 18) : null,
      feed: s.feed.toLowerCase(),
    });
  });

  // Feed rounds per underlying, in the oracle's units (scaled by today's oracle price over today's feed answer, which
  // is 1 unless the token has an ERC-8056 multiplier).
  const prices = new Map<string, PricePoint[]>();
  for (const s of stockInfo.values()) {
    const k = s.feedNow > 0 && s.spot > 0 ? s.spot / s.feedNow : 1;
    const pts = logs
      .filter((l) => l.source === "feed" && l.address === s.feed && l.event === "AnswerUpdated")
      .map((l) => ({
        t: Number(l.args.updatedAt),
        price: units(BigInt(String(l.args.current)), s.feedDecimals) * k,
      }))
      .filter((p) => p.t > 0 && p.price > 0)
      .sort((a, b) => a.t - b.t);
    prices.set(s.token, pts);
  }

  // 2. Series of the live epochs, every series' option balance for the wallet, the agents.
  const seriesIds = [
    ...new Set(
      logs
        .filter((l) => l.source === "epochManager" && l.event === "SeriesProposed")
        .map((l) => String(l.args.seriesId)),
    ),
  ];
  const vaultRows = vaults.map((v, i) => {
    const r = r1.slice(i * V, i * V + V);
    const ep = r[16] as readonly unknown[] | undefined;
    const cfg = r[17] as { agentId?: bigint; mandate?: Record<string, number> } | undefined;
    return {
      vault: v,
      symbol: String(r[0] ?? "?"),
      decimals: num(r[1]) || 18,
      isCall: Boolean(r[2]),
      asset: String(r[3] ?? "").toLowerCase(),
      underlying: String(r[4] ?? "").toLowerCase(),
      totalAssets: big(r[5]),
      totalSupply: big(r[6]),
      currentEpoch: Number(big(r[7])),
      lastProcessedEpoch: Number(big(r[8])),
      locked: Boolean(r[9]),
      balance: big(r[10]),
      pendingPremium: big(r[11]),
      dr: (r[12] as readonly bigint[] | undefined) ?? [0n, 0n],
      rr: (r[13] as readonly bigint[] | undefined) ?? [0n, 0n],
      claimableDepositShares: big(r[14]),
      claimableRedeemAssets: big(r[15]),
      state: ep ? num(ep[0]) : 0,
      seriesId: ep ? big(ep[2]) : 0n,
      agentId: cfg?.agentId ?? 0n,
      mandate: cfg?.mandate ?? null,
      ok: r[0] !== undefined && r[5] !== undefined,
    };
  });
  const liveSeriesIds = vaultRows.filter((v) => v.seriesId > 0n).map((v) => v.seriesId);
  const calls2: Call[] = [
    ...liveSeriesIds.map((id): Call => ({ ...em, functionName: "getSeries", args: [id] })),
    ...(seriesIds.length
      ? [
          {
            address: dep.optionToken,
            abi: optionTokenAbi as Abi,
            functionName: "balanceOfBatch",
            args: [seriesIds.map(() => account), seriesIds.map((s) => BigInt(s))],
          },
        ]
      : []),
    ...Array.from({ length: agentCount }, (_, i): Call[] => [
      { ...reg, functionName: "getAgent", args: [BigInt(i + 1)] },
      { ...reg, functionName: "track", args: [BigInt(i + 1)] },
    ]).flat(),
  ];
  const r2 = await multicall(client, calls2);
  const liveSeries = new Map<string, Record<string, unknown>>();
  liveSeriesIds.forEach((id, i) => {
    if (r2[i]) liveSeries.set(id.toString(), r2[i] as Record<string, unknown>);
  });
  let o2 = liveSeriesIds.length;
  const balances = new Map<string, bigint>();
  if (seriesIds.length) {
    const b = (r2[o2] as readonly bigint[] | undefined) ?? [];
    seriesIds.forEach((s, i) => balances.set(s, b[i] ?? 0n));
    o2 += 1;
  }
  const agentsRaw = Array.from({ length: agentCount }, (_, i) => ({
    id: String(i + 1),
    a: r2[o2 + i * 2] as Record<string, unknown> | undefined,
    track: r2[o2 + i * 2 + 1] as readonly unknown[] | undefined,
  }));
  const mine = agentsRaw.filter(
    (g) =>
      g.a &&
      [g.a.owner, g.a.signer, g.a.payout].some((x) => typeof x === "string" && x.toLowerCase() === acct),
  );

  // 3. The option series the wallet holds or traded, and the fees its agents can claim.
  const traded = new Set(
    logs
      .filter(
        (l) =>
          l.source === "epochManager" &&
          ((l.event === "OptionsBought" && (l.args.recipient === acct || l.args.buyer === acct)) ||
            (l.event === "OptionsRedeemed" && l.args.holder === acct)),
      )
      .map((l) => String(l.args.seriesId)),
  );
  for (const [id, b] of balances) if (b > 0n) traded.add(id);
  const optionIds = [...traded];
  const calls3: Call[] = [
    ...optionIds.map((id): Call => ({ ...em, functionName: "getSeries", args: [BigInt(id)] })),
    ...mine.map((g): Call => ({
      address: dep.feeManager,
      abi: feeManagerAbi as Abi,
      functionName: "claimable",
      args: [g.a!.payout as Address],
    })),
  ];
  const r3 = await multicall(client, calls3);

  // Which vaults the wallet ever touched or holds now: only those need their block times.
  const touched = new Set<string>();
  const userKeys = ["owner", "account", "from", "to", "sender", "receiver"];
  for (const l of logs)
    if (l.source === "vault" && userKeys.some((k) => l.args[k] === acct)) touched.add(l.address);
  for (const v of vaultRows)
    if (
      v.balance > 0n ||
      v.pendingPremium > 0n ||
      v.dr[1]! > 0n ||
      v.rr[1]! > 0n ||
      v.claimableDepositShares > 0n ||
      v.claimableRedeemAssets > 0n
    )
      touched.add(v.vault);
  const needTimes = logs.filter(
    (l) =>
      (l.source === "vault" && touched.has(l.address)) ||
      (l.source === "epochManager" &&
        (touched.has(String(l.args.vault)) ||
          (traded.has(String(l.args.seriesId)) &&
            (l.event === "OptionsBought" || l.event === "OptionsRedeemed")))) ||
      ((l.source === "agentRegistry" || l.source === "feeManager") && mine.length > 0),
  );
  await fillTimes(chainId, needTimes);

  const vaultOut: DepRead["vaults"] = [];
  for (const v of vaultRows) {
    if (!v.ok || !touched.has(v.vault)) continue;
    const u = stockInfo.get(v.underlying);
    const s = v.seriesId > 0n ? liveSeries.get(v.seriesId.toString()) : undefined;
    const dU = u?.decimals ?? 18;
    const assetDecimals = v.isCall ? dU : usdgDecimals;
    vaultOut.push({
      manager: dep.epochManager.toLowerCase(),
      logs: logs.filter(
        (l) =>
          (l.source === "vault" && l.address === v.vault) ||
          (l.source === "epochManager" && String(l.args.vault) === v.vault),
      ),
      input: {
        chainId,
        deployment: key,
        version,
        vault: v.vault,
        symbol: v.symbol,
        isCall: v.isCall,
        underlying: u?.symbol ?? "?",
        assetSymbol: v.isCall ? (u?.symbol ?? "?") : "USDG",
        assetDecimals,
        shareDecimals: v.decimals,
        usdgDecimals,
        spot: u?.spot ?? 0,
        prices: prices.get(v.underlying) ?? [],
        sigma: u?.sigma ?? null,
        live: {
          totalAssets: v.totalAssets,
          totalSupply: v.totalSupply,
          balance: v.balance,
          pendingPremium: v.pendingPremium,
          depositRequest: { epoch: Number(v.dr[0] ?? 0n), amount: v.dr[1] ?? 0n },
          redeemRequest: { epoch: Number(v.rr[0] ?? 0n), amount: v.rr[1] ?? 0n },
          claimableDepositShares: v.claimableDepositShares,
          claimableRedeemAssets: v.claimableRedeemAssets,
          currentEpoch: v.currentEpoch,
          lastProcessedEpoch: v.lastProcessedEpoch,
          locked: v.locked,
          state: v.state,
          series: s
            ? {
                id: v.seriesId.toString(),
                strike: units(big(s.strike), 18),
                expiry: Number(big(s.expiry)),
                size: units(big(s.size), dU),
                sold: units(big(s.sold), dU),
                premium: units(big(s.premium), usdgDecimals),
                collateral: units(big(s.collateral), assetDecimals),
                settled: Boolean(s.settled),
                cancelled: Boolean(s.cancelled),
              }
            : null,
        },
      },
    });
  }

  const vaultByAddr = new Map(vaultRows.map((v) => [v.vault, v]));
  const options: OptionInput[] = [];
  const optionRaw = new Map<string, bigint>();
  optionIds.forEach((id, i) => {
    const s = r3[i] as Record<string, unknown> | undefined;
    if (!s) return;
    const vault = String(s.vault ?? "").toLowerCase();
    const v = vaultByAddr.get(vault);
    const u = stockInfo.get(String(s.underlying ?? "").toLowerCase());
    optionRaw.set(`${key}:${id}`, balances.get(id) ?? 0n);
    options.push({
      chainId,
      deployment: key,
      version,
      vault,
      symbol: v?.symbol ?? "?",
      underlying: u?.symbol ?? "?",
      isCall: Boolean(s.isCall),
      underlyingDecimals: u?.decimals ?? 18,
      usdgDecimals,
      spot: u?.spot ?? 0,
      series: {
        id,
        strike: units(big(s.strike), 18),
        expiry: Number(big(s.expiry)),
        settled: Boolean(s.settled),
        cancelled: Boolean(s.cancelled),
        payoutPerOption: big(s.payoutPerOption),
        settlementPrice: units(big(s.settlementPrice), 18),
        premium: big(s.premium),
        sold: big(s.sold),
      },
      balance: balances.get(id) ?? 0n,
    });
  });

  const agents: AgentInput[] = mine.map((g, i) => {
    const a = g.a!;
    return {
      chainId,
      deployment: key,
      version,
      registry: dep.agentRegistry.toLowerCase(),
      id: g.id,
      owner: String(a.owner).toLowerCase(),
      signer: String(a.signer).toLowerCase(),
      payout: String(a.payout).toLowerCase(),
      status: num(a.status),
      strikes: num(a.strikes),
      accepted: num(a.accepted),
      rejected: num(a.rejected),
      bond: units(big(a.bond), usdgDecimals),
      unbonding: units(big(a.unbonding), usdgDecimals),
      settledEpochs: g.track ? num(g.track[0]) : 0,
      cumulativePnl: g.track ? units(big(g.track[1]), usdgDecimals) : 0,
      feesClaimable: units(big(r3[optionIds.length + i]), usdgDecimals),
      usdgDecimals,
    };
  });

  // What the wallet could put to work: its stock tokens and USDG next to this deployment's vaults on them.
  const proposals = new Map<string, PLog>();
  for (const l of logs)
    if (l.source === "epochManager" && l.event === "SeriesProposed")
      proposals.set(String(l.args.seriesId), l);
  const holdings: HoldingInput[] = [];
  const held = [
    ...[...stockInfo.values()]
      .filter((s) => s.balance > 0n)
      .map((s) => ({ asset: s.symbol, token: s.token, amount: units(s.balance, s.decimals), spot: s.spot })),
    ...(usdgBalance > 0n
      ? [{ asset: "USDG", token: dep.usdg.toLowerCase(), amount: units(usdgBalance, usdgDecimals), spot: 1 }]
      : []),
  ];
  for (const h of held) {
    const fits = vaultRows.filter(
      (v) => v.ok && (h.asset === "USDG" ? !v.isCall : v.isCall && v.underlying === h.token),
    );
    holdings.push({
      chainId,
      deployment: key,
      version,
      asset: h.asset,
      amount: h.amount,
      usd: h.amount * h.spot,
      vaults: fits.map((v) => {
        const u = stockInfo.get(v.underlying);
        const s = v.seriesId > 0n ? liveSeries.get(v.seriesId.toString()) : undefined;
        const p = proposals.get(v.seriesId.toString());
        const dU = u?.decimals ?? 18;
        const assetDecimals = v.isCall ? dU : usdgDecimals;
        return {
          vault: v.vault,
          symbol: v.symbol,
          isCall: v.isCall,
          underlying: u?.symbol ?? "?",
          state: v.state,
          locked: v.locked,
          spot: u?.spot ?? 0,
          totalAssets: units(v.totalAssets, assetDecimals),
          mandate: v.mandate
            ? { maxDeltaBps: num(v.mandate.maxDeltaBps), maxShareSoldBps: num(v.mandate.maxShareSoldBps) }
            : null,
          series: s
            ? {
                id: v.seriesId.toString(),
                strike: units(big(s.strike), 18),
                expiry: Number(big(s.expiry)),
                size: units(big(s.size), dU),
                sold: units(big(s.sold), dU),
                premium: units(big(s.premium), usdgDecimals),
                fairValue: p ? units(BigInt(String(p.args.fairValue)), 18) : null,
                premiumBps: num(big(s.premiumBps ?? 0n)) || num(s.premiumBps),
                delta: p ? Math.abs(units(BigInt(String(p.args.delta)), 18)) : null,
                settled: Boolean(s.settled),
              }
            : null,
        };
      }),
    });
  }

  return {
    vaults: vaultOut,
    options,
    optionRaw,
    agents,
    holdings,
    logs,
    source,
    now,
  };
}

/* ================================================================ the wallet */

const nextOpenCache = new Map<number, { at: number; value: number | null }>();

/** The next NYSE session open from the chain's MarketCalendar (null while a session runs or when unreadable). */
async function nextOpen(chainId: AppChainId): Promise<number | null> {
  const hit = nextOpenCache.get(chainId);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value;
  const dep = chainDeployments(chainId)[0];
  if (!dep) return null;
  const value = await marketStatus(clientFor(chainId), dep)
    .then((m) => (m.open ? null : m.opensAt))
    .catch(() => null);
  nextOpenCache.set(chainId, { at: Date.now(), value });
  return value;
}

/** The chains read: the testnets with a Strike deployment, plus the local devnet when asked for (`?chain=31337`). */
export function portfolioChains(withDevnet = false): AppChainId[] {
  const ids = usageChainIds();
  return withDevnet && chainDeployments(31337).length ? [...ids, 31337] : ids;
}

export async function computePortfolio(account: Address, withDevnet = false): Promise<PortfolioJson> {
  const jobs = portfolioChains(withDevnet).flatMap((chainId) =>
    chainDeployments(chainId).map((dep) => ({ chainId, dep })),
  );
  const settled = await Promise.allSettled(jobs.map((j) => readDeploymentFor(j.chainId, j.dep, account)));
  const chains: ChainStatus[] = [];
  const reads: { chainId: AppChainId; read: DepRead }[] = [];
  settled.forEach((r, i) => {
    const j = jobs[i]!;
    const key = depKey(j.chainId, j.dep);
    if (r.status === "fulfilled") {
      reads.push({ chainId: j.chainId, read: r.value });
      chains.push({
        key,
        chainId: j.chainId,
        label: CHAIN_META[j.chainId].label,
        ok: true,
        source: r.value.source,
      });
    } else {
      const message = (r.reason instanceof Error ? r.reason.message : String(r.reason)).split("\n")[0]!;
      chains.push({ key, chainId: j.chainId, label: CHAIN_META[j.chainId].label, ok: false, error: message });
    }
  });
  if (!reads.length) throw new Error(chains[0]?.error ?? "No deployment could be read");

  const replays: VaultReplay[] = [];
  const optionInputs: OptionInput[] = [];
  const agentInputs: AgentInput[] = [];
  const allLogs: PLog[] = [];
  const holdings: HoldingInput[] = [];
  const optionRaw = new Map<string, bigint>();
  for (const { read } of reads) {
    for (const v of read.vaults) replays.push(replayVault(v.input, v.logs, account, read.now));
    optionInputs.push(...read.options);
    agentInputs.push(...read.agents);
    holdings.push(...read.holdings);
    for (const [k, b] of read.optionRaw) optionRaw.set(k, b);
    allLogs.push(...read.logs.filter((l) => l.source !== "vault" && l.source !== "feed"));
  }
  const now = Math.max(...reads.map((r) => r.read.now));
  const { options, activity: optionActivity } = buildOptions(
    optionInputs,
    allLogs.filter((l) => l.source === "epochManager"),
    account,
    now,
  );
  const agents = buildAgents(agentInputs, allLogs, account);
  const positions = replays.map((r) => r.position).filter((p) => p.touched);
  const totals = totalsOf(positions);
  const chart = valueSeries(replays, now, totals);
  const opens = await Promise.all(
    [...new Set(reads.map((r) => r.chainId))].map(async (id) => [id, await nextOpen(id)] as const),
  );

  return buildPortfolio({
    address: account,
    now,
    generatedAt: new Date().toISOString(),
    source: reads.every((r) => r.read.source === "indexer") ? "indexer" : "rpc",
    chains,
    positions,
    totals,
    chart,
    markers: replays.flatMap((r) => r.markers),
    activity: sortActivity([
      ...replays.flatMap((r) => r.activity),
      ...optionActivity,
      ...agentActivity(allLogs, agents, account),
    ]),
    options,
    optionRaw: Object.fromEntries([...optionRaw].map(([k, v]) => [k, v.toString()])),
    agents,
    holdings,
    nextOpen: Object.fromEntries(opens),
    managers: Object.fromEntries(
      jobs.map((j) => [depKey(j.chainId, j.dep), j.dep.epochManager.toLowerCase()]),
    ),
  });
}

function agentActivity(
  logs: PLog[],
  agents: ReturnType<typeof buildAgents>,
  account: string,
): ReturnType<typeof sortActivity> {
  const acct = account.toLowerCase();
  const rows: ReturnType<typeof sortActivity> = [];
  const ids = new Set(agents.map((a) => `${a.deployment}:${a.id}`));
  const payouts = new Set(agents.map((a) => `${a.deployment}:${a.payout}`));
  for (const l of logs) {
    const id = `${l.deployment}:${String(l.args.agentId ?? "")}`;
    let text: string | null = null;
    if (l.source === "agentRegistry") {
      if (l.event === "AgentRegistered" && l.args.owner === acct)
        text = `registered agent #${String(l.args.agentId)}${
          String(l.args.erc8004Id ?? "0") !== "0" ? ` (ERC-8004 identity ${String(l.args.erc8004Id)})` : ""
        }`;
      else if (l.event === "BondPosted" && ids.has(id))
        text = `bond posted for agent #${String(l.args.agentId)}: ${(Number(l.args.amount) / 1e6).toLocaleString("en-US")} USDG`;
      else if (l.event === "Slashed" && ids.has(id))
        text = `agent #${String(l.args.agentId)} slashed ${(Number(l.args.amount) / 1e6).toLocaleString("en-US")} USDG (strike ${String(l.args.strikes)})`;
    } else if (l.source === "feeManager") {
      if (l.event === "FeesCredited" && payouts.has(`${l.deployment}:${String(l.args.agent)}`))
        text = `fees credited to the agent's payout address: ${(Number(l.args.agentAmount) / 1e6).toLocaleString("en-US")} USDG`;
      else if (l.event === "Claimed" && l.args.account === acct)
        text = `claimed ${(Number(l.args.amount) / 1e6).toLocaleString("en-US")} USDG of fees`;
    }
    if (text)
      rows.push({
        chainId: l.chainId,
        deployment: l.deployment,
        version: l.deployment.split("-")[1] ?? "",
        vault: null,
        symbol: null,
        t: l.time,
        block: l.block,
        logIndex: l.logIndex,
        kind: "agent",
        text,
        tx: l.tx,
      });
  }
  return rows;
}

/* ================================================================ cache */

const cache = new Map<string, { at: number; value: Promise<PortfolioJson> }>();

/** {@link computePortfolio}, reused for {@link PORTFOLIO_TTL_MS}; concurrent callers share one read. */
export function readPortfolio(account: Address, withDevnet = false): Promise<PortfolioJson> {
  const key = `${account.toLowerCase()}:${withDevnet}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < PORTFOLIO_TTL_MS) return hit.value;
  if (cache.size > 500) cache.clear();
  const value = computePortfolio(account, withDevnet).catch((err) => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, { at: Date.now(), value });
  return value;
}
