import "server-only";
import {
  auditSettlement,
  decisionLogAbi,
  epochManagerAbi,
  stockOracleAbi,
  strikeVaultAbi,
} from "@strike/sdk";
import {
  createPublicClient,
  decodeEventLog,
  getAddress,
  type Abi,
  type Address,
  type Log,
  type PublicClient,
} from "viem";
import { scanLogs } from "./activity";
import { getAppChain, isAppChainId, RPC_OVERRIDES, type AppChainId } from "./chains";
import { chainDeployments, fromBlock } from "./deployment";
import { buildTrace, type EpochTraceJson, type TraceLog } from "./epochTrace";
import { isMirrorChain, type MirrorChainId } from "./mirrorAudit";
import { tokenInfo, vaultDeployment } from "./reads";
import { serverReadTransport } from "./rpc/server";
import { toSettlementAuditJson, type SettlementAuditJson } from "./settlementAudit";
import { USAGE_MAX_RANGE } from "./usage/scan";

// Server side of the vault page's epoch trace: one log scan over the vault's EpochManager, the vault itself, the
// StockOracle its EpochManager reads and its deployment's DecisionLog (the same scanLogs and decode as the usage
// counter in usage/scan.ts), then buildTrace (epochTrace.ts) keeps this vault's current and last epoch. Also the
// settlement check: the SDK's auditSettlement against Robinhood Chain mainnet Chainlink.

export const TRACE_TTL_MS = 60_000;
export const AUDIT_TTL_MS = 10 * 60_000;
const ERROR_TTL_MS = 30_000;

export class TraceInputError extends Error {}

/** `?chain=` and `?vault=` as a chain with a Strike deployment and an address, or a TraceInputError. */
export function parseTraceQuery(
  chain: string | null,
  vault: string | null,
): { chainId: AppChainId; vault: Address } {
  const id = chain && /^\d+$/.test(chain) ? Number(chain) : NaN;
  if (!isAppChainId(id) || chainDeployments(id).length === 0) {
    throw new TraceInputError(`chain must be a chain with a Strike deployment (got "${chain ?? ""}")`);
  }
  if (!vault || !/^0x[0-9a-fA-F]{40}$/.test(vault)) {
    throw new TraceInputError(`vault must be an address (got "${vault ?? ""}")`);
  }
  return { chainId: id, vault: getAddress(vault) };
}

const ABIS: Record<TraceLog["source"], Abi> = {
  epochManager: epochManagerAbi as Abi,
  vault: strikeVaultAbi as Abi,
  oracle: stockOracleAbi as Abi,
  decisionLog: decisionLogAbi as Abi,
};

