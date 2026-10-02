import { type HttpTransportConfig, type Transport, fallback, http } from "viem";
import { getStrikeChain } from "./chains.js";

// Which RPC a Strike process reads and writes through. With ALCHEMY_API_KEY set, Alchemy first and the public RPC as
// the fallback; without it, STRIKE_RPC_URL or the chain's public RPC, as before.
//
// The key never goes into a URL that viem sees: `rpcEndpointsFor` and `rpcTransportFor` send it in an
// `Authorization: Bearer` header (https://www.alchemy.com/docs/how-to-use-api-keys-in-http-headers), because viem
// prints the request URL in its error messages, and those messages end up in logs, MCP tool answers and decision
// records. `rpcUrlFor` returns the key-in-path form for tools that take only a URL (cast, forge); never log it.

/** Alchemy's network name per chain: `https://<name>.g.alchemy.com/v2` (https://www.alchemy.com/rpc). */
export const ALCHEMY_NETWORKS: Readonly<Record<number, string>> = {
  4663: "robinhood-mainnet",
  46630: "robinhood-testnet",
  42161: "arb-mainnet",
  421614: "arb-sepolia",
};

/** Where an endpoint came from: Alchemy (ALCHEMY_API_KEY), STRIKE_RPC_URL, or the chain's public RPC. */
export type RpcProvider = "alchemy" | "custom" | "public";

/** One RPC endpoint. `url` never carries an API key; Alchemy's key travels in `headers`. */
export interface RpcEndpoint {
  provider: RpcProvider;
  url: string;
  headers?: Record<string, string>;
}

type Env = Record<string, string | undefined>;
const processEnv = (): Env => (globalThis as { process?: { env?: Env } }).process?.env ?? {};

// Alchemy keys are URL-safe tokens. Anything else (a pasted URL, quotes, an unexpanded "${ALCHEMY_API_KEY}") is
// ignored rather than spliced into a URL or header.
const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const ALCHEMY_URL = /^https:\/\/([a-z0-9-]+)\.g\.alchemy\.com\/v2\/([^/?#]+)\/?$/i;

/** ALCHEMY_API_KEY from `env`, trimmed, or undefined when unset or not a plausible key. */
export function alchemyApiKey(env: Env = processEnv()): string | undefined {
  const key = env.ALCHEMY_API_KEY?.trim();
  return key && KEY_PATTERN.test(key) ? key : undefined;
}

/** Alchemy's keyless endpoint for a chain (`https://robinhood-testnet.g.alchemy.com/v2`), or undefined. */
export function alchemyEndpoint(chainId: number): string | undefined {
  const network = ALCHEMY_NETWORKS[chainId];
  return network ? `https://${network}.g.alchemy.com/v2` : undefined;
}

/** The chain's public RPC (viem's chain definition), or undefined for an unknown chain. */
export function publicRpcUrl(chainId: number): string | undefined {
  try {
    return getStrikeChain(chainId).rpcUrls.default.http[0];
  } catch {
    return undefined;
  }
}

/** True for a loopback URL (a local devnet or fork). Those are never swapped for a live provider. */
export function isLocalRpcUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "::1" ||
      host === "0.0.0.0" ||
      /^127\.\d+\.\d+\.\d+$/.test(host)
    );
  } catch {
    return false;
  }
}

/** An explicit URL as an endpoint; an Alchemy URL with the key in its path is turned into header auth. */
function explicitEndpoint(url: string): RpcEndpoint {
  const m = ALCHEMY_URL.exec(url);
  if (m?.[2] && KEY_PATTERN.test(m[2])) {
    return {
      provider: "alchemy",
      url: `https://${m[1]!.toLowerCase()}.g.alchemy.com/v2`,
      headers: { Authorization: `Bearer ${m[2]}` },
    };
  }
  return { provider: "custom", url };
}

/**
 * The RPC endpoints for a chain, best first: Alchemy (when ALCHEMY_API_KEY is set and Alchemy serves the chain),
 * then STRIKE_RPC_URL, then the chain's public RPC. A loopback STRIKE_RPC_URL (a local devnet or fork) is used alone,
 * so a rehearsal never reaches a live chain. Throws when there is none (an unknown chain without STRIKE_RPC_URL).
 */
