import { auditMirror } from "@strike/sdk";
import { type NextRequest, NextResponse } from "next/server";
import { RPC_OVERRIDES } from "@/lib/chains";
import { MirrorAuditCache, type MirrorChainId, parseMirrorChain } from "@/lib/mirrorAudit";

// GET /api/mirror-audit?chain=46630 (or 421614): the price mirror audit. Every round of the chain's MirrorFeeds checked
// against Robinhood Chain mainnet Chainlink by the SDK's auditMirror (the same check as scripts/verify-mirror.mjs).
// One audit per chain per 10 minutes on an instance, and the CDN keeps the answer as long, serving the previous one
// while it refreshes. A mismatch is a 200 with `ok: false`: the audit worked, the prices did not pass.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const OK_CACHE = "public, max-age=60, s-maxage=600, stale-while-revalidate=1800";
const ERROR_CACHE = "public, max-age=10, s-maxage=30";

// The server's RPCs: Alchemy when ALCHEMY_API_KEY is set (key in a header), then the NEXT_PUBLIC_RPC_<chainId>
// override or the public RPC; mainnet also falls back to its second public RPC (the SDK's mirrorRpcEndpoints).
const cache = new MirrorAuditCache((chainId: MirrorChainId) =>
  auditMirror({
    chainId,
    env: { ALCHEMY_API_KEY: process.env.ALCHEMY_API_KEY, STRIKE_RPC_URL: RPC_OVERRIDES[chainId] },
  }),
);

export async function GET(req: NextRequest) {
  const parsed = parseMirrorChain(req.nextUrl.searchParams.get("chain"));
  if ("error" in parsed) {
    return NextResponse.json(
      { error: parsed.error },
      { status: 400, headers: { "Cache-Control": ERROR_CACHE } },
    );
  }
  const { value, error } = await cache.get(parsed.chainId);
  if (!value) {
    return NextResponse.json(
      { error: `Could not run the price mirror audit: ${error ?? "unknown error"}` },
      { status: 502, headers: { "Cache-Control": ERROR_CACHE } },
    );
  }
  return NextResponse.json(value, {
    headers: { "Cache-Control": OK_CACHE, "Access-Control-Allow-Origin": "*" },
  });
}
