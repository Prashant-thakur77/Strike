import type { WalletStatement, parseStatementQuery } from "@strike/sdk";

// GET /api/statement?address=0x…&from=&to=&format=csv|json: a wallet's Strike statement (the SDK's `statement`,
// sdk/src/statement.ts, holds the logic: rows, totals, the cast checks, CSV). This file is the HTTP side only: the
// query, a per-client rate limit, cache headers and the CSV download. The SDK's functions come in through `deps` (the
// Playwright specs load as CommonJS and cannot import the SDK), so the specs drive it with a fake reader.

/** Fixed-window request counter per client key (the caller's IP). */
export class RateLimiter {
  private hits = new Map<string, { start: number; count: number }>();

  constructor(
    readonly max: number,
    readonly windowMs: number,
  ) {}

  /** Seconds to wait when `key` is over the limit, else 0 (and the request is counted). */
  take(key: string, now = Date.now()): number {
    if (this.max <= 0) return 0;
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) if (now - v.start >= this.windowMs) this.hits.delete(k);
    }
    const h = this.hits.get(key);
    if (!h || now - h.start >= this.windowMs) {
      this.hits.set(key, { start: now, count: 1 });
      return 0;
    }
    if (h.count >= this.max) return Math.max(1, Math.ceil((h.start + this.windowMs - now) / 1000));
    h.count += 1;
    return 0;
  }
}

/** The caller's IP as the platform reports it (Vercel sets x-forwarded-for), else "anonymous". */
export function clientKey(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || req.headers.get("x-real-ip")?.trim() || "anonymous";
}

export interface StatementRouteDeps {
  read: (address: string, opts: { from: number | null; to: number | null }) => Promise<WalletStatement>;
  limiter: RateLimiter;
  /** The SDK's parseStatementQuery (throws a StatementInputError for a bad query). */
  parseQuery: typeof parseStatementQuery;
  /** The SDK's statementCsv. */
  toCsv: (s: WalletStatement) => string;
}

/** A bad request (the SDK's StatementInputError), told apart by name so this file needs no SDK import. */
const isInputError = (err: unknown) => err instanceof Error && err.name === "StatementInputError";

const OK_CACHE = "public, max-age=60, s-maxage=300, stale-while-revalidate=600";
const PARTIAL_CACHE = "public, max-age=15, s-maxage=30";
const ERROR_CACHE = "no-store";

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  Response.json(body, {
    status,
    headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": ERROR_CACHE, ...headers },
  });

/** Answer one statement request: 400 for a bad query, 429 over the rate limit, 502 when no chain could be read. */
export async function handleStatementRequest(req: Request, deps: StatementRouteDeps): Promise<Response> {
  let q: ReturnType<typeof parseStatementQuery>;
  try {
    q = deps.parseQuery(new URL(req.url).searchParams);
  } catch (err) {
    if (isInputError(err)) return json({ error: (err as Error).message }, 400);
    throw err;
  }
  const wait = deps.limiter.take(clientKey(req));
  if (wait > 0) {
    return json({ error: `Too many statement requests: try again in ${wait} s` }, 429, {
      "Retry-After": String(wait),
    });
  }
  let s: WalletStatement;
  try {
    s = await deps.read(q.address, { from: q.from, to: q.to });
  } catch (err) {
    if (isInputError(err)) return json({ error: (err as Error).message }, 400);
    const message = err instanceof Error ? err.message.split("\n")[0] : "Unexpected error";
    return json({ error: `Could not read the statement: ${message}` }, 502);
  }
  if (s.errors.length > 0 && s.sources.length === 0) {
    return json({ error: "Could not read any chain", errors: s.errors }, 502);
  }
  const cache = s.errors.length ? PARTIAL_CACHE : OK_CACHE;
  if (q.format === "csv") {
    const day = s.generatedAt.slice(0, 10);
    return new Response(deps.toCsv(s), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="strike-statement-${s.address}-${day}.csv"`,
        "Cache-Control": cache,
        "Access-Control-Allow-Origin": "*",
      },
    });
  }
  return json(s, 200, { "Cache-Control": cache });
}
