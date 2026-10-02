// The core of /api/rpc/[chainId]: a read-only JSON-RPC proxy for the app's chain reads. The route hands it the raw
// body and the upstreams (Alchemy with its key in a header, then the public RPC); it answers each request from a
// short cache when the call is pinned to a block, refuses anything outside READ_METHODS, and forwards the rest to
// the upstreams in order, moving on when one is down, rate-limited or refuses (Alchemy's free tier caps eth_getLogs
// at 10 blocks), but never past a revert, which is the chain's answer. No imports, so the Playwright specs test it
// directly with a mock fetch.

/** Methods the proxy forwards: reads only. Wallets send their own transactions, so nothing here can send one. */
export const READ_METHODS: ReadonlySet<string> = new Set([
  "eth_call",
  "eth_getLogs",
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_chainId",
  "eth_getTransactionReceipt",
  "eth_getBalance",
  "eth_getCode",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_feeHistory",
  "eth_maxPriorityFeePerGas",
  "eth_getTransactionByHash",
  "eth_getStorageAt",
  "net_version",
]);

/** Chains the proxy serves: the app's live networks (the local devnet is read directly). */
export const PROXY_CHAIN_IDS: readonly number[] = [46630, 421614, 4663];

/** Largest request body, in bytes. The app's biggest batch (a vault list) is a few tens of kB. */
export const MAX_BODY_BYTES = 256 * 1024;
/** Most calls in one batch. The app's transports send at most 50. */
export const MAX_BATCH = 100;
/** How long a call pinned to a block (or a log range ending at a numbered block) is reused. */
export const PINNED_TTL_MS = 30_000;
/** eth_chainId and net_version never change for a chain. */
const CONSTANT_TTL_MS = 24 * 3_600_000;
/** Answers larger than this are not kept. */
const MAX_CACHED_BYTES = 128 * 1024;
const MAX_CACHE_ENTRIES = 500;
/** Per-upstream deadline, so a hung upstream leaves time for the next one. */
export const UPSTREAM_TIMEOUT_MS = 10_000;
/**
 * Largest upstream answer relayed (Vercel functions answer at most 4.5 MB). A bigger one, in practice a wide
 * eth_getLogs, gets a "response size" error, which the app's log scans answer by halving their range.
 */
export const MAX_UPSTREAM_BYTES = 4 * 1024 * 1024;
/** How long an upstream that gave no answer at all (timeout, connection error, non-JSON) is skipped. */
export const UPSTREAM_COOLDOWN_MS = 30_000;

export type UpstreamProvider = "alchemy" | "custom" | "public";

/** An RPC to forward to. `url` carries no key; Alchemy's goes in `headers`. */
export interface Upstream {
  provider: UpstreamProvider;
  url: string;
  headers?: Record<string, string>;
}

type Id = string | number | null;
interface RpcRequest {
  jsonrpc: "2.0";
  id: Id;
  method: string;
  params?: unknown[];
}
export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}
export interface RpcResponse {
  jsonrpc: "2.0";
  id: Id;
  result?: unknown;
  error?: RpcError;
}

export interface ProxyResult {
  status: number;
  body: RpcResponse | RpcResponse[];
  /** Who answered: the providers that served at least one call ("alchemy", "public", "alchemy+public"), "cache", or "none". */
  served: string;
}

const errorResponse = (id: Id, code: number, message: string): RpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

