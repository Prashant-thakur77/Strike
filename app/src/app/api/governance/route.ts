import { type NextRequest, NextResponse } from "next/server";
import { GovernanceCache, parseGovChain } from "@/lib/governance";
import { readGovernance } from "@/lib/governanceRead";

// GET /api/governance?chain=46630 (or 421614): who holds each privileged role on every Strike contract of the chain's
// deployments, confirmed with `hasRole` at one head after replaying the RoleGranted/RoleRevoked logs since each
// deployment block; what each role can and cannot do; and the last admin and role events with their transactions.
// One read per chain per 10 minutes on an instance, and the CDN keeps the answer as long. 400 for another chain; 502
// when the chain cannot be read.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const OK_CACHE = "public, max-age=60, s-maxage=600, stale-while-revalidate=1800";
const PARTIAL_CACHE = "public, max-age=30, s-maxage=60";
const ERROR_CACHE = "public, max-age=10, s-maxage=30";

const cache = new GovernanceCache(readGovernance);

export async function GET(req: NextRequest) {
  const parsed = parseGovChain(req.nextUrl.searchParams.get("chain"));
  if ("error" in parsed) {
    return NextResponse.json(
      { error: parsed.error },
      { status: 400, headers: { "Cache-Control": ERROR_CACHE } },
    );
  }
  const { value, error } = await cache.get(parsed.chainId);
  if (!value) {
    return NextResponse.json(
      { error: `Could not read the roles: ${error ?? "unknown error"}` },
      { status: 502, headers: { "Cache-Control": ERROR_CACHE } },
    );
  }
  return NextResponse.json(value, {
    headers: {
      "Cache-Control": value.errors.length ? PARTIAL_CACHE : OK_CACHE,
      "Access-Control-Allow-Origin": "*",
    },
  });
}
