import type { Address } from "viem";
import { bundledStrikeConfig } from "./config.generated.js";

// strike.config.json, at the repository root, is the one place that names Strike's chains, endpoints, deployment
// files, services and secret variables (docs/configuration.md). Every component reads it: the SDK through
// loadStrikeConfig(), the shell scripts through jq (scripts/config.sh), the bot, the MCP server, the example agent
// and the app through the SDK. In Node, loadStrikeConfig() reads the file itself (STRIKE_CONFIG, else the nearest
// strike.config.json above the working directory); in a browser, the npm package or anywhere without a file, it
// returns the copy that scripts/export-abis.mjs bundles into the SDK (src/config.generated.ts). A test fails when
// that copy and the file differ.

/** One chain: display names, endpoints, deployment files and how the keeper and the indexer treat it. */
export interface StrikeChainConfig {
  /** Display name, e.g. "Robinhood Chain testnet" (the app's network menu). viem's chain `name` is kept as is. */
  name: string;
  /** Short display name, e.g. "RH testnet". */
  shortName: string;
  testnet: boolean;
  /** A local devnet (31337): its deployment files are written by scripts/demo-local.sh and are not in git. */
  local?: boolean;
  /** Block explorer base URL (`<explorer>/tx/<hash>`), or null where there is none. */
  explorer: string | null;
  /** Blockscout API that contracts are verified against (`forge --verifier-url`). */
  verifierUrl?: string;
  /** Where testers get the chain's gas token. */
  faucet?: string;
  rpc: {
    /** The keyless public RPC. */
    public: string;
    /** Alchemy's base URL without the key (`https://<network>.g.alchemy.com/v2`), or null. */
    alchemy: string | null;
  };
  /** Deployment files (repository paths), the primary first. Each has a `<file>-vaults.json` beside it. */
  deployments: string[];
  /** The chain whose Chainlink rounds the testnet MirrorFeeds copy (scripts/keeper.sh), e.g. "4663". */
  mainnetFeedsChain?: string;
  /** Blocks after which an event is treated as final (the indexer's reorg-safe cursor). */
  confirmations: number;
  /** The Graph network names for the chain (subgraph/scripts/set-network.mjs). */
  subgraphNetworks?: string[];
  /** Stock tokens and their Chainlink feeds on the chain, by symbol (the keeper's mirror source, the app's monitor). */
  stocks?: Record<string, { token: Address; feed: Address }>;
}

/** Roles of the secrets Strike reads; the config maps each to an environment variable name. */
export type StrikeSecretRole =
  | "deployerKey"
  | "agentSignerKey"
  | "alchemyKey"
  | "telegramToken"
  | "databaseUrl"
  | "testDatabaseUrl"
  | "postgresPassword"
  | "keeperKey"
  | "agentKey"
  | "agent2Key"
  | "anthropicKey"
  | "claudeCodeToken"
  | "arbiscanKey"
  | "githubToken"
  | "blobToken"
  | "waitlistSalt"
  | "x402RelayerKey"
  | "x402PayerKey"
  | "gasRelayerKey"
  | "gasDripSalt";

/** One token an x402 paid endpoint accepts (an EIP-3009 stablecoin) and its EIP-712 domain. */
export interface StrikeX402Asset {
  chainId: number;
  address: Address;
  symbol: string;
  decimals: number;
  /** The token's EIP-712 domain name and version; its DOMAIN_SEPARATOR must match them. */
  eip712Name: string;
  eip712Version: string;
}

