// The decision page's price path: the underlying's feed rounds on the vault's chain (the mirrored mainnet Chainlink
// prints the contracts read) around one epoch, from GET /api/mirror-audit, which checks each round against the mainnet
// round it copies. Pure: the page fetches the audit and passes the rounds in.

const YEAR = 31_536_000;

export interface AuditRound {
  roundId: string;
  price: string;
  updatedAt: number;
  status: string;
}

export interface PathPoint {
  t: number;
  price: number;
  /** The audit found the same answer in the mainnet Chainlink round with the same timestamp. */
  matched: boolean;
  status: string;
}

export interface PricePath {
  points: PathPoint[];
  /** Rounds in the window the audit could not match (anything but "match"). */
  unmatched: number;
  from: number;
  to: number;
}

/**
 * The rounds from a day before the epoch opened to three days after expiry, oldest first. Deploy seeds are left out:
 * they were never a mainnet price.
 */
export function pricePath(rounds: AuditRound[], openedAt: number, expiry: number): PricePath {
  const from = openedAt - 86_400;
  const to = expiry + 3 * 86_400;
  const points = rounds
    .filter((r) => r.status !== "deploy-seed" && r.updatedAt >= from && r.updatedAt <= to)
    .map((r) => ({ t: r.updatedAt, price: Number(r.price), matched: r.status === "match", status: r.status }))
    .filter((p) => Number.isFinite(p.price) && p.price > 0)
    .sort((a, b) => a.t - b.t);
  return { points, unmatched: points.filter((p) => !p.matched).length, from, to };
}

/** The model's one-sigma range at expiry around the snapshot spot: spot × e^(±σ√T), T from the epoch open. */
export function oneSigmaRange(
  spot: number,
  sigma: number,
  tenorSeconds: number,
): { low: number; high: number } {
  const s = sigma * Math.sqrt(tenorSeconds / YEAR);
  return { low: spot * Math.exp(-s), high: spot * Math.exp(s) };
}

/** The last round at or before `t`: the price the feed showed then. */
export function priceAt(points: PathPoint[], t: number): PathPoint | null {
  let last: PathPoint | null = null;
  for (const p of points) {
    if (p.t > t) break;
    last = p;
  }
  return last;
}
