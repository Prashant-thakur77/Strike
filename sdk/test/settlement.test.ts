import { describe, expect, it } from "vitest";
import { type FeedRound, StrikeError, findSettlementRound } from "../src/index.js";

const PHASE = 3n << 64n;

/** A feed with rounds 1..n of one phase, published at the given times. Counts reads. */
function feed(times: number[], phase = PHASE) {
  const rounds = times.map((t, i) => ({
    roundId: phase + BigInt(i + 1),
    answer: 100n,
    updatedAt: BigInt(t),
  }));
  let reads = 0;
  const get = async (id: bigint): Promise<FeedRound | null> => {
    reads++;
    return rounds.find((r) => r.roundId === id) ?? null;
  };
  return { latest: rounds[rounds.length - 1] as FeedRound, get, reads: () => reads };
}

describe("findSettlementRound", () => {
  it("finds the first round at or after expiry", async () => {
    const f = feed([100, 200, 300, 400, 500]);
    expect(await findSettlementRound(f.latest, f.get, 250n)).toBe(PHASE + 3n);
    expect(await findSettlementRound(f.latest, f.get, 300n)).toBe(PHASE + 3n);
    expect(await findSettlementRound(f.latest, f.get, 500n)).toBe(PHASE + 5n);
  });

  it("returns the first round of the phase when every round is after expiry", async () => {
    const f = feed([100, 200, 300]);
    expect(await findSettlementRound(f.latest, f.get, 50n)).toBe(PHASE + 1n);
  });

  it("uses O(log n) reads long after expiry", async () => {
    const times = Array.from({ length: 10_000 }, (_, i) => (i + 1) * 60);
    const f = feed(times);
    expect(await findSettlementRound(f.latest, f.get, 61n)).toBe(PHASE + 2n);
    expect(f.reads()).toBeLessThan(40);
  });

  it("throws until a round at or after expiry exists", async () => {
    const f = feed([100, 200]);
    await expect(findSettlementRound(f.latest, f.get, 201n)).rejects.toBeInstanceOf(StrikeError);
  });

  it("treats missing rounds as before expiry", async () => {
    const f = feed([100, 200, 300, 400]);
    const holes = async (id: bigint) => (id === PHASE + 2n ? null : f.get(id));
    expect(await findSettlementRound(f.latest, holes, 150n)).toBe(PHASE + 3n);
  });
});
