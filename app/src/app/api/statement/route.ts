import { getStrikeChain, parseStatementQuery, statement, statementCsv } from "@strike/sdk";
import { createPublicClient, type PublicClient } from "viem";
import type { AppChainId } from "@/lib/chains";
import { serverReadTransport } from "@/lib/rpc/server";
import { RateLimiter, handleStatementRequest } from "@/lib/statementRoute";

// GET /api/statement?address=0x…&from=2026-10-01&to=2026-10-31&format=csv|json: every Strike event of a wallet on
// every deployment (Robinhood Chain testnet v2 and v3, Arbitrum Sepolia v3), with totals per token and the `cast`
// commands that check each row type. The SDK's `statement` builds it, from the indexer when STRIKE_INDEXER_URL is set,
// else from log scans on each chain (Alchemy first when the server has ALCHEMY_API_KEY). A wallet's history is reused
// for a minute on an instance and the CDN keeps the answer for five; each client IP gets STATEMENT_RATE_LIMIT requests
// a minute (default 20).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const clients = new Map<number, PublicClient>();
function publicClientFor(chainId: number): PublicClient {
  let pc = clients.get(chainId);
  if (!pc) {
    pc = createPublicClient({
      chain: getStrikeChain(chainId),
      transport: serverReadTransport(chainId as AppChainId, { retryCount: 1, timeout: 20_000 }),
    }) as PublicClient;
    clients.set(chainId, pc);
  }
  return pc;
}

const limiter = new RateLimiter(Number(process.env.STATEMENT_RATE_LIMIT ?? 20), 60_000);

export function GET(req: Request) {
  return handleStatementRequest(req, {
    limiter,
    parseQuery: parseStatementQuery,
    toCsv: statementCsv,
    read: (address, { from, to }) =>
      statement(address, {
        from,
        to,
        publicClientFor,
        indexerUrl: process.env.STRIKE_INDEXER_URL || null,
        cacheTtlMs: 60_000,
      }),
  });
}
