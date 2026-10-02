// Small helpers shared by the ingestion loop: RPC limit detection, backoff and bounded concurrency.

/**
 * True when an RPC error looks like a block-range or result-size limit, so the same range is retried in halves.
 * The same patterns as the app's scanner (app/src/lib/activity.ts `isRangeLimitError`), which were collected from
 * the public RPCs, Alchemy's free tier ("up to a 10 block range") and Blockscout.
 */
export function isRangeLimitError(err: unknown): boolean {
  const text =
    err instanceof Error
      ? `${err.message} ${String((err as { details?: unknown }).details ?? "")}`
      : String(err);
  return /block range|range (is )?too (large|wide|big)|range limit|exceed(s|ed)? .*range|more than \d+ (results|logs|blocks)|too many (results|logs|blocks)|limit exceeded|response size|query timeout|log response/i.test(
    text,
  );
}

/** Exponential backoff: base, 2x base, 4x base, ... capped at `maxMs`. `attempt` starts at 1. */
export function backoffMs(attempt: number, baseMs: number, maxMs = 15_000): number {
  return Math.min(baseMs * 2 ** (attempt - 1), maxMs);
}

/** Sleep that ends early (without throwing) when `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** `fn` over `items` with at most `limit` calls in flight; results in input order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/** One line about an error: viem's short message and its details (the cause of a failed request), never a URL. */
export function errorMessage(err: unknown): string {
  const e = err as { shortMessage?: unknown; details?: unknown; message?: unknown } | null;
  if (e && typeof e.shortMessage === "string") {
    const details = typeof e.details === "string" && e.details ? `: ${e.details.split("\n")[0]}` : "";
    return `${e.shortMessage}${details}`;
  }
  return (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "error";
}

export const minBig = (a: bigint, b: bigint) => (a < b ? a : b);
export const maxBig = (a: bigint, b: bigint) => (a > b ? a : b);
