import { expect, test } from "@playwright/test";
import { parseUnits } from "viem";
import { fmtDollars } from "../src/lib/format";
import {
  affordableOptions,
  bump,
  callPayout,
  optionStep,
  premiumPerOption,
  protectOutcome,
  protectPlan,
  putPayout,
  quoteBudget,
  ratio,
  upsideOutcome,
  valueInUsd,
  withSlippage,
} from "../src/lib/hedge";
import { UNIT_MULTIPLIER, perSharePrice, sharesOf } from "../src/lib/shares";

// Pure unit tests (no browser page) for the buy panel's hedging arithmetic. Units as on-chain: options and stock
// tokens in underlying base units (18 decimals here), USDG in base units (6 decimals), prices WAD per raw token.

const T = 18; // stock-token decimals
const U = 6; // USDG decimals
const tok = (n: string) => parseUnits(n, T);
const usdg = (n: string) => parseUnits(n, U);
const usd = (n: string) => parseUnits(n, 18); // WAD price per raw token

test.beforeEach(() => {
  test.skip(test.info().project.name !== "desktop", "pure functions: one project is enough");
});

/** EpochManager._quoteBuy for a fixed fair value: premium rounded up, never zero. */
function fakeQuote(perOptionWad: bigint) {
  return (amount: bigint) => {
    const p = valueInUsd(amount, perOptionWad, T, U, true);
    return p === 0n ? 1n : p;
  };
}

test("values token amounts like Decimals.valueInUsd, rounding either way", () => {
  expect(valueInUsd(tok("1"), usd("386.37"), T, U)).toBe(usdg("386.37"));
  expect(valueInUsd(tok("120"), usd("386.37"), T, U)).toBe(usdg("46364.4"));
  // One base unit at $1 is 1e-18 dollars: zero rounded down, one USDG unit rounded up.
  expect(valueInUsd(1n, usd("1"), T, U)).toBe(0n);
  expect(valueInUsd(1n, usd("1"), T, U, true)).toBe(1n);
  expect(valueInUsd(0n, usd("1"), T, U, true)).toBe(0n);
  // A 6-decimal token.
  expect(valueInUsd(1_500000n, usd("10"), 6, U)).toBe(usdg("15"));
});

test("slippage: the budget holds the quote plus its allowance, and no more", () => {
  expect(withSlippage(usdg("100"), 100)).toBe(usdg("101"));
  expect(withSlippage(usdg("3.14"), 50)).toBe(usdg("3.1557"));
  expect(quoteBudget(0n, 100)).toBe(0n);
  expect(quoteBudget(usdg("101"), 100)).toBe(usdg("100"));
  for (const slip of [0, 50, 100, 200]) {
    for (const budget of [1n, 7n, 99n, 100n, 101n, 12_345n, usdg("100"), usdg("99.999999"), usdg("250000")]) {
      const p = quoteBudget(budget, slip);
      expect(withSlippage(p, slip)).toBeLessThanOrEqual(budget);
      expect(withSlippage(p + 1n, slip)).toBeGreaterThan(budget);
    }
  }
});

test("protect: one put per token held, capped at what the series has left", () => {
  expect(protectPlan(tok("10"), tok("23"))).toEqual({ options: tok("10"), capped: false, uncovered: 0n });
  expect(protectPlan(tok("23"), tok("23"))).toEqual({ options: tok("23"), capped: false, uncovered: 0n });
  expect(protectPlan(tok("120"), tok("23"))).toEqual({
    options: tok("23"),
    capped: true,
    uncovered: tok("97"),
  });
  expect(protectPlan(tok("5"), 0n)).toEqual({ options: 0n, capped: true, uncovered: tok("5") });
  expect(protectPlan(0n, tok("23"))).toEqual({ options: 0n, capped: false, uncovered: 0n });
});

