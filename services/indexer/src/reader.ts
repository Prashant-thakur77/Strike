import { describeRpc, getStrikeChain, rpcEndpointsFor, transportFromEndpoints } from "@strike/sdk";
import { type Hex, type PublicClient, createPublicClient } from "viem";
import type { RawLog } from "./abi.js";
import { createRpcFetch } from "./net.js";

/** A block header: what the indexer keeps to detect reorgs and to date events. */
export interface ChainBlock {
  number: bigint;
  hash: Hex;
  parentHash: Hex;
  timestamp: bigint;
}

/** What the indexer reads from a chain. The live implementation is viem over the SDK's RPC endpoints. */
export interface ChainReader {
  readonly chainId: number;
  /** For logs: which RPC answers (never an API key). */
  readonly description: string;
  getBlockNumber(): Promise<bigint>;
  /** The chain's `finalized` block, or null when the RPC does not serve the tag. */
  getFinalizedBlockNumber(): Promise<bigint | null>;
  getBlock(number: bigint): Promise<ChainBlock>;
  /** Logs of `addresses` in [fromBlock, toBlock]. */
  getLogs(addresses: readonly Hex[], fromBlock: bigint, toBlock: bigint): Promise<RawLog[]>;
}

/**
 * The environment the SDK's `rpcEndpointsFor` sees for one chain: Alchemy first when ALCHEMY_API_KEY is set, then
 * RPC_URL_<chainId> (as STRIKE_RPC_URL), then the chain's public RPC. A single STRIKE_RPC_URL is not used here,
 * because this process reads several chains.
 */
export function rpcEnvFor(chainId: number, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, STRIKE_RPC_URL: env[`RPC_URL_${chainId}`]?.trim() || undefined };
}

/** One connection pool and DNS cache for every RPC client of the process (src/net.ts). */
let sharedFetch: typeof fetch | null = null;

/** A viem public client for a chain over the SDK's endpoints (the key, if any, in a header). */
export function publicClientFor(
  chainId: number,
  env: NodeJS.ProcessEnv = process.env,
): {
  client: PublicClient;
  description: string;
} {
  const endpoints = rpcEndpointsFor(chainId, rpcEnvFor(chainId, env));
  const client = createPublicClient({
    chain: getStrikeChain(chainId),
    transport: transportFromEndpoints(endpoints, {
      retryCount: 2,
      timeout: 30_000,
      fetchFn: (sharedFetch ??= createRpcFetch()),
    }),
  }) as PublicClient;
  return { client, description: describeRpc(endpoints) };
}

export function viemChainReader(
  chainId: number,
  env: NodeJS.ProcessEnv = process.env,
): ChainReader & {
  client: PublicClient;
} {
  const { client, description } = publicClientFor(chainId, env);
  return {
    chainId,
    description,
    client,
    getBlockNumber: () => client.getBlockNumber({ cacheTime: 0 }),
    async getFinalizedBlockNumber() {
      try {
        return (await client.getBlock({ blockTag: "finalized" })).number;
      } catch {
        return null;
      }
    },
    async getBlock(number) {
      const b = await client.getBlock({ blockNumber: number });
      if (!b.hash) throw new Error(`block ${number} has no hash yet`);
      return { number: b.number, hash: b.hash, parentHash: b.parentHash, timestamp: b.timestamp };
    },
    async getLogs(addresses, fromBlock, toBlock) {
      const logs = await client.getLogs({ address: [...addresses], fromBlock, toBlock });
      return logs.flatMap((l) =>
        l.removed || l.blockHash === null || l.blockNumber === null || l.transactionHash === null
          ? []
          : [
              {
                address: l.address,
                topics: l.topics as Hex[],
                data: l.data,
                blockNumber: l.blockNumber,
                blockHash: l.blockHash,
                transactionHash: l.transactionHash,
                transactionIndex: l.transactionIndex ?? 0,
                logIndex: l.logIndex ?? 0,
              },
            ],
      );
    },
  };
}
