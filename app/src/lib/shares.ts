// ERC-8056 scaled UI amounts. A Robinhood stock token reports `uiMultiplier()` (1e18 = 1.0): one raw token is
// `uiMultiplier / 1e18` shares of the stock. Chainlink stock feeds price one RAW token (the multiplier is already in
// the price), so the per-share price is the feed price divided by the multiplier. Never multiply a feed price by it.

/** 1.0 in the multiplier's 18-decimal fixed point. */
export const UNIT_MULTIPLIER = 10n ** 18n;

/** A price per raw token (WAD) as a price per share (WAD). Falls back to the raw price for a zero multiplier. */
export function perSharePrice(pricePerRawToken: bigint, multiplier: bigint): bigint {
  if (multiplier <= 0n) return pricePerRawToken;
  return (pricePerRawToken * UNIT_MULTIPLIER) / multiplier;
}

/** A raw token amount as shares of the stock (same decimals): raw × multiplier. Raw for a zero multiplier. */
export function sharesOf(rawAmount: bigint, multiplier: bigint): bigint {
  if (multiplier <= 0n) return rawAmount;
  return (rawAmount * multiplier) / UNIT_MULTIPLIER;
}

/** True when one raw token is not exactly one share, so a per-share figure is worth showing. */
export function hasMultiplier(multiplier: bigint): boolean {
  return multiplier > 0n && multiplier !== UNIT_MULTIPLIER;
}

/** The multiplier as a decimal string with 3 to 9 fraction digits ("1.000775", "0.500"). */
export function fmtMultiplier(multiplier: bigint): string {
  const whole = multiplier / UNIT_MULTIPLIER;
  const frac = (multiplier % UNIT_MULTIPLIER).toString().padStart(18, "0").slice(0, 9).replace(/0+$/, "");
  return `${whole}.${frac.padEnd(3, "0")}`;
}
