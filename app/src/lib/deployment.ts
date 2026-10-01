import { deploymentForEpochManager, deployments, deploymentsFor, type getDeployment } from "@strike/sdk";

export type Deployment = ReturnType<typeof getDeployment>;

/** The default Strike deployment on `chainId`, or null when the protocol is not deployed there (yet). */
export function findDeployment(chainId: number): Deployment | null {
  return deployments[String(chainId)] ?? null;
}

/**
 * Every Strike deployment on `chainId`, the default first: v2 and v3 on Robinhood Chain testnet, v3 on Arbitrum
 * Sepolia. Empty where Strike is not deployed.
 */
export function chainDeployments(chainId: number): Deployment[] {
  return deploymentsFor(chainId);
}

/** The deployment on `chainId` a vault belongs to, by the vault's `manager()` (its EpochManager). */
export function deploymentOfManager(chainId: number, epochManager: string): Deployment | null {
  return deploymentForEpochManager(chainId, epochManager);
}

/** "v2", "v3", ... (the record's `version`), or "" when the record has none (local devnets). */
export function deploymentVersion(dep: Deployment | null | undefined): string {
  return dep?.version ?? "";
}

/** A stable key for a deployment (its EpochManager), for query keys and React keys. */
export function deploymentKey(dep: Deployment | null | undefined): string {
  return dep ? dep.epochManager.toLowerCase() : "none";
}

/** Chain ids that have a deployment in the SDK map. Regenerating the map adds networks automatically. */
export function deployedChainIds(): number[] {
  return Object.keys(deployments)
    .map(Number)
    .filter((id) => Number.isFinite(id));
}

/** Block to start event scans from (the deployment block when known). */
export function fromBlock(dep: Deployment): bigint {
  const block = (dep as { block?: unknown }).block;
  return typeof block === "number" && block > 0 ? BigInt(block) : 0n;
}
