"use client";

import { useMemo } from "react";
import { usePublicClient } from "wagmi";
import type { PublicClient } from "viem";
import { useChainState } from "@/components/providers/ChainProvider";
import { useScopedDeployment } from "@/components/providers/DeploymentScope";
import { CHAIN_META, getAppChain } from "@/lib/chains";
import { chainDeployments, deploymentKey, findDeployment } from "@/lib/deployment";

/**
 * The selected network, its public client and its Strike deployment (null when not deployed there): the chain's
 * default one, or inside a `DeploymentScope` (a vault page) the vault's own. `deployments` lists all of the chain's.
 */
export function useStrike() {
  const { chainId, ready, setChainId } = useChainState();
  const client = usePublicClient({ chainId }) as PublicClient | undefined;
  const scoped = useScopedDeployment();
  const deployments = useMemo(() => chainDeployments(chainId), [chainId]);
  const deployment = useMemo(
    () => (scoped && scoped.chainId === chainId ? scoped : findDeployment(chainId)),
    [scoped, chainId],
  );
  return {
    chainId,
    ready,
    setChainId,
    chain: getAppChain(chainId),
    meta: CHAIN_META[chainId],
    client,
    deployment,
    /** Every deployment on the chain, the default first. */
    deployments,
    /** Part of query keys: which deployment a read went to. */
    depKey: deploymentKey(deployment),
  };
}
