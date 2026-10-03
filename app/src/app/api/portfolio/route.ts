import { type NextRequest, NextResponse } from "next/server";
import { PortfolioInputError, parseAddress, readPortfolio } from "@/lib/portfolioRead";

// GET /api/portfolio?address=0x…: one wallet across every Strike deployment (Robinhood Chain testnet v2 and v3,
// Arbitrum Sepolia v3). Positions, value over time, epoch-by-epoch results, options, agents, activity, what the wallet
// could do and what needs its action, all from the chains' logs (or the indexer when STRIKE_INDEXER_URL is set) and
// today's reads through Multicall3. One read per address per 30 seconds on an instance, and the CDN keeps it as long.
// Read-only: any address can be looked up, nothing is stored. 400 for a malformed address, 502 when no chain answers.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const OK_CACHE = "public, max-age=15, s-maxage=30, stale-while-revalidate=120";
const ERROR_CACHE = "public, max-age=10, s-maxage=15";

export async function GET(req: NextRequest) {
  try {
    const address = parseAddress(req.nextUrl.searchParams.get("address"));
    const body = await readPortfolio(address, req.nextUrl.searchParams.get("chain") === "31337");
    const partial = body.chains.some((c) => !c.ok);
    return NextResponse.json(body, {
      headers: { "Cache-Control": partial ? ERROR_CACHE : OK_CACHE, "Access-Control-Allow-Origin": "*" },
    });
  } catch (err) {
    const bad = err instanceof PortfolioInputError;
    const message = err instanceof Error ? err.message.split("\n")[0] : "Unexpected error";
    return NextResponse.json(
      { error: bad ? message : `Could not read the portfolio: ${message}` },
      { status: bad ? 400 : 502, headers: { "Cache-Control": ERROR_CACHE } },
    );
  }
}
