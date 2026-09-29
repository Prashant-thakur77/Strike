/** Sleep for `ms`, resolving early (without throwing) when `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted || ms <= 0) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Exponential backoff: base, 2x base, 4x base, ... capped at `maxMs`. `attempt` starts at 1. */
export function backoffMs(attempt: number, baseMs: number, maxMs = 30_000): number {
  return Math.min(baseMs * 2 ** (attempt - 1), maxMs);
}

export type Sleep = (ms: number) => Promise<void>;