/** x402 paid endpoints (docs/ENDPOINTS.md): prices, accepted tokens and the payee. Public values only. */
export interface StrikeX402Config {
  /** x402 protocol version: headers PAYMENT-REQUIRED, PAYMENT-SIGNATURE and PAYMENT-RESPONSE. */
  version: 2;
  /** EIP-3009 transferWithAuthorization for the exact price. */
  scheme: "exact";
  /** "self": the app verifies and settles with its own relayer key (secrets.x402RelayerKey); else a facilitator URL. */
  facilitator: string;
  /** Who receives the payments. */
  payTo: Address;
  /** How long a signed payment stays valid, in seconds (default 120). */
  maxTimeoutSeconds?: number;
  /** Default total an agent may pay in one run, in token units ("0.05"). */
  agentRunCap?: string;
  /** Paid routes by name: path, price per call in token units ("0.01") and what the caller gets. */
  routes: Record<string, { path: string; price: string; description: string }>;
  /** Accepted tokens, the preferred first. */
  assets: StrikeX402Asset[];
}

/** strike.config.json (version 1). */
export interface StrikeConfig {
  version: 1;
  /** The chain used when STRIKE_CHAIN_ID is unset. */
  defaultChainId: number;
  /** By chain id (as a string, JSON's only key type). */
  chains: Record<string, StrikeChainConfig>;
  services: {
    app: string;
    mcp: string;
    indexer: { port: number };
    telegramBot: string;
    /** Unused fallback: a team-run Google Forms or Tally sign-up link, or "". /waitlist has its own form since D46. */
    waitlistForm: string;
    repository: string;
  };
  /** x402 paid endpoints; absent when the deployment sells nothing. */
  x402?: StrikeX402Config;
  /** Environment variable NAMES by role. Never values. */
  secrets: Record<StrikeSecretRole, string>;
}

/** The file's name, at the repository root. */
export const STRIKE_CONFIG_FILE = "strike.config.json";

export interface LoadStrikeConfigOptions {
  /** Read this file instead of searching. STRIKE_CONFIG in `env` does the same. */
  path?: string;
  /** Where the search for strike.config.json starts (default: the working directory), walking up to the root. */
  cwd?: string;
  /** Environment for STRIKE_CONFIG (default: process.env). */
  env?: Record<string, string | undefined>;
  /** false: never read the filesystem; return the bundled copy. */
  fs?: boolean;
}

interface NodeFs {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: "utf8"): string;
}
interface NodePath {
  resolve(...paths: string[]): string;
  dirname(path: string): string;
  join(...paths: string[]): string;
}
interface NodeProcess {
  env?: Record<string, string | undefined>;
  cwd?(): string;
  getBuiltinModule?(id: string): unknown;
}

const nodeProcess = (): NodeProcess | undefined => (globalThis as { process?: NodeProcess }).process;

/** node:fs and node:path when running in Node (22.3+), without a static import that would break browser bundles. */
function nodeModules(): { fs: NodeFs; path: NodePath } | null {
  const proc = nodeProcess();
  if (typeof proc?.getBuiltinModule !== "function" || typeof proc.cwd !== "function") return null;
  try {
    const fs = proc.getBuiltinModule("node:fs") as NodeFs | undefined;
    const path = proc.getBuiltinModule("node:path") as NodePath | undefined;
    return fs?.readFileSync && path?.resolve ? { fs, path } : null;
  } catch {
    return null;
  }
}

/**
 * The strike.config.json loadStrikeConfig() would read: `options.path` or STRIKE_CONFIG, else the nearest one above
 * the working directory. null outside Node or when there is none (the bundled copy is used then).
 */
