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
  /** DecisionLog (additive, anchors agents' decision records); absent where it is not deployed. */
  decisionLog?: Address;
  /** Risk engine (IRiskEngine: greeks, implied volatility, scenario loss); absent where it is not deployed. */
  riskEngine?: Address;
  /** RiskLens (v3 only): reads a series' greeks and stress test through the EpochManager's pricer. */
  riskLens?: Address;
  /** The Stylus (Rust/WASM) program of this deployment, when it has one. */
  stylusPricer?: Address;
  /** Protocol version of this deployment's contracts ("v2", "v3"). */
  version?: string;
  /** Network name, when the record carries one. */
  network?: string;
  /** Deployment block, where event scans start. */
  block?: number;
  stocks: Record<string, { token: Address; feed: Address }>;
  vaults: Record<string, unknown>;
}

/** Deployed Strike contracts by chain id (regenerate with `node scripts/export-abis.mjs`). */
export const deployments = generatedDeployments as unknown as Record<string, StrikeDeployment>;

/**
 * Environment variables that replace one address of the deployment record, so a second deployment on the same
 * chain (v3 next to v2 on 46630) can be targeted without a new map entry. STRIKE_DEPLOY_BLOCK sets `block`.
 */
export const DEPLOYMENT_ENV = {
  epochManager: "STRIKE_EPOCH_MANAGER",
  agentRegistry: "STRIKE_AGENT_REGISTRY",
  vaultFactory: "STRIKE_VAULT_FACTORY",
  stockOracle: "STRIKE_STOCK_ORACLE",
  optionToken: "STRIKE_OPTION_TOKEN",
  feeManager: "STRIKE_FEE_MANAGER",
  marketCalendar: "STRIKE_MARKET_CALENDAR",
  usdg: "STRIKE_USDG",
  pricer: "STRIKE_PRICER",
  vaultImplementation: "STRIKE_VAULT_IMPLEMENTATION",
  decisionLog: "STRIKE_DECISION_LOG",
  riskEngine: "STRIKE_RISK_ENGINE",
  riskLens: "STRIKE_RISK_LENS",
} as const satisfies Partial<Record<keyof StrikeDeployment, string>>;

type Env = Record<string, string | undefined>;
const processEnv = (): Env => (globalThis as { process?: { env?: Env } }).process?.env ?? {};

/**
 * The deployment record for `chainId`, with the {@link DEPLOYMENT_ENV} overrides on top. Overrides apply only when
 * STRIKE_CHAIN_ID is unset or equals `chainId`.
 */
export function getDeployment(chainId: number, env: Env = processEnv()): StrikeDeployment {
  const d = deployments[String(chainId)];
  if (!d) throw new Error(`No Strike deployment for chain ${chainId}`);
  if (env.STRIKE_CHAIN_ID && Number(env.STRIKE_CHAIN_ID) !== chainId) return d;
  let out = d;
  for (const [key, name] of Object.entries(DEPLOYMENT_ENV)) {
    const value = env[name]?.trim();
    if (!value) continue;
    if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${name} must be a 0x-prefixed 20-byte address`);
    out = { ...out, [key]: value as Address };
  }
  const block = env.STRIKE_DEPLOY_BLOCK?.trim();
  if (block) {
    if (!/^\d+$/.test(block)) throw new Error("STRIKE_DEPLOY_BLOCK must be a block number");
    out = { ...out, block: Number(block) };
  }
  return out;
}
