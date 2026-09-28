"use client";

import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { useConnection } from "wagmi";
import {
  faucetTokens,
  marketStatus,
  optionHoldings,
  position,
  registry,
  rejections,
  vaultAddresses,
  vaultHistory,
  vaultSummary,
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

export function useFaucetTokens() {
  const { client, deployment, chainId, ready } = useStrike();
  const { address } = useConnection();
  return useQuery({
    queryKey: ["strike", chainId, "faucet", address],
    enabled: ready && !!client && !!deployment,
    queryFn: () => faucetTokens(client!, deployment!, address),
  });
}
