import { describe, expect, it } from "vitest";
import {
  type Mandate,
  SECONDS_PER_YEAR,
  WAD,
  roundStrikeToCent,
  blackScholes,
  clampDeltaToMandate,
  floorToCent,
  maxProposalSize,
  normCdf,
  strikeForDelta,
  suggestProposal,
  vaultCapacity,
} from "../src/index.js";

const WEEK = 7 * 86_400;
const mandate: Mandate = {
  minDeltaBps: 1000,
  maxDeltaBps: 3500,
  minPremiumBps: 9500,
  minYieldBps: 5,
  maxShareSoldBps: 8000,
  minTenor: 86_400,
  maxTenor: 8 * 86_400,
};

// Outputs of the Rust/Solidity integer pricer (contracts/test/vectors/pricer.json), all WAD.
const vectors = [
  {
    spot: "1562015618046984188433",
    strike: "984071553663356763173",
    time: 3062137,
    sigma: "1926790764033279735",
    isCall: true,
    price: "669889701755132186750",
    delta: "857631834876286019",
  },
  {
    spot: "1607965387666567210864",
    strike: "2202916517133031701186",
    time: 5726391,
    sigma: "1963028508085419887",
    isCall: false,
    price: "955648260480847710802",
    delta: "-483288746541130209",
  },
  {
    spot: "1522912290465998038367",
    strike: "1416315169772584942463",
    time: 2614706,
    sigma: "1775282573844838595",
    isCall: true,
    price: "352684903460548532318",
    delta: "654518358730701167",
  },
  {
    spot: "29392446141223050558",
    strike: "43213707970242899189",
    time: 6958741,
    sigma: "298398994406646454",
    isCall: false,
    price: "13825750012896064615",
    delta: "-996313923651076668",
  },
  {
    spot: "1438853710312906179211",
    strike: "1625909373404971056090",
    time: 4170795,
    sigma: "617456883804766606",
    isCall: false,
    price: "250205648399334102073",
    delta: "-667135222247208168",
  },
  {
    spot: "1385089131011722161694",
    strike: "1703666902517695675356",
    time: 3610890,
    sigma: "461825613193074701",
    isCall: false,
    price: "328922851539986612832",
    delta: "-893726672043743661",
  },
  {
    spot: "36828934493221133271",
    strike: "47518693677079651304",
    time: 3137715,
    sigma: "101191978116112897",
    isCall: false,
    price: "10689759183858518161",
    delta: "-999999999999999194",
  },
  {
    spot: "478811020088020618969",
    strike: "411786272709208572709",
    time: 2447096,
    sigma: "1769213507293955103",
    isCall: true,
    price: "124121924934388800389",
    delta: "709664630281197947",
  },
  {
    spot: "1117950966312000727917",
    strike: "994981671271992719744",
    time: 4516251,
    sigma: "763215627825399151",
    isCall: false,
    price: "69484148047560456272",
    delta: "-291890376534680706",
  },
  {
    spot: "716599960686718153419",
    strike: "566118894686890497494",
    time: 7333979,
    sigma: "572346512259683548",
    isCall: true,
    price: "169565559490166047211",
    delta: "839403120264485247",
  },
];
const wad = (s: string) => Number(s) / 1e18;

describe("normCdf", () => {
  it("matches reference values", () => {
    expect(normCdf(0)).toBe(0.5);
    expect(normCdf(1.96)).toBeCloseTo(0.9750021048517795, 14);
    expect(normCdf(-1)).toBeCloseTo(0.15865525393145707, 14);
    expect(normCdf(8)).toBeCloseTo(1 - 6.22096057427178e-16, 15);
    expect(normCdf(-40)).toBe(0);
  });

  it("is symmetric", () => {
    for (const x of [0.1, 0.5, 1.3, 2.7, 5, 7.5]) expect(normCdf(x) + normCdf(-x)).toBeCloseTo(1, 14);
  });
});

