import { handleReadOnlyMcpRequest } from "@strike/mcp/http";
import { rpcEndpointsFor } from "@strike/sdk";
import { RPC_OVERRIDES } from "@/lib/chains";
import { SKILL_MD } from "@/lib/skill";

// Read-only Strike MCP server over Streamable HTTP: POST /api/mcp. Stateless (a fresh server per request, JSON
// answers, no sessions), read tools only, no signer. ?chainId=46630|421614 picks the chain (default 46630) and
// ?version=v2|v3 one deployment on it (default: all of them). Chain reads are shared for a few seconds per instance,
// and go to Alchemy first when the server has ALCHEMY_API_KEY (key in a header), then STRIKE_MCP_RPC_URL (46630) or
// NEXT_PUBLIC_RPC_<chainId>, then the public RPC.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CHAIN_ID = 46630;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  headers.set("Cache-Control", "no-store");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

async function handle(request: Request): Promise<Response> {
  try {
    const res = await handleReadOnlyMcpRequest(request, {
      chainId: CHAIN_ID,
      rpcEndpoints: (chainId) =>
        rpcEndpointsFor(chainId, {
          ALCHEMY_API_KEY: process.env.ALCHEMY_API_KEY,
          STRIKE_RPC_URL:
            (chainId === CHAIN_ID && process.env.STRIKE_MCP_RPC_URL) ||
            (RPC_OVERRIDES as Record<number, string | undefined>)[chainId] ||
            undefined,
        }),
      skillText: SKILL_MD,
      indexerUrl: process.env.STRIKE_INDEXER_URL || undefined,
    });
    return withCors(res);
  } catch (err) {
    console.error("mcp endpoint:", err);
    return withCors(
      Response.json(
        { jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null },
        { status: 500 },
      ),
    );
  }
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
