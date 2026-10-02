import { NextResponse } from "next/server";
import { readStatus } from "@/lib/statusRead";

// GET /api/status: is Strike running by itself? Per testnet, each MirrorFeed's latest round against the Robinhood
// Chain mainnet Chainlink print it copies, each deployment's vaults (epoch state, next expiry, last settlement and its
// transaction), and whether the keeper and weekly-agent schedules are switched on (GitHub's run list; optional
// GITHUB_TOKEN raises its rate limit). One read per 5 minutes on an instance, and the CDN keeps the answer as long.
// Ages are left to the reader: `updatedAt` and `blockTime` are unix seconds, `generatedAt` says when it was read.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const OK_CACHE = "public, max-age=60, s-maxage=300, stale-while-revalidate=900";

export async function GET() {
  try {
    const status = await readStatus();
    const partial = status.chains.some((c) => c.errors.length);
    return NextResponse.json(status, {
      headers: {
        "Cache-Control": partial ? "public, max-age=30, s-maxage=60" : OK_CACHE,
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message.split("\n")[0] : "Unexpected error";
    return NextResponse.json(
      { error: `Could not read the status: ${message}` },
      { status: 502, headers: { "Cache-Control": "public, max-age=10, s-maxage=30" } },
    );
  }
}
