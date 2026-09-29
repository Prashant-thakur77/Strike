import { expect, test } from "@playwright/test";
import { breakeven, buyPrice, payoffAt } from "../src/lib/payoff";
import { UNIT_MULTIPLIER, fmtMultiplier, hasMultiplier, perSharePrice } from "../src/lib/shares";

// Pure unit tests (no browser page) for the ERC-8056 per-share conversion. Chainlink prices one RAW token; one raw
// token is multiplier / 1e18 shares, so price per share = price per token / multiplier. Never price × multiplier.

const WAD = 10n ** 18n;
const usd = (n: string) => BigInt(Math.round(Number(n) * 1e6)) * 10n ** 12n;

test("per-share price divides the per-token price by the multiplier", () => {
  test.skip(test.info().project.name !== "desktop", "pure function: one project is enough");
  const m = 1_000775000000000000n; // 1.000775
  expect(perSharePrice(usd("381.12"), m)).toBe((usd("381.12") * WAD) / m);
  expect(Number(perSharePrice(usd("381.12"), m)) / 1e18).toBeCloseTo(380.8249, 3);
  // A 2-for-1 split: each raw token is two shares, so a share costs half the token price.
  expect(perSharePrice(usd("400"), 2n * WAD)).toBe(usd("200"));
  // Never above the feed price when the multiplier is above 1 (it would be if we multiplied).
  expect(perSharePrice(usd("400"), m) < usd("400")).toBe(true);
});

test("a missing or unit multiplier leaves the price alone", () => {
  test.skip(test.info().project.name !== "desktop", "pure function: one project is enough");
  expect(perSharePrice(usd("381.12"), UNIT_MULTIPLIER)).toBe(usd("381.12"));
  expect(perSharePrice(usd("381.12"), 0n)).toBe(usd("381.12"));
  expect(hasMultiplier(UNIT_MULTIPLIER)).toBe(false);
  expect(hasMultiplier(0n)).toBe(false);
  expect(hasMultiplier(1_000775000000000000n)).toBe(true);
});

test("formats the multiplier for the note", () => {
  test.skip(test.info().project.name !== "desktop", "pure function: one project is enough");
  expect(fmtMultiplier(1_000775000000000000n)).toBe("1.000775");
  expect(fmtMultiplier(UNIT_MULTIPLIER)).toBe("1.000");
  expect(fmtMultiplier(2n * WAD)).toBe("2.000");
  expect(fmtMultiplier(500000000000000000n)).toBe("0.500");
  expect(fmtMultiplier(1_000000400000000000n)).toBe("1.0000004");
});

// Payoff at expiry and the buy-price mirror of EpochManager._quoteBuy (display only).

test("payoff: calls pay S − K, puts K − S; the depositor side mirrors the buyer", () => {
  test.skip(test.info().project.name !== "desktop", "pure function: one project is enough");
  expect(payoffAt(true, 370, 400, 2.5)).toEqual({ payout: 30, buyer: 27.5, depositor: -27.5 });
  expect(payoffAt(true, 370, 350, 2.5)).toEqual({ payout: 0, buyer: -2.5, depositor: 2.5 });
  expect(payoffAt(false, 330, 300, 4)).toEqual({ payout: 30, buyer: 26, depositor: -26 });
  expect(payoffAt(false, 330, 360, 4)).toEqual({ payout: 0, buyer: -4, depositor: 4 });
  expect(breakeven(true, 369.86, 2.5)).toBeCloseTo(372.36, 6);
  expect(breakeven(false, 330, 4)).toBe(326);
  expect(payoffAt(true, 369.86, breakeven(true, 369.86, 2.5), 2.5).buyer).toBeCloseTo(0, 9);
});

test("buy price: fair value at the buffered spot × premium factor, never below intrinsic", () => {
  test.skip(test.info().project.name !== "desktop", "pure function: one project is enough");
  const base = {
    strike: 369.86,
    tenorSeconds: 3 * 86_400,
    sigma: 0.6,
    premiumBps: 10_000,
    spotBufferBps: 50,
  };
  // A stand-in model that records what it was asked (specs load as CommonJS: no @strike/sdk here).
  const asked: number[][] = [];
  const model = (spot: number, strike: number, tenor: number, sigma: number) => {
    asked.push([spot, strike, tenor, sigma]);
    return 2.5;
  };
  const call = buyPrice({ ...base, spot: 352.45, isCall: true }, model);
  expect(call.pricedSpot).toBeCloseTo(352.45 * 1.005, 9); // against a call buyer: up
  expect(asked[0]).toEqual([call.pricedSpot, 369.86, 3 * 86_400, 0.6]);
  expect(call.perOption).toBe(2.5);
  expect(call.floorBinds).toBe(false);
  const put = buyPrice({ ...base, spot: 352.45, isCall: false }, model);
  expect(put.pricedSpot).toBeCloseTo(352.45 * 0.995, 9); // against a put buyer: down
  expect(buyPrice({ ...base, spot: 352.45, isCall: true, premiumBps: 12_000 }, model).perOption).toBeCloseTo(
    3,
    9,
  );
  // Deep in the money at a 50% premium factor: the intrinsic floor sets the price.
  const itm = buyPrice({ ...base, spot: 420, isCall: true, premiumBps: 5_000 }, () => 52);
  expect(itm.floorBinds).toBe(true);
  expect(itm.perOption).toBeCloseTo(420 * 1.005 - 369.86, 9);
});
