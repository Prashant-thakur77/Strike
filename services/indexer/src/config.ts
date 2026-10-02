import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getStrikeChain } from "@strike/sdk";
import { isAddress } from "viem";
import { CHAIN_LABELS } from "./meta.js";

// What to index: chains and their deployments. Read from strike.config.json at the repository root when it exists
// (the shared config every component is moving to), else from the deployment records the app counts:
// contracts/deployments/{46630,46630-v3,421614}.json and their -vaults.json files.

/** The deployment records /api/stats counts, in its order, used when there is no strike.config.json. */
export const DEFAULT_DEPLOYMENT_FILES = [
  "contracts/deployments/46630.json",
  "contracts/deployments/46630-v3.json",
  "contracts/deployments/421614.json",
] as const;

export type ContractKind =
  "epochManager" | "vaultFactory" | "agentRegistry" | "decisionLog" | "vault" | "mirrorFeed";

export interface WatchedContract {
  /** Lowercase address. */
  address: string;
  kind: ContractKind;
  /** Stock symbol of a feed, or the vault's key in the -vaults.json file. */
  label?: string;
}

export interface DeploymentSpec {
  /** `<chainId>-<version>`, the app's /api/stats key. */
  id: string;
  chainId: number;
  version: string;
  /** Record the deployment was read from, relative to the root. */
  file: string;
  /** Deployment block: logs are read from here. */
  deployBlock: bigint;
  usdg: string;
  stockOracle: string;
  epochManager: string;
  vaultFactory: string;
  agentRegistry: string;
  decisionLog?: string;
  /** EpochManager, VaultFactory, AgentRegistry, DecisionLog, the MirrorFeeds and the vaults listed in -vaults.json. */
  contracts: WatchedContract[];
}

export interface ChainSpec {
  chainId: number;
  name: string;
  short: string;
  explorer: string;
  deployments: DeploymentSpec[];
}

export interface IndexerSpec {
  /** "strike.config.json" or "contracts/deployments". */
  source: string;
  root: string;
  chains: ChainSpec[];
  /** services.indexer.port from strike.config.json, when set. */
  port?: number;
}

type Json = Record<string, unknown>;

const lower = (a: unknown, what: string): string => {
  if (typeof a !== "string" || !isAddress(a, { strict: false }))
    throw new Error(`${what}: not an address (${a})`);
  return a.toLowerCase();
};

const readJson = (path: string): Json => JSON.parse(readFileSync(path, "utf8")) as Json;

/** The repository root: STRIKE_ROOT, else the nearest directory up from `from` with strike.config.json or contracts/deployments. */
export function findRoot(from: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): string {
  if (env.STRIKE_ROOT?.trim()) return resolve(env.STRIKE_ROOT.trim());
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, "strike.config.json")) || existsSync(join(dir, "contracts/deployments")))
      return dir;
    const up = dirname(dir);
    if (up === dir)
      throw new Error(`no strike.config.json or contracts/deployments above ${from}: set STRIKE_ROOT`);
    dir = up;
  }
}

