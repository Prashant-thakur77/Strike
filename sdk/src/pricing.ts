import type { Mandate } from "./types.js";
import { BPS, MAX_PREMIUM_BPS, SECONDS_PER_YEAR, USDG_DECIMALS, WAD, numberToWad } from "./units.js";

/** Black-Scholes premium (USD per token) and delta (negative for puts), as floats. */
export interface BlackScholesQuote {
  price: number;
  delta: number;
}

/**
 * Standard normal CDF, Hart (1968) as published by West (2005): double-precision accurate. The on-chain pricer
 * uses the same rational approximation in WAD integers.
 */
export function normCdf(x: number): number {
  const a = Math.abs(x);
  let p: number;
  if (a > 37) {
    p = 0;
  } else {
    const e = Math.exp((-a * a) / 2);
    if (a < 7.07106781186547) {
      let n = 3.52624965998911e-2 * a + 0.700383064443688;
      n = n * a + 6.37396220353165;
      n = n * a + 33.912866078383;
      n = n * a + 112.079291497871;
      n = n * a + 221.213596169931;
      n = n * a + 220.206867912376;
      let d = 8.83883476483184e-2 * a + 1.75566716318264;
      d = d * a + 16.064177579207;
      d = d * a + 86.7807322029461;
      d = d * a + 296.564248779674;
      d = d * a + 637.333633378831;
      d = d * a + 793.826512519948;
      d = d * a + 440.413735824752;
      p = (e * n) / d;
    } else {
      let b = a + 0.65;
      b = a + 4 / b;
      b = a + 3 / b;
      b = a + 2 / b;
      b = a + 1 / b;
      p = e / b / 2.506628274631;
    }
  }
  return x > 0 ? 1 - p : p;
}

/** Years for a tenor in seconds (365-day year, like the on-chain pricer). */
export function tenorYears(seconds: number): number {
  return seconds / SECONDS_PER_YEAR;
}

function assertPositive(name: string, value: number) {
  if (!Number.isFinite(value) || value <= 0)
    throw new RangeError(`${name} must be a positive number, got ${value}`);
}

/**
 * Black-Scholes price and delta with zero interest rate and a 365-day year: a float port of the on-chain
 * `BlackScholesLib.quote` (the two agree to ~1e-9 of spot).
 * @param spot USD per token.
 * @param strike USD per token.
 * @param tenorSeconds Seconds to expiry. At or below zero the option is worth its intrinsic value.
 * @param sigma Annualised volatility as a fraction (0.6 = 60%).
 * @param isCall True for a call, false for a put.
 */
export function blackScholes(
  spot: number,
  strike: number,
  tenorSeconds: number,
  sigma: number,
  isCall: boolean,
): BlackScholesQuote {
  assertPositive("spot", spot);
  assertPositive("strike", strike);
  assertPositive("sigma", sigma);
  if (!(tenorSeconds > 0)) {
    if (isCall) return { price: Math.max(spot - strike, 0), delta: spot > strike ? 1 : 0 };
    return { price: Math.max(strike - spot, 0), delta: strike > spot ? -1 : 0 };
  }
  const vol = sigma * Math.sqrt(tenorYears(tenorSeconds));
  const d1 = (Math.log(spot / strike) + (vol * vol) / 2) / vol;
  const d2 = d1 - vol;
  const nd1 = normCdf(d1);
  const nd2 = normCdf(d2);
  if (isCall) return { price: Math.max(spot * nd1 - strike * nd2, 0), delta: nd1 };
  return { price: Math.max(strike * (1 - nd2) - spot * (1 - nd1), 0), delta: nd1 - 1 };
}

/**
 * The strike whose |delta| equals `targetDelta`, by bisection over [spot / 10, spot × 10] (the same bracket as
 * the on-chain `strikeForDelta`). Call |delta| falls as the strike rises; put |delta| rises with it.
 * @param targetDelta |delta| strictly between 0 and 1 (the sign is ignored, so -0.2 works for puts).
 * @throws RangeError when the target cannot be reached inside the bracket.
 */
export function strikeForDelta(
  spot: number,
  targetDelta: number,
  tenorSeconds: number,
  sigma: number,
  isCall: boolean,
): number {
  assertPositive("spot", spot);
  assertPositive("sigma", sigma);
  assertPositive("tenorSeconds", tenorSeconds);
  const target = Math.abs(targetDelta);
  if (!(target > 0 && target < 1))
    throw new RangeError(`target delta must be between 0 and 1, got ${targetDelta}`);
  const absDelta = (k: number) => Math.abs(blackScholes(spot, k, tenorSeconds, sigma, isCall).delta);
  let lo = spot / 10;
  let hi = spot * 10;
  const [dLo, dHi] = [absDelta(lo), absDelta(hi)];
  const reachable = isCall ? dHi <= target && target <= dLo : dLo <= target && target <= dHi;
  if (!reachable) {
    throw new RangeError(`delta ${target} is not reachable between strikes ${lo} and ${hi}`);
  }
  // Bisect in log space: 100 rounds shrink the bracket far below float precision.
  for (let i = 0; i < 100; i++) {
    const mid = Math.sqrt(lo * hi);
    const d = absDelta(mid);
    if (isCall ? d > target : d < target) lo = mid;
    else hi = mid;
  }
  return Math.sqrt(lo * hi);
}

