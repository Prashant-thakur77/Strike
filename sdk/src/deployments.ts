import type { Address } from "viem";
import { generatedDeployments } from "./deployments.generated.js";

export interface StrikeDeployment {
  chainId: number;
  usdg: Address;
  epochManager: Address;
  vaultFactory: Address;
  agentRegistry: Address;
  optionToken: Address;
  feeManager: Address;
  stockOracle: Address;
  marketCalendar: Address;
  pricer: Address;
  vaultImplementation: Address;
  stocks: Record<string, { token: Address; feed: Address }>;
  vaults: Record<string, unknown>;
}

/** Deployed Strike contracts by chain id (regenerate with `node scripts/export-abis.mjs`). */
export const deployments = generatedDeployments as unknown as Record<string, StrikeDeployment>;

export function getDeployment(chainId: number): StrikeDeployment {
  const d = deployments[String(chainId)];
  if (!d) throw new Error(`No Strike deployment for chain ${chainId}`);
  return d;
}
