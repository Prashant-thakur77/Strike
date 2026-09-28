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

/** An ERC-8056 multiplier change and the oracle's corporate-action grace, both in seconds. */
export interface CorporateAction {
  effectiveAt: bigint;
  grace: bigint;
}

/** Last round of `phase` (rounds are contiguous from 1): gallop forward, then bisect. Null for an empty phase. */
async function lastRoundOfPhase(phase: bigint, getRound: RoundReader): Promise<FeedRound | null> {
  const base = phase << 64n;
  let known = await getRound(base + 1n);
  if (known === null) return null;
  let lo = 1n;
  let step = 1n;
  let hi = 0n; // first missing round, once found
  while (hi === 0n) {
    const r = await getRound(base + lo + step);
    if (r === null) hi = lo + step;
    else {
      lo += step;
      known = r;
      step *= 2n;
    }
  }
  while (hi - lo > 1n) {
    const mid: bigint = (lo + hi) / 2n;
    const r = await getRound(base + mid);
    if (r === null) hi = mid;
    else {
      lo = mid;
      known = r;
    }
  }
  return known;
}

/** First round at or after `target`, searching earlier phases when needed, with the proof the oracle expects. */
async function firstAtOrAfter(
  latest: FeedRound,
  getRound: RoundReader,
  target: bigint,
): Promise<{ hints: bigint[]; updatedAt: bigint }> {
  let top = latest;
  for (;;) {
    const id = await findSettlementRound(top, getRound, target);
    const round = await getRound(id);
    if (round === null) throw new StrikeError(`round ${id} disappeared`);
    const phase = id >> 64n;
    if ((id & AGGREGATOR_MASK) > 1n || phase <= 1n) return { hints: [id], updatedAt: round.updatedAt };
    // Round 1 of a new phase: the previous phase's last round proves nothing was printed there after the target.
    const last = await lastRoundOfPhase(phase - 1n, getRound);
    if (last === null) throw new StrikeError(`phase ${phase - 1n} has no rounds; cannot prove round ${id}`);
    if (last.updatedAt < target) return { hints: [id, last.roundId], updatedAt: round.updatedAt };
    top = last; // the old phase printed after the target: the settlement round is there
  }
}

/**
 * Every hint `StockOracle.recordSettlementPriceWithHints` needs: the first round at or after `expiry` (plus the
 * previous phase's last round when it is round 1 of a new phase) and, when that print falls inside a corporate-action
 * window, the same proof for the first round at or after `effectiveAt + grace`. One element means plain
 * `EpochManager.settle(vault, hints[0])` is enough.
 */
export async function findSettlementHints(
  latest: FeedRound,
  getRound: RoundReader,
  expiry: bigint,
  action?: CorporateAction,
): Promise<bigint[]> {
  const first = await firstAtOrAfter(latest, getRound, expiry);
  if (
    action !== undefined &&
    action.effectiveAt !== 0n &&
    first.updatedAt + action.grace > action.effectiveAt &&
    action.effectiveAt + action.grace > first.updatedAt
  ) {
    const next = await firstAtOrAfter(latest, getRound, action.effectiveAt + action.grace);
    return [...first.hints, ...next.hints];
  }
  return first.hints;
}
