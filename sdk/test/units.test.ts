import { describe, expect, it } from "vitest";
import {
  WAD,
  bpsToFraction,
  formatAmount,
  formatUsdg,
  formatWad,
  fractionToBps,
  numberToWad,
  parseAmount,
  parseUsdg,
  parseWad,
  wadToNumber,
} from "../src/index.js";

describe("WAD helpers", () => {
  it("parses decimal strings and numbers", () => {
    expect(parseWad("369.5")).toBe(369_500000000000000000n);
    expect(parseWad(1)).toBe(WAD);
    expect(parseWad("0.000000000000000001")).toBe(1n);
    expect(parseWad(0.0000001)).toBe(100_000_000_000n);
  });

  it("rejects malformed input", () => {
    expect(() => parseWad("1e5")).toThrow(RangeError);
    expect(() => parseWad("12abc")).toThrow(RangeError);
    expect(() => parseWad(Number.NaN)).toThrow(RangeError);
  });

  it("formats, truncating instead of rounding up", () => {
    expect(formatWad(369_999999000000000000n, 2)).toBe("369.99");
    expect(formatWad(WAD)).toBe("1");
    expect(formatWad(1n, 18)).toBe("0.000000000000000001");
    expect(formatWad(-1_500000000000000000n)).toBe("-1.5");
  });

  it("round-trips floats without float noise", () => {
    expect(numberToWad(390.12)).toBe(390_120000000000000000n);
    expect(wadToNumber(390_120000000000000000n)).toBe(390.12);
    expect(() => numberToWad(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe("USDG and token amounts", () => {
  it("uses 6 decimals for USDG", () => {
    expect(parseUsdg("25.5")).toBe(25_500_000n);
    expect(formatUsdg(25_555_555n)).toBe("25.55");
    expect(formatUsdg(25_555_555n, 6)).toBe("25.555555");
    expect(formatUsdg(10_000_000n)).toBe("10");
  });

  it("formats arbitrary decimals", () => {
    expect(formatAmount(1_234_567n, 6, 2)).toBe("1.23");
    expect(formatAmount(0n, 18)).toBe("0");
    expect(parseAmount("8", 18)).toBe(8n * WAD);
  });
});

describe("basis points", () => {
  it("converts both ways", () => {
    expect(bpsToFraction(2500)).toBe(0.25);
    expect(fractionToBps(0.2)).toBe(2000);
    expect(fractionToBps(0.12345)).toBe(1235);
  });
});