export function locateStrikeConfig(options: LoadStrikeConfigOptions = {}): string | null {
  if (options.fs === false) return null;
  const node = nodeModules();
  if (!node) return null;
  const env = options.env ?? nodeProcess()?.env ?? {};
  const explicit = options.path ?? (env.STRIKE_CONFIG?.trim() || undefined);
  if (explicit) return node.path.resolve(explicit);
  let dir = node.path.resolve(options.cwd ?? nodeProcess()!.cwd!());
  for (;;) {
    const file = node.path.join(dir, STRIKE_CONFIG_FILE);
    if (node.fs.existsSync(file)) return file;
    const up = node.path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * A public sign-up form link (Google Forms or Tally): `services.waitlistForm` holds one or "". A Google Forms id is a
 * long random-looking string, so the long-string check skips this field when the value is such a link.
 */
export const WAITLIST_FORM_URL = /^https:\/\/(docs\.google\.com\/forms\/|forms\.gle\/|tally\.so\/)[^\s@]+$/;

/** Patterns of secret values, with what they are. Checked against every string in the config. */
const SECRET_PATTERNS: [RegExp, string][] = [
  [/0x[0-9a-fA-F]{64}/, "a 32-byte hex key"],
  [/\d{5,}:[A-Za-z0-9_-]{30,}/, "a Telegram bot token"],
  [/[a-z][a-z0-9+.-]*:\/\/[^/\s@]*:[^/\s@]*@/i, "credentials in a URL"],
  [/\.alchemy\.com\/v2\/[^\s/?#]+/i, "an Alchemy key in a URL"],
  [/[?&][^=&#]*(key|token|secret|password|auth)[^=&#]*=/i, "a key in a query string"],
  [/\bsk-[A-Za-z0-9_-]{10,}/, "an API key (sk-...)"],
  [/\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/, "a GitHub token"],
  [/^([a-z]+\s+){11,23}[a-z]+$/, "a mnemonic"],
];

/**
 * Paths of values in a config that look like secrets (a key, a token, credentials or a key in a URL, a mnemonic, a
 * long random string, or a `secrets` entry that is not an environment variable name), each with the reason. The
 * values themselves are never returned, so an error message cannot leak one.
 */
export function secretLikeValues(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => secretLikeValues(v, `${path}[${i}]`));
  if (isObject(value))
    return Object.entries(value).flatMap(([k, v]) => secretLikeValues(v, path ? `${path}.${k}` : k));
  if (typeof value !== "string") return [];
  if (/^secrets\./.test(path) && !/^[A-Z][A-Z0-9_]*$/.test(value))
    return [`${path} (not an environment variable name)`];
  const hit = SECRET_PATTERNS.find(([re]) => re.test(value));
  if (hit) return [`${path} (${hit[1]})`];
  if (path === "services.waitlistForm" && WAITLIST_FORM_URL.test(value)) return [];
  const long = value
    .split(/[\s/:?#&=@.]+/)
    .some((part) => part.length >= 32 && /^[A-Za-z0-9_+-]+$/.test(part) && !/^0x[0-9a-fA-F]{40}$/.test(part));
  return long ? [`${path} (a long random string)`] : [];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
const isUrl = (v: unknown, local = false) =>
  typeof v === "string" && (local ? /^https?:\/\/[^\s@]+$/ : /^https:\/\/[^\s@]+$/).test(v);

/**
 * Checks the shape loadStrikeConfig() relies on and returns the config typed, or throws with every problem found.
 * The full JSON Schema (strike.config.schema.json) is checked by the SDK's tests; this is the runtime guard.
 */
export function validateStrikeConfig(raw: unknown, origin = STRIKE_CONFIG_FILE): StrikeConfig {
  const problems: string[] = [];
  const fail = (msg: string) => problems.push(msg);
  if (!isObject(raw)) throw new Error(`${origin}: not a JSON object`);
  if (raw.version !== 1) fail(`version must be 1 (got ${JSON.stringify(raw.version)})`);
  if (!isObject(raw.chains) || !Object.keys(raw.chains).length) fail("chains must be a non-empty object");
  else {
    for (const [id, c] of Object.entries(raw.chains)) {
      const at = `chains.${id}`;
      if (!/^[1-9]\d*$/.test(id)) fail(`${at}: a chain id must be a positive integer`);
      if (!isObject(c)) {
        fail(`${at}: not an object`);
        continue;
      }
      if (typeof c.name !== "string" || !c.name) fail(`${at}.name is required`);
      if (c.explorer !== null && !isUrl(c.explorer)) fail(`${at}.explorer must be an https URL or null`);
      if (!isObject(c.rpc) || !isUrl(c.rpc.public, true)) fail(`${at}.rpc.public must be an http(s) URL`);
      else if (
        c.rpc.alchemy !== null &&
        !/^https:\/\/[a-z0-9-]+\.g\.alchemy\.com\/v2$/.test(String(c.rpc.alchemy))
      )
        fail(`${at}.rpc.alchemy must be https://<network>.g.alchemy.com/v2 (no key) or null`);
      if (!Array.isArray(c.deployments) || c.deployments.some((f) => typeof f !== "string"))
        fail(`${at}.deployments must be a list of file paths`);
      if (!Number.isInteger(c.confirmations) || (c.confirmations as number) < 0)
        fail(`${at}.confirmations must be a non-negative integer`);
      if (
        c.mainnetFeedsChain !== undefined &&
        !isObject((raw.chains as Record<string, unknown>)[String(c.mainnetFeedsChain)])
      )
        fail(`${at}.mainnetFeedsChain ${JSON.stringify(c.mainnetFeedsChain)} is not a chain of this file`);
    }
    if (!isObject(raw.chains[String(raw.defaultChainId)]))
      fail(`defaultChainId ${raw.defaultChainId} is not in chains`);
  }
  if (!isObject(raw.services)) fail("services must be an object");
  else if (
    raw.services.waitlistForm !== undefined &&
    raw.services.waitlistForm !== "" &&
    !WAITLIST_FORM_URL.test(String(raw.services.waitlistForm))
  )
    fail('services.waitlistForm must be "" or an https Google Forms or Tally link');
  if (!isObject(raw.secrets)) fail("secrets must be an object");
  else {
    for (const [role, name] of Object.entries(raw.secrets)) {
      if (typeof name !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(name))
        fail(`secrets.${role} must be an environment variable NAME (A-Z, 0-9, _), never a value`);
    }
  }
  for (const p of secretLikeValues(raw))
    fail(`${p} looks like a secret: the file holds environment variable names only`);
  if (problems.length) throw new Error(`${origin} is invalid:\n  - ${problems.join("\n  - ")}`);
  return raw as unknown as StrikeConfig;
}

const cache = new Map<string, StrikeConfig>();

/**
 * strike.config.json, typed and validated. In Node: the file at `options.path` or STRIKE_CONFIG, else the nearest
 * strike.config.json above the working directory; a file that exists but is invalid throws. Without one (a browser,
 * the npm package, an edge runtime, or `fs: false`): the copy bundled into the SDK when it was generated.
 */
export function loadStrikeConfig(options: LoadStrikeConfigOptions = {}): StrikeConfig {
  const file = locateStrikeConfig(options);
  if (!file) return bundledStrikeConfig;
  const hit = cache.get(file);
  if (hit) return hit;
  const { fs } = nodeModules()!;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (isObject(raw)) delete raw.$schema;
  const config = validateStrikeConfig(raw, file);
  cache.set(file, config);
  return config;
}

/** The config's entry for a chain, or undefined. */
export function strikeChainConfig(
  chainId: number | string,
  config: StrikeConfig = loadStrikeConfig(),
): StrikeChainConfig | undefined {
  return config.chains[String(chainId)];
}

/** The chain's block explorer base URL from the config, or null (no explorer, unknown chain). */
export function strikeExplorerUrl(
  chainId: number | string,
  config: StrikeConfig = loadStrikeConfig(),
): string | null {
  return strikeChainConfig(chainId, config)?.explorer ?? null;
}

/** The environment variable that holds a secret, e.g. strikeSecretName("alchemyKey") === "ALCHEMY_API_KEY". */
export function strikeSecretName(role: StrikeSecretRole, config: StrikeConfig = loadStrikeConfig()): string {
  return config.secrets[role];
}
