"use client";

import { useQuery } from "@tanstack/react-query";
import type { VaultSummary } from "@/lib/reads";
import { WHY_STALE_MS, loadWhyStrike } from "@/lib/whyStrike";
import { useStrike } from "./useStrike";

/**
 * The agent's decision record for the vault's current epoch and its on-chain anchor check. Records never change,
 * so a found one is kept for the session; a miss is retried after ten minutes (the agent runs twice a week).
 */
export function useWhyStrike(vault: VaultSummary) {
  const { client, chainId } = useStrike();
  return useQuery({
    queryKey: [
      "strike",
      chainId,
      "why",
      vault.address,
      vault.currentEpoch.toString(),
      vault.series?.id.toString() ?? null,
      vault.openedAt.toString(),
    ],
    enabled: !!client,
    staleTime: WHY_STALE_MS,
    gcTime: WHY_STALE_MS * 3,
    retry: 1,
    queryFn: ({ signal }) => loadWhyStrike(client!, chainId, vault, fetch, signal),
  });
}
