// Pure arithmetic for the buy panel's hedging modes ("Protect my position" on puts, "Upside for a budget" on calls).
// Units are the contracts' own, never floats:
//   options, stock tokens  base units of the underlying; one option is written on one RAW token
//   USDG                   base units (6 decimals)
//   prices                 WAD (1e18 = $1) per RAW token, as the Chainlink feed and EpochManager use them. The
//                          ERC-8056 multiplier is already inside the price: divide by it for a per-share figure
//                          (lib/shares.ts), never multiply.
// Rounding follows EpochManager: what the buyer pays rounds up, what the buyer is paid rounds down.

export const WAD = 10n ** 18n;
const BPS = 10_000n;

function ceilDiv(a: bigint, b: bigint): bigint {
  return a === 0n ? 0n : (a - 1n) / b + 1n;
}

/** `Decimals.valueInUsd`: `amount` base units at `priceWad` per raw token, in base units of a USD stablecoin. */
export function valueInUsd(
  amount: bigint,
  priceWad: bigint,
  tokenDecimals: number,
  usdDecimals: number,
  roundUp = false,
): bigint {
  const num = amount * priceWad * 10n ** BigInt(usdDecimals);
  const den = 10n ** BigInt(tokenDecimals) * WAD;
  return roundUp ? ceilDiv(num, den) : num / den;
}

/** The most a buy may cost at `slipBps` slippage: the `maxPremium` the panel sends to `EpochManager.buy`. */
export function withSlippage(premium: bigint, slipBps: number): bigint {
  return premium + (premium * BigInt(slipBps)) / BPS;
}

/** The largest quoted premium whose slippage allowance still fits inside `budget`. */
export function quoteBudget(budget: bigint, slipBps: number): bigint {
  if (budget <= 0n) return 0n;
  let p = (budget * BPS) / (BPS + BigInt(slipBps));
  while (withSlippage(p + 1n, slipBps) <= budget) p += 1n;
  return p;
}

/** Sizing granularity for a budget: 1e-6 of a token, so "Use this amount" fills a readable number. */
export function optionStep(tokenDecimals: number): bigint {
  return 10n ** BigInt(Math.max(0, tokenDecimals - 6));
}

/** `part / whole` as a float for display, or null when `whole` is not positive. */
export function ratio(part: bigint, whole: bigint): number | null {
  if (whole <= 0n) return null;
  return Number((part * 1_000_000_000n) / whole) / 1e9;
}

// ------------------------------------------------------------------ puts: protect a position

export interface ProtectPlan {
  /** Options to buy: one per raw token held, capped at what the series has left. */
  options: bigint;
  /** True when the series has fewer options left than the tokens held. */
  capped: boolean;
  /** Tokens left without protection because of the cap. */
  uncovered: bigint;
}

export function protectPlan(held: bigint, remaining: bigint): ProtectPlan {
  const h = held > 0n ? held : 0n;
  const left = remaining > 0n ? remaining : 0n;
  const options = h < left ? h : left;
  return { options, capped: h > left, uncovered: h - options };
}

/** What `options` puts pay at settlement price `price` (USDG base units), as `EpochManager` settles and redeems. */
export function putPayout(
  options: bigint,
  strike: bigint,
  price: bigint,
  tokenDecimals: number,
  usdDecimals: number,
): bigint {
  return strike > price ? valueInUsd(options, strike - price, tokenDecimals, usdDecimals) : 0n;
}

export interface ProtectInput {
  held: bigint;
  options: bigint;
  /** Premium for `options`, from `EpochManager.quoteBuy` (USDG base units). */
  premium: bigint;
  spot: bigint;
  strike: bigint;
  tokenDecimals: number;
  usdDecimals: number;
}

export interface ProtectOutcome {
  /** Today's value of every token held (USDG base units). */
  positionValue: bigint;
  /** Premium as a share of today's value. */
  costRatio: number | null;
  /** The least the position is worth at expiry, after the premium: options × strike − premium. Tokens left
   *  uncovered by a cap count as worthless, since nothing protects them. Signed. */
  worstCase: bigint;
  /** Today's value minus the worst case, never below zero. */
  maxLoss: bigint;
  maxLossRatio: number | null;
}

export function protectOutcome(p: ProtectInput): ProtectOutcome {
  const positionValue = valueInUsd(p.held, p.spot, p.tokenDecimals, p.usdDecimals);
  // Below the strike, tokens + puts are worth held·S + options·(K − S) ≥ options·K; above it, more.
  const worstCase = valueInUsd(p.options, p.strike, p.tokenDecimals, p.usdDecimals) - p.premium;
  const loss = positionValue - worstCase;
  const maxLoss = loss > 0n ? loss : 0n;
  return {
    positionValue,
    costRatio: ratio(p.premium, positionValue),
    worstCase,
    maxLoss,
    maxLossRatio: ratio(maxLoss, positionValue),
  };
}

