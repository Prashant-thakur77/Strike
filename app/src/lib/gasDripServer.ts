// POST and GET /api/gas-drip's logic (D47), with the chain, the clock and the limiters passed in, so the Playwright
// specs run it without a network or a key. app/src/app/api/gas-drip/route.ts wires it to the relayer key and RPC.
//
// Order of checks on a POST, cheapest first: body shape and the honeypot field; attempts per IP (6 per 10 minutes);
// the proof-of-work against an HMAC challenge bound to the chain, the address and a 10-minute window; one request in
// flight per address; the relayer's own balance floor; the contract's `check(to)` (one drip per address ever, only
// below 0.0001 ETH, 20 per UTC day, not empty); drips per IP (2 per day); then `drip(to)` from the relayer, one at a
// time per chain so nonces never collide. IP limits are per server instance and keyed by an HMAC of the IP, so no IP
// is kept. The contract limits hold even if every off-chain one is bypassed.
import { type Address, getAddress, isAddress } from "viem";
import {
  GAS_DRIP_LIMITS,
  GAS_DRIP_SELECTORS,
  type GasDripReason,
  type GasDripResult,
  type GasDripStatus,
  gasDripMessage,
  powValid,
} from "./gasDrip";
import { hmacHex } from "./waitlistCrypto";
import { RateLimiter } from "./waitlistServer";

export const GAS_DRIP_MAX_BODY = 1024;

/** What the route needs from one chain: the drip's live numbers and a way to send `drip(to)`. */
export interface GasDripChain {
  drip: Address;
  relayer: Address;
  read(to?: Address): Promise<{
    amount: bigint;
    dailyCap: number;
    dripsLeftToday: number;
    remaining: bigint;
    relayerBalance: bigint;
    isRelayer: boolean;
    /** `check(to)`: ok, or the error selector drip(to) would revert with. */
    check?: { ok: boolean; reason: string };
  }>;
  /** Simulate, send and wait for `drip(to)`; resolves with the tx hash once it is mined successfully. */
  send(to: Address): Promise<`0x${string}`>;
}

export interface GasDripDeps {
  /** HMAC key for challenges and IP keys (GAS_DRIP_SALT, else the relayer key); undefined → the route is off. */
  secret: string | undefined;
  chain(chainId: number): GasDripChain | null;
  attempts: RateLimiter;
  ipDrips: RateLimiter;
  now?: () => number;
  difficulty?: number;
  onError?: (stage: string, err: unknown) => void;
}

/** Fresh limiters with the published limits. */
export function gasDripLimiters(now: () => number = Date.now) {
  return {
    attempts: new RateLimiter(GAS_DRIP_LIMITS.attemptsPer10Min, 10 * 60_000, now),
    ipDrips: new RateLimiter(GAS_DRIP_LIMITS.perIpPerDay, 24 * 3600_000, now),
  };
}

/** The challenge for (chain, address) in the window `bucket`: 32 hex chars of an HMAC. */
export async function challengeFor(secret: string, chainId: number, address: Address, bucket: number) {
  return (await hmacHex(`gas-drip:${chainId}:${address.toLowerCase()}:${bucket}`, secret)).slice(0, 32);
}

const bucketOf = (t: number) => Math.floor(t / GAS_DRIP_LIMITS.challengeMs);

export interface Answer<T> {
  status: number;
  body: T;
  headers?: Record<string, string>;
}

const refuse = (status: number, reason: GasDripReason, retryAfter?: number): Answer<GasDripResult> => ({
  status,
  body: {
    ok: false,
    reason,
    message: gasDripMessage(reason, retryAfter),
    ...(retryAfter ? { retryAfter } : {}),
  },
  headers: retryAfter ? { "Retry-After": String(retryAfter) } : undefined,
});

