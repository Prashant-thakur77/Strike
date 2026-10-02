"use client";

import { useQuery } from "@tanstack/react-query";
import type { StatusJson } from "@/lib/status";

const FIVE_MIN = 5 * 60_000;

async function fetchStatus(): Promise<StatusJson> {
  const res = await fetch("/api/status");
  const body = (await res.json().catch(() => null)) as (StatusJson & { error?: string }) | null;
  if (!res.ok || !body || body.error) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body;
}

/** The liveness card's data from /api/status (read on the server, cached 5 minutes). */
export function useStatus() {
  return useQuery({
    queryKey: ["status"],
    queryFn: fetchStatus,
    staleTime: FIVE_MIN / 2,
    refetchInterval: FIVE_MIN,
    refetchIntervalInBackground: false,
    retry: 1,
  });
}
