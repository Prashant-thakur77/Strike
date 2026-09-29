"use client";

import { useQuery } from "@tanstack/react-query";
import { erc20Abi, type Address } from "viem";
import { useConnection } from "wagmi";
import { AGENT_LOG_STALE_MS, AgentLogError, fetchAgentLog } from "@/lib/agentLog";
import { affordableOptions } from "@/lib/hedge";
import {
  faucetTokens,
  marketStatus,
  optionHoldings,
  position,
  quotePremium,
  registry,
  rejections,
  vaultAddresses,
  vaultHistory,
  vaultSummary,
  walletBalances,
  type VaultSummary,
} from "@/lib/reads";
import { useStrike } from "./useStrike";

const REFRESH = 15_000;

/** Every vault with its live state and trailing APY. */
export function useVaults() {
  const { client, deployment, chainId, ready } = useStrike();
  return useQuery({
    queryKey: ["strike", chainId, "vaults"],
    enabled: ready && !!client && !!deployment,
    refetchInterval: REFRESH,
    queryFn: async () => {
      const addresses = await vaultAddresses(client!, deployment!);
      const summaries = await Promise.all(addresses.map((a) => vaultSummary(client!, deployment!, a)));
      const histories = await Promise.all(
        summaries.map((s) => vaultHistory(client!, deployment!, s).catch(() => null)),
      );
      return summaries.map((summary, i) => ({ summary, history: histories[i] ?? null }));
    },
  });
}

export function useVault(address: Address) {
  const { client, deployment, chainId, ready } = useStrike();
  return useQuery({
    queryKey: ["strike", chainId, "vault", address],
    enabled: ready && !!client && !!deployment,
    refetchInterval: REFRESH,
    queryFn: () => vaultSummary(client!, deployment!, address),
  });
}

export function useVaultHistory(vault: VaultSummary | undefined) {
  const { client, deployment, chainId } = useStrike();
  return useQuery({
    queryKey: ["strike", chainId, "history", vault?.address, vault?.currentEpoch.toString(), vault?.state],
    enabled: !!client && !!deployment && !!vault,
    queryFn: () => vaultHistory(client!, deployment!, vault!),
  });
}

export function useMarket() {
  const { client, deployment, chainId, ready } = useStrike();
  return useQuery({
    queryKey: ["strike", chainId, "market"],
    enabled: ready && !!client && !!deployment,
    refetchInterval: 30_000,
    queryFn: () => marketStatus(client!, deployment!),
  });
}

export function usePosition(vault: VaultSummary | undefined) {
  const { client, deployment, chainId } = useStrike();
  const { address } = useConnection();
  return useQuery({
    queryKey: ["strike", chainId, "position", vault?.address, address],
    enabled: !!client && !!deployment && !!vault && !!address,
    refetchInterval: REFRESH,
    queryFn: () => position(client!, deployment!, vault!, address!),
  });
}

export function useOptionHoldings(seriesIds: bigint[] | undefined) {
  const { client, deployment, chainId } = useStrike();
  const { address } = useConnection();
  return useQuery({
    queryKey: ["strike", chainId, "options", address, seriesIds?.map(String).join(",")],
    enabled: !!client && !!deployment && !!address && !!seriesIds,
    queryFn: () => optionHoldings(client!, deployment!, seriesIds!, address!),
  });
}

export function useRegistry() {
  const { client, deployment, chainId, ready } = useStrike();
  return useQuery({
    queryKey: ["strike", chainId, "registry"],
    enabled: ready && !!client && !!deployment,
    refetchInterval: 30_000,
    queryFn: () => registry(client!, deployment!),
  });
}

export function useRejections() {
  const { client, deployment, chainId, ready } = useStrike();
  return useQuery({
    queryKey: ["strike", chainId, "rejections"],
    enabled: ready && !!client && !!deployment,
    refetchInterval: 30_000,
    queryFn: () => rejections(client!, deployment!),
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
  const { client, deployment, chainId, ready } = useStrike();
  const { address } = useConnection();
  return useQuery({
    queryKey: ["strike", chainId, "faucet", address],
    enabled: ready && !!client && !!deployment,
    queryFn: () => faucetTokens(client!, deployment!, address),
  });
}

/** The connected wallet's gas, USDG and stock-token balances on the selected network. */
export function useWalletBalances() {
  const { client, deployment, chainId, ready } = useStrike();
  const { address } = useConnection();
  return useQuery({
    queryKey: ["strike", chainId, "wallet", address],
    enabled: ready && !!client && !!deployment && !!address,
    refetchInterval: REFRESH,
    queryFn: () => walletBalances(client!, deployment!, address!),
  });
}

/** The premium for `amount` options of a series (`EpochManager.quoteBuy`), refreshed as the spot moves. */
export function useQuoteBuy(seriesId: bigint, amount: bigint | null) {
  const { client, deployment, chainId } = useStrike();
  return useQuery({
    queryKey: ["strike", chainId, "quote", seriesId.toString(), amount?.toString()],
    enabled: !!client && !!deployment && amount !== null && amount > 0n,
    refetchInterval: REFRESH,
    queryFn: () => quotePremium(client!, deployment!, seriesId, amount!),
  });
}

/** The most options of a series a premium `budget` buys (at most `cap`, in `step`s), confirmed by `quoteBuy`. */
export function useAffordable(seriesId: bigint, budget: bigint | null, cap: bigint, step: bigint) {
  const { client, deployment, chainId } = useStrike();
  return useQuery({
    queryKey: [
      "strike",
      chainId,
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
