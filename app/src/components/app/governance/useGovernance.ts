"use client";

import { useQuery } from "@tanstack/react-query";
import { GOV_TTL_MS, type GovChainId, type GovernanceJson } from "@/lib/governance";

async function fetchGovernance(chainId: GovChainId): Promise<GovernanceJson> {
  const res = await fetch(`/api/governance?chain=${chainId}`);
  const body = (await res.json().catch(() => null)) as (GovernanceJson & { error?: string }) | null;
  if (!res.ok || !body || body.error) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body;
}

/** A chain's role holders and admin actions from /api/governance (read server-side, cached 10 minutes). */
export function useGovernance(chainId: GovChainId) {
  return useQuery({
    queryKey: ["governance", chainId],
    queryFn: () => fetchGovernance(chainId),
    staleTime: GOV_TTL_MS / 2,
    refetchInterval: GOV_TTL_MS,
    refetchIntervalInBackground: false,
    retry: 1,
  });
}
