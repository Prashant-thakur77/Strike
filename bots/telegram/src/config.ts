import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type StrikeClient, createStrikeClient, getDeployment, getStrikeChain } from "@strike/sdk";
import { createPublicClient, http } from "viem";

/** Bot configuration from the environment. */
export interface BotConfig {
  /** TELEGRAM_BOT_TOKEN. Unset: only the dry run works. */
  token?: string;
  /** TELEGRAM_API_URL (default https://api.telegram.org): a self-hosted Bot API server, or a mock. */
  telegramApiUrl: string;
  /** STRIKE_CHAIN_ID (default 46630, Robinhood Chain testnet). */
  chainId: number;
  /** STRIKE_RPC_URL (default: the chain's public RPC). */
  rpcUrl: string;
  /** DATA_DIR (default ./data): where the state file lives. */
  dataDir: string;
  /** POLL_INTERVAL_SECONDS (default 15): how often to look for new logs. */
  pollIntervalMs: number;
  /** LOG_BLOCK_RANGE (default 50000): largest getLogs range; halved automatically when the RPC refuses. */
  logBlockRange: bigint;
  /** First block to scan when there is no stored cursor: the Strike deploy block. */
  startBlock: bigint;
  /** Block explorer base URL for tx links. */
  explorerUrl: string;
}

/** Blockscout for Robinhood Chain testnet (the chain definition's explorer is used for other chains). */
const EXPLORERS: Record<number, string> = {
  46630: "https://explorer.testnet.chain.robinhood.com",
};

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

/** Read and validate the environment. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): BotConfig {
  const chainId = positiveInt(env, "STRIKE_CHAIN_ID", 46630);
  const chain = getStrikeChain(chainId);
  const rpcUrl = env.STRIKE_RPC_URL?.trim() || chain.rpcUrls.default.http[0];
  if (!rpcUrl) throw new Error(`no RPC URL for chain ${chainId}: set STRIKE_RPC_URL`);
  const token = env.TELEGRAM_BOT_TOKEN?.trim() || undefined;
  if (token && !/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) {
    throw new Error("TELEGRAM_BOT_TOKEN does not look like a BotFather token (<digits>:<secret>)");
  }
  return {
    token,
    telegramApiUrl: (env.TELEGRAM_API_URL?.trim() || "https://api.telegram.org").replace(/\/+$/, ""),
    chainId,
    rpcUrl,
    dataDir: resolve(env.DATA_DIR?.trim() || "data"),
    pollIntervalMs: positiveInt(env, "POLL_INTERVAL_SECONDS", 15) * 1000,
    logBlockRange: BigInt(positiveInt(env, "LOG_BLOCK_RANGE", 50_000)),
    startBlock: deploymentBlock(chainId),
    explorerUrl: EXPLORERS[chainId] ?? chain.blockExplorers?.default.url ?? "",
  };
}

/** A read-only Strike client for the configuration. */
export function clientFromConfig(config: BotConfig): StrikeClient {
  const chain = { ...getStrikeChain(config.chainId), rpcUrls: { default: { http: [config.rpcUrl] } } };
  const publicClient = createPublicClient({ chain, transport: http(config.rpcUrl, { retryCount: 3 }) });
  return createStrikeClient({ publicClient, chainId: config.chainId });
}

/** Load `.env` from the working directory if there is one (Node 22's built-in loader; never overrides). */
export function loadDotEnv(path = ".env"): void {
  if (existsSync(path)) process.loadEnvFile(path);
}
