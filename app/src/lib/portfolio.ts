// One wallet across every vault of the selected network: vault shares and what they are worth, premium to claim,
// queued deposits and withdrawals, and the options it holds. Pure: the page reads the chain and passes the numbers in.

export interface PositionRow {
  vault: string;
  symbol: string;
  version: string;
  isCall: boolean;
  underlying: string;
  /** Shares and their value in the vault's asset (stock tokens for calls, USDG for puts). */
  shares: number;
  assets: number;
  /** The asset's USD value at the feed's spot (1 for USDG). */
  assetUsd: number;
  pendingPremium: number;
  queuedDeposit: number;
  queuedRedeemShares: number;
  claimableDepositShares: number;
  claimableRedeemAssets: number;
}

export interface OptionRow {
  seriesId: string;
  vault: string;
  symbol: string;
  isCall: boolean;
  underlying: string;
  strike: number;
  expiry: number;
  balance: number;
  settled: boolean;
  cancelled: boolean;
  /** Payout per option in the vault's asset once settled (0 when it expired worthless). */
  payoutPerOption: number;
  /** The asset's USD value at the feed's spot. */
  assetUsd: number;
  spot: number;
}

export type OptionState = "live" | "expired" | "paid" | "worthless" | "cancelled";

export function optionState(o: OptionRow, now: number): OptionState {
  if (o.cancelled) return "cancelled";
  if (o.settled) return o.payoutPerOption > 0 ? "paid" : "worthless";
  return now >= o.expiry ? "expired" : "live";
}

/** In-the-money amount per option at today's spot, in USD: what exercise would pay now, not a market price. */
export function intrinsicNow(o: OptionRow): number {
  return o.isCall ? Math.max(o.spot - o.strike, 0) : Math.max(o.strike - o.spot, 0);
}

/** A row with anything in it: shares, premium, a queued or claimable request. */
export function hasPosition(p: PositionRow): boolean {
  return (
    p.shares > 0 ||
    p.pendingPremium > 0 ||
    p.queuedDeposit > 0 ||
    p.queuedRedeemShares > 0 ||
    p.claimableDepositShares > 0 ||
    p.claimableRedeemAssets > 0
  );
}

export interface PortfolioTotals {
  vaults: number;
  /** Deposits valued at the feed's spot, USD. */
  depositsUsd: number;
  premiumToClaim: number;
  options: number;
  /** Settled options' payout still held as option tokens, USD at today's spot. */
  redeemableUsd: number;
}

export function portfolioTotals(positions: PositionRow[], options: OptionRow[]): PortfolioTotals {
  const held = positions.filter(hasPosition);
  return {
    vaults: held.length,
    depositsUsd: held.reduce((s, p) => s + p.assets * p.assetUsd, 0),
    premiumToClaim: held.reduce((s, p) => s + p.pendingPremium, 0),
    options: options.reduce((s, o) => s + o.balance, 0),
    redeemableUsd: options
      .filter((o) => o.settled && o.payoutPerOption > 0)
      .reduce((s, o) => s + o.payoutPerOption * o.balance * o.assetUsd, 0),
  };
}
