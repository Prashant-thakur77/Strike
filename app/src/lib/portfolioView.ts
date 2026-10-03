// The portfolio's JSON (what GET /api/portfolio serves and the page renders), and the parts derived from the ledger:
// the actions waiting for the wallet, what its idle tokens could do in which vault, and allocation.
// Every item is derived from today's reads and the logs, never stored, so none of it can go stale. Pure, with
// type-only imports (Playwright tests it on fixtures).

import type {
  ActivityRow,
  AgentView,
  ChartMarker,
  ChartPoint,
  EpochResult,
  OptionPosition,
  Totals,
  VaultPosition,
} from "./portfolioLedger";

export interface OptionTotals {
  series: number;
  held: number;
  premiumPaid: number;
  redeemedUsd: number;
  redeemableUsd: number;
  /** Settled and cancelled series only: redeemed + redeemable − premium paid. */
  netSettledUsd: number;
}

export interface ChainStatus {
  key: string;
  chainId: number;
  label: string;
  ok: boolean;
  source?: "indexer" | "rpc";
  error?: string;
}

/* ================================================================ what the wallet could do */

export interface HoldingVault {
  vault: string;
  symbol: string;
  isCall: boolean;
  underlying: string;
  /** EpochManager state: 0 idle, 1 open (waiting for a proposal), 2 selling. */
  state: number;
  locked: boolean;
  spot: number;
  /** Collateral under management, in the vault's asset. */
  totalAssets: number;
  mandate: { maxDeltaBps: number; maxShareSoldBps: number } | null;
  series: {
    id: string;
    strike: number;
    expiry: number;
    size: number;
    sold: number;
    premium: number;
    /** Model fair value per option the agent proposed with (SeriesProposed), USD. */
    fairValue: number | null;
    premiumBps: number;
    delta: number | null;
    settled: boolean;
  } | null;
}

export interface HoldingInput {
  chainId: number;
  deployment: string;
  version: string;
  asset: string;
  amount: number;
  usd: number;
  vaults: HoldingVault[];
}

export interface Opportunity {
  chainId: number;
  deployment: string;
  version: string;
  /** What the wallet holds: a stock token's symbol or USDG. */
  asset: string;
  amount: number;
  usd: number;
  vault: string;
  symbol: string;
  isCall: boolean;
  underlying: string;
  status: "selling" | "expired" | "open" | "idle";
  /** A deposit now is queued (the vault is locked) and joins when this epoch closes. */
  queued: boolean;
  strike: number | null;
  expiry: number | null;
  delta: number | null;
  /** Premium per option this week: what buyers paid per option sold, else the proposed price (fair value × factor). */
  premiumPerOption: number | null;
  /** The wallet's size in options: tokens for a call, USDG ÷ strike for a put. */
  options: number | null;
  /** This week's premium on that size, if the series sold its whole size; at this week's price, not a promise. */
  premiumIfSoldOut: number | null;
  /** The same at what has sold so far. */
  premiumAtSales: number | null;
  breakEven: number | null;
  maxDeltaBps: number | null;
  maxShareSoldBps: number | null;
  /** Next NYSE open (when no series runs; epochs open in session). */
  nextOpen: number | null;
}

export function opportunities(
  holdings: HoldingInput[],
  nextOpen: Record<string, number | null>,
  now: number,
): Opportunity[] {
  const out: Opportunity[] = [];
  for (const h of holdings)
    for (const v of h.vaults) {
      const s = v.series && !v.series.settled ? v.series : null;
      const status: Opportunity["status"] = s
        ? now >= s.expiry
          ? "expired"
          : "selling"
        : v.state === 1
          ? "open"
          : "idle";
      const perOption = s
        ? s.sold > 0
          ? s.premium / s.sold
          : s.fairValue !== null
            ? (s.fairValue * s.premiumBps) / 10_000
            : null
        : null;
      const options = s ? (v.isCall ? h.amount : s.strike > 0 ? h.amount / s.strike : null) : null;
      const capacity = s ? (v.isCall ? v.totalAssets : s.strike > 0 ? v.totalAssets / s.strike : 0) : 0;
      const sizeShare = s && capacity > 0 ? Math.min(s.size / capacity, 1) : null;
      const soldShare = s && capacity > 0 ? Math.min(s.sold / capacity, 1) : null;
      out.push({
        chainId: h.chainId,
        deployment: h.deployment,
        version: h.version,
        asset: h.asset,
        amount: h.amount,
        usd: h.usd,
        vault: v.vault,
        symbol: v.symbol,
        isCall: v.isCall,
        underlying: v.underlying,
        status,
        queued: v.locked,
        strike: s?.strike ?? null,
        expiry: s?.expiry ?? null,
        delta: s?.delta ?? null,
        premiumPerOption: perOption,
        options,
        premiumIfSoldOut:
          perOption !== null && options !== null && sizeShare !== null
            ? options * sizeShare * perOption
            : null,
        premiumAtSales:
          perOption !== null && options !== null && soldShare !== null
            ? options * soldShare * perOption
            : null,
        breakEven: s && perOption !== null ? (v.isCall ? s.strike + perOption : s.strike - perOption) : null,
        maxDeltaBps: v.mandate?.maxDeltaBps ?? null,
        maxShareSoldBps: v.mandate?.maxShareSoldBps ?? null,
        nextOpen: s ? null : (nextOpen[String(h.chainId)] ?? null),
      });
    }
  return out;
}

