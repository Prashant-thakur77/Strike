import { isAppChainId, type AppChainId } from "@/lib/chains";
import {
  MAX_BODY_BYTES,
  PROXY_CHAIN_IDS,
  RpcCache,
  UpstreamHealth,
  proxyRpc,
  readBodyLimited,
  type RpcResponse,
} from "@/lib/rpc/proxy";
import { serverRpcEndpoints, serverRpcSecret } from "@/lib/rpc/server";

// POST /api/rpc/<chainId>: the app's read-only JSON-RPC proxy (46630, 421614, 4663). With ALCHEMY_API_KEY in the
// server environment it forwards to Alchemy (the key in an Authorization header, never sent to the browser) and falls
// back to the public RPC when Alchemy errors, rate-limits or refuses a call; without it, straight to the public RPC.
// Only the read methods in lib/rpc/proxy.ts pass: wallets send their own transactions. Batches up to 100 calls,
// bodies up to 256 kB; calls pinned to a block are reused for 30 s per instance, and an upstream that gave no answer
// is skipped for 30 s. No CORS headers: other sites' pages cannot read the answers.
// GET /api/rpc/<chainId>: which provider answers now ({ chainId, provider: "alchemy" | "public" }), for the
// "RPC: Alchemy" note on /app/proof.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const cache = new RpcCache();
const health = new UpstreamHealth();

type Params = { params: Promise<{ chainId: string }> };

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

const rpcError = (code: number, message: string): RpcResponse => ({
  jsonrpc: "2.0",
  id: null,
  error: { code, message },
});

async function chainOf(params: Params["params"]): Promise<AppChainId | null> {
  const { chainId } = await params;
  const id = Number(chainId);
  return /^\d+$/.test(chainId) && PROXY_CHAIN_IDS.includes(id) && isAppChainId(id) ? id : null;
}

export async function POST(request: Request, { params }: Params): Promise<Response> {
  const chainId = await chainOf(params);
  if (chainId === null) return json(rpcError(-32601, "Unknown chain"), 404);
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return json(rpcError(-32600, "Request body too large"), 413);
  }
  const raw = await readBodyLimited(request.body, MAX_BODY_BYTES);
  if (raw === null) return json(rpcError(-32600, "Request body too large"), 413);

  const secret = serverRpcSecret();
  const result = await proxyRpc(raw, {
    upstreams: serverRpcEndpoints(chainId),
    cache,
    health,
    cacheScope: String(chainId),
    secrets: secret ? [secret] : [],
    onUpstreamError: (provider, reason) =>
      console.warn(`rpc proxy ${chainId}: ${provider} failed (${reason})`),
  });
  return json(result.body, result.status, { "X-Strike-Rpc": result.served });
}

// The provider check behind GET: one eth_chainId through Alchemy alone, kept for a minute per instance.
const probes = new Map<number, { at: number; ok: boolean }>();

async function alchemyAnswers(chainId: AppChainId): Promise<boolean> {
  const hit = probes.get(chainId);
  if (hit && Date.now() - hit.at < 60_000) return hit.ok;
  const alchemy = serverRpcEndpoints(chainId).filter((e) => e.provider === "alchemy");
  let ok = false;
  if (alchemy.length) {
    const res = await proxyRpc(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), {
      upstreams: alchemy,
      timeoutMs: 5_000,
    });
    const body = res.body as RpcResponse;
    ok = typeof body.result === "string" && Number(body.result) === chainId;
  }
  probes.set(chainId, { at: Date.now(), ok });
  return ok;
}

export async function GET(_request: Request, { params }: Params): Promise<Response> {
  const chainId = await chainOf(params);
  if (chainId === null) return json({ error: "Unknown chain" }, 404);
  const provider = (await alchemyAnswers(chainId)) ? "alchemy" : "public";
  return json({ chainId, provider }, 200, { "Cache-Control": "public, max-age=60, s-maxage=60" });
}
