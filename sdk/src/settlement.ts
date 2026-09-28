import { StrikeError } from "./errors.js";

/** One Chainlink-style feed round. */
export interface FeedRound {
  roundId: bigint;
  answer: bigint;
  updatedAt: bigint;
}

/** Reads a round by id; resolves to null when the feed has no data for it. */
export type RoundReader = (roundId: bigint) => Promise<FeedRound | null>;

const AGGREGATOR_MASK = (1n << 64n) - 1n;

/**
 * The settlement round for `expiry`: the first round with `updatedAt >= expiry` (SafeStockFeed rule 10), found by
 * walking back from the latest round. Round ids are `phase << 64 | aggregatorRound`; the search stays inside the
 * latest round's phase. It gallops backwards then bisects, so it needs O(log n) reads even long after expiry.
 * @throws StrikeError when no round at or after expiry has been published yet.
 */
export async function findSettlementRound(
  latest: FeedRound,
  getRound: RoundReader,
  expiry: bigint,
): Promise<bigint> {
  if (latest.updatedAt < expiry) {
    throw new StrikeError(
      `no price at or after expiry ${expiry} yet (latest round ${latest.roundId} was published at ${latest.updatedAt})`,
    );
  }
  const phaseBase = latest.roundId - (latest.roundId & AGGREGATOR_MASK);
  const atOrAfter = async (agg: bigint) => {
    const r = await getRound(phaseBase + agg);
    return r !== null && r.updatedAt >= expiry;
  };

  // Invariant: round `hi` is at or after expiry; round `lo` (when known) is before it, or missing.
  let hi = latest.roundId & AGGREGATOR_MASK;
  let lo: bigint | null = null;
  let step = 1n;
  while (lo === null && hi > 1n) {
    const probe = hi - step > 1n ? hi - step : 1n;
    if (await atOrAfter(probe)) {
      hi = probe;
      step *= 2n;
    } else {
      lo = probe;
    }
  }
  if (lo === null) return phaseBase + hi;
  let before: bigint = lo;
  while (hi - before > 1n) {
    const mid: bigint = (before + hi) / 2n;
    if (await atOrAfter(mid)) hi = mid;
    else before = mid;
  }
  return phaseBase + hi;
}
