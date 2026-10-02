// Where a vault's week stands, from the chain's state and clock, and what the vault page says about a series that
// has expired but not settled. Pure (no SDK import), so the Playwright specs load it as it is.
//
// EpochManager keeps a vault in Selling (2) after its series expires: `settle` only accepts the first price round at
// or after expiry (InvalidSettlementRound otherwise), and on the testnets that round is a mirrored Robinhood Chain
// mainnet Chainlink print. When the close is followed by a weekend, that print can take a day or more, so the page
// has to tell "selling" from "expired, waiting for the settlement price" itself.

/**
 * - `idle`: between epochs (after a settlement or an abort), nothing on sale.
 * - `open`: the epoch is open and the vault locked, waiting for the agent's proposal.
 * - `selling`: a series is live and before its expiry.
 * - `expired`: still Selling on chain, but past expiry: waiting for the settlement price and the settle transaction.
 */
export type SeriesPhase = "idle" | "open" | "selling" | "expired";

export function seriesPhase(
  vault: { state: number; series: { expiry: bigint } | null },
  now: number,
): SeriesPhase {
  if (vault.state === 1) return "open";
  if (vault.state !== 2 || !vault.series) return "idle";
  return Number(vault.series.expiry) <= now ? "expired" : "selling";
}

/** The chain's clock when it has been read (`useMarket().now`), else the wall clock, in unix seconds. */
export function clockNow(chainNow: number | undefined): number {
  return chainNow ?? Math.floor(Date.now() / 1000);
}

export interface SettlementWaitInput {
  symbol: string;
  expiry: number;
  /** Options sold: with none sold, `settle` needs no price at all. */
  sold: bigint;
  /** The feed's last round on this chain: its time (unix seconds) and price (USD), when known. */
  lastPrintAt: number | null;
  lastPrice: number | null;
  /** True on the testnets whose feeds mirror Robinhood Chain mainnet Chainlink (46630, 421614). */
  mirrored: boolean;
  /** The next NYSE session open, from the chain's calendar, when the market is closed now. */
  reopensAt: number | null;
  /** Seconds before expiry that sales stop (`EpochManager.saleCutoff`). */
  saleCutoff: number | null;
  /** `fmtUtc` from lib/marketHours, passed in so this file stays free of Intl setup. */
  fmt: (ts: number) => string;
}

export interface SettlementWait {
  headline: string;
  /** The settlement rule and why nobody chooses the price. */
  rule: string;
  /** The last print and whether it can be the settlement round. */
  lastPrint: string | null;
  /** Why the wait can be long right now (a closed market). */
  why: string | null;
  buying: string;
}

const usd = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The vault page's account of a series past expiry and not settled. It never states a settlement price. */
export function settlementWait(i: SettlementWaitInput): SettlementWait {
  const when = i.fmt(i.expiry);
  const source = i.mirrored
    ? `the first Chainlink ${i.symbol} print on Robinhood Chain mainnet at or after expiry, mirrored to this testnet by the keeper`
    : `the first ${i.symbol} price round at or after expiry`;
  const cutoff = !i.saleCutoff
    ? ""
    : i.saleCutoff % 3600 === 0
      ? `${i.saleCutoff / 3600} hour${i.saleCutoff === 3600 ? "" : "s"} `
      : `${Math.round(i.saleCutoff / 60)} minutes `;
  const buying = `Buying is closed: sales stopped ${cutoff}before expiry. Holders redeem once the series settles.`;

  if (i.sold === 0n) {
    return {
      headline: `Expired ${when}. Nothing was sold, so it needs no settlement price.`,
      rule: "With no options sold, settle records no price: anyone can send it now, and the vault unlocks.",
      lastPrint: null,
      why: null,
      buying,
    };
  }

  const printedAfter = i.lastPrintAt !== null && i.lastPrintAt >= i.expiry;
  const lastPrint =
    i.lastPrintAt === null
      ? null
      : printedAfter
        ? `A round at or after expiry is in: ${i.fmt(i.lastPrintAt)}. Anyone can send settle now; the contract records that round's price.`
        : `Last print: ${i.fmt(i.lastPrintAt)}${i.lastPrice !== null && i.lastPrice > 0 ? `, ${usd(i.lastPrice)}` : ""}. It came before expiry, so it is not the settlement price.`;
  const why =
    printedAfter || i.reopensAt === null
      ? null
      : i.mirrored
        ? `NYSE is closed until ${i.fmt(i.reopensAt)}. Chainlink's feed prints when the price moves past its threshold or its heartbeat runs out, so the next print may come with the heartbeat or at the next open.`
        : `NYSE is closed until ${i.fmt(i.reopensAt)}; the next round may not come before then.`;

  return {
    headline: printedAfter
      ? `Expired ${when}. The settlement round is in; waiting for the settle transaction.`
      : `Expired ${when}. Waiting for the settlement price.`,
    rule: `It settles at ${source}. The settle call reverts with InvalidSettlementRound for any other round, so nobody picks the price, and anyone may send it once that round exists.`,
    lastPrint,
    why,
    buying,
  };
}