/** One deployment record (contracts/deployments/<name>.json) and its -vaults.json, when there is one. */
export function readDeployment(root: string, file: string, ordinalChainId?: number): DeploymentSpec {
  const path = isAbsolute(file) ? file : join(root, file);
  const d = readJson(path);
  const chainId = Number(d.chainId ?? ordinalChainId);
  if (!Number.isInteger(chainId) || chainId <= 0) throw new Error(`${file}: no chainId`);
  const version = typeof d.version === "string" && d.version ? d.version : "v?";
  const block = d.block;
  if (typeof block !== "number" || !Number.isInteger(block) || block < 0)
    throw new Error(`${file}: no deploy block`);

  const epochManager = lower(d.epochManager, `${file} epochManager`);
  const vaultFactory = lower(d.vaultFactory, `${file} vaultFactory`);
  const agentRegistry = lower(d.agentRegistry, `${file} agentRegistry`);
  const decisionLog = d.decisionLog ? lower(d.decisionLog, `${file} decisionLog`) : undefined;
  const contracts: WatchedContract[] = [
    { address: epochManager, kind: "epochManager" },
    { address: vaultFactory, kind: "vaultFactory" },
    { address: agentRegistry, kind: "agentRegistry" },
  ];
  if (decisionLog) contracts.push({ address: decisionLog, kind: "decisionLog" });
  const stocks = (d.stocks ?? {}) as Record<string, { feed?: unknown }>;
  for (const [symbol, s] of Object.entries(stocks)) {
    if (s.feed)
      contracts.push({ address: lower(s.feed, `${file} ${symbol} feed`), kind: "mirrorFeed", label: symbol });
  }
  const vaultsPath = path.replace(/\.json$/, "-vaults.json");
  if (existsSync(vaultsPath)) {
    for (const [key, v] of Object.entries(readJson(vaultsPath))) {
      if (typeof v === "string" && isAddress(v, { strict: false }) && key !== "agentSigner") {
        contracts.push({ address: v.toLowerCase(), kind: "vault", label: key });
      }
    }
  }
  return {
    id: `${chainId}-${version}`,
    chainId,
    version,
    file: isAbsolute(file) ? file : file.replace(/^\.\//, ""),
    deployBlock: BigInt(block),
    usdg: lower(d.usdg, `${file} usdg`),
    stockOracle: lower(d.stockOracle, `${file} stockOracle`),
    epochManager,
    vaultFactory,
    agentRegistry,
    decisionLog,
    contracts,
  };
}

const explorerOf = (chainId: number): string => {
  try {
    return getStrikeChain(chainId).blockExplorers?.default.url ?? "";
  } catch {
    return "";
  }
};

/** A deployments entry of strike.config.json: a path, or an object with `file` or `path`. */
const deploymentPath = (entry: unknown): string | null => {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object") {
    const o = entry as Json;
    const p = o.file ?? o.path;
    if (typeof p === "string") return p;
  }
  return null;
};

/**
 * Feeds shared by two deployments of a chain (v2 and v3 on 46630 read the same five MirrorFeeds) are watched once,
 * by the first deployment that lists them. A vault listed twice is kept by the first deployment too.
 */
function dedupeContracts(chains: ChainSpec[]): void {
  for (const chain of chains) {
    const seen = new Set<string>();
    for (const dep of chain.deployments) {
      dep.contracts = dep.contracts.filter((c) => {
        if (seen.has(c.address)) return false;
        seen.add(c.address);
        return true;
      });
    }
  }
}

/** Chains and deployments to index. `chains` limits it to those chain ids (INDEXER_CHAINS). */
export function loadIndexerSpec(
  opts: { root?: string; chains?: number[]; env?: NodeJS.ProcessEnv } = {},
): IndexerSpec {
  const env = opts.env ?? process.env;
  const root = opts.root ?? findRoot(process.cwd(), env);
  const configPath = env.STRIKE_CONFIG?.trim()
    ? resolve(env.STRIKE_CONFIG.trim())
    : join(root, "strike.config.json");
  const wanted = opts.chains?.length ? new Set(opts.chains) : null;
  let spec: IndexerSpec;

  if (existsSync(configPath)) {
    const cfg = readJson(configPath);
    if (cfg.version !== 1) throw new Error(`${configPath}: unsupported version ${String(cfg.version)}`);
    const chains: ChainSpec[] = [];
    for (const [id, raw] of Object.entries((cfg.chains ?? {}) as Record<string, Json>)) {
      const chainId = Number(id);
      const files = Array.isArray(raw.deployments) ? raw.deployments.map(deploymentPath) : [];
      const deployments = files
        .filter((f): f is string => f !== null)
        .map((f) => readDeployment(root, f, chainId))
        .filter((d) => d.chainId === chainId);
      if (!deployments.length) continue; // e.g. 4663: the mainnet feeds chain, no Strike deployment
      // A local devnet (31337, `local: true`) only when asked for by INDEXER_CHAINS: a hosted indexer cannot reach it.
      if (raw.local === true && !wanted?.has(chainId)) continue;
      chains.push({
        chainId,
        name: typeof raw.name === "string" ? raw.name : (CHAIN_LABELS[chainId]?.name ?? `Chain ${chainId}`),
        short: CHAIN_LABELS[chainId]?.short ?? (typeof raw.name === "string" ? raw.name : String(chainId)),
        explorer: typeof raw.explorer === "string" ? raw.explorer.replace(/\/+$/, "") : explorerOf(chainId),
        deployments,
      });
    }
    const services = (cfg.services ?? {}) as Json;
    const port = Number((services.indexer as Json | undefined)?.port);
    spec = {
      source: "strike.config.json",
      root,
      chains,
      ...(Number.isInteger(port) && port > 0 ? { port } : {}),
    };
  } else {
    const byChain = new Map<number, ChainSpec>();
    for (const file of DEFAULT_DEPLOYMENT_FILES) {
      const dep = readDeployment(root, file);
      let chain = byChain.get(dep.chainId);
      if (!chain) {
        chain = {
          chainId: dep.chainId,
          name: CHAIN_LABELS[dep.chainId]?.name ?? `Chain ${dep.chainId}`,
          short: CHAIN_LABELS[dep.chainId]?.short ?? String(dep.chainId),
          explorer: explorerOf(dep.chainId),
          deployments: [],
        };
        byChain.set(dep.chainId, chain);
      }
      chain.deployments.push(dep);
    }
    spec = { source: "contracts/deployments", root, chains: [...byChain.values()] };
  }
  if (wanted) spec.chains = spec.chains.filter((c) => wanted.has(c.chainId));
  dedupeContracts(spec.chains);
  const ids = spec.chains.flatMap((c) => c.deployments.map((d) => d.id));
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new Error(`two deployments with the id ${dup}: give them different versions`);
  return spec;
}