describe("blackScholes", () => {
  it("prices the textbook at-the-money option", () => {
    const call = blackScholes(100, 100, SECONDS_PER_YEAR, 0.2, true);
    expect(call.price).toBeCloseTo(7.965567455405804, 10);
    expect(call.delta).toBeCloseTo(0.539827837277029, 12);
    const put = blackScholes(100, 100, SECONDS_PER_YEAR, 0.2, false);
    expect(put.price).toBeCloseTo(call.price, 10);
    expect(put.delta).toBeCloseTo(call.delta - 1, 12);
  });

  it("satisfies put-call parity with zero rates", () => {
    for (const [s, k] of [
      [369, 390],
      [224, 200],
      [50, 75],
    ] as const) {
      const c = blackScholes(s, k, WEEK, 0.6, true).price;
      const p = blackScholes(s, k, WEEK, 0.6, false).price;
      expect(c - p).toBeCloseTo(s - k, 9);
    }
  });

  it("agrees with the on-chain integer pricer to 1e-9 of spot", () => {
    for (const v of vectors) {
      const q = blackScholes(wad(v.spot), wad(v.strike), v.time, wad(v.sigma), v.isCall);
      expect(Math.abs(q.price - wad(v.price)) / wad(v.spot)).toBeLessThan(1e-9);
      expect(Math.abs(q.delta - wad(v.delta))).toBeLessThan(1e-9);
    }
  });

  it("returns intrinsic value at expiry", () => {
    expect(blackScholes(110, 100, 0, 0.5, true)).toEqual({ price: 10, delta: 1 });
    expect(blackScholes(90, 100, 0, 0.5, true)).toEqual({ price: 0, delta: 0 });
    expect(blackScholes(90, 100, -5, 0.5, false)).toEqual({ price: 10, delta: -1 });
  });

  it("rejects invalid inputs", () => {
    expect(() => blackScholes(0, 100, WEEK, 0.5, true)).toThrow(RangeError);
    expect(() => blackScholes(100, 100, WEEK, 0, true)).toThrow(RangeError);
  });
});

describe("strikeForDelta", () => {
  it("inverts delta for calls and puts", () => {
    for (const target of [0.1, 0.2, 0.35, 0.5, 0.8]) {
      const kc = strikeForDelta(369, target, WEEK, 0.6, true);
      expect(blackScholes(369, kc, WEEK, 0.6, true).delta).toBeCloseTo(target, 9);
      const kp = strikeForDelta(369, -target, WEEK, 0.6, false);
      expect(blackScholes(369, kp, WEEK, 0.6, false).delta).toBeCloseTo(-target, 9);
    }
  });

  it("puts low-delta calls above spot and low-delta puts below", () => {
    const call = strikeForDelta(369, 0.2, 4 * 86_400, 0.6, true);
    const put = strikeForDelta(369, 0.2, 4 * 86_400, 0.6, false);
    expect(call).toBeGreaterThan(369);
    // Closed form: K = S·exp(-N⁻¹(Δ)·σ√T + σ²T/2) with N⁻¹(0.2) = -0.8416212335729143.
    const vol = 0.6 * Math.sqrt((4 * 86_400) / SECONDS_PER_YEAR);
    expect(call).toBeCloseTo(369 * Math.exp(0.8416212335729143 * vol + (vol * vol) / 2), 6);
    expect(put).toBeLessThan(369);
  });

  it("rejects unreachable or invalid targets", () => {
    expect(() => strikeForDelta(369, 0, WEEK, 0.6, true)).toThrow(RangeError);
    expect(() => strikeForDelta(369, 1, WEEK, 0.6, true)).toThrow(RangeError);
    expect(() => strikeForDelta(369, 0.2, 0, 0.6, true)).toThrow(RangeError);
    // At 500% volatility over two years even a 10x-spot call keeps |delta| > 0.99.
    expect(() => strikeForDelta(100, 0.5, 2 * SECONDS_PER_YEAR, 5, true)).toThrow(/not reachable/);
  });
});

