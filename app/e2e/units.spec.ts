import { expect, test } from "@playwright/test";
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
