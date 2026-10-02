import { type HttpTransportConfig, type Transport, fallback, http } from "viem";
import { RPC_OVERRIDES, getAppChain, type AppChainId } from "../chains";
import { PROXY_CHAIN_IDS } from "./proxy";

/**
 * Whether this build's browsers read through /api/rpc, the server-side Alchemy proxy. next.config.ts sets it at build
 * time from whether ALCHEMY_API_KEY is set (only this flag reaches the bundle, never the key); without a key,
 * browsers keep reading the public RPC directly instead of funnelling every visitor through the server's IP.
 */
export const RPC_PROXY = process.env.NEXT_PUBLIC_STRIKE_RPC_PROXY === "1";

/** The proxy's path for a chain. */
export const rpcProxyPath = (chainId: number) => `/api/rpc/${chainId}`;

/** The direct RPC for a chain: the NEXT_PUBLIC_RPC_<chainId> override, else the chain's public RPC. */
export function directRpcUrl(chainId: AppChainId): string | undefined {
  return RPC_OVERRIDES[chainId] ?? getAppChain(chainId).rpcUrls.default.http[0];
}

/**
 * The read transport for a chain in the browser: the proxy first (Alchemy behind it, the public RPC as its fallback)
 * and the direct RPC if the proxy itself fails; just the direct RPC when the build has no proxy, on the server, and
 * on the local devnet. Wallet writes never use it: they go through the wallet's own provider.
 */
export function readTransport(chainId: AppChainId, config: HttpTransportConfig = {}): Transport {
  const direct = directRpcUrl(chainId);
  if (!RPC_PROXY || !PROXY_CHAIN_IDS.includes(chainId) || typeof window === "undefined")
    return http(direct, config);
  const { retryCount, ...rest } = config;
  const batch = rest.batch
    ? { ...(typeof rest.batch === "object" ? rest.batch : {}), batchSize: 50 } // within the proxy's MAX_BATCH
    : undefined;
  // The proxy may try two upstreams in turn, so it gets longer than one RPC call would.
  const proxy = http(rpcProxyPath(chainId), { ...rest, batch, timeout: Math.max(rest.timeout ?? 0, 25_000) });
  return fallback([proxy, http(direct, rest)], retryCount === undefined ? {} : { retryCount });
}