/**
 * Clamp a target |delta| into the mandate's band, `margin` inside each edge so rounding and small spot moves
 * cannot push the proposal out. Falls back to the middle of the band when it is narrower than two margins.
 */
export function clampDeltaToMandate(targetDelta: number, mandate: Mandate, margin = 0.01): number {
  const min = mandate.minDeltaBps / BPS;
  const max = mandate.maxDeltaBps / BPS;
  const lo = min + margin;
  const hi = max - margin;
  if (lo > hi) return (min + max) / 2;
  return Math.min(Math.max(Math.abs(targetDelta), lo), hi);
}

/**
 * Options the vault's collateral can back at `strike` (mirrors `EpochManager._capacity`): one token per call; the
 * strike in USDG per put.
 * @param strike WAD per token (only used for puts).
 */
export function vaultCapacity(args: {
  isCall: boolean;
  totalAssets: bigint;
  strike: bigint;
  underlyingDecimals: number;
  usdgDecimals?: number;
}): bigint {
  if (args.isCall) return args.totalAssets;
  if (args.strike === 0n) return 0n;
  const usdgDecimals = args.usdgDecimals ?? USDG_DECIMALS;
  return (
    (args.totalAssets * 10n ** BigInt(args.underlyingDecimals) * WAD) /
    (args.strike * 10n ** BigInt(usdgDecimals))
  );
}

/** Largest size the mandate allows for this capacity (`capacity × maxShareSoldBps / 10_000`, rounded down). */
export function maxProposalSize(capacity: bigint, mandate: Mandate): bigint {
  return (capacity * BigInt(mandate.maxShareSoldBps)) / BigInt(BPS);
}

/** Floor a WAD price to a whole cent (what `proposeByDelta` does to the solved strike). */
export function floorToCent(priceWad: bigint): bigint {
  const cent = 10n ** 16n;
  return priceWad - (priceWad % cent);
}

/** Inputs for {@link suggestProposal}. Prices in USD, sigma as a fraction. */
export interface ProposalSuggestionInput {
  spot: number;
  sigma: number;
  tenorSeconds: number;
  isCall: boolean;
  mandate: Mandate;
  /** Vault collateral (`totalAssets`, in the vault asset's base units). */
  totalAssets: bigint;
  underlyingDecimals: number;
  usdgDecimals?: number;
  /** Desired |delta| before clamping to the mandate (default 0.20). */
  targetDelta?: number;
  /** Premium as a share of fair value (default: the mandate minimum or 100%, whichever is higher). */
  premiumBps?: number;
  /** Share of the mandate's maximum size to sell, in bps (default 10_000 = the full allowed size). */
  sizeShareBps?: number;
}

/** A proposal that should pass the mandate, with the numbers behind it. */
export interface ProposalSuggestion {
  /** |delta| actually targeted, after clamping to the mandate band. */
  targetDelta: number;
  /** Strike, WAD per token (floored to a cent). */
  strike: bigint;
  strikeUsd: number;
  /** Model |delta| at the rounded strike. */
  delta: number;
  /** Black-Scholes fair value per option, USD. */
  fairValue: number;
  premiumBps: number;
  /** Options (underlying base units). */
  size: bigint;
  capacity: bigint;
  /** Premium per option over the collateral it locks, in bps. */
  yieldBps: number;
  meetsMinYield: boolean;
}

/**
 * Pick a strike, size and premium factor that sit inside a vault's mandate: target delta (clamped into the band),
 * strike by {@link strikeForDelta}, size = the allowed share of capacity, premium ≥ the mandate minimum. Pure
 * math; confirm on-chain with `previewProposal` before proposing.
 */
export function suggestProposal(input: ProposalSuggestionInput): ProposalSuggestion {
  const { spot, sigma, tenorSeconds, isCall, mandate } = input;
  const targetDelta = clampDeltaToMandate(input.targetDelta ?? 0.2, mandate);
  const strike = floorToCent(numberToWad(strikeForDelta(spot, targetDelta, tenorSeconds, sigma, isCall)));
  const strikeUsd = Number(strike) / 1e18;
  const quote = blackScholes(spot, strikeUsd, tenorSeconds, sigma, isCall);
  const premiumBps = Math.min(Math.max(input.premiumBps ?? BPS, mandate.minPremiumBps), MAX_PREMIUM_BPS);
  const capacity = vaultCapacity({
    isCall,
    totalAssets: input.totalAssets,
    strike,
    underlyingDecimals: input.underlyingDecimals,
    usdgDecimals: input.usdgDecimals,
  });
  const sizeShareBps = Math.min(Math.max(input.sizeShareBps ?? BPS, 0), BPS);
  const size = (maxProposalSize(capacity, mandate) * BigInt(sizeShareBps)) / BigInt(BPS);
  const collateralValue = isCall ? spot : strikeUsd;
  const yieldBps = ((quote.price * premiumBps) / BPS / collateralValue) * BPS;
  return {
    targetDelta,
    strike,
    strikeUsd,
    delta: Math.abs(quote.delta),
    fairValue: quote.price,
    premiumBps,
    size,
    capacity,
    yieldBps,
    meetsMinYield: yieldBps >= mandate.minYieldBps,
  };
}