// ------------------------------------------------------------------ calls: upside for a budget

/** Premium per option as a WAD price per raw token, rounded up so the breakeven is never flattering. */
export function premiumPerOption(
  premium: bigint,
  options: bigint,
  tokenDecimals: number,
  usdDecimals: number,
): bigint {
  if (options <= 0n) return 0n;
  return ceilDiv(premium * WAD * 10n ** BigInt(tokenDecimals), options * 10n ** BigInt(usdDecimals));
}

/** `price` moved by `bps` (1_000 = +10%). */
export function bump(price: bigint, bps: number): bigint {
  return (price * (BPS + BigInt(bps))) / BPS;
}

/** What `options` calls pay at settlement price `price`: (S − K) / S tokens each, rounded down as on-chain,
 *  and those tokens' value at `price` in USDG base units. */
export function callPayout(
  options: bigint,
  strike: bigint,
  price: bigint,
  tokenDecimals: number,
  usdDecimals: number,
): { tokens: bigint; usd: bigint } {
  if (price <= strike) return { tokens: 0n, usd: 0n };
  const perOption = ((price - strike) * WAD) / price;
  const tokens = (options * perOption) / WAD;
  return { tokens, usd: valueInUsd(tokens, price, tokenDecimals, usdDecimals) };
}

export interface UpsideInput {
  options: bigint;
  premium: bigint;
  strike: bigint;
  tokenDecimals: number;
  usdDecimals: number;
  /** How far above breakeven the example settles, in bps (default +10%). */
  aboveBps?: number;
}

export interface UpsideOutcome {
  /** Settlement price at which the payout equals the premium: strike + premium per option. */
  breakeven: bigint;
  premiumPerOption: bigint;
  /** The example settlement price, `aboveBps` over breakeven. */
  target: bigint;
  payoutTokens: bigint;
  payoutUsd: bigint;
  /** Payout minus premium at the target (signed, USDG base units). */
  profit: bigint;
}

export function upsideOutcome(p: UpsideInput): UpsideOutcome {
  const ppo = premiumPerOption(p.premium, p.options, p.tokenDecimals, p.usdDecimals);
  const breakeven = p.strike + ppo;
  const target = bump(breakeven, p.aboveBps ?? 1_000);
  const payout = callPayout(p.options, p.strike, target, p.tokenDecimals, p.usdDecimals);
  return {
    breakeven,
    premiumPerOption: ppo,
    target,
    payoutTokens: payout.tokens,
    payoutUsd: payout.usd,
    profit: payout.usd - p.premium,
  };
}

export interface Affordable {
  options: bigint;
  /** The confirmed quote for `options` (USDG base units). */
  premium: bigint;
  /** True when the budget covers everything the series has left. */
  capped: boolean;
}

/**
 * The most options whose quoted premium fits `budget`, in multiples of `step`, capped at `cap`.
 *
 * `EpochManager` prices options linearly (fair value × premium factor × amount, rounded up), so one quote for the
 * whole remaining size gives a proportional estimate that fits at that spot. Every answer is then confirmed with a
 * fresh `quote`; if the price moved in between, the estimate shrinks and is quoted again.
 */
export async function affordableOptions({
  budget,
  cap,
  step = 1n,
  quote,
  maxQuotes = 8,
}: {
  budget: bigint;
  cap: bigint;
  step?: bigint;
  quote: (amount: bigint) => Promise<bigint>;
  maxQuotes?: number;
}): Promise<Affordable> {
  const none: Affordable = { options: 0n, premium: 0n, capped: false };
  if (budget <= 0n || cap <= 0n || step <= 0n) return none;
  const all = await quote(cap);
  if (all <= budget) return { options: cap, premium: all, capped: true };
  const down = (x: bigint) => x - (x % step);
  let n = down((cap * budget) / all);
  for (let i = 0; i < maxQuotes && n > 0n; i++) {
    const p = await quote(n);
    if (p <= budget) {
      // Rounding can leave the estimate one step short: try one more.
      const up = n + step;
      if (up < cap) {
        const pu = await quote(up);
        if (pu <= budget) return { options: up, premium: pu, capped: false };
      }
      return { options: n, premium: p, capped: false };
    }
    const next = down((n * budget) / p);
    n = next < n ? next : n - step;
  }
  return none;
}
