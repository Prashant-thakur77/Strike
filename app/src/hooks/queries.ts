"use client";

import { createStrikeClient } from "@strike/sdk";
import { useQuery } from "@tanstack/react-query";
import { erc20Abi, type Address, type PublicClient } from "viem";
import { useConnection } from "wagmi";
import { AGENT_LOG_STALE_MS, AgentLogError, fetchAgentLog } from "@/lib/agentLog";
import { affordableOptions } from "@/lib/hedge";
import {
  NotAVaultError,
  faucetTokens,
  hasForeignManager,
  marketStatus,
  optionHoldings,
  position,
  quotePremium,
  registry,
  rejections,
  vaultAddresses,
  vaultDeployment,
  vaultHistory,
  vaultSummary,
  walletBalances,
  type Registry,
  type Rejection,
  type VaultSummary,
} from "@/lib/reads";
import { deploymentKey, deploymentVersion, type Deployment } from "@/lib/deployment";
import { useStrike } from "./useStrike";

const REFRESH = 15_000;

async function vaultsOf(client: PublicClient, dep: Deployment) {
  const addresses = await vaultAddresses(client, dep);
  const summaries = await Promise.all(addresses.map((a) => vaultSummary(client, dep, a)));
  const histories = await Promise.all(summaries.map((s) => vaultHistory(client, dep, s).catch(() => null)));
  return summaries.map((summary, i) => ({ summary, history: histories[i] ?? null }));
}

/** Every vault of the deployment in use (the chain's default one, or a vault page's own) with its trailing APY. */
export function useVaults() {
  const { client, deployment, chainId, ready, depKey } = useStrike();
  return useQuery({
    queryKey: ["strike", chainId, depKey, "vaults"],
    enabled: ready && !!client && !!deployment,
    refetchInterval: REFRESH,
    queryFn: () => vaultsOf(client!, deployment!),
  });
}

/**
 * Every vault of every deployment on the chain (v2 and v3 on Robinhood Chain testnet), the default deployment's
 * first; each summary carries its `version`. A deployment that cannot be read fails the whole list.
 */
export function useAllVaults() {
  const { client, deployments, chainId, ready } = useStrike();
  return useQuery({
    queryKey: ["strike", chainId, "all-vaults", deployments.map(deploymentKey).join(",")],
    enabled: ready && !!client && deployments.length > 0,
    refetchInterval: REFRESH,
    queryFn: async () => (await Promise.all(deployments.map((d) => vaultsOf(client!, d)))).flat(),
  });
}

/** One vault, read through the deployment its EpochManager (`manager()`) belongs to. */
export function useVault(address: Address) {
  const { client, deployment, chainId, ready, depKey } = useStrike();
  return useQuery({
    queryKey: ["strike", chainId, "vault", address],
    enabled: ready && !!client && !!deployment,
    refetchInterval: REFRESH,
    queryFn: async () => {
      const own = await vaultDeployment(client!, chainId, address);
      // A vault of no deployment on this chain (v1's on Robinhood Chain testnet sit at the addresses of v3's on
      // Arbitrum Sepolia) is not shown with the default deployment's reads: it is "not a Strike vault here".
      if (!own && (await hasForeignManager(client!, chainId, address))) throw new NotAVaultError(address);
      return vaultSummary(client!, own ?? deployment!, address);
    },
  });
}

export function useVaultHistory(vault: VaultSummary | undefined) {
  const { client, chainId } = useStrike();
  return useQuery({
    queryKey: ["strike", chainId, "history", vault?.address, vault?.currentEpoch.toString(), vault?.state],
    enabled: !!client && !!vault,
    queryFn: () => vaultHistory(client!, vault!.deployment, vault!),
  });
}

export function useMarket() {
  const { client, deployment, chainId, ready, depKey } = useStrike();
  return useQuery({
    queryKey: ["strike", chainId, depKey, "market"],
    enabled: ready && !!client && !!deployment,
    refetchInterval: 30_000,
    queryFn: () => marketStatus(client!, deployment!),
  });
}

export function usePosition(vault: VaultSummary | undefined) {
  const { client, deployment, chainId, depKey } = useStrike();
  const { address } = useConnection();
  return useQuery({
    queryKey: ["strike", chainId, depKey, "position", vault?.address, address],
    enabled: !!client && !!deployment && !!vault && !!address,
    refetchInterval: REFRESH,
    queryFn: () => position(client!, deployment!, vault!, address!),
  });
}

export function useOptionHoldings(seriesIds: bigint[] | undefined) {
  const { client, deployment, chainId, depKey } = useStrike();
  const { address } = useConnection();
  return useQuery({
    queryKey: ["strike", chainId, depKey, "options", address, seriesIds?.map(String).join(",")],
    enabled: !!client && !!deployment && !!address && !!seriesIds,
    queryFn: () => optionHoldings(client!, deployment!, seriesIds!, address!),
  });
}

/** The AgentRegistry of the deployment in use (the chain's default one). */
export function useRegistry() {
  const { client, deployment, chainId, ready, depKey } = useStrike();
  return useQuery({
    queryKey: ["strike", chainId, depKey, "registry"],
    enabled: ready && !!client && !!deployment,
    refetchInterval: 30_000,
    queryFn: () => registry(client!, deployment!),
  });
}

/**
 * Every AgentRegistry on the chain (v2's and v3's on Robinhood Chain testnet), the default deployment's first. Agent
 * ids repeat across registries: each row carries its `registryVersion`.
 */
