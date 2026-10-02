"use client";

import { useQuery } from "@tanstack/react-query";
import { RPC_PROXY, rpcProxyPath } from "@/lib/rpc/client";
import styles from "./proof.module.css";

/**
 * Which RPC this page's chain reads use: "RPC: Alchemy" when they go through the /api/rpc proxy and Alchemy answers
 * it (GET /api/rpc/<chainId>), else "RPC: public". The key never reaches the browser; the page only learns which.
 */
export function RpcSource({ chainId }: { chainId: number }) {
  const q = useQuery({
    queryKey: ["rpc-source", chainId],
    queryFn: async () => {
      const res = await fetch(rpcProxyPath(chainId));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as { provider?: string };
    },
    enabled: RPC_PROXY,
    staleTime: 60_000,
    retry: 0,
  });
  const state =
    !RPC_PROXY || q.isError
      ? "public"
      : q.data
        ? q.data.provider === "alchemy"
          ? "alchemy"
          : "public"
        : "checking";
  const label = state === "alchemy" ? "Alchemy" : state === "public" ? "public" : "…";
  const title =
    state === "alchemy"
      ? "Reads go through /api/rpc, Strike's server-side proxy to Alchemy. The key stays on the server; the public RPC takes over if Alchemy fails."
      : "Reads go to the chain's public RPC.";
  return (
    <span className={styles.rpcSource} data-testid="rpc-source" data-provider={state} title={title}>
      RPC: {label}
    </span>
  );
}
