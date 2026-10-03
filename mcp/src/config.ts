import {
  type RpcEndpoint,
  type StrikeClient,
  createStrikeClient,
  getStrikeChain,
  loadStrikeConfig,
  rpcEndpointsFor,
  strikeSecretName,
  transportFromEndpoints,
} from "@strike/sdk";
import { type Hex, createPublicClient, createWalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { findDeploymentVersion, normalizeVersion } from "./deployments.js";
import { type X402Payer, createX402Payer } from "./x402.js";

/** Server configuration from the environment. */
export interface StrikeMcpConfig {
  /** STRIKE_CHAIN_ID (default: strike.config.json's defaultChainId, 46630, Robinhood Chain testnet). */
  chainId: number;
  /**
   * STRIKE_DEPLOYMENT_VERSION ("v2", "v3"): which of the chain's deployments to use, for v3 next to v2 on Robinhood
   * Chain testnet. Default: the SDK's default deployment for the chain, with the STRIKE_EPOCH_MANAGER-style address
   * overrides on top (those do not apply to a deployment picked here).
   */
  deploymentVersion?: string;
  /** The first RPC endpoint's URL, for display. Never carries an API key (Alchemy's goes in a header). */
  rpcUrl: string;
  /**
   * RPC endpoints, best first (the SDK's `rpcEndpointsFor`): Alchemy when ALCHEMY_API_KEY is set, then
   * STRIKE_RPC_URL, then the chain's public RPC. Reads and sends fall back down the list.
   */
  rpcEndpoints: RpcEndpoint[];
  /** STRIKE_AGENT_PRIVATE_KEY: the agent signer's key. Without it the server is read-only. */
  privateKey?: Hex;
  /** STRIKE_SKILL_PATH: override the location of STRIKE_SKILL.md. */
  skillPath?: string;
  /** STRIKE_MCP_READ_ONLY=1: register only the read-only tools (and never load the agent key). */
  readOnly: boolean;
}

/** Read and validate the STRIKE_* environment variables (defaults and the key's variable from strike.config.json). */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): StrikeMcpConfig {
  const chainId = Number(env.STRIKE_CHAIN_ID ?? loadStrikeConfig().defaultChainId);
  if (!Number.isInteger(chainId) || chainId <= 0)
    throw new Error(`invalid STRIKE_CHAIN_ID: ${env.STRIKE_CHAIN_ID}`);
  const rpcEndpoints = rpcEndpointsFor(chainId, env);
  const rawVersion = env.STRIKE_DEPLOYMENT_VERSION?.trim();
  let deploymentVersion: string | undefined;
  if (rawVersion) {
    deploymentVersion = normalizeVersion(rawVersion) ?? undefined;
    if (!deploymentVersion)
      throw new Error(`invalid STRIKE_DEPLOYMENT_VERSION: ${rawVersion} (use v2 or v3)`);
    findDeploymentVersion(chainId, deploymentVersion, (m) => new Error(`STRIKE_DEPLOYMENT_VERSION: ${m}`));
  }
  const readOnly = env.STRIKE_MCP_READ_ONLY === "1" || env.STRIKE_MCP_READ_ONLY === "true";
  const keyEnv = strikeSecretName("agentKey"); // STRIKE_AGENT_PRIVATE_KEY
  const key = readOnly ? undefined : env[keyEnv]?.trim();
  if (key && !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(`${keyEnv} must be a 0x-prefixed 32-byte hex key`);
  }
  return {
    chainId,
    deploymentVersion,
    rpcUrl: rpcEndpoints[0]!.url,
    rpcEndpoints,
    privateKey: key ? (key as Hex) : undefined,
    skillPath: env.STRIKE_SKILL_PATH,
    readOnly,
  };
}

/** A Strike client for the configuration: read-only, or signing as the agent when a key is set. */
export function clientFromConfig(config: StrikeMcpConfig): StrikeClient {
  const chain = { ...getStrikeChain(config.chainId), rpcUrls: { default: { http: [config.rpcUrl] } } };
  const transport = transportFromEndpoints(config.rpcEndpoints);
  const pollingInterval = config.chainId === 31337 ? 100 : 1000;
  const publicClient = createPublicClient({ chain, transport, pollingInterval });
  const walletClient = config.privateKey
    ? createWalletClient({ account: privateKeyToAccount(config.privateKey), chain, transport })
    : undefined;
  try {
    const deployment = config.deploymentVersion
      ? findDeploymentVersion(config.chainId, config.deploymentVersion)
      : undefined;
    return createStrikeClient({ publicClient, walletClient, chainId: config.chainId, deployment });
  } catch (err) {
    throw new Error(
      `${err instanceof Error ? err.message : String(err)}. Deploy Strike there and run \`node scripts/export-abis.mjs\`, or set STRIKE_CHAIN_ID to a deployed chain (31337 for the local devnet: scripts/demo-local.sh).`,
    );
  }
}

/**
 * The x402 payer for `paid_risk_report`, or undefined (read-only server, no x402 section, no key). The key is
 * STRIKE_PAYER_KEY, else the agent key; STRIKE_X402_MAX_SPEND caps the run (default x402.agentRunCap);
 * STRIKE_X402_ENDPOINT overrides the report's URL (default: the app's URL and the route's path); payments go on
 * STRIKE_X402_CHAIN_ID when the route accepts it, else the server's chain, else the route's first token.
 */
export function x402FromEnv(
  config: StrikeMcpConfig,
  env: NodeJS.ProcessEnv = process.env,
): { payer: X402Payer; endpoint: string } | undefined {
  const file = loadStrikeConfig();
  const x402 = file.x402;
  if (config.readOnly || !x402?.routes.riskReport) return undefined;
  const payerEnv = strikeSecretName("x402PayerKey");
  const raw = env[payerEnv]?.trim() || config.privateKey;
  if (!raw) return undefined;
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new Error(`${payerEnv} must be a 0x-prefixed 32-byte hex key`);
  const cap = env.STRIKE_X402_MAX_SPEND?.trim();
  if (cap && !/^\d+(\.\d+)?$/.test(cap)) throw new Error(`invalid STRIKE_X402_MAX_SPEND: ${cap}`);
  const preferred = Number(env.STRIKE_X402_CHAIN_ID ?? config.chainId);
  const endpoint = env.STRIKE_X402_ENDPOINT?.trim() || `${file.services.app}${x402.routes.riskReport.path}`;
  return {
    payer: createX402Payer({
      config: x402,
      privateKey: raw as Hex,
      capUnits: cap || undefined,
      preferredChainId: Number.isInteger(preferred) ? preferred : undefined,
    }),
    endpoint,
  };
}
