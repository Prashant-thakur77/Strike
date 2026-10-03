import { type NextRequest, NextResponse } from "next/server";
import { STRIKE_CONFIG } from "@/lib/config";
import { TraceInputError, parseTraceQuery } from "@/lib/epochTraceRead";
import { getFacilitator } from "@/lib/x402/facilitator";
import { NonceLedger, handlePaidRequest } from "@/lib/x402/paywall";
import { paidRoute, routeRequirements } from "@/lib/x402/requirements";
import { ReportInputError, buildRiskReport } from "@/lib/x402/riskReport";

// GET /api/agent/risk-report?vault=0x…&chain=421614: the paid risk report, sold per call over x402 v2 (docs/ENDPOINTS.md,
// D48). Without a payment: 402 with the price in each accepted token (strike.config.json `x402`: 0.01 USDC on Arbitrum
// Sepolia, 0.01 USDG on Robinhood Chain testnet). With a PAYMENT-SIGNATURE header (X-PAYMENT also accepted): the
// authorization is verified, the report built, the payment settled on-chain, and the report returned with the
// settlement transaction in PAYMENT-RESPONSE. A bad chain or vault is a 400 before any payment; a report that cannot
// be built is not charged. Every other route stays free.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ROUTE = "riskReport";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, PAYMENT-SIGNATURE, X-PAYMENT",
};

/** Nonces this instance has taken (paywall.ts); the token's authorizationState covers other instances. */
const nonces = new NonceLedger();

export async function GET(req: NextRequest) {
  const config = STRIKE_CONFIG.x402;
  if (!config) {
    return NextResponse.json(
      { error: "this deployment sells no x402 routes" },
      { status: 404, headers: CORS },
    );
  }
  const p = req.nextUrl.searchParams;
  let target: ReturnType<typeof parseTraceQuery>;
  try {
    target = parseTraceQuery(p.get("chain") ?? "421614", p.get("vault"));
  } catch (err) {
    const message = err instanceof TraceInputError ? err.message : "invalid query";
    return NextResponse.json(
      { error: message, usage: "GET /api/agent/risk-report?vault=0x…&chain=421614|46630" },
      { status: 400, headers: { ...CORS, "Cache-Control": "no-store" } },
    );
  }
  const route = paidRoute(config, ROUTE);
  const url = new URL(req.nextUrl.pathname + req.nextUrl.search, req.nextUrl.origin).toString();
  return handlePaidRequest(req, {
    requirements: routeRequirements(config, ROUTE),
    resource: { url, description: route.description, mimeType: "application/json" },
    facilitator: getFacilitator(config),
    nonces,
    headers: CORS,
    produce: async () => {
      try {
        return { status: 200, body: await buildRiskReport(target.chainId, target.vault) };
      } catch (err) {
        const bad = err instanceof ReportInputError;
        const message = err instanceof Error ? err.message.split("\n")[0] : "unexpected error";
        return {
          status: bad ? 400 : 502,
          body: { error: bad ? message : `could not build the report: ${message}` },
        };
      }
    },
  });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: { ...CORS, "Access-Control-Max-Age": "86400" } });
}
