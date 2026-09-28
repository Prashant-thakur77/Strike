import { deployments, type getDeployment } from "@strike/sdk";

export type Deployment = ReturnType<typeof getDeployment>;

/** The Strike deployment on `chainId`, or null when the protocol is not deployed there (yet). */
export function findDeployment(chainId: number): Deployment | null {
  return deployments[String(chainId)] ?? null;
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