/** Read and build one vault's trace. Throws TraceInputError when the address is not a vault of the chain. */
export async function computeTrace(chainId: AppChainId, vault: Address): Promise<EpochTraceJson> {
  const chain = getAppChain(chainId);
  const client = createPublicClient({
    chain,
    transport: serverReadTransport(chainId, { retryCount: 2 }),
  }) as PublicClient;
  const dep = await vaultDeployment(client, chainId, vault);
  if (!dep) throw new TraceInputError(`${vault} is not a Strike vault on chain ${chainId}`);
  const v = { address: vault, abi: strikeVaultAbi } as const;
  const [head, currentEpoch, isCall, underlyingAddr, assetAddr, shareDecimals, ep, oracle] =
    await Promise.all([
      client.getBlock(),
      client.readContract({ ...v, functionName: "currentEpoch" }),
      client.readContract({ ...v, functionName: "isCall" }),
      client.readContract({ ...v, functionName: "underlying" }),
      client.readContract({ ...v, functionName: "asset" }),
      client.readContract({ ...v, functionName: "decimals" }),
      client.readContract({
        address: dep.epochManager,
        abi: epochManagerAbi,
        functionName: "epochs",
        args: [vault],
      }),
      client.readContract({ address: dep.epochManager, abi: epochManagerAbi, functionName: "oracle" }),
    ]);
  const [underlying, asset, usdg] = await Promise.all([
    tokenInfo(client, underlyingAddr),
    tokenInfo(client, assetAddr),
    tokenInfo(client, dep.usdg),
  ]);

  const sources = new Map<string, TraceLog["source"]>([
    [dep.epochManager.toLowerCase(), "epochManager"],
    [vault.toLowerCase(), "vault"],
    [oracle.toLowerCase(), "oracle"],
  ]);
  if (dep.decisionLog) sources.set(dep.decisionLog.toLowerCase(), "decisionLog");
  const raw = await scanLogs<Log>({
    from: fromBlock(dep),
    to: head.number,
    maxRange: USAGE_MAX_RANGE,
    fetchLogs: (from, to) =>
      client.getLogs({ address: [...sources.keys()] as Address[], fromBlock: from, toBlock: to }) as Promise<
        Log[]
      >,
  });
  const decoded: TraceLog[] = [];
  for (const l of raw) {
    const source = sources.get(l.address.toLowerCase());
    if (!source) continue;
    try {
      const d = decodeEventLog({ abi: ABIS[source], data: l.data, topics: l.topics, strict: true });
      decoded.push({
        source,
        eventName: d.eventName ?? "",
        args: (d.args ?? {}) as Record<string, unknown>,
        tx: l.transactionHash ?? "",
        block: l.blockNumber ?? 0n,
        logIndex: l.logIndex ?? 0,
        time: null,
      });
    } catch {
      // An event the trace does not use (roles, parameters).
    }
  }
  // Block times only for the logs the trace can show: this vault's, and the shared contracts' that name it or its series.
  const mine = vault.toLowerCase();
  const series = new Set(
    decoded
      .filter((l) => l.eventName === "SeriesProposed" && String(l.args.vault ?? "").toLowerCase() === mine)
      .map((l) => String(l.args.seriesId)),
  );
  const relevant = decoded.filter(
    (l) =>
      l.source === "vault" ||
      String(l.args.vault ?? "").toLowerCase() === mine ||
      ((l.eventName === "OptionsBought" || l.eventName === "OptionsRedeemed") &&
        series.has(String(l.args.seriesId))) ||
      (l.eventName === "SettlementPriceRecorded" &&
        String(l.args.token ?? "").toLowerCase() === underlyingAddr.toLowerCase()),
  );
  const blocks = [...new Set(relevant.map((l) => l.block))];
  const times = new Map<bigint, number>();
  // Most series have a handful of events; bound the reads anyway (the trace shows two epochs).
  await Promise.all(
    blocks.slice(-400).map(async (b) => {
      try {
        times.set(b, Number((await client.getBlock({ blockNumber: b })).timestamp));
      } catch {
        // shown without a time
      }
    }),
  );
  for (const l of relevant) l.time = times.get(l.block) ?? null;

  return buildTrace(
    {
      chainId,
      vault,
      explorer: chain.blockExplorers?.default.url ?? "",
      currentEpoch,
      state: ep[0],
      isCall,
      underlying: { address: underlyingAddr, symbol: underlying.symbol, decimals: underlying.decimals },
      asset: { symbol: asset.symbol, decimals: asset.decimals },
      shareDecimals,
      usdgDecimals: usdg.decimals,
      openSigma: ep[4],
      now: Number(head.timestamp),
    },
    relevant,
  );
}

// ------------------------------------------------------------------ caches

interface Entry<T> {
  at: number;
  ttl: number;
  value?: T;
  error?: Error;
}

function cached<T>(ttl: number, run: (chainId: AppChainId, vault: Address) => Promise<T>) {
  const entries = new Map<string, Entry<T>>();
  const inflight = new Map<string, Promise<Entry<T>>>();
  return async (chainId: AppChainId, vault: Address): Promise<T> => {
    const key = `${chainId}:${vault.toLowerCase()}`;
    const hit = entries.get(key);
    let e: Entry<T> | undefined = hit && Date.now() - hit.at < hit.ttl ? hit : undefined;
    if (!e) {
      let p = inflight.get(key);
      if (!p) {
        p = run(chainId, vault)
          .then((value): Entry<T> => ({ at: Date.now(), ttl, value }))
          .catch((err: unknown): Entry<T> => ({
            at: Date.now(),
            // A bad address stays bad; an RPC failure is retried soon.
            ttl: err instanceof TraceInputError ? ttl : ERROR_TTL_MS,
            error: err instanceof Error ? err : new Error(String(err)),
          }))
          .then((x) => {
            entries.set(key, x);
            inflight.delete(key);
            return x;
          });
        inflight.set(key, p);
      }
      e = await p;
    }
    if (e.error) throw e.error;
    return e.value!;
  };
}

/** {@link computeTrace}, one read per vault per minute on an instance. */
export const readTrace = cached(TRACE_TTL_MS, computeTrace);

/** The SDK's settlement check for a vault on a mirrored testnet, one run per vault per 10 minutes on an instance. */
export const readSettlementAudit = cached(
  AUDIT_TTL_MS,
  async (chainId, vault): Promise<SettlementAuditJson> => {
    if (!isMirrorChain(chainId))
      throw new TraceInputError("the settlement check runs on 46630 and 421614 only");
    const audit = await auditSettlement({
      chainId: chainId as MirrorChainId,
      vault,
      env: { ALCHEMY_API_KEY: process.env.ALCHEMY_API_KEY, STRIKE_RPC_URL: RPC_OVERRIDES[chainId] },
    });
    return toSettlementAuditJson(audit);
  },
);
