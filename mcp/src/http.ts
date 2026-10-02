import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  type RpcEndpoint,
  type StrikeClient,
  createStrikeClient,
  getStrikeChain,
  rpcEndpointsFor,
  transportFromEndpoints,
} from "@strike/sdk";
import { createPublicClient, custom } from "viem";
import { createStrikeMcpServer } from "./server.js";

// The read-only Strike MCP server over Streamable HTTP, for serverless hosts (the app serves it at /api/mcp).
// Stateless: every request builds a fresh server and transport and answers with plain JSON, so no session has to
// survive between invocations. Only the read-only tools are registered, and the client never has a signer.

/** Options for {@link handleReadOnlyMcpRequest}. */
export interface ReadOnlyMcpOptions {
  /** Chain to read (default 46630, Robinhood Chain testnet). */
  chainId?: number;
  /** RPC URL (default: the chain's public RPC). Ignored when `rpcEndpoints` is set. */
  rpcUrl?: string;
  /**
   * RPC endpoints, best first, from the SDK's `rpcEndpointsFor` (Alchemy with its key in a header, then the public
   * RPC): reads fall back down the list.
   */
  rpcEndpoints?: readonly RpcEndpoint[];
  /** STRIKE_SKILL.md's text for the strike://skill resource. */
  skillText?: string;
  /** How long identical RPC reads are shared between requests, in ms (default 10 000). */
  cacheTtlMs?: number;
}

/** RPC methods whose answers may be shared for a few seconds: reads only, never anything that sends. */
const CACHEABLE = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_call",
  "eth_getBlockByNumber",
  "eth_getLogs",
  "eth_getBalance",
  "eth_getCode",
]);
const MAX_ENTRIES = 1_000;

/**
 * A viem transport that shares identical read calls for `ttlMs` (and coalesces concurrent ones), so bursts of
 * MCP calls from many agents cost the public RPC one request per distinct read instead of one per caller.
 */
export function cachedReadTransport(rpc: string | readonly RpcEndpoint[], ttlMs: number) {
  const endpoints: readonly RpcEndpoint[] =
    typeof rpc === "string" ? [{ provider: "custom", url: rpc }] : rpc;
  const upstream = transportFromEndpoints(endpoints, { retryCount: 1, timeout: 20_000 })({ retryCount: 0 });
  const cache = new Map<string, { expires: number; value: Promise<unknown> }>();
  return custom(
    {
      async request({ method, params }: { method: string; params?: unknown }) {
        if (!CACHEABLE.has(method)) {
          throw new Error(`${method} is not available on the read-only Strike endpoint`);
        }
        const key = `${method}:${JSON.stringify(params ?? [])}`;
        const now = Date.now();
        const hit = cache.get(key);
        if (hit && hit.expires > now) return hit.value;
        if (cache.size >= MAX_ENTRIES) {
          for (const [k, v] of cache) if (v.expires <= now) cache.delete(k);
          if (cache.size >= MAX_ENTRIES) cache.clear();
        }
        const value = upstream.request({ method, params } as never) as Promise<unknown>;
        const ttl = method === "eth_chainId" ? 24 * 3_600_000 : ttlMs;
        cache.set(key, { expires: now + ttl, value });
        value.catch(() => cache.delete(key));
        return value;
      },
    },
    { retryCount: 0 },
  );
}

// One read client per chain and RPC per server instance: warm serverless invocations reuse it and its cache.
const clients = new Map<string, StrikeClient>();

/**
 * A read-only Strike client (no wallet) over the caching transport. `rpc` is a URL or the SDK's endpoints (default:
 * the chain's public RPC).
 */
export function readOnlyClient(
  chainId: number,
  rpc?: string | readonly RpcEndpoint[],
  cacheTtlMs = 10_000,
): StrikeClient {
  const endpoints: readonly RpcEndpoint[] =
    typeof rpc === "string" && rpc
      ? [{ provider: "custom", url: rpc }]
      : Array.isArray(rpc) && rpc.length
        ? rpc
        : rpcEndpointsFor(chainId, {});
  // The cache key names the endpoints by provider and URL only: the key in a header never becomes a map key.
  const key = `${chainId}:${endpoints.map((e) => `${e.provider}@${e.url}`).join(",")}:${cacheTtlMs}`;
  let client = clients.get(key);
  if (!client) {
    const chain = { ...getStrikeChain(chainId), rpcUrls: { default: { http: [endpoints[0]!.url] } } };
    const publicClient = createPublicClient({ chain, transport: cachedReadTransport(endpoints, cacheTtlMs) });
    client = createStrikeClient({ publicClient, chainId });
    clients.set(key, client);
  }
  return client;
}

/**
 * Answer one MCP Streamable HTTP request with the read-only tool set. POST only: in stateless mode there is no
 * standalone SSE stream to open (GET) and no session to end (DELETE), so both get 405 as the spec allows.
 */
export async function handleReadOnlyMcpRequest(
  request: Request,
  options: ReadOnlyMcpOptions = {},
): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json(
      {
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed: this stateless endpoint takes POST only" },
        id: null,
      },
      { status: 405, headers: { Allow: "POST" } },
    );
  }
  const chainId = options.chainId ?? 46630;
  const server = createStrikeMcpServer({
    chainId,
    readOnly: true,
    skillText: options.skillText,
    client: () => readOnlyClient(chainId, options.rpcEndpoints ?? options.rpcUrl, options.cacheTtlMs),
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    // The answer is always JSON here, so accept clients that only ask for application/json too.
    const accept = request.headers.get("accept") ?? "";
    let req = request;
    if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
      const headers = new Headers(request.headers);
      headers.set("accept", "application/json, text/event-stream");
      req = new Request(request.url, { method: "POST", headers, body: await request.text() });
    }
    return await transport.handleRequest(req);
  } finally {
    await server.close();
  }
}