/** A small per-instance cache with expiry, bounded in entries. */
export class RpcCache {
  private entries = new Map<string, { expires: number; value: unknown }>();
  constructor(
    private readonly maxEntries = MAX_CACHE_ENTRIES,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): { value: unknown } | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expires <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return { value: hit.value };
  }

  set(key: string, value: unknown, ttlMs: number): void {
    if (this.entries.size >= this.maxEntries) {
      const now = this.now();
      for (const [k, v] of this.entries) if (v.expires <= now) this.entries.delete(k);
      // Still full: drop the oldest entries (Map keeps insertion order).
      for (const k of this.entries.keys()) {
        if (this.entries.size < this.maxEntries) break;
        this.entries.delete(k);
      }
    }
    this.entries.set(key, { expires: this.now() + ttlMs, value });
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * A per-instance circuit breaker: an upstream that gave no answer is skipped for a while, so an Alchemy outage costs
 * one timeout per instance, not one per request. The last upstream (the public RPC) is always tried.
 */
export class UpstreamHealth {
  private downUntil = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now) {}

  isDown(up: Upstream): boolean {
    return (this.downUntil.get(up.url) ?? 0) > this.now();
  }

  markDown(up: Upstream, ms = UPSTREAM_COOLDOWN_MS): void {
    this.downUntil.set(up.url, this.now() + ms);
  }

  markUp(up: Upstream): void {
    this.downUntil.delete(up.url);
  }
}

const HEX_QUANTITY = /^0x[0-9a-f]{1,64}$/i;
const isPinnedTag = (tag: unknown): boolean =>
  (typeof tag === "string" && HEX_QUANTITY.test(tag)) ||
  (typeof tag === "object" &&
    tag !== null &&
    (typeof (tag as { blockHash?: unknown }).blockHash === "string" ||
      typeof (tag as { blockNumber?: unknown }).blockNumber === "string"));

/**
 * How long a call may be reused, or 0. Only calls whose answer cannot change: eth_call at a numbered block or hash,
 * eth_getLogs over a numbered range or a block hash, and the chain id. Nothing at "latest", so a read right after
 * a transaction never sees the state before it.
 */
export function cacheTtl(method: string, params: unknown[] | undefined): number {
  if (method === "eth_chainId" || method === "net_version") return CONSTANT_TTL_MS;
  if (method === "eth_call") return isPinnedTag(params?.[1]) ? PINNED_TTL_MS : 0;
  if (method === "eth_getLogs") {
    const f = params?.[0] as { fromBlock?: unknown; toBlock?: unknown; blockHash?: unknown } | undefined;
    if (!f || typeof f !== "object") return 0;
    if (typeof f.blockHash === "string") return PINNED_TTL_MS;
    return isPinnedTag(f.fromBlock) && isPinnedTag(f.toBlock) ? PINNED_TTL_MS : 0;
  }
  return 0;
}

/**
 * True for an error that is the chain's answer (a revert, out of gas, a bad nonce): every upstream would say the
 * same, so it goes back to the caller. Anything else (rate limits, range limits, unsupported networks, internal
 * errors) is the provider's, and the next upstream is tried.
 */
export function isChainError(error: RpcError | undefined): boolean {
  if (!error) return false;
  if (error.code === 3) return true;
  return /revert|out of gas|insufficient funds|gas required exceeds|intrinsic gas|invalid opcode|nonce too/i.test(
    error.message ?? "",
  );
}

function validate(item: unknown): { ok: true; req: RpcRequest } | { ok: false; res: RpcResponse } {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    return { ok: false, res: errorResponse(null, -32600, "Invalid request") };
  }
  const r = item as Record<string, unknown>;
  const id = r.id;
  const validId = typeof id === "string" || typeof id === "number" || id === null;
  if (!validId || r.jsonrpc !== "2.0" || typeof r.method !== "string") {
    return { ok: false, res: errorResponse(validId ? (id as Id) : null, -32600, "Invalid request") };
  }
  if (r.params !== undefined && !Array.isArray(r.params)) {
    return { ok: false, res: errorResponse(id as Id, -32602, "params must be an array") };
  }
  if (!READ_METHODS.has(r.method)) {
    return {
      ok: false,
      res: errorResponse(
        id as Id,
        -32601,
        `${r.method.slice(0, 64)} is not available on this read-only endpoint`,
      ),
    };
  }
  return {
    ok: true,
    req: { jsonrpc: "2.0", id: id as Id, method: r.method, ...(r.params ? { params: r.params } : {}) },
  };
}

