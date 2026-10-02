import { type NextRequest, NextResponse } from "next/server";
import { TraceInputError, parseTraceQuery, readTrace } from "@/lib/epochTraceRead";

// GET /api/epoch-trace?chain=46630&vault=0x…: the vault page's epoch trace. The current and the last epoch of a vault,
// each step with its transaction and the evidence it carries, built from one scan of the vault's, its EpochManager's,
// its StockOracle's and its DecisionLog's logs. One read per vault per minute on an instance, and the CDN keeps it as
// long. 400 for a chain without a deployment or an address that is not a vault there; 502 when the chain cannot be read.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const OK_CACHE = "public, max-age=30, s-maxage=60, stale-while-revalidate=300";
const ERROR_CACHE = "public, max-age=10, s-maxage=30";

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  try {
    const { chainId, vault } = parseTraceQuery(p.get("chain"), p.get("vault"));
    const trace = await readTrace(chainId, vault);
    return NextResponse.json(trace, {
      headers: { "Cache-Control": OK_CACHE, "Access-Control-Allow-Origin": "*" },
    });
  } catch (err) {
    const bad = err instanceof TraceInputError;
    const message = err instanceof Error ? err.message.split("\n")[0] : "Unexpected error";
    return NextResponse.json(
      { error: bad ? message : `Could not read the epoch trace: ${message}` },
      { status: bad ? 400 : 502, headers: { "Cache-Control": ERROR_CACHE } },
    );
  }
}
