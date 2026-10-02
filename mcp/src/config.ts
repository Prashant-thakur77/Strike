import {
  type RpcEndpoint,
  type StrikeClient,
  createStrikeClient,
  getStrikeChain,
  rpcEndpointsFor,
  transportFromEndpoints,
} from "@strike/sdk";
import { type Hex, createPublicClient, createWalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/** Server configuration from the environment. */
export interface StrikeMcpConfig {
  /** STRIKE_CHAIN_ID (default 46630, Robinhood Chain testnet). */
  chainId: number;
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

/** Read and validate the STRIKE_* environment variables. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): StrikeMcpConfig {
  const chainId = Number(env.STRIKE_CHAIN_ID ?? 46630);
  if (!Number.isInteger(chainId) || chainId <= 0)
    throw new Error(`invalid STRIKE_CHAIN_ID: ${env.STRIKE_CHAIN_ID}`);
  const rpcEndpoints = rpcEndpointsFor(chainId, env);
  const readOnly = env.STRIKE_MCP_READ_ONLY === "1" || env.STRIKE_MCP_READ_ONLY === "true";
  const key = readOnly ? undefined : env.STRIKE_AGENT_PRIVATE_KEY?.trim();
  if (key && !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("STRIKE_AGENT_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key");
  }
  return {
    chainId,
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
    return createStrikeClient({ publicClient, walletClient, chainId: config.chainId });
  } catch (err) {
    throw new Error(
      `${err instanceof Error ? err.message : String(err)}. Deploy Strike there and run \`node scripts/export-abis.mjs\`, or set STRIKE_CHAIN_ID to a deployed chain (31337 for the local devnet: scripts/demo-local.sh).`,
    );
  }
}
