import { NextResponse } from "next/server";
import { readUsage } from "@/lib/usage/scan";

// GET /api/stats: testnet usage counted from every deployment's logs (src/lib/usage). The CDN keeps an answer for
// 10 minutes and serves the previous one while it refreshes, so a visitor never waits on a log scan and the RPCs see
// one scan per region every 10 minutes at most. `generatedAt` says when the logs were read.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const OK_CACHE = "public, max-age=60, s-maxage=600, stale-while-revalidate=1800";

export async function GET() {
  try {
    const stats = await readUsage();
    // A partial answer (one chain's RPC failed) is cached for a minute only.
    const cache = stats.errors.length ? "public, max-age=30, s-maxage=60" : OK_CACHE;
    return NextResponse.json(stats, {
      headers: { "Cache-Control": cache, "Access-Control-Allow-Origin": "*" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message.split("\n")[0] : "Unexpected error";
    return NextResponse.json(
      { error: `Could not read the testnets: ${message}` },
      { status: 502, headers: { "Cache-Control": "public, max-age=10, s-maxage=30" } },
    );
  }
}
