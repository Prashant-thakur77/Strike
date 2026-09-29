import type { Mandate } from "./types.js";
import { BPS, MAX_PREMIUM_BPS } from "./units.js";

// The protocol's limits on a vault mandate (`MandateGuard.validate`). `VaultFactory.createVault` reverts with
// `InvalidMandate()` (no arguments) when one is broken, so these checks name the rule before anything is sent.

/** Lowest `minPremiumBps` any mandate may set (90% of fair value): a curator cannot sell to its own agent cheaply. */
export const MIN_PREMIUM_FLOOR_BPS = 9000;
/** Longest `maxTenor` any mandate may allow, in seconds (35 days). */
export const MAX_TENOR_CAP = 35 * 86_400;

/**
 * The mandate the seeded vaults use, a sensible default for a new weekly vault: |delta| 0.10-0.35, at least 95% of
 * fair value, at least 0.05% of the collateral per option, sell up to 80% of the vault, tenor 1-8 days.
 */
export const DEFAULT_MANDATE: Mandate = {
  minDeltaBps: 1000,
  maxDeltaBps: 3500,
  minPremiumBps: 9500,
  minYieldBps: 5,
  maxShareSoldBps: 8000,
  minTenor: 86_400,
  maxTenor: 8 * 86_400,
};

const isUint = (n: number, max: number) => Number.isInteger(n) && n >= 0 && n <= max;

/**
 * Every rule of `MandateGuard.validate` the mandate breaks, in plain words (empty when it is valid). The same checks,
 * in the same order, as the contract.
 */
export function mandateProblems(m: Mandate): string[] {
  const out: string[] = [];
  const u16 = 0xffff;
  const u32 = 0xffff_ffff;
  for (const k of [
    "minDeltaBps",
    "maxDeltaBps",
    "minPremiumBps",
    "minYieldBps",
    "maxShareSoldBps",
  ] as const) {
    if (!isUint(m[k], u16)) out.push(`${k} must be a whole number of bps between 0 and 65535`);
  }
  for (const k of ["minTenor", "maxTenor"] as const) {
    if (!isUint(m[k], u32)) out.push(`${k} must be a whole number of seconds`);
  }
  if (out.length > 0) return out;
  if (m.minDeltaBps > m.maxDeltaBps) out.push("minDeltaBps must not exceed maxDeltaBps");
  if (m.maxDeltaBps > BPS) out.push(`maxDeltaBps must be at most ${BPS} (a delta of 1)`);
  if (m.maxShareSoldBps === 0 || m.maxShareSoldBps > BPS)
    out.push(`maxShareSoldBps must be between 1 and ${BPS} (0.01%-100% of the vault)`);
  if (m.minPremiumBps < MIN_PREMIUM_FLOOR_BPS)
    out.push(
      `minPremiumBps must be at least ${MIN_PREMIUM_FLOOR_BPS} (90% of fair value, the protocol floor)`,
    );
  if (m.minPremiumBps > MAX_PREMIUM_BPS)
    out.push(`minPremiumBps must be at most ${MAX_PREMIUM_BPS} (3x fair value)`);
  if (m.minYieldBps > BPS) out.push(`minYieldBps must be at most ${BPS}`);
  if (m.minTenor === 0) out.push("minTenor must be at least 1 second");
  if (m.minTenor > m.maxTenor) out.push("minTenor must not exceed maxTenor");
  if (m.maxTenor > MAX_TENOR_CAP) out.push(`maxTenor must be at most ${MAX_TENOR_CAP} seconds (35 days)`);
  return out;
}

/** Whether `VaultFactory.createVault` would accept the mandate (see {@link mandateProblems}). */
export function isValidMandate(m: Mandate): boolean {
  return mandateProblems(m).length === 0;
}
