import type { FastifyInstance } from "fastify";

// A small in-process rate limiter for the HTTP API: a fixed window per client IP. Every route except /health runs
// a Postgres query, so one client looping on /events or /ready could starve the pool the others share. Over the
// limit a request gets 429 with Retry-After (seconds until its window ends) and never reaches the database.
// State is per process (a standby and the writer count separately) and bounded: expired windows are swept, and
// the table is capped at `maxClients` (the oldest windows go first).

export interface RateLimitOptions {
  /** Requests a client may make per window. 0 turns the limiter off. */
  max: number;
  windowMs: number;
  /** Most distinct clients tracked at once. */
  maxClients?: number;
  now?: () => number;
}

export interface RateDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the client's window ends (at least 1). */
  retryAfterSeconds: number;
}

export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  private readonly now: () => number;
  private readonly maxClients: number;
  private nextSweep = 0;

  constructor(private readonly o: RateLimitOptions) {
    this.now = o.now ?? Date.now;
    this.maxClients = o.maxClients ?? 10_000;
  }

  get enabled(): boolean {
    return this.o.max > 0;
  }

  /** Count one request from `key` and say whether it is allowed. */
  take(key: string): RateDecision {
    const { max, windowMs } = this.o;
    const t = this.now();
    this.sweep(t);
    let w = this.windows.get(key);
    if (!w || t - w.start >= windowMs) {
      w = { start: t, count: 0 };
      this.windows.delete(key); // re-insert last so Map order stays oldest first
      this.windows.set(key, w);
      this.evict();
    }
    const retryAfterSeconds = Math.max(1, Math.ceil((w.start + windowMs - t) / 1000));
    if (w.count >= max) return { allowed: false, limit: max, remaining: 0, retryAfterSeconds };
    w.count += 1;
    return { allowed: true, limit: max, remaining: max - w.count, retryAfterSeconds };
  }

  get size(): number {
    return this.windows.size;
  }

  private sweep(t: number): void {
    if (t < this.nextSweep) return;
    this.nextSweep = t + this.o.windowMs;
    for (const [k, w] of this.windows) {
      if (t - w.start >= this.o.windowMs) this.windows.delete(k);
      else break; // oldest first: the rest are still live
    }
  }

  private evict(): void {
    while (this.windows.size > this.maxClients) {
      const oldest = this.windows.keys().next().value;
      if (oldest === undefined) return;
      this.windows.delete(oldest);
    }
  }
}

/** Routes the limiter skips: liveness answers without the database and is what orchestrators poll. */
const EXEMPT = new Set(["/health"]);

/** Limit every route except /health, per client IP (`req.ip`, which honours X-Forwarded-For only with trustProxy). */
export function registerRateLimit(app: FastifyInstance, limiter: RateLimiter): void {
  if (!limiter.enabled) return;
  app.addHook("onRequest", async (req, reply) => {
    if (EXEMPT.has(req.routeOptions.url ?? req.url.split("?")[0] ?? "")) return;
    const d = limiter.take(req.ip);
    reply.header("RateLimit-Limit", String(d.limit));
    reply.header("RateLimit-Remaining", String(d.remaining));
    if (d.allowed) return;
    reply.header("Retry-After", String(d.retryAfterSeconds));
    return reply.code(429).send({
      error: `rate limit exceeded: ${d.limit} requests per window per client, retry in ${d.retryAfterSeconds} s`,
      requestId: req.id,
    });
  });
}
