import "server-only";
import { type RpcEndpoint, alchemyApiKey, rpcEndpointsFor, transportFromEndpoints } from "@strike/sdk";
import type { HttpTransportConfig, Transport } from "viem";
import { LOCAL_RPC, RPC_OVERRIDES, type AppChainId } from "../chains";

// Server side of the app's RPC: the /api/rpc proxy, /api/stats, /api/mcp and /api/option read through these. With
// ALCHEMY_API_KEY in the server environment (Vercel), Alchemy first, its key in an Authorization header; then the
// NEXT_PUBLIC_RPC_<chainId> override or the chain's public RPC. The key is read at request time, never inlined into
// a bundle, and never leaves the server.

/** The RPC endpoints for a chain, best first. The local devnet is read directly. */
export function serverRpcEndpoints(chainId: AppChainId, env: NodeJS.ProcessEnv = process.env): RpcEndpoint[] {
  if (chainId === 31337) return [{ provider: "custom", url: LOCAL_RPC }];
  return rpcEndpointsFor(chainId, {
    ALCHEMY_API_KEY: env.ALCHEMY_API_KEY,
    STRIKE_RPC_URL: RPC_OVERRIDES[chainId],
  });
}

/** A viem transport over {@link serverRpcEndpoints}, falling back down the list. */
export function serverReadTransport(chainId: AppChainId, config: HttpTransportConfig = {}): Transport {
  return transportFromEndpoints(serverRpcEndpoints(chainId), config);
}

/** The Alchemy key, for scrubbing it out of anything relayed to a caller; undefined when unset. */
export function serverRpcSecret(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return alchemyApiKey({ ALCHEMY_API_KEY: env.ALCHEMY_API_KEY });
}