/* ================================================================ needs your action */

export type ActionKind =
  "claim-premium" | "claim-deposit" | "claim-redeem" | "redeem-option" | "settling" | "slash-received";

export interface ActionItem {
  id: string;
  kind: ActionKind;
  chainId: number;
  deployment: string;
  version: string;
  vault: string;
  symbol: string;
  /** The EpochManager, for an option redeem. */
  manager?: string;
  seriesId?: string;
  /** The amount for the transaction, base units as a decimal string (option redeems). */
  amountRaw?: string;
  title: string;
  detail: string;
  /** True when a transaction applies (the page offers a button). */
  tx: boolean;
  /** The evidence, for informational items. */
  link?: string;
}

const SLASH_WINDOW = 14 * 86_400;

export function actions(
  positions: VaultPosition[],
  options: OptionPosition[],
  optionRaw: Record<string, string>,
  managers: Record<string, string>,
  now: number,
): ActionItem[] {
  const out: ActionItem[] = [];
  const base = (p: Pick<VaultPosition, "chainId" | "deployment" | "version" | "vault" | "symbol">) => ({
    chainId: p.chainId,
    deployment: p.deployment,
    version: p.version,
    vault: p.vault,
    symbol: p.symbol,
  });
  for (const p of positions) {
    if (p.premiumClaimable > 0)
      out.push({
        ...base(p),
        id: `premium-${p.chainId}-${p.vault}`,
        kind: "claim-premium",
        title: `Claim ${num(p.premiumClaimable)} USDG premium`,
        detail: `${p.symbol} (${p.version}): premium credited at settlement, waiting in the vault.`,
        tx: true,
      });
    if (p.claimableDepositShares > 0)
      out.push({
        ...base(p),
        id: `deposit-${p.chainId}-${p.vault}`,
        kind: "claim-deposit",
        title: `Claim ${num(p.claimableDepositShares)} shares`,
        detail: `${p.symbol} (${p.version}): your queued deposit became shares when its epoch closed. They already earn; claiming moves them to your wallet${p.pendingPremium > p.premiumClaimable ? " and credits the premium they earned" : ""}.`,
        tx: true,
      });
    if (p.claimableRedeemAssets > 0)
      out.push({
        ...base(p),
        id: `redeem-${p.chainId}-${p.vault}`,
        kind: "claim-redeem",
        title: `Withdrawal ready: ${num(p.claimableRedeemAssets)} ${p.assetSymbol}`,
        detail: `${p.symbol} (${p.version}): your queued withdrawal was processed at settlement.`,
        tx: true,
      });
    if (p.exposure?.phase === "expired")
      out.push({
        ...base(p),
        id: `settling-${p.chainId}-${p.vault}`,
        kind: "settling",
        title: "Series waiting for its settlement price",
        detail: `${p.symbol} (${p.version}): the series expired ${utc(p.exposure.expiry)} and settles at the first price print at or after expiry (the next NYSE session). Nothing to do; premium and any payout are booked then.`,
        tx: false,
      });
    for (const e of p.epochs)
      if (
        e.status === "aborted" &&
        (e.premium ?? 0) > 0 &&
        e.closedAt !== null &&
        now - e.closedAt < SLASH_WINDOW
      )
        out.push({
          ...base(p),
          id: `slash-${p.chainId}-${p.vault}-${e.epoch}`,
          kind: "slash-received",
          title: `Slashed bond paid into your vault: ${num(e.premium ?? 0)} USDG to you`,
          detail: `${p.symbol} (${p.version}), epoch ${e.epoch}: the agent's proposal was rejected, its bond was slashed and paid to depositors when the epoch closed.`,
          tx: false,
          link: e.txClosed ?? undefined,
        });
  }
  for (const o of options) {
    if ((o.state === "paid" || o.state === "cancelled") && o.held > 0) {
      const raw = optionRaw[`${o.deployment}:${o.seriesId}`];
      out.push({
        chainId: o.chainId,
        deployment: o.deployment,
        version: o.version,
        vault: o.vault,
        symbol: o.symbol,
        id: `option-${o.chainId}-${o.deployment}-${o.seriesId}`,
        kind: "redeem-option",
        manager: managers[o.deployment],
        seriesId: o.seriesId,
        amountRaw: raw,
        title:
          o.state === "paid"
            ? `Redeem ${num(o.held)} ${o.underlying} ${o.isCall ? "calls" : "puts"} for ${num(o.redeemable)} ${o.redeemableUnit}`
            : `Redeem ${num(o.held)} cancelled options for a ${num(o.redeemable)} USDG refund`,
        detail: `Strike $${o.strike.toFixed(2)}, ${o.state === "paid" ? `settled at $${(o.settlementPrice ?? 0).toFixed(2)}` : "series cancelled; the premium is refunded"}.`,
        tx: !!raw && raw !== "0" && !!managers[o.deployment],
      });
    } else if (o.state === "expired" && o.held > 0)
      out.push({
        chainId: o.chainId,
        deployment: o.deployment,
        version: o.version,
        vault: o.vault,
        symbol: o.symbol,
        id: `option-settling-${o.chainId}-${o.deployment}-${o.seriesId}`,
        kind: "settling",
        title: `Your ${o.underlying} ${o.isCall ? "calls" : "puts"} expired: waiting for the settlement price`,
        detail: `Strike $${o.strike.toFixed(2)}, expired ${utc(o.expiry)}. Once settled, an in-the-money option is redeemed here.`,
        tx: false,
      });
  }
  return out;
}

