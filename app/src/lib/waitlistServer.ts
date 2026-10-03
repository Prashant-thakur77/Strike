// The waitlist route's logic (D46), with its store, clock and limiter passed in, so the Playwright specs run it without
// a network or a Blob token. app/src/app/api/waitlist/route.ts wires it to the private Vercel Blob store.
//
// Limits: request bodies up to 8 kB; 5 sign-up attempts per IP per 10 minutes (counted per server instance, in
// memory, keyed by an HMAC of the IP, so no IP is kept either); the count is cached for 60 s.
// Nothing here logs or returns an email: the store sees only the HMAC path and the ciphertext.
import { encryptJson, entryPath, hmacHex, type StoredEntry } from "./waitlistCrypto";
import { ENTRY_SCHEMA, isBot, validateEntry, type FieldErrors } from "./waitlistEntry";

export const MAX_BODY_BYTES = 8 * 1024;
export const RATE_LIMIT = { max: 5, windowMs: 10 * 60_000 } as const;
export const COUNT_TTL_MS = 60_000;

export const UNAVAILABLE = "Sign-up is temporarily unavailable. Please try again later.";

/** Where entries live. The real one is the private Vercel Blob store (waitlistBlob.ts). */
export interface WaitlistStore {
  read(path: string): Promise<StoredEntry | null>;
  write(path: string, entry: StoredEntry): Promise<void>;
  count(): Promise<number>;
}

/** A sliding-window limit per key: at most `max` hits in any `windowMs`. In memory, so per server instance. */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    readonly max: number = RATE_LIMIT.max,
    readonly windowMs: number = RATE_LIMIT.windowMs,
    private now: () => number = Date.now,
  ) {}

  /** Records a hit. `ok: false` once the key is over its limit, with the seconds until a slot frees up. */
  hit(key: string): { ok: true } | { ok: false; retryAfter: number } {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((at) => t - at < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return { ok: false, retryAfter: Math.max(1, Math.ceil((recent[0] + this.windowMs - t) / 1000)) };
    }
    recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.prune(t);
    return { ok: true };
  }

  private prune(t: number) {
    for (const [k, v] of this.hits) if (!v.some((at) => t - at < this.windowMs)) this.hits.delete(k);
  }
}

export type SignupBody =
  | { ok: true; status: "created" | "updated" }
  | { ok: false; error: string; fields?: FieldErrors; retryAfter?: number };

export interface SignupResult {
  status: number;
  body: SignupBody;
  headers?: Record<string, string>;
}

export interface SignupDeps {
  /** WAITLIST_SALT from the server environment. Missing or short: the route refuses every sign-up (fail closed). */
  salt: string | undefined;
  publicKeyPem: string;
  store: WaitlistStore | null;
  limiter: RateLimiter;
  now?: () => Date;
  onError?: (stage: "read" | "write", err: unknown) => void;
}

const fail = (status: number, error: string, extra: Partial<SignupBody> = {}): SignupResult => ({
  status,
  body: { ok: false, error, ...extra } as SignupBody,
});

/** The salt has to be long enough that the HMAC paths cannot be brute-forced from a list of emails. */
export function saltUsable(salt: string | undefined): salt is string {
  return typeof salt === "string" && salt.trim().length >= 32;
}

/** POST /api/waitlist: checks, rate-limits, encrypts and stores one sign-up. `raw` is the request body as text. */
export async function handleSignup(raw: string | null, ip: string, deps: SignupDeps): Promise<SignupResult> {
  const { salt, store } = deps;
  if (!saltUsable(salt) || !store) return fail(503, UNAVAILABLE);
  if (raw === null || new TextEncoder().encode(raw).length > MAX_BODY_BYTES)
    return fail(413, "That sign-up is too large. Shorten the note and try again.");

  const limit = deps.limiter.hit(await hmacHex(`ip:${ip}`, salt));
  if (!limit.ok)
    return {
      ...fail(429, "Too many sign-ups from this connection. Please wait a few minutes and try again.", {
        retryAfter: limit.retryAfter,
      }),
      headers: { "Retry-After": String(limit.retryAfter) },
    };

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail(400, "The sign-up could not be read. Reload the page and try again.");
  }

  // A bot filled in the hidden field: answer as if it worked, and store nothing.
  if (isBot(body)) return { status: 200, body: { ok: true, status: "created" } };

  const now = (deps.now ?? (() => new Date()))();
  const checked = validateEntry(body, now);
  if (!checked.ok) return fail(400, "Some answers need another look.", { fields: checked.errors });

  const path = await entryPath(checked.entry.email, salt);
  let existing: StoredEntry | null = null;
  try {
    existing = await store.read(path);
  } catch (err) {
    deps.onError?.("read", err);
    return fail(502, "Your sign-up could not be saved just now. Please try again.");
  }

  const stamp = now.toISOString();
  const stored = await encryptJson(checked.entry, deps.publicKeyPem, {
    v: ENTRY_SCHEMA,
    created: existing?.created ?? stamp,
    updated: stamp,
  });
  try {
    await store.write(path, stored);
  } catch (err) {
    deps.onError?.("write", err);
    return fail(502, "Your sign-up could not be saved just now. Please try again.");
  }
  return { status: 200, body: { ok: true, status: existing ? "updated" : "created" } };
}

/** The client IP as Vercel passes it: the first x-forwarded-for hop, else x-real-ip. Only ever hashed. */
export function clientIp(headers: Headers): string {
  const fwd = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || headers.get("x-real-ip")?.trim() || "unknown";
}

/** The entry count, cached for `ttlMs` per instance so a busy page lists the store at most once a minute. */
export class CountCache {
  private cached: { at: number; n: number } | null = null;
  constructor(
    private ttlMs: number = COUNT_TTL_MS,
    private now: () => number = Date.now,
  ) {}

  async get(store: WaitlistStore): Promise<number> {
    const t = this.now();
    if (this.cached && t - this.cached.at < this.ttlMs) return this.cached.n;
    const n = await store.count();
    this.cached = { at: t, n };
    return n;
  }
}

/** A store in memory, for the specs and local runs without a Blob token. */
export class MemoryStore implements WaitlistStore {
  readonly blobs = new Map<string, string>();
  async read(path: string): Promise<StoredEntry | null> {
    const raw = this.blobs.get(path);
    return raw ? (JSON.parse(raw) as StoredEntry) : null;
  }
  async write(path: string, entry: StoredEntry): Promise<void> {
    this.blobs.set(path, JSON.stringify(entry));
  }
  async count(): Promise<number> {
    return this.blobs.size;
  }
}