/** Runtime settings from the environment. */
export interface Settings {
  databaseUrl: string;
  host: string;
  port: number;
  /** Blocks behind the head that are indexed (CONFIRMATIONS, default 5). */
  confirmations: bigint;
  pollIntervalMs: number;
  /** Largest getLogs range (LOG_MAX_RANGE, default 500000); halved on an RPC range or size limit. */
  maxRange: bigint;
  /** /ready fails when a chain is further behind its head than this (READY_MAX_LAG_BLOCKS, default 1000). */
  readyMaxLagBlocks: number;
  /** /ready fails when the head was last read longer ago than this (READY_MAX_HEAD_AGE_SECONDS, default 300). */
  readyMaxHeadAgeSeconds: number;
  /** How often vault values are read (TVL_INTERVAL_SECONDS, default 300; 0 turns it off). */
  tvlIntervalMs: number;
  /** INDEXER_CHAINS, e.g. "46630,421614"; empty means every configured chain. */
  chains: number[];
  logLevel: string;
  shutdownTimeoutMs: number;
  poolMax: number;
  /** Requests per client IP per window on every route but /health (RATE_LIMIT_MAX, default 120; 0 turns it off). */
  rateLimitMax: number;
  /** The window (RATE_LIMIT_WINDOW_SECONDS, default 60). */
  rateLimitWindowMs: number;
  /** Read the client IP from X-Forwarded-For (TRUST_PROXY=true), for an instance behind a reverse proxy. */
  trustProxy: boolean;
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min = 0): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`invalid ${name}: ${raw}`);
  return n;
}

function boolEnv(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw || raw === "false" || raw === "0") return false;
  if (raw === "true" || raw === "1") return true;
  throw new Error(`invalid ${name}: ${raw} (true or false)`);
}

export function settingsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  spec?: Pick<IndexerSpec, "port">,
): Settings {
  const chains = (env.INDEXER_CHAINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const n = Number(s);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`invalid INDEXER_CHAINS entry: ${s}`);
      return n;
    });
  return {
    databaseUrl: env.DATABASE_URL?.trim() ?? "",
    host: env.HOST?.trim() || "0.0.0.0",
    port: intEnv(env, "PORT", spec?.port ?? 8787, 1),
    confirmations: BigInt(intEnv(env, "CONFIRMATIONS", 5)),
    pollIntervalMs: intEnv(env, "POLL_INTERVAL_SECONDS", 10, 1) * 1000,
    maxRange: BigInt(intEnv(env, "LOG_MAX_RANGE", 500_000, 1)),
    readyMaxLagBlocks: intEnv(env, "READY_MAX_LAG_BLOCKS", 1000),
    readyMaxHeadAgeSeconds: intEnv(env, "READY_MAX_HEAD_AGE_SECONDS", 300, 1),
    tvlIntervalMs: intEnv(env, "TVL_INTERVAL_SECONDS", 300) * 1000,
    chains,
    logLevel: env.LOG_LEVEL?.trim() || "info",
    shutdownTimeoutMs: intEnv(env, "SHUTDOWN_TIMEOUT_SECONDS", 25, 1) * 1000,
    poolMax: intEnv(env, "PGPOOL_MAX", 10, 1),
    rateLimitMax: intEnv(env, "RATE_LIMIT_MAX", 120),
    rateLimitWindowMs: intEnv(env, "RATE_LIMIT_WINDOW_SECONDS", 60, 1) * 1000,
    trustProxy: boolEnv(env, "TRUST_PROXY"),
  };
}