/* ================================================================ allocation */

export interface Slice {
  key: string;
  usd: number;
}

export function allocation(
  positions: VaultPosition[],
  labels: Record<number, string>,
): { byUnderlying: Slice[]; byChain: Slice[] } {
  const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
  const u = new Map<string, number>();
  const c = new Map<string, number>();
  for (const p of positions) {
    const v = p.valueUsd + p.pendingPremium;
    if (v <= 0) continue;
    add(u, `${p.underlying} ${p.isCall ? "covered call" : "cash-secured put"}`, v);
    add(c, `${labels[p.chainId] ?? p.chainId} ${p.version}`, v);
  }
  const list = (m: Map<string, number>) =>
    [...m].map(([key, usd]) => ({ key, usd })).sort((a, b) => b.usd - a.usd);
  return { byUnderlying: list(u), byChain: list(c) };
}

/* ================================================================ the JSON */

export interface PortfolioJson {
  address: string;
  /** Latest block time of the chains read. */
  now: number;
  generatedAt: string;
  source: "indexer" | "rpc";
  chains: ChainStatus[];
  totals: Totals;
  chart: ChartPoint[];
  markers: ChartMarker[];
  positions: VaultPosition[];
  /** Every epoch of every vault the wallet was in, newest first. */
  epochs: EpochResult[];
  options: OptionPosition[];
  optionTotals: OptionTotals;
  agents: AgentView[];
  activity: ActivityRow[];
  opportunities: Opportunity[];
  actions: ActionItem[];
  allocation: { byUnderlying: Slice[]; byChain: Slice[] };
  /** Nothing in any vault, no options, no agent, no history. */
  empty: boolean;
}

export interface BuildInput {
  address: string;
  now: number;
  generatedAt: string;
  source: "indexer" | "rpc";
  chains: ChainStatus[];
  positions: VaultPosition[];
  totals: Totals;
  chart: ChartPoint[];
  markers: ChartMarker[];
  activity: ActivityRow[];
  options: OptionPosition[];
  optionRaw: Record<string, string>;
  agents: AgentView[];
  holdings: HoldingInput[];
  nextOpen: Record<string, number | null>;
  managers: Record<string, string>;
}

export function buildPortfolio(i: BuildInput): PortfolioJson {
  const labels = Object.fromEntries(i.chains.map((c) => [c.chainId, c.label]));
  const done = i.options.filter((o) => o.netUsd !== null);
  return {
    address: i.address,
    now: i.now,
    generatedAt: i.generatedAt,
    source: i.source,
    chains: i.chains,
    totals: i.totals,
    chart: i.chart,
    markers: i.markers.sort((a, b) => a.t - b.t),
    positions: i.positions,
    epochs: i.positions
      .flatMap((p) => p.epochs)
      .sort(
        (a, b) =>
          (b.closedAt ?? Number.MAX_SAFE_INTEGER) - (a.closedAt ?? Number.MAX_SAFE_INTEGER) ||
          b.epoch - a.epoch,
      ),
    options: i.options,
    optionTotals: {
      series: i.options.length,
      held: i.options.reduce((s, o) => s + o.held, 0),
      premiumPaid: i.options.reduce((s, o) => s + o.premiumPaid, 0),
      redeemedUsd: i.options.reduce((s, o) => s + o.redeemedUsd, 0),
      redeemableUsd: i.options.reduce((s, o) => s + o.redeemableUsd, 0),
      netSettledUsd: done.reduce((s, o) => s + (o.netUsd ?? 0), 0),
    },
    agents: i.agents,
    activity: i.activity,
    opportunities: opportunities(i.holdings, i.nextOpen, i.now),
    actions: actions(i.positions, i.options, i.optionRaw, i.managers, i.now),
    allocation: allocation(i.positions, labels),
    empty:
      i.positions.length === 0 && i.options.length === 0 && i.agents.length === 0 && i.activity.length === 0,
  };
}

const num = (x: number) => x.toLocaleString("en-US", { maximumFractionDigits: x > 0 && x < 0.01 ? 6 : 4 });
const utc = (t: number) => `${new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