test("protect: cost, protected value, worst case and max loss for a worked example", () => {
  // 120 TSLA at $386.37, puts struck at $370 for 412.35 USDG.
  const out = protectOutcome({
    held: tok("120"),
    options: tok("120"),
    premium: usdg("412.35"),
    spot: usd("386.37"),
    strike: usd("370"),
    tokenDecimals: T,
    usdDecimals: U,
  });
  expect(out.positionValue).toBe(usdg("46364.4"));
  expect(out.worstCase).toBe(usdg("43987.65")); // 120 × 370 − 412.35
  expect(out.maxLoss).toBe(usdg("2376.75")); // 46,364.40 − 43,987.65
  expect(out.costRatio!).toBeCloseTo(412.35 / 46364.4, 8);
  expect(out.maxLossRatio!).toBeCloseTo(2376.75 / 46364.4, 8);

  // Capped at 23 options: the 97 uncovered tokens count at zero in the worst case.
  const capped = protectOutcome({
    held: tok("120"),
    options: tok("23"),
    premium: usdg("79.03"),
    spot: usd("386.37"),
    strike: usd("370"),
    tokenDecimals: T,
    usdDecimals: U,
  });
  expect(capped.worstCase).toBe(usdg("8430.97")); // 23 × 370 − 79.03
  expect(capped.maxLoss).toBe(usdg("46364.4") - usdg("8430.97"));

  // No position value (feed down): ratios are unknown, not zero or infinite.
  const dark = protectOutcome({
    held: tok("1"),
    options: tok("1"),
    premium: usdg("1"),
    spot: 0n,
    strike: usd("370"),
    tokenDecimals: T,
    usdDecimals: U,
  });
  expect(dark.costRatio).toBeNull();
  expect(dark.maxLossRatio).toBeNull();
  expect(ratio(1n, 0n)).toBeNull();
});

test("protect: the worst case is the lowest the position is worth at any settlement price", () => {
  const spot = usd("386.37");
  const strike = usd("370");
  for (const [held, options, premium] of [
    [tok("120"), tok("120"), usdg("412.35")],
    [tok("120"), tok("23"), usdg("79.03")],
    [tok("0.5"), tok("0.5"), usdg("1.72")],
  ] as const) {
    const out = protectOutcome({ held, options, premium, spot, strike, tokenDecimals: T, usdDecimals: U });
    // Tokens + puts − premium, if the stock settles at `price`.
    const at = (price: bigint) =>
      valueInUsd(held, price, T, U) + putPayout(options, strike, price, T, U) - premium;
    for (let i = 0n; i <= 200n; i++) {
      const price = (spot * 2n * i) / 200n; // $0 … 2 × spot
      expect(at(price)).toBeGreaterThanOrEqual(out.worstCase - 1n); // one unit for the two floors
    }
    expect(at(0n)).toBe(out.worstCase); // reached if the stock goes to zero
  }
  // Out of the money, the puts pay nothing.
  expect(putPayout(tok("10"), strike, strike, T, U)).toBe(0n);
  expect(putPayout(tok("10"), strike, usd("380"), T, U)).toBe(0n);
  expect(putPayout(tok("10"), strike, usd("360"), T, U)).toBe(usdg("100"));
});

test("per-share figures divide prices and scale token amounts by the multiplier", () => {
  const m = 1_000775000000000000n; // 1.000775
  expect(sharesOf(tok("120"), m)).toBe(tok("120.093"));
  expect(sharesOf(tok("3"), 2n * UNIT_MULTIPLIER)).toBe(tok("6")); // 2-for-1 split
  expect(sharesOf(tok("3"), 0n)).toBe(tok("3"));
  expect(sharesOf(tok("3"), UNIT_MULTIPLIER)).toBe(tok("3"));
  // The protected price per share is the strike divided by the multiplier, never multiplied.
  expect(perSharePrice(usd("370"), m) < usd("370")).toBe(true);
  expect(Number(perSharePrice(usd("370"), m)) / 1e18).toBeCloseTo(369.7134, 3);
});

test("calls: breakeven is strike + premium per option, rounded against the buyer", () => {
  expect(premiumPerOption(usdg("99"), tok("10"), T, U)).toBe(usd("9.9"));
  expect(premiumPerOption(usdg("99"), 0n, T, U)).toBe(0n);
  // Rounded up: the per-option premium never undercounts what was paid.
  const ppo = premiumPerOption(1n, 3n, T, U);
  expect(valueInUsd(3n, ppo, T, U, true)).toBeGreaterThanOrEqual(1n);
  expect(bump(usd("100"), 1_000)).toBe(usd("110"));

  const out = upsideOutcome({
    options: tok("10"),
    premium: usdg("99"),
    strike: usd("407"),
    tokenDecimals: T,
    usdDecimals: U,
  });
  expect(out.breakeven).toBe(usd("416.9"));
  expect(out.target).toBe(usd("458.59")); // 10% above breakeven
  // Each call pays (S − K) / S tokens: 51.59 / 458.59 TSLA, i.e. $51.59, so 10 pay $515.90.
  expect(Number(out.payoutTokens) / 1e18).toBeCloseTo((10 * 51.59) / 458.59, 12);
  expect(out.payoutUsd).toBeGreaterThanOrEqual(usdg("515.9") - 1n);
  expect(out.payoutUsd).toBeLessThanOrEqual(usdg("515.9"));
  // Net at 10% over breakeven is 10% of breakeven per option: 10 × $41.69.
  expect(out.profit).toBeGreaterThanOrEqual(usdg("416.9") - 1n);
  expect(out.profit).toBeLessThanOrEqual(usdg("416.9"));
});

