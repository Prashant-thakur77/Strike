import { formatUnits, parseUnits } from "viem";

/** 1e18: prices, strikes, fair values, deltas and volatilities are WAD fixed point on-chain. */
export const WAD = 10n ** 18n;
/** Basis points in one (100%). */
export const BPS = 10_000;
/** USDG has 6 decimals on every chain Strike supports (the contracts read it on-chain). */
export const USDG_DECIMALS = 6;
/** Seconds in the pricer's 365-day year. */
export const SECONDS_PER_YEAR = 31_536_000;
/** Highest `premiumBps` the mandate guard accepts (3x fair value). */
export const MAX_PREMIUM_BPS = 30_000;

/** Parse a decimal amount ("369.5", 369.5) into WAD. */
export function parseWad(value: string | number): bigint {
  return parseUnits(toDecimalString(value), 18);
}

/** WAD as a JavaScript number (for display and float math only; loses precision past ~15 digits). */
export function wadToNumber(value: bigint): number {
  return Number(formatUnits(value, 18));
}

/** A float as WAD, rounded to 12 decimals so float noise does not leak into on-chain values. */
export function numberToWad(value: number): bigint {
  if (!Number.isFinite(value)) throw new RangeError(`not a finite number: ${value}`);
  return parseUnits(value.toFixed(12), 18);
}

/** Format WAD as a decimal string, truncated to `fractionDigits` (trailing zeros removed). */
export function formatWad(value: bigint, fractionDigits = 4): string {
  return formatAmount(value, 18, fractionDigits);
}

/** Parse a USDG amount ("25.5") into base units. */
export function parseUsdg(value: string | number, decimals = USDG_DECIMALS): bigint {
  return parseUnits(toDecimalString(value), decimals);
}

/** Format USDG base units as a decimal string ("25.5"), truncated to `fractionDigits`. */
export function formatUsdg(value: bigint, fractionDigits = 2, decimals = USDG_DECIMALS): string {
  return formatAmount(value, decimals, fractionDigits);
}

/** Parse a token amount with the given decimals. */
export function parseAmount(value: string | number, decimals: number): bigint {
  return parseUnits(toDecimalString(value), decimals);
}

/**
 * Format base units as a decimal string truncated (never rounded up) to `fractionDigits`, without trailing
 * zeros. `formatAmount(1234567n, 6, 2)` is `"1.23"`.
 */
export function formatAmount(value: bigint, decimals: number, fractionDigits = decimals): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const digits = Math.min(fractionDigits, decimals);
  let fraction = (abs % scale).toString().padStart(decimals, "0").slice(0, digits);
  fraction = fraction.replace(/0+$/, "");
  const out = fraction ? `${whole}.${fraction}` : whole.toString();
  return negative && out !== "0" ? `-${out}` : out;
}

/** Basis points as a fraction (2500 → 0.25). */
export function bpsToFraction(bps: number): number {
  return bps / BPS;
}

/** A fraction as whole basis points, rounded to nearest (0.2 → 2000). */
export function fractionToBps(fraction: number): number {
  return Math.round(fraction * BPS);
}

function toDecimalString(value: string | number): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError(`not a finite number: ${value}`);
    // Avoid exponent notation (1e-7) that parseUnits rejects.
    return value.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 18 });
  }
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) throw new RangeError(`not a decimal number: "${value}"`);
  return trimmed;
}
