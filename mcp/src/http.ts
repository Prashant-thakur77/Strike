import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  type RpcEndpoint,
  type StrikeClient,
  type StrikeDeployment,
  createStrikeClient,
  deploymentsFor,
  getStrikeChain,
  loadStrikeConfig,
  rpcEndpointsFor,
  transportFromEndpoints,
} from "@strike/sdk";
import { type PublicClient, createPublicClient, custom } from "viem";
import { findDeploymentVersion, normalizeVersion } from "./deployments.js";
import { type DeploymentClient, createStrikeMcpServer } from "./server.js";

// The read-only Strike MCP server over Streamable HTTP, for serverless hosts (the app serves it at /api/mcp).
// Stateless: every request builds a fresh server and transport and answers with plain JSON, so no session has to
// survive between invocations. Only the read-only tools are registered, and the client never has a signer.
// Each request picks its chain and deployment with the URL's query: /api/mcp?chainId=421614, /api/mcp?version=v3.
// Without them it reads the default chain and every deployment there (v2 and v3 on Robinhood Chain testnet).

/** Options for {@link handleReadOnlyMcpRequest}. */
export interface ReadOnlyMcpOptions {
  /**
   * Chain to read when the request URL has no `chainId` (default: strike.config.json's defaultChainId, 46630,
   * Robinhood Chain testnet).
   */
  chainId?: number;
  /**
   * Deployment version to read ("v2", "v3") when the request URL has no `version`. Default: every deployment on the
   * chain, the SDK's default one first.
   */
  version?: string;
  /**
   * Chains a request may pick with `?chainId=` (default: every chain in strike.config.json with a deployment, except
   * the local devnet). The default chain is always allowed.
   */
  chainIds?: readonly number[];
  /** RPC URL for the default chain (default: the chain's public RPC). Ignored when `rpcEndpoints` is set. */
  rpcUrl?: string;
  /**
   * RPC endpoints, best first, from the SDK's `rpcEndpointsFor` (Alchemy with its key in a header, then the public
   * RPC): reads fall back down the list. A list applies to the default chain only (other chains read their public
   * RPC); a function gives the endpoints for whichever chain the request picks.
   */
  rpcEndpoints?: readonly RpcEndpoint[] | ((chainId: number) => readonly RpcEndpoint[]);
  /** STRIKE_SKILL.md's text for the strike://skill resource. */
  skillText?: string;
  /** How long identical RPC reads are shared between requests, in ms (default 10 000). */
  cacheTtlMs?: number;
  /** The indexer's base URL for wallet_statement (default: log scans on each chain). */
  indexerUrl?: string;
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

// One public client per chain and RPC, and one read client per deployment on it, per server instance: warm
// serverless invocations reuse them, and every deployment of a chain shares one read cache.
const publicClients = new Map<string, PublicClient>();
const clients = new Map<string, StrikeClient>();

/**
 * A read-only Strike client (no wallet) over the caching transport. `rpc` is a URL or the SDK's endpoints (default:
 * the chain's public RPC). `deployment` picks one of the chain's deployments (default: the SDK's default one).
 */
export function readOnlyClient(
  chainId: number,
  rpc?: string | readonly RpcEndpoint[],
  cacheTtlMs = 10_000,
  deployment?: StrikeDeployment,
): StrikeClient {
  const endpoints: readonly RpcEndpoint[] =
    typeof rpc === "string" && rpc
      ? [{ provider: "custom", url: rpc }]
      : Array.isArray(rpc) && rpc.length
        ? rpc
        : rpcEndpointsFor(chainId, {});
  // The cache key names the endpoints by provider and URL only: the key in a header never becomes a map key.
  const key = `${chainId}:${endpoints.map((e) => `${e.provider}@${e.url}`).join(",")}:${cacheTtlMs}`;
  const clientKey = `${key}:${deployment?.epochManager.toLowerCase() ?? "default"}`;
  let client = clients.get(clientKey);
  if (!client) {
    let publicClient = publicClients.get(key);
    if (!publicClient) {
      const chain = { ...getStrikeChain(chainId), rpcUrls: { default: { http: [endpoints[0]!.url] } } };
      publicClient = createPublicClient({
        chain,
        transport: cachedReadTransport(endpoints, cacheTtlMs),
      }) as PublicClient;
      publicClients.set(key, publicClient);
    }
    client = createStrikeClient({ publicClient, chainId, deployment });
    clients.set(clientKey, client);
  }
  return client;
}

/**
 * Read-only clients for the chain's deployments, the SDK's default one first: every deployment, or only the one
 * with `version` ("v2", "v3"). A chain without a deployment gets the default client, which throws when built.
 */
export function readOnlyClients(
  chainId: number,
  rpc?: string | readonly RpcEndpoint[],
  cacheTtlMs = 10_000,
  version?: string,
): DeploymentClient[] {
  if (version !== undefined) {
    const d = findDeploymentVersion(chainId, version);
    return [{ version: d.version ?? null, client: readOnlyClient(chainId, rpc, cacheTtlMs, d) }];
  }
  const all = deploymentsFor(chainId);
  if (!all.length) return [{ version: null, client: readOnlyClient(chainId, rpc, cacheTtlMs) }];
  return all.map((d) => ({
    version: d.version ?? null,
    client: readOnlyClient(chainId, rpc, cacheTtlMs, d),
  }));
}

/** A request's chain and deployment version did not name something this endpoint reads. */
export class McpTargetError extends Error {}

/** Chains a request may pick by default: strike.config.json's chains with a deployment, except local ones. */
export function remoteChainIds(): number[] {
  return Object.entries(loadStrikeConfig().chains)
    .filter(([id, c]) => !c.local && deploymentsFor(Number(id)).length > 0)
    .map(([id]) => Number(id));
}

/**
 * The chain and deployment version a request reads: `?chainId=` and `?version=` from its URL, else the options'.
 * Throws {@link McpTargetError} for a chain this endpoint does not read or a version the chain does not have.
 */
export function mcpTarget(
  url: string,
  options: Pick<ReadOnlyMcpOptions, "chainId" | "version" | "chainIds"> = {},
): { chainId: number; version?: string } {
  const query = new URL(url).searchParams;
  const defaultChainId = options.chainId ?? loadStrikeConfig().defaultChainId;
  const rawChain = query.get("chainId")?.trim();
  let chainId = defaultChainId;
  if (rawChain) {
    const allowed = [...new Set([defaultChainId, ...(options.chainIds ?? remoteChainIds())])];
    chainId = /^\d+$/.test(rawChain) ? Number(rawChain) : Number.NaN;
    if (!allowed.includes(chainId)) {
      throw new McpTargetError(
        `unknown chainId ${rawChain.slice(0, 24)}: this endpoint reads chains ${allowed.join(", ")}`,
      );
    }
  }
  const rawVersion = query.get("version")?.trim() || options.version;
  if (!rawVersion) return { chainId };
  const version = normalizeVersion(rawVersion);
  if (!version) throw new McpTargetError(`invalid version ${rawVersion.slice(0, 24)}: use v2 or v3`);
  findDeploymentVersion(chainId, version, (m) => new McpTargetError(m));
  return { chainId, version };
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
  let target: { chainId: number; version?: string };
  try {
    target = mcpTarget(request.url, options);
  } catch (err) {
    if (!(err instanceof McpTargetError)) throw err;
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32602, message: err.message }, id: null },
      { status: 400 },
    );
  }
  const { chainId, version } = target;
  const isDefaultChain = chainId === (options.chainId ?? loadStrikeConfig().defaultChainId);
  const rpc =
    typeof options.rpcEndpoints === "function"
      ? options.rpcEndpoints(chainId)
      : isDefaultChain
        ? (options.rpcEndpoints ?? options.rpcUrl)
        : undefined;
  let built: DeploymentClient[] | undefined;
  const deployments = () => (built ??= readOnlyClients(chainId, rpc, options.cacheTtlMs, version));
  // wallet_statement and explain_decision read other chains too: the same cached read clients, per chain.
  const rpcFor = (cid: number) =>
    typeof options.rpcEndpoints === "function"
      ? options.rpcEndpoints(cid)
      : cid === chainId
        ? rpc
        : undefined;
  const server = createStrikeMcpServer({
    chainId,
    readOnly: true,
    skillText: options.skillText,
    client: () => deployments()[0]!.client,
    deployments,
    publicClientFor: (cid) => readOnlyClient(cid, rpcFor(cid), options.cacheTtlMs).viem.publicClient,
    indexerUrl: options.indexerUrl,
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
