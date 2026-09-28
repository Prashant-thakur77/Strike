import { describe, expect, it } from "vitest";
import { type FeedRound, StrikeError, findSettlementHints, findSettlementRound } from "../src/index.js";

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

describe("findSettlementHints", () => {
  /** Rounds per phase: phases[i] holds the publish times of phase i + 1. */
  function phased(phases: number[][]) {
    const rounds: FeedRound[] = [];
    phases.forEach((times, p) =>
      times.forEach((t, i) =>
        rounds.push({ roundId: (BigInt(p + 1) << 64n) + BigInt(i + 1), answer: 100n, updatedAt: BigInt(t) }),
      ),
    );
    const get = async (id: bigint) => rounds.find((r) => r.roundId === id) ?? null;
    return { latest: rounds[rounds.length - 1] as FeedRound, get };
  }
  const P = (phase: number, round: number) => (BigInt(phase) << 64n) + BigInt(round);

  it("needs one hint inside a phase", async () => {
    const f = phased([[100, 200, 300]]);
    expect(await findSettlementHints(f.latest, f.get, 150n)).toEqual([P(1, 2)]);
  });

  it("adds the previous phase's last round for round 1 of a new phase", async () => {
    const f = phased([[100, 200], [500, 600]]);
    expect(await findSettlementHints(f.latest, f.get, 300n)).toEqual([P(2, 1), P(1, 2)]);
  });

  it("goes back to the old phase when it printed after expiry", async () => {
    const f = phased([[100, 200, 350], [500, 600]]);
    expect(await findSettlementHints(f.latest, f.get, 300n)).toEqual([P(1, 3)]);
  });

  it("finds the last round of a long phase", async () => {
    const f = phased([Array.from({ length: 1000 }, (_, i) => i + 1), [5000]]);
    expect(await findSettlementHints(f.latest, f.get, 2000n)).toEqual([P(2, 1), P(1, 1000)]);
  });

  it("moves past a corporate-action window", async () => {
    const f = phased([[100, 200, 300, 400, 500]]);
    // The first print after expiry (200) is within 100s of effectiveAt 250: use the first print at or after 350.
    expect(await findSettlementHints(f.latest, f.get, 150n, { effectiveAt: 250n, grace: 100n })).toEqual([
      P(1, 2),
      P(1, 4),
    ]);
    // A distant action changes nothing.
    expect(await findSettlementHints(f.latest, f.get, 150n, { effectiveAt: 5000n, grace: 100n })).toEqual([
      P(1, 2),
    ]);
  });
});
