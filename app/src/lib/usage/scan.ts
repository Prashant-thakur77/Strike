import {
  agentRegistryAbi,
  decisionLogAbi,
  epochManagerAbi,
  strikeVaultAbi,
  vaultFactoryAbi,
} from "@strike/sdk";
import { createPublicClient, decodeEventLog, erc20Abi, http, type Abi, type Address, type Log } from "viem";
import { scanLogs } from "../activity";
import { CHAIN_META, RPC_OVERRIDES, getAppChain, isAppChainId, type AppChainId } from "../chains";
import {
  chainDeployments,
  deployedChainIds,
  deploymentVersion,
  fromBlock,
  type Deployment,
} from "../deployment";
import { vaultSummary } from "../reads";
import {
  aggregateUsage,
  type DeploymentInput,
  type UsageLog,
  type UsageSource,
  type UsageStats,
} from "./aggregate";

// Server side of the usage panel: read every testnet deployment's logs and value locked, then count them with
// aggregate.ts. /api/stats calls `readUsage()` and the CDN caches the answer, so visitors never scan logs themselves.

/**
 * Largest `getLogs` range per call. Measured on 2026-10-02: both public RPCs (rpc.testnet.chain.robinhood.com and
 * sepolia-rollup.arbitrum.io/rpc) answered the whole history of every deployment in one call (1.43M blocks on
 * 46630 v2, 0.43M on 421614) in under a second, from 10k-block ranges up. 500k keeps each call well inside that as history grows, and `scanLogs` halves the range
 * on any range or result-size error, so a stricter RPC (an override in NEXT_PUBLIC_RPC_<chainId>) still works.
 */
export const USAGE_MAX_RANGE = 500_000n;

/** How long a computed answer is reused by this server instance (the CDN keeps it as long; see the route). */
export const USAGE_TTL_MS = 10 * 60_000;

/** Chains counted: the testnets with a Strike deployment (not the local devnet). */
export function usageChainIds(): AppChainId[] {
  return deployedChainIds().filter(
    (id): id is AppChainId => isAppChainId(id) && id !== 31337 && CHAIN_META[id].testnet,
  );
}

const ABI: Record<Exclude<UsageSource, "vault">, Abi> = {
  epochManager: epochManagerAbi as Abi,
  vaultFactory: vaultFactoryAbi as Abi,
  // The v3 registry's events have the same signatures as v2's (sdk/src/abi/agentRegistryV3.ts).
  agentRegistry: agentRegistryAbi as Abi,
  decisionLog: decisionLogAbi as Abi,
};

/** Decode a raw log with the ABI of the contract that emitted it; null for events the counter does not use. */
function decode(log: Log, source: UsageSource): UsageLog | null {
  try {
    const d = decodeEventLog({
      abi: source === "vault" ? (strikeVaultAbi as Abi) : ABI[source],
      data: log.data,
      topics: log.topics,
      strict: true,
    });
    return {
      source,
      address: log.address,
      eventName: d.eventName ?? "",
      args: (d.args ?? {}) as Record<string, unknown>,
      transactionHash: log.transactionHash ?? "0x",
      blockNumber: log.blockNumber ?? 0n,
      logIndex: log.logIndex ?? 0,
    };
  } catch {
    return null;
  }
}