export function useRegistries() {
  const { client, deployments, chainId, ready } = useStrike();
  return useQuery({
    queryKey: ["strike", chainId, "registries", deployments.map(deploymentKey).join(",")],
    enabled: ready && !!client && deployments.length > 0,
    refetchInterval: 30_000,
    queryFn: () =>
      Promise.all(
        deployments.map(
          async (d): Promise<{ version: string; deployment: Deployment; registry: Registry }> => ({
            version: deploymentVersion(d),
            deployment: d,
            registry: await registry(client!, d),
          }),
        ),
      ),
  });
}

/** Every ProposalRejected event of every EpochManager on the chain, newest first; each carries its `version`. */
export function useRejections() {
  const { client, deployments, chainId, ready } = useStrike();
  return useQuery({
    queryKey: ["strike", chainId, "rejections", deployments.map(deploymentKey).join(",")],
    enabled: ready && !!client && deployments.length > 0,
    refetchInterval: 30_000,
    queryFn: async (): Promise<Rejection[]> => {
      const lists = await Promise.all(deployments.map((d) => rejections(client!, d)));
      return lists.flat().sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
    },
  });
}

/**
 * The weekly agent's newest decision records from docs/agent-log on GitHub (not the chain, so it ignores the
 * selected network). Kept fresh for 10 minutes: the folder changes twice a week and the API allows 60 calls an hour.
 */
export function useAgentLog() {
  return useQuery({
    queryKey: ["agent-log"],
    queryFn: ({ signal }) => fetchAgentLog(fetch, signal),
    staleTime: AGENT_LOG_STALE_MS,
    gcTime: AGENT_LOG_STALE_MS * 3,
    // A rate limit won't lift in a second: show the fallback instead of spending another call.
    retry: (count, err) => !(err instanceof AgentLogError && err.kind === "rate-limit") && count < 1,
  });
}

export function useFaucetTokens() {
  const { client, deployment, chainId, ready, depKey } = useStrike();
  const { address } = useConnection();
  return useQuery({
    queryKey: ["strike", chainId, depKey, "faucet", address],
    enabled: ready && !!client && !!deployment,
    queryFn: () => faucetTokens(client!, deployment!, address),
  });
}

/** The connected wallet's gas, USDG and stock-token balances on the selected network. */
export function useWalletBalances() {
  const { client, deployment, chainId, ready, depKey } = useStrike();
  const { address } = useConnection();
  return useQuery({
    queryKey: ["strike", chainId, depKey, "wallet", address],
    enabled: ready && !!client && !!deployment && !!address,
    refetchInterval: REFRESH,
    queryFn: () => walletBalances(client!, deployment!, address!),
  });
}

/** The premium for `amount` options of a series (`EpochManager.quoteBuy`), refreshed as the spot moves. */
export function useQuoteBuy(seriesId: bigint, amount: bigint | null) {
  const { client, deployment, chainId, depKey } = useStrike();
  return useQuery({
    queryKey: ["strike", chainId, depKey, "quote", seriesId.toString(), amount?.toString()],
    enabled: !!client && !!deployment && amount !== null && amount > 0n,
    refetchInterval: REFRESH,
    queryFn: () => quotePremium(client!, deployment!, seriesId, amount!),
  });
}

/** The most options of a series a premium `budget` buys (at most `cap`, in `step`s), confirmed by `quoteBuy`. */
export function useAffordable(seriesId: bigint, budget: bigint | null, cap: bigint, step: bigint) {
  const { client, deployment, chainId, depKey } = useStrike();
  return useQuery({
    queryKey: [
      "strike",
      chainId,
      depKey,
      "affordable",
      seriesId.toString(),
      budget?.toString(),
      cap.toString(),
      step.toString(),
    ],
    enabled: !!client && !!deployment && budget !== null && budget > 0n && cap > 0n,
    refetchInterval: REFRESH,
    queryFn: () =>
      affordableOptions({
        budget: budget!,
        cap,
        step,
        quote: (amount) => quotePremium(client!, deployment!, seriesId, amount),
      }),
  });
}

/** The connected wallet's balance of an ERC-20 (base units). */
export function useTokenBalance(token: Address | undefined) {
  const { client, chainId } = useStrike();
  const { address } = useConnection();
  return useQuery({
    queryKey: ["strike", chainId, "balance", token, address],
    enabled: !!client && !!token && !!address,
    refetchInterval: REFRESH,
    queryFn: () =>
      client!.readContract({ address: token!, abi: erc20Abi, functionName: "balanceOf", args: [address!] }),
  });
}

/**
 * Live risk of a vault's selling series from the risk engine contract (`seriesRisk` in the SDK): greeks, the
 * depositors' exposure, the ±30% stress test and the last buy's implied volatility. Disabled where no risk engine
 * is deployed or nothing is on sale.
 */
export function useSeriesRisk(vault: VaultSummary | undefined) {
  const { client, chainId, deployment: inUse } = useStrike();
  // The vault's own deployment: its EpochManager, and RiskLens where that deployment has one (v3).
  const deployment = vault?.deployment ?? inUse;
  const seriesId = vault?.state === 2 ? vault.series?.id : undefined;
  return useQuery({
    queryKey: ["strike", chainId, deploymentKey(deployment), "risk", seriesId?.toString()],
    enabled: !!client && !!(deployment?.riskEngine || deployment?.riskLens) && seriesId !== undefined,
    refetchInterval: 30_000,
    placeholderData: (prev) => prev,
    retry: 1,
    queryFn: () =>
      createStrikeClient({ publicClient: client!, chainId, deployment: deployment! }).seriesRisk(seriesId!),
  });
}
