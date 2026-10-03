import { describe, expect, it } from "vitest";
import { SETTLE_WAITING_EXIT, settleWaitReason } from "../src/chain.js";

// Friday 2 October 2026, 20:00 UTC: the 2 October series' expiry.
const EXPIRY = 1790971200;

describe("settleWaitReason", () => {
  it("waits while the series has not expired", () => {
    const reason = settleWaitReason({
      now: EXPIRY - 588_440,
      expiry: EXPIRY,
      sold: 4n,
      priceRecorded: false,
      latestPriceAt: EXPIRY - 600,
    });
    expect(reason?.kind).toBe("not-expired");
    expect(reason?.reason).toContain("still selling until expiry at 2026-10-02T20:00:00Z");
    expect(reason?.reason).toContain("in about 164 h");
  });

  it("waits after expiry until the feed has a round at or after expiry", () => {
    const reason = settleWaitReason({
      now: EXPIRY + 16_000,
      expiry: EXPIRY,
      sold: 4n,
      priceRecorded: false,
      latestPriceAt: 1790970931, // 19:55:31 UTC, the last print before expiry
    });
    expect(reason?.kind).toBe("no-print");
    expect(reason?.reason).toContain("no round at or after expiry yet");
    expect(reason?.reason).toContain("2026-10-02T19:55:31Z");
  });

  it("settles once the first print at or after expiry is mirrored", () => {
    const base = { now: EXPIRY + 3_600, expiry: EXPIRY, sold: 4n, priceRecorded: false };
    expect(settleWaitReason({ ...base, latestPriceAt: EXPIRY })).toBeNull();
    expect(settleWaitReason({ ...base, latestPriceAt: EXPIRY + 60 })).toBeNull();
  });

  it("settles when the price is already recorded, or nothing was sold", () => {
    const base = { now: EXPIRY + 3_600, expiry: EXPIRY, latestPriceAt: EXPIRY - 600 };
    expect(settleWaitReason({ ...base, sold: 4n, priceRecorded: true })).toBeNull();
    expect(settleWaitReason({ ...base, sold: 0n, priceRecorded: false })).toBeNull();
  });

  it("waits when the feed could not be read after expiry", () => {
    const reason = settleWaitReason({
      now: EXPIRY + 60,
      expiry: EXPIRY,
      sold: 1n,
      priceRecorded: false,
      latestPriceAt: null,
    });
    expect(reason).toEqual({
      kind: "no-print",
      reason: expect.stringContaining("no round at or after expiry yet;"),
    });
  });

  it("uses EX_TEMPFAIL as the waiting exit code", () => {
    expect(SETTLE_WAITING_EXIT).toBe(75);
  });
});
