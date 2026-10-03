/**
 * Result at expiry for one option, in USD, at settlement price `s`.
 * Calls pay (S − K) / S tokens per option (worth S − K dollars at S); puts pay K − S USDG. The buyer paid
 * `premium` up front; the depositor side is the premium it received minus that payout (it excludes the stock's own
 * move, which a covered-call depositor also carries).
 */
export function payoffAt(isCall: boolean, strike: number, s: number, premium: number) {
  const payout = isCall ? Math.max(s - strike, 0) : Math.max(strike - s, 0);
  return { payout, buyer: payout - premium, depositor: premium - payout };
}

/** Settlement price at which the buyer's payout equals the premium paid. */
export function breakeven(isCall: boolean, strike: number, premium: number): number {
  return isCall ? strike + premium : strike - premium;
}

export interface BuyPriceInput {
  /** Oracle spot, USD per token. */
  spot: number;
  strike: number;
  tenorSeconds: number;
  /** Annualised volatility as a fraction (0.6 = 60%). */
  sigma: number;
  isCall: boolean;
  /** The series' premium factor, bps of fair value (10,000 = 100%). */
  premiumBps: number;
  /** `underlyings(token).spotBufferBps`: buys are priced this far against the buyer. */
  spotBufferBps: number;
}

export interface BuyPrice {
  /** Spot moved `spotBufferBps` against the buyer: up for calls, down for puts. */
  pricedSpot: number;
  /** Black-Scholes value at the priced spot. */
  fair: number;
  /** fair × premium factor. */
  scaled: number;
  /** Exercise value at the priced spot. */
  intrinsic: number;
  /** What one option costs: max(scaled, intrinsic). */
  perOption: number;
  /** True when the intrinsic-value floor sets the price. */
  floorBinds: boolean;
}

/** Fair value of one option (the SDK's `blackScholes(...).price`; injected so this file has no SDK import). */
export type FairValue = (
  spot: number,
  strike: number,
  tenorSeconds: number,
  sigma: number,
  isCall: boolean,
) => number;

/** A float mirror of `EpochManager._quoteBuy` for one option (display only; the contract's quote is authoritative). */
export function buyPrice(i: BuyPriceInput, fairValue: FairValue): BuyPrice {
  const pricedSpot = (i.spot * (i.isCall ? 10_000 + i.spotBufferBps : 10_000 - i.spotBufferBps)) / 10_000;
  const fair = fairValue(pricedSpot, i.strike, Math.max(i.tenorSeconds, 1), i.sigma, i.isCall);
  const scaled = (fair * i.premiumBps) / 10_000;
  const intrinsic = i.isCall ? Math.max(pricedSpot - i.strike, 0) : Math.max(i.strike - pricedSpot, 0);
  return {
    pricedSpot,
    fair,
    scaled,
    intrinsic,
    perOption: Math.max(scaled, intrinsic),
    floorBinds: intrinsic > scaled,
  };
}

/** About how wide a 12px Inter Tight label is (used only to keep it inside the chart). */
const labelWidth = (text: string) => text.length * 6.8;

/**
 * Where a marker's label goes: 6px to the preferred side of the marker at `px`, or to the other side when the
 * preferred side would cross the chart's edge (and that side fits).
 */
export function placeLabel(
  px: number,
  text: string,
  prefer: "start" | "end",
  width: number,
): { x: number; anchor: "start" | "end" } {
  const fits = (side: "start" | "end") =>
    side === "start" ? px + 6 + labelWidth(text) <= width - 2 : px - 6 - labelWidth(text) >= 2;
  const side =
    fits(prefer) || !fits(prefer === "start" ? "end" : "start")
      ? prefer
      : prefer === "start"
        ? "end"
        : "start";
  return { x: px + (side === "start" ? 6 : -6), anchor: side };
}
