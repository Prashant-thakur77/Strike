"use client";

import { useQuery } from "@tanstack/react-query";
import { MIRROR_TTL_MS, type MirrorAuditJson, type MirrorChainId, isMirrorChain } from "@/lib/mirrorAudit";

async function fetchAudit(chainId: MirrorChainId): Promise<MirrorAuditJson> {
  const res = await fetch(`/api/mirror-audit?chain=${chainId}`);
  const body = (await res.json().catch(() => null)) as (MirrorAuditJson & { error?: string }) | null;
  if (!res.ok || !body || body.error) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body;
}

/** The price mirror audit of a testnet from /api/mirror-audit (run server-side, cached 10 minutes). Off elsewhere. */
export function useMirrorAudit(chainId: number) {
  return useQuery({
    queryKey: ["mirror-audit", chainId],
    queryFn: () => fetchAudit(chainId as MirrorChainId),
    enabled: isMirrorChain(chainId),
    staleTime: MIRROR_TTL_MS / 2,
    refetchInterval: MIRROR_TTL_MS,
    refetchIntervalInBackground: false,
    retry: 1,
  });
}
