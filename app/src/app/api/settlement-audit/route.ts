import { type NextRequest, NextResponse } from "next/server";
import { TraceInputError, parseTraceQuery, readSettlementAudit } from "@/lib/epochTraceRead";

// GET /api/settlement-audit?chain=46630&vault=0x…: each series of a vault and the price round it settled at (or, once
// expired, will settle at), checked against Robinhood Chain mainnet Chainlink by the SDK's auditSettlement, the same
// check as `node scripts/verify-mirror.mjs --chain <id> --settlement <vault>`. One run per vault per 10 minutes on an
// instance, and the CDN keeps the answer as long. 400 for another chain or an address that is not a vault; 502 when
// the chains cannot be read.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const OK_CACHE = "public, max-age=60, s-maxage=600, stale-while-revalidate=1800";
const ERROR_CACHE = "public, max-age=10, s-maxage=30";

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  try {
    const { chainId, vault } = parseTraceQuery(p.get("chain"), p.get("vault"));
    const audit = await readSettlementAudit(chainId, vault);
    return NextResponse.json(audit, {
      headers: { "Cache-Control": OK_CACHE, "Access-Control-Allow-Origin": "*" },
    });
  } catch (err) {
    const bad = err instanceof TraceInputError;
    const message = err instanceof Error ? err.message.split("\n")[0] : "Unexpected error";
    return NextResponse.json(
      { error: bad ? message : `Could not run the settlement check: ${message}` },
      { status: bad ? 400 : 502, headers: { "Cache-Control": ERROR_CACHE } },
    );
  }
}