export function rpcEndpointsFor(chainId: number, env: Env = processEnv()): RpcEndpoint[] {
  const explicit = env.STRIKE_RPC_URL?.trim() || undefined;
  if (explicit && isLocalRpcUrl(explicit)) return [{ provider: "custom", url: explicit }];
  const out: RpcEndpoint[] = [];
  const key = alchemyApiKey(env);
  const alchemy = alchemyEndpoint(chainId);
  if (key && alchemy)
    out.push({ provider: "alchemy", url: alchemy, headers: { Authorization: `Bearer ${key}` } });
  if (explicit) out.push(explicitEndpoint(explicit));
  const pub = publicRpcUrl(chainId);
  if (pub) out.push({ provider: "public", url: pub });
  const seen = new Set<string>();
  const unique = out.filter((e) => {
    const id = `${e.url}|${e.headers?.Authorization ?? ""}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  if (!unique.length) throw new Error(`no RPC URL for chain ${chainId}: set STRIKE_RPC_URL`);
  return unique;
}

/**
 * One RPC URL for a chain: Alchemy's (with the key in the path) when ALCHEMY_API_KEY is set, else STRIKE_RPC_URL,
 * else the public RPC; a loopback STRIKE_RPC_URL always wins. For tools that take only a URL (cast, forge). The
 * result can contain the key: print it only through {@link redactRpcUrl}. viem clients should use
 * {@link rpcTransportFor} instead, which keeps the key out of the URL and falls back to the public RPC.
 */
export function rpcUrlFor(chainId: number, env: Env = processEnv()): string {
  const [first] = rpcEndpointsFor(chainId, env);
  const bearer = first!.headers?.Authorization?.replace(/^Bearer /, "");
  return first!.provider === "alchemy" && bearer ? `${first!.url}/${bearer}` : first!.url;
}

/** A URL safe to print: an Alchemy key in the path, credentials and query values are replaced with `***`. */
export function redactRpcUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = "***";
      u.password = "";
    }
    if (/\.alchemy\.com$/i.test(u.hostname)) u.pathname = u.pathname.replace(/^\/v2\/.+$/, "/v2/***");
    for (const k of [...u.searchParams.keys()]) u.searchParams.set(k, "***");
    return u.toString().replace(/%2A/g, "*");
  } catch {
    return "<unparseable RPC URL>";
  }
}

/** A short label for logs: "Alchemy (robinhood-testnet)", or the host of a custom or public RPC. Never the key. */
export function describeRpcEndpoint(e: RpcEndpoint): string {
  let host = "";
  try {
    host = new URL(e.url).host;
  } catch {
    host = "?";
  }
  if (e.provider === "alchemy") return `Alchemy (${host.replace(/\.g\.alchemy\.com$/i, "")})`;
  return e.provider === "public" ? `${host} (public)` : host;
}

/** "Alchemy (robinhood-testnet), falling back to rpc.testnet.chain.robinhood.com (public)", for a startup log line. */
export function describeRpc(endpoints: readonly RpcEndpoint[]): string {
  const [first, ...rest] = endpoints.map(describeRpcEndpoint);
  return rest.length ? `${first}, falling back to ${rest.join(", then ")}` : (first ?? "no RPC");
}

/**
 * A viem transport over the endpoints: one `http` transport each (Alchemy's key in a header), tried in order with
 * viem's `fallback`, which moves on for transport errors and RPC limits (Alchemy's free tier caps `eth_getLogs` at
 * 10 blocks) but never retries a revert. `config` goes to every `http` transport; its `retryCount` applies to the
 * whole fallback when there is more than one endpoint.
 */
export function transportFromEndpoints(
  endpoints: readonly RpcEndpoint[],
  config: HttpTransportConfig = {},
): Transport {
  if (!endpoints.length) throw new Error("no RPC endpoints");
  const { retryCount, ...rest } = config;
  const one = (e: RpcEndpoint, perTransport: HttpTransportConfig) =>
    http(e.url, {
      ...perTransport,
      ...(e.headers
        ? {
            fetchOptions: {
              ...perTransport.fetchOptions,
              headers: { ...(perTransport.fetchOptions?.headers as Record<string, string>), ...e.headers },
            },
          }
        : {}),
    });
  if (endpoints.length === 1) return one(endpoints[0]!, config);
  return fallback(
    endpoints.map((e) => one(e, rest)),
    retryCount === undefined ? {} : { retryCount },
  );
}

/** {@link transportFromEndpoints} over {@link rpcEndpointsFor}: Alchemy first when ALCHEMY_API_KEY is set. */
export function rpcTransportFor(
  chainId: number,
  env: Env = processEnv(),
  config: HttpTransportConfig = {},
): Transport {
  return transportFromEndpoints(rpcEndpointsFor(chainId, env), config);
}
