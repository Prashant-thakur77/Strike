"use client";

import { useMemo } from "react";
import { usePublicClient } from "wagmi";
import type { PublicClient } from "viem";
import { useChainState } from "@/components/providers/ChainProvider";
import { CHAIN_META, getAppChain } from "@/lib/chains";
import { findDeployment } from "@/lib/deployment";

/** The selected network, its public client and its Strike deployment (null when not deployed there). */
export function useStrike() {
  const { chainId, ready, setChainId } = useChainState();
  const client = usePublicClient({ chainId }) as PublicClient | undefined;
  const deployment = useMemo(() => findDeployment(chainId), [chainId]);
  return {
    chainId,
    ready,
    setChainId,
    chain: getAppChain(chainId),
    meta: CHAIN_META[chainId],
    client,
    deployment,
  };
}
