"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { UsageStats } from "@/lib/usage/aggregate";

/** The CDN refreshes /api/stats every 10 minutes; asking more often only returns the same answer. */
export const USAGE_REFRESH_MS = 10 * 60_000;

async function fetchUsage(): Promise<UsageStats> {
  const res = await fetch("/api/stats");
  const body = (await res.json().catch(() => null)) as (UsageStats & { error?: string }) | null;
  if (!res.ok || !body || body.error) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body;
}

/** Testnet usage from /api/stats (counted server-side from every deployment's logs). */
export function useUsage() {
  return useQuery({
    queryKey: ["usage-stats"],
    queryFn: fetchUsage,
    staleTime: USAGE_REFRESH_MS / 2,
    refetchInterval: USAGE_REFRESH_MS,
    refetchIntervalInBackground: false,
    retry: 1,
  });
}

/** The current time, ticking every 30 s, for "updated N min ago". */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}