test("calls: the payout mirrors EpochManager settlement and redemption", () => {
  const strike = usd("407");
  expect(callPayout(tok("10"), strike, strike, T, U)).toEqual({ tokens: 0n, usd: 0n });
  expect(callPayout(tok("10"), strike, usd("400"), T, U)).toEqual({ tokens: 0n, usd: 0n });
  const price = usd("440");
  const perOption = ((price - strike) * 10n ** 18n) / price; // _settleMath
  const tokens = (tok("3") * perOption) / 10n ** 18n; // redeem
  expect(callPayout(tok("3"), strike, price, T, U)).toEqual({ tokens, usd: valueInUsd(tokens, price, T, U) });
  // Worth S − K per option, less rounding dust.
  expect(callPayout(tok("3"), strike, price, T, U).usd).toBeGreaterThanOrEqual(usdg("99") - 1n);
});

test("budget: the most options whose quote fits, confirmed by a fresh quote", async () => {
  const step = optionStep(T);
  expect(step).toBe(10n ** 12n);
  expect(optionStep(6)).toBe(1n);
  expect(optionStep(0)).toBe(1n);

  const quote = fakeQuote(usd("3.1410")); // $3.141 per option
  const cap = tok("59"); // $185.32 for all of it
  const budget = quoteBudget(usdg("100"), 100);
  let calls = 0;
  const a = await affordableOptions({
    budget,
    cap,
    step,
    quote: async (n) => {
      calls++;
      return quote(n);
    },
  });
  expect(a.capped).toBe(false);
  expect(a.options % step).toBe(0n);
  expect(a.premium).toBe(quote(a.options));
  expect(a.premium).toBeLessThanOrEqual(budget);
  expect(quote(a.options + step)).toBeGreaterThan(budget); // no room for one more step
  expect(withSlippage(a.premium, 100)).toBeLessThanOrEqual(usdg("100")); // max loss within the budget
  expect(Number(a.options) / 1e18).toBeCloseTo(99.0099 / 3.141, 4);
  expect(calls).toBeLessThanOrEqual(3);

  // A budget above the whole series buys all that's left.
  const all = await affordableOptions({ budget: usdg("1000"), cap, step, quote: async (n) => quote(n) });
  expect(all).toEqual({ options: cap, premium: quote(cap), capped: true });

  // Nothing to buy: no budget, sold out, or too small for one step.
  const none = { options: 0n, premium: 0n, capped: false };
  expect(await affordableOptions({ budget: 0n, cap, step, quote: async (n) => quote(n) })).toEqual(none);
  expect(await affordableOptions({ budget, cap: 0n, step, quote: async (n) => quote(n) })).toEqual(none);
  expect(await affordableOptions({ budget: 1n, cap, step, quote: async (n) => quote(n) })).toEqual(none);
});

test("budget: re-quotes and shrinks when the price moves after the estimate", async () => {
  const cap = tok("23");
  const step = optionStep(T);
  const budget = usdg("50");
  // The spot jumps 3% after the first quote, so the proportional estimate no longer fits.
  let n = 0;
  const quote = async (amount: bigint) => fakeQuote(n++ === 0 ? usd("3.141") : usd("3.23523"))(amount);
  const a = await affordableOptions({ budget, cap, step, quote });
  expect(a.options).toBeGreaterThan(0n);
  expect(a.premium).toBeLessThanOrEqual(budget);
  expect(a.premium).toBe(fakeQuote(usd("3.23523"))(a.options));
  expect(fakeQuote(usd("3.23523"))(a.options + step)).toBeGreaterThan(budget);
});

test("formats dollar amounts with cents and a real minus sign", () => {
  expect(fmtDollars(usdg("43987.65"), U)).toBe("$43,987.65");
  expect(fmtDollars(usdg("2376.7"), U)).toBe("$2,376.70");
  expect(fmtDollars(-usdg("12"), U)).toBe("−$12.00");
  expect(fmtDollars(undefined, U)).toBe("—");
});
