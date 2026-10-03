import { type Address, keccak256, stringToHex } from "viem";

// The starter gas drip (GasDrip.sol, D49): a brand-new wallet gets 0.0001 test ETH from a team-funded contract, sent
// by Strike's relayer through POST /api/gas-drip, so it can pay for its first transactions without an outside faucet.
// Shared by the route and the faucet page: the limits, the proof-of-work both sides compute, and refusals in words.
// Pure, with no SDK import, so the specs load it directly (`gasDripOf`, which reads the SDK map, is in drip.ts).
// The contract enforces one drip per address, the balance floor and the daily cap; the route adds the rest.

/** Wei per drip and drips per UTC day, as deployed (GasDrip.amount(), dailyCap()); the route reads the live values. */
export const GAS_DRIP_AMOUNT = 100_000_000_000_000n;
export const GAS_DRIP_DAILY_CAP = 20;

/** The route's own limits, on top of the contract's. Shown on the faucet page as they are. */
export const GAS_DRIP_LIMITS = {
  /** Drips per IP per day (per server instance, keyed by an HMAC of the IP). */
  perIpPerDay: 2,
  /** Requests per IP per 10 minutes, successful or not. */
  attemptsPer10Min: 6,
  /** Leading zero bits the proof-of-work hash needs: about 260,000 hashes, a few seconds in a browser. */
  difficulty: 18,
  /** How long a challenge stays valid. */
  challengeMs: 10 * 60_000,
  /** The relayer stops below this balance (wei), leaving gas to report the problem instead of failing mid-send. */
  relayerFloor: 20_000_000_000_000n,
} as const;

/** Why a drip is refused, by the contract's error name or the route's own check. */
export type GasDripReason =
  | "AlreadyDripped"
  | "HasGas"
  | "DailyCapReached"
  | "Empty"
  | "ZeroRecipient"
  | "NotRelayer"
  | "RateLimited"
  | "BadProof"
  | "Bot"
  | "Unavailable"
  | "RelayerLow"
  | "BadRequest";

/** GasDrip's error selectors (bytes4 of keccak256 of the signature), as `check(address)` returns them. */
export const GAS_DRIP_SELECTORS: Record<string, GasDripReason> = {
  [keccak256(stringToHex("AlreadyDripped(address)")).slice(0, 10)]: "AlreadyDripped",
  [keccak256(stringToHex("HasGas(uint256)")).slice(0, 10)]: "HasGas",
  [keccak256(stringToHex("DailyCapReached(uint256)")).slice(0, 10)]: "DailyCapReached",
  [keccak256(stringToHex("Empty()")).slice(0, 10)]: "Empty",
  [keccak256(stringToHex("ZeroRecipient()")).slice(0, 10)]: "ZeroRecipient",
};

/** A refusal in plain words for the faucet page. */
export function gasDripMessage(reason: GasDripReason, retryAfter?: number): string {
  switch (reason) {
    case "AlreadyDripped":
      return "This wallet already had its starter gas. It is one per address, ever.";
    case "HasGas":
      return "This wallet already has enough test ETH for its first transactions.";
    case "DailyCapReached":
      return "Today's 20 starter drips are gone. They reset at 00:00 UTC; the chain's faucet works meanwhile.";
    case "Empty":
      return "The starter drip is empty for now. The team refills it; the chain's faucet works meanwhile.";
    case "ZeroRecipient":
    case "BadRequest":
      return "That is not a wallet address on a network with a starter drip.";
    case "RateLimited":
      return `Too many requests from this connection. Try again in ${fmtWait(retryAfter ?? 600)}.`;
    case "BadProof":
      return "The anti-bot check did not match. Reload the page and try again.";
    case "Bot":
      return "Request refused.";
    case "RelayerLow":
    case "NotRelayer":
    case "Unavailable":
      return "The starter drip is offline right now. Use the chain's faucet instead.";
  }
}

function fmtWait(s: number): string {
  if (s < 90) return `${Math.max(1, Math.round(s))} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return `${Math.round(s / 3600)} h`;
}

// ------------------------------------------------------------------ proof of work

/** The string the client hashes: the server's challenge and a counter. */
export const powInput = (challenge: string, nonce: number) => `${challenge}:${nonce}`;

/** Leading zero bits of a 0x hash. */
export function leadingZeroBits(hash: string): number {
  let bits = 0;
  for (const ch of hash.slice(2)) {
    const v = parseInt(ch, 16);
    if (v === 0) {
      bits += 4;
      continue;
    }
    return bits + Math.clz32(v) - 28;
  }
  return bits;
}

/** Whether `nonce` solves `challenge` at `difficulty` bits. */
export function powValid(challenge: string, nonce: number, difficulty: number): boolean {
  if (!Number.isSafeInteger(nonce) || nonce < 0) return false;
  return leadingZeroBits(keccak256(stringToHex(powInput(challenge, nonce)))) >= difficulty;
}

/**
 * Find a nonce for `challenge`, yielding to the page every `batch` hashes so the UI stays live. Resolves with the
 * nonce, or null when `signal` aborts.
 */
export async function solvePow(
  challenge: string,
  difficulty: number,
  {
    batch = 4000,
    signal,
    onProgress,
  }: { batch?: number; signal?: AbortSignal; onProgress?: (n: number) => void } = {},
): Promise<number | null> {
  for (let nonce = 0; ;) {
    const end = nonce + batch;
    for (; nonce < end; nonce++) if (powValid(challenge, nonce, difficulty)) return nonce;
    if (signal?.aborted) return null;
    onProgress?.(nonce);
    await new Promise((r) => setTimeout(r, 0));
  }
}

// ------------------------------------------------------------------ the route's answers

/** GET /api/gas-drip: whether this wallet can get starter gas, and the challenge to solve first. */
export interface GasDripStatus {
  available: boolean;
  chainId: number;
  drip: Address | null;
  relayer: Address | null;
  amount: string;
  dailyCap: number;
  dripsLeftToday: number;
  remaining: string;
  /** Present when an address was asked about. */
  eligible?: boolean;
  reason?: GasDripReason;
  message?: string;
  challenge?: string;
  difficulty: number;
  limits: { perIpPerDay: number; attemptsPer10Min: number };
}

/** POST /api/gas-drip's answer. */
export type GasDripResult =
  | { ok: true; txHash: `0x${string}`; amount: string }
  | { ok: false; reason: GasDripReason; message: string; retryAfter?: number };
