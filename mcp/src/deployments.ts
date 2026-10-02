import { type StrikeDeployment, StrikeError, deploymentsFor } from "@strike/sdk";

// Picking one of a chain's Strike deployments by protocol version ("v2", "v3"): the remote endpoint's `?version=`
// and the stdio server's STRIKE_DEPLOYMENT_VERSION.

/** "v3", "V3" or "3" as "v3"; null for anything else. */
export function normalizeVersion(raw: string): string | null {
  const m = /^v?(\d+)$/i.exec(raw.trim());
  return m ? `v${Number(m[1])}` : null;
}

/**
 * The deployment on `chainId` whose protocol version is `version` (one of the SDK's `deploymentsFor`). Throws,
 * naming the versions the chain has, when there is none; `error` builds the thrown error.
 */
export function findDeploymentVersion(
  chainId: number,
  version: string,
  error: (message: string) => Error = (m) => new StrikeError(m),
): StrikeDeployment {
  const wanted = normalizeVersion(version);
  const all = deploymentsFor(chainId);
  const found = wanted ? all.find((d) => d.version?.toLowerCase() === wanted) : undefined;
  if (found) return found;
  const have = all.map((d) => d.version ?? "unversioned").join(", ");
  throw error(
    all.length
      ? `no ${version} deployment on chain ${chainId}; it has ${have}`
      : `no Strike deployment on chain ${chainId}`,
  );
}