function parseChainId(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** GET: the drip's numbers, and for an address whether it qualifies plus its challenge. */
export async function gasDripStatus(
  chainIdRaw: string | null,
  addressRaw: string | null,
  deps: GasDripDeps,
): Promise<Answer<GasDripStatus | { error: string }>> {
  const chainId = parseChainId(chainIdRaw);
  const chain = chainId ? deps.chain(chainId) : null;
  if (!chainId || !chain) return { status: 404, body: { error: "No starter drip on this network." } };
  if (addressRaw && !isAddress(addressRaw)) return { status: 400, body: { error: "Not an address." } };
  const to = addressRaw ? getAddress(addressRaw) : undefined;
  const difficulty = deps.difficulty ?? GAS_DRIP_LIMITS.difficulty;
  const base = {
    chainId,
    drip: chain.drip,
    relayer: chain.relayer,
    difficulty,
    limits: { perIpPerDay: GAS_DRIP_LIMITS.perIpPerDay, attemptsPer10Min: GAS_DRIP_LIMITS.attemptsPer10Min },
  };
  let r;
  try {
    r = await chain.read(to);
  } catch (err) {
    deps.onError?.("read", err);
    return { status: 502, body: { error: "Could not read the drip from the chain." } };
  }
  const available = !!deps.secret && r.isRelayer && r.relayerBalance >= GAS_DRIP_LIMITS.relayerFloor;
  const status: GasDripStatus = {
    ...base,
    available,
    amount: r.amount.toString(),
    dailyCap: r.dailyCap,
    dripsLeftToday: r.dripsLeftToday,
    remaining: r.remaining.toString(),
  };
  if (to) {
    const reason: GasDripReason | undefined = !deps.secret
      ? "Unavailable"
      : !r.isRelayer
        ? "NotRelayer"
        : r.relayerBalance < GAS_DRIP_LIMITS.relayerFloor
          ? "RelayerLow"
          : r.check && !r.check.ok
            ? (GAS_DRIP_SELECTORS[r.check.reason.toLowerCase()] ?? "Unavailable")
            : undefined;
    status.eligible = !reason;
    if (reason) {
      status.reason = reason;
      status.message = gasDripMessage(reason);
    } else {
      status.challenge = await challengeFor(deps.secret!, chainId, to, bucketOf((deps.now ?? Date.now)()));
    }
  }
  return { status: 200, body: status };
}

const inflight = new Set<string>();
const queues = new Map<number, Promise<unknown>>();

/** Run `fn` after every earlier send on the same chain (one relayer, one nonce sequence). */
function serial<T>(chainId: number, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(chainId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(
    chainId,
    next.catch(() => undefined),
  );
  return next;
}

/** POST: verify everything, then send `drip(to)` from the relayer. */
export async function handleGasDrip(
  raw: string,
  ip: string,
  deps: GasDripDeps,
): Promise<Answer<GasDripResult>> {
  let body: { chainId?: unknown; address?: unknown; nonce?: unknown; website?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return refuse(400, "BadRequest");
  }
  if (!body || typeof body !== "object") return refuse(400, "BadRequest");
  // The honeypot: a field people never see and bots fill in.
  if (typeof body.website === "string" && body.website.trim() !== "") return refuse(400, "Bot");
  const chainId = parseChainId(body.chainId);
  const chain = chainId ? deps.chain(chainId) : null;
  if (!chainId || !chain || typeof body.address !== "string" || !isAddress(body.address))
    return refuse(400, "BadRequest");
  if (!deps.secret) return refuse(503, "Unavailable");
  const to = getAddress(body.address);
  const ipKey = await hmacHex(`ip:${ip}`, deps.secret);

  const attempt = deps.attempts.hit(ipKey);
  if (!attempt.ok) return refuse(429, "RateLimited", attempt.retryAfter);

  const nonce = typeof body.nonce === "number" ? body.nonce : Number.NaN;
  const difficulty = deps.difficulty ?? GAS_DRIP_LIMITS.difficulty;
  const bucket = bucketOf((deps.now ?? Date.now)());
  let proven = false;
  for (const b of [bucket, bucket - 1]) {
    if (powValid(await challengeFor(deps.secret, chainId, to, b), nonce, difficulty)) proven = true;
  }
  if (!proven) return refuse(400, "BadProof");

  const key = `${chainId}:${to.toLowerCase()}`;
  if (inflight.has(key)) return refuse(429, "RateLimited", 30);
  inflight.add(key);
  try {
    let r;
    try {
      r = await chain.read(to);
    } catch (err) {
      deps.onError?.("read", err);
      return refuse(502, "Unavailable");
    }
    if (!r.isRelayer) return refuse(503, "NotRelayer");
    if (r.relayerBalance < GAS_DRIP_LIMITS.relayerFloor) return refuse(503, "RelayerLow");
    if (r.check && !r.check.ok) {
      const reason = GAS_DRIP_SELECTORS[r.check.reason.toLowerCase()] ?? "Unavailable";
      return refuse(409, reason);
    }
    const daily = deps.ipDrips.hit(ipKey);
    if (!daily.ok) return refuse(429, "RateLimited", daily.retryAfter);
    try {
      const txHash = await serial(chainId, () => chain.send(to));
      return { status: 200, body: { ok: true, txHash, amount: r.amount.toString() } };
    } catch (err) {
      deps.onError?.("send", err);
      return refuse(502, "Unavailable");
    }
  } finally {
    inflight.delete(key);
  }
}