/**
 * Read a request body up to `max` bytes. Returns null when it is larger (the stream is cancelled there), so an
 * oversized body is never buffered in full.
 */
export async function readBodyLimited(
  stream: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<string | null> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

class ResponseTooLarge extends Error {}

/** Send `reqs` (ids 0..n-1) to one upstream. Throws when it gives no JSON-RPC answer at all. */
async function callUpstream(
  up: Upstream,
  reqs: RpcRequest[],
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<{ answers: Map<number, RpcResponse>; status: number }> {
  const body = reqs.map((r, i) => ({ ...r, id: i }));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  let text: string;
  try {
    res = await fetchFn(up.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...up.headers },
      body: JSON.stringify(body.length === 1 ? body[0] : body),
      signal: controller.signal,
      cache: "no-store",
    });
    const limited = await readBodyLimited(res.body, MAX_UPSTREAM_BYTES);
    if (limited === null) throw new ResponseTooLarge();
    text = limited;
  } finally {
    clearTimeout(timer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status}, not JSON`);
  }
  const out = new Map<number, RpcResponse>();
  const items = Array.isArray(parsed) ? parsed : [parsed];
  for (const it of items) {
    const r = it as RpcResponse;
    if (typeof r?.id === "number" && r.id >= 0 && r.id < reqs.length) out.set(r.id, r);
  }
  // One error object for a whole batch (some providers answer a 429 that way): it applies to every call.
  if (!out.size && items.length === 1 && (items[0] as RpcResponse)?.error) {
    const error = (items[0] as RpcResponse).error!;
    reqs.forEach((_, i) => out.set(i, { jsonrpc: "2.0", id: i, error }));
  }
  if (!out.size) throw new Error(`HTTP ${res.status}, no JSON-RPC answer`);
  return { answers: out, status: res.status };
}

export interface ProxyOptions {
  upstreams: readonly Upstream[];
  fetch?: typeof fetch;
  cache?: RpcCache;
  /** Prefix for cache keys (the chain id). */
  cacheScope?: string;
  /** Strings that must never reach the caller (the Alchemy key): replaced with *** in every answer. */
  secrets?: readonly string[];
  timeoutMs?: number;
  /** Called once per upstream that failed outright (no answer, timeout), without its URL or headers. */
  onUpstreamError?: (provider: UpstreamProvider, reason: string) => void;
  /** Skips upstreams that recently gave no answer (all but the last). */
  health?: UpstreamHealth;
}

/** Answer one JSON-RPC request or batch (the raw body text). */
export async function proxyRpc(raw: string, opts: ProxyOptions): Promise<ProxyResult> {
  const fetchFn = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? UPSTREAM_TIMEOUT_MS;
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    return { status: 413, body: errorResponse(null, -32600, "Request body too large"), served: "none" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 400, body: errorResponse(null, -32700, "Parse error"), served: "none" };
  }
  const batch = Array.isArray(parsed);
  const items = batch ? (parsed as unknown[]) : [parsed];
  if (!items.length) return { status: 400, body: errorResponse(null, -32600, "Empty batch"), served: "none" };
  if (items.length > MAX_BATCH) {
    return {
      status: 413,
      body: errorResponse(null, -32600, `Batch too large (at most ${MAX_BATCH} calls)`),
      served: "none",
    };
  }

  const out: (RpcResponse | undefined)[] = new Array(items.length);
  const served = new Set<string>();
  const pending: { index: number; req: RpcRequest; cacheKey?: string; ttl: number }[] = [];
  for (const [index, item] of items.entries()) {
    const v = validate(item);
    if (!v.ok) {
      out[index] = v.res;
      continue;
    }
    const ttl = opts.cache ? cacheTtl(v.req.method, v.req.params) : 0;
    const cacheKey = ttl
      ? `${opts.cacheScope ?? ""}:${v.req.method}:${JSON.stringify(v.req.params ?? [])}`
      : undefined;
    const hit = cacheKey ? opts.cache!.get(cacheKey) : undefined;
    if (hit) {
      out[index] = { jsonrpc: "2.0", id: v.req.id, result: hit.value };
      served.add("cache");
      continue;
    }
    pending.push({ index, req: v.req, cacheKey, ttl });
  }

  // Forward what is left, upstream by upstream; each call stays pending until it gets a usable answer.
  let todo = pending;
  const lastError = new Map<number, RpcError>();
  const lastUpstream = opts.upstreams[opts.upstreams.length - 1];
  for (const up of opts.upstreams) {
    if (!todo.length) break;
    if (up !== lastUpstream && opts.health?.isDown(up)) continue;
    let answers: Map<number, RpcResponse>;
    try {
      const res = await callUpstream(
        up,
        todo.map((p) => p.req),
        fetchFn,
        timeoutMs,
      );
      answers = res.answers;
      // A refused key (401/403), a rate limit (429) or a server error: skip it for a while too. A 400 is one refused
      // call (an eth_getLogs range), not a dead endpoint.
      if (res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500) {
        opts.onUpstreamError?.(up.provider, `HTTP ${res.status}`);
        opts.health?.markDown(up);
      } else {
        opts.health?.markUp(up);
      }
    } catch (err) {
      if (err instanceof ResponseTooLarge) {
        // Every upstream would return the same answer: say so instead of trying the next one.
        const message = `Response size exceeds ${MAX_UPSTREAM_BYTES / 1024 / 1024} MB; ask for a smaller block range`;
        for (const p of todo) out[p.index] = errorResponse(p.req.id, -32005, message);
        served.add(up.provider === "alchemy" ? "alchemy" : "public");
        todo = [];
        break;
      }
      const reason = err instanceof Error && err.name === "AbortError" ? "timeout" : "no answer";
      opts.onUpstreamError?.(
        up.provider,
        err instanceof Error && err.message.startsWith("HTTP") ? err.message : reason,
      );
      opts.health?.markDown(up);
      continue;
    }
    const next: typeof todo = [];
    todo.forEach((p, i) => {
      const a = answers.get(i);
      if (a && (!a.error || isChainError(a.error))) {
        out[p.index] = a.error
          ? { jsonrpc: "2.0", id: p.req.id, error: a.error }
          : { jsonrpc: "2.0", id: p.req.id, result: a.result };
        served.add(up.provider === "alchemy" ? "alchemy" : "public");
        if (!a.error && p.cacheKey && JSON.stringify(a.result ?? null).length <= MAX_CACHED_BYTES) {
          opts.cache!.set(p.cacheKey, a.result, p.ttl);
        }
      } else {
        if (a?.error) lastError.set(p.index, a.error);
        next.push(p);
      }
    });
    todo = next;
  }
  for (const p of todo) {
    const e = lastError.get(p.index);
    out[p.index] = e
      ? { jsonrpc: "2.0", id: p.req.id, error: e }
      : errorResponse(p.req.id, -32603, "No RPC answered; try again");
  }

  const responses = out as RpcResponse[];
  const allFailed = pending.length > 0 && todo.length === pending.length && !served.size;
  const order = ["alchemy", "public", "cache"];
  const body = scrub(batch ? responses : responses[0]!, opts.secrets ?? []);
  return {
    status: allFailed && !batch && !lastError.size ? 502 : 200,
    body,
    served: served.size ? order.filter((s) => served.has(s)).join("+") : "none",
  };
}

/** Replace every secret in the answer with ***. Upstream error messages are relayed, so they pass through here. */
function scrub<T>(body: T, secrets: readonly string[]): T {
  const live = secrets.filter((s) => s && s.length >= 8);
  if (!live.length) return body;
  let text = JSON.stringify(body);
  if (!live.some((s) => text.includes(s))) return body;
  for (const s of live) text = text.split(s).join("***");
  return JSON.parse(text) as T;
}