describe("mandate helpers", () => {
  it("clamps a target delta inside the band with a margin", () => {
    expect(clampDeltaToMandate(0.2, mandate)).toBe(0.2);
    expect(clampDeltaToMandate(0.5, mandate)).toBeCloseTo(0.34, 12);
    expect(clampDeltaToMandate(0.05, mandate)).toBeCloseTo(0.11, 12);
    expect(clampDeltaToMandate(-0.2, mandate)).toBe(0.2);
    expect(clampDeltaToMandate(0.9, { ...mandate, minDeltaBps: 2000, maxDeltaBps: 2100 })).toBeCloseTo(
      0.205,
      12,
    );
  });

  it("computes capacity like the contract", () => {
    expect(vaultCapacity({ isCall: true, totalAssets: 10n * WAD, strike: 0n, underlyingDecimals: 18 })).toBe(
      10n * WAD,
    );
    // 50,000 USDG backs 50,000 / 350 puts.
    expect(
      vaultCapacity({
        isCall: false,
        totalAssets: 50_000_000_000n,
        strike: 350n * WAD,
        underlyingDecimals: 18,
      }),
    ).toBe(142_857142857142857142n);
    expect(vaultCapacity({ isCall: false, totalAssets: 1n, strike: 0n, underlyingDecimals: 18 })).toBe(0n);
    expect(maxProposalSize(10n * WAD, mandate)).toBe(8n * WAD);
  });

  it("floors prices to a cent", () => {
    expect(floorToCent(388_901234567890000000n)).toBe(388_900000000000000000n);
  });
});

describe("suggestProposal", () => {
  const base = {
    spot: 369,
    sigma: 0.6,
    tenorSeconds: 4 * 86_400 + 5 * 3600,
    mandate,
    underlyingDecimals: 18,
  };

  it("suggests a covered call inside the mandate", () => {
    const s = suggestProposal({ ...base, isCall: true, totalAssets: 10n * WAD });
    expect(s.targetDelta).toBe(0.2);
    expect(s.delta).toBeGreaterThan(mandate.minDeltaBps / 10_000);
    expect(s.delta).toBeLessThan(mandate.maxDeltaBps / 10_000);
    expect(s.delta).toBeCloseTo(0.2, 3);
    expect(s.strike % 10n ** 16n).toBe(0n);
    expect(s.strikeUsd).toBeGreaterThan(369);
    expect(s.premiumBps).toBe(10_000);
    expect(s.size).toBe(8n * WAD);
    expect(s.meetsMinYield).toBe(true);
  });

  it("suggests a cash-secured put, clamping the delta and honouring the premium floor", () => {
    const s = suggestProposal({
      ...base,
      isCall: false,
      totalAssets: 50_000_000_000n,
      targetDelta: 0.9,
      premiumBps: 9000,
      sizeShareBps: 5000,
    });
    expect(s.targetDelta).toBeCloseTo(0.34, 12);
    expect(s.strikeUsd).toBeLessThan(369);
    expect(s.premiumBps).toBe(9500);
    expect(s.size).toBe(maxProposalSize(s.capacity, mandate) / 2n);
  });

  it("flags a premium below the minimum yield", () => {
    const s = suggestProposal({
      ...base,
      isCall: true,
      totalAssets: WAD,
      mandate: { ...mandate, minYieldBps: 5000 },
    });
    expect(s.meetsMinYield).toBe(false);
  });
});

describe("roundStrikeToCent", () => {
  const band = { minDeltaBps: 500, maxDeltaBps: 4000 };
  const k = 275_123_400_000_000_000_000n; // 275.1234
  it("rounds toward the middle of the delta band", () => {
    // Upper half: lower |delta| (calls up, puts down). Lower half: raise it (calls down, puts up).
    expect(roundStrikeToCent(k, true, 4000, band)).toBe(275_130_000_000_000_000_000n);
    expect(roundStrikeToCent(k, false, 4000, band)).toBe(275_120_000_000_000_000_000n);
    expect(roundStrikeToCent(k, true, 500, band)).toBe(275_120_000_000_000_000_000n);
    expect(roundStrikeToCent(k, false, 500, band)).toBe(275_130_000_000_000_000_000n);
    expect(roundStrikeToCent(275_120_000_000_000_000_000n, true, 4000, band)).toBe(
      275_120_000_000_000_000_000n,
    );
  });
});
