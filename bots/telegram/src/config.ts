import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  type RpcEndpoint,
  type StrikeClient,
  createStrikeClient,
  deploymentsFor,
  getDeployment,
  getStrikeChain,
  loadStrikeConfig,
  rpcEndpointsFor,
  strikeExplorerUrl,
  strikeSecretName,
  transportFromEndpoints,
} from "@strike/sdk";
import { type PublicClient, createPublicClient } from "viem";

/** One chain the bot reads: every Strike deployment on it is covered. */
export interface ChainSetting {
  chainId: number;
  /** The SDK's `rpcEndpointsFor`: Alchemy when ALCHEMY_API_KEY is set, then (primary chain only) STRIKE_RPC_URL, then the public RPC. */
  rpcEndpoints: RpcEndpoint[];
  /** Block explorer base URL for tx links (strike.config.json's `explorer` for the chain). */
  explorerUrl: string;
}

/** Bot configuration from the environment. */
export interface BotConfig {
  /** TELEGRAM_BOT_TOKEN. Unset: only the dry run works. */
  token?: string;
  /** TELEGRAM_API_URL (default https://api.telegram.org): a self-hosted Bot API server, or a mock. */
  telegramApiUrl: string;
  /**
   * STRIKE_CHAIN_ID (default: strike.config.json's defaultChainId, 46630, Robinhood Chain testnet): the primary
   * chain. Its state file keeps the subscribers, and its first deployment keeps the legacy `cursor`.
   */
  chainId: number;
  /**
   * Every chain the bot reads, the primary first: STRIKE_CHAIN_IDS (comma-separated), else each chain in
   * strike.config.json that has a deployment and is not `local`. A local primary chain (31337) is read alone.
   */
  chains: ChainSetting[];
  /** The first RPC endpoint's URL, for display. Never carries an API key (Alchemy's goes in a header). */
  rpcUrl: string;
  /** The SDK's `rpcEndpointsFor`: Alchemy when ALCHEMY_API_KEY is set, then STRIKE_RPC_URL, then the public RPC. */
  rpcEndpoints: RpcEndpoint[];
  /** DATA_DIR (default ./data): where the state file lives. */
  dataDir: string;
  /** POLL_INTERVAL_SECONDS (default 15): how often to look for new logs. */
  pollIntervalMs: number;
  /** WATCH_INTERVAL_SECONDS (default 60): how often each watched wallet is read for /watch alerts. */
  watchIntervalMs: number;
  /** strike.config.json's services.app: the "act in the app" link. */
  appUrl: string;
  /** LOG_BLOCK_RANGE (default 50000): largest getLogs range; halved automatically when the RPC refuses. */
  logBlockRange: bigint;
  /** First block to scan when there is no stored cursor: the Strike deploy block. */
  startBlock: bigint;
  /** Block explorer base URL for tx links (strike.config.json's `explorer` for the chain). */
  explorerUrl: string;
}

/**
 * The block Strike was deployed at on a chain. The SDK's generated deployments carry it (from
 * contracts/deployments/<chainId>.json) but its `StrikeDeployment` type does not expose it, so read it here.
 */
export function deploymentBlock(chainId: number): bigint {
  const block = (getDeployment(chainId) as { block?: number | string }).block;
  return block === undefined ? 0n : BigInt(block);
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`invalid ${name}: ${raw}`);
  return n;
}

/** Read and validate the environment (defaults, the explorer and the token's variable from strike.config.json). */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): BotConfig {
  const chainId = positiveInt(env, "STRIKE_CHAIN_ID", loadStrikeConfig().defaultChainId);
  getStrikeChain(chainId); // an unknown chain fails here
  const rpcEndpoints = rpcEndpointsFor(chainId, env);
  const explorerOf = (id: number) =>
    strikeExplorerUrl(id) ?? getStrikeChain(id).blockExplorers?.default.url ?? "";
  const tokenEnv = strikeSecretName("telegramToken"); // TELEGRAM_BOT_TOKEN
  const token = env[tokenEnv]?.trim() || undefined;
  if (token && !/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) {
    throw new Error(`${tokenEnv} does not look like a BotFather token (<digits>:<secret>)`);
  }
  const chains: ChainSetting[] = chainIdsFor(chainId, env).map((id) => ({
    chainId: id,
    // STRIKE_RPC_URL names the primary chain's endpoint; the other chains use Alchemy (if keyed) and their public RPC.
    rpcEndpoints: id === chainId ? rpcEndpoints : rpcEndpointsFor(id, { ...env, STRIKE_RPC_URL: undefined }),
    explorerUrl: explorerOf(id),
  }));
  return {
    token,
    telegramApiUrl: (env.TELEGRAM_API_URL?.trim() || "https://api.telegram.org").replace(/\/+$/, ""),
    chainId,
    chains,
    rpcUrl: rpcEndpoints[0]!.url,
    rpcEndpoints,
    dataDir: resolve(env.DATA_DIR?.trim() || "data"),
    pollIntervalMs: positiveInt(env, "POLL_INTERVAL_SECONDS", 15) * 1000,
    watchIntervalMs: positiveInt(env, "WATCH_INTERVAL_SECONDS", 60) * 1000,
    appUrl: loadStrikeConfig().services.app,
    logBlockRange: BigInt(positiveInt(env, "LOG_BLOCK_RANGE", 50_000)),
    startBlock: deploymentBlock(chainId),
    explorerUrl: explorerOf(chainId),
  };
}

/** The chains to read, the primary first (see {@link BotConfig.chains}). */
function chainIdsFor(primary: number, env: NodeJS.ProcessEnv): number[] {
  const raw = env.STRIKE_CHAIN_IDS?.trim();
  let ids: number[];
  if (raw) {
    ids = raw.split(",").map((part) => {
      const n = Number(part.trim());
      if (!Number.isInteger(n) || n <= 0) throw new Error(`invalid STRIKE_CHAIN_IDS entry: ${part.trim()}`);
      getStrikeChain(n); // unknown chains fail here, by id
      return n;
    });
  } else {
    const config = loadStrikeConfig();
    const primaryIsLocal = config.chains[String(primary)]?.local === true;
    ids = primaryIsLocal
      ? []
      : Object.entries(config.chains)
          .filter(([id, c]) => !c.local && deploymentsFor(Number(id)).length > 0)
          .map(([id]) => Number(id));
  }
  return [primary, ...ids.filter((id) => id !== primary)];
}

/** A viem public client for a chain over the bot's RPC endpoints. */
export function publicClientFor(setting: ChainSetting): PublicClient {
  const chain = {
    ...getStrikeChain(setting.chainId),
    rpcUrls: { default: { http: [setting.rpcEndpoints[0]!.url] } },
  };
  const transport = transportFromEndpoints(setting.rpcEndpoints, { retryCount: 3 });
  return createPublicClient({ chain, transport }) as PublicClient;
}

/** A read-only Strike client for the primary chain's default deployment (what the bot read before it covered every deployment). */
export function clientFromConfig(config: BotConfig): StrikeClient {
  return createStrikeClient({ publicClient: publicClientFor(config.chains[0]!), chainId: config.chainId });
}

/** Load `.env` from the working directory if there is one (Node 22's built-in loader; never overrides). */
export function loadDotEnv(path = ".env"): void {
  if (existsSync(path)) process.loadEnvFile(path);
}