/** Logs, value locked and USDG decimals of one deployment, read up to the chain head. */
export async function readDeployment(chainId: AppChainId, dep: Deployment): Promise<DeploymentInput> {
  const chain = getAppChain(chainId);
  const client = createPublicClient({ chain, transport: http(RPC_OVERRIDES[chainId], { retryCount: 2 }) });
  const from = fromBlock(dep);
  const head = await client.getBlockNumber();

  const core: [Address, Exclude<UsageSource, "vault">][] = [
    [dep.epochManager, "epochManager"],
    [dep.vaultFactory, "vaultFactory"],
    [dep.agentRegistry, "agentRegistry"],
  ];
  if (dep.decisionLog) core.push([dep.decisionLog, "decisionLog"]);
  const sourceOf = new Map(core.map(([a, s]) => [a.toLowerCase(), s]));

  const raw = await scanLogs<Log>({
    from,
    to: head,
    maxRange: USAGE_MAX_RANGE,
    fetchLogs: (fromBlock, toBlock) =>
      client.getLogs({ address: core.map(([a]) => a), fromBlock, toBlock }) as Promise<Log[]>,
  });
  const logs = raw.flatMap((l) => {
    const source = sourceOf.get(l.address.toLowerCase());
    const d = source ? decode(l, source) : null;
    return d ? [d] : [];
  });

  const vaults = [
    ...new Set(
      logs
        .filter(
          (l) =>
            (l.source === "vaultFactory" && l.eventName === "VaultCreated") ||
            (l.source === "epochManager" && l.eventName === "VaultRegistered"),
        )
        .map((l) => String(l.args.vault).toLowerCase()),
    ),
  ] as Address[];

  if (vaults.length) {
    const vaultRaw = await scanLogs<Log>({
      from,
      to: head,
      maxRange: USAGE_MAX_RANGE,
      fetchLogs: (fromBlock, toBlock) =>
        client.getLogs({ address: vaults, fromBlock, toBlock }) as Promise<Log[]>,
    });
    for (const l of vaultRaw) {
      const d = decode(l, "vault");
      if (d) logs.push(d);
    }
  }

  const [usdgDecimals, tvls] = await Promise.all([
    client.readContract({ address: dep.usdg, abi: erc20Abi, functionName: "decimals" }),
    Promise.all(
      vaults.map((v) =>
        vaultSummary(client, dep, v)
          .then((s) => s.tvlUsd)
          .catch(() => null),
      ),
    ),
  ]);
  // Unknown if any vault could not be valued: a partial sum would understate it.
  const tvlUsd = tvls.some((x) => x === null) ? null : tvls.reduce<number>((s, x) => s + (x ?? 0), 0);

  return {
    chainId,
    chainName: CHAIN_META[chainId].label,
    chainShort: CHAIN_META[chainId].short,
    version: deploymentVersion(dep) || "v?",
    explorer: chain.blockExplorers?.default.url ?? "",
    contracts: {
      epochManager: dep.epochManager,
      vaultFactory: dep.vaultFactory,
      agentRegistry: dep.agentRegistry,
      ...(dep.decisionLog ? { decisionLog: dep.decisionLog } : {}),
    },
    fromBlock: from,
    toBlock: head,
    usdgDecimals,
    logs,
    tvlUsd,
  };
}

/** Read and count every testnet deployment. A deployment whose read fails is listed in `errors`, not counted. */
export async function computeUsage(): Promise<UsageStats> {
  const jobs = usageChainIds().flatMap((chainId) =>
    chainDeployments(chainId).map((dep) => ({ chainId, dep, key: `${chainId}-${deploymentVersion(dep)}` })),
  );
  const settled = await Promise.allSettled(jobs.map((j) => readDeployment(j.chainId, j.dep)));
  const inputs: DeploymentInput[] = [];
  const errors: { key: string; message: string }[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") inputs.push(r.value);
    else
      errors.push({
        key: jobs[i].key,
        message: (r.reason instanceof Error ? r.reason.message : String(r.reason)).split("\n")[0],
      });
  });
  if (!inputs.length) throw new Error(errors[0]?.message ?? "No testnet deployment to read");
  return aggregateUsage(inputs, { errors });
}

let cached: { at: number; value: UsageStats } | null = null;
let inflight: Promise<UsageStats> | null = null;

/** {@link computeUsage}, reused for {@link USAGE_TTL_MS}; concurrent callers share one read. */
export async function readUsage(now: number = Date.now()): Promise<UsageStats> {
  if (cached && now - cached.at < USAGE_TTL_MS) return cached.value;
  if (!inflight) {
    inflight = computeUsage()
      .then((value) => {
        // A partial answer (a chain's RPC failed) is retried after a minute instead of ten.
        const age = value.errors.length ? USAGE_TTL_MS - 60_000 : 0;
        cached = { at: Date.now() - age, value };
        return value;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}
