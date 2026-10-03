// The agents page's live views, from the chain and the decision records only:
//
//   - live series health: is each live series still out of the money, how far is spot from the strike and from the
//     break-even, how long is left, and the pricing model's odds of finishing in the money from here;
//   - alerts: the series and feeds that need a look, derived from the same reads (the Telegram bot pushes the
//     contract's events; these are the states in between);
//   - performance: each agent's settled epochs and cumulative depositor PnL (AgentRegistry.track), with a plain
//     statement of how much a sample that size can say;
//   - decisions that sold nothing: rejected, not sent, skipped and stopped runs from the records.
//
// Pure (numbers in, numbers out), so the Playwright specs load it as CommonJS.

import type { LogEntry, LogStatus } from "./agentLog";

const YEAR = 31_536_000;
/** SafeStockFeed's limit on these deployments: Chainlink's 24 h heartbeat plus an hour. */
export const FEED_MAX_AGE = 25 * 3600;
/** "Near the strike": spot within this share of the strike. */
export const NEAR_SHARE = 0.02;

/** Abramowitz-Stegun 26.2.17 normal CDF (error < 7.5e-8), enough for odds shown to one decimal. */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p =
    d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

export interface SeriesInput {
  vault: string;
  symbol: string;
  underlying: string;
  isCall: boolean;
  agentId: number;
  /** USD per raw token. */
  strike: number;
  spot: number;
  /** Unix seconds of the feed's last update. */
  spotUpdatedAt: number;
  /** SafeStockFeed status, 0 = Ok. */
  feedStatus: number;
  expiry: number;
  now: number;
  /** Options sold so far, and the USDG premium they paid. */
  sold: number;
  premium: number;
  /** Annualised volatility the EpochManager prices with, or null when unknown. */
  sigma: number | null;
  settled: boolean;
  cancelled: boolean;
}

export type HealthState = "out" | "near" | "in" | "expired" | "unsold";

export interface SeriesHealth {
  input: SeriesInput;
  state: HealthState;
  /** Spot over strike minus one, signed so that negative is toward the money (for both calls and puts). */
  cushion: number;
  /** Strike ∓ premium paid per option: where depositors start to lose; null with nothing sold. */
  breakEven: number | null;
  /** Spot's distance to the break-even as a share of spot, signed like `cushion`; null with nothing sold. */
  breakEvenCushion: number | null;
  /** Seconds to expiry (≤ 0 once expired). */
  left: number;
  /** In-the-money amount per option at today's spot (0 when out of the money). */
  intrinsic: number;
  /** What holders could claim at today's spot, for the options sold, minus the premium they paid. Negative is good for depositors. */
  markNet: number;
  /** Model odds of finishing in the money from today's spot, or null without a volatility or past expiry. */
  oddsItm: number | null;
  feedAge: number;
  feedStale: boolean;
}

export function seriesHealth(s: SeriesInput): SeriesHealth {
  const left = s.expiry - s.now;
  const dir = s.isCall ? 1 : -1;
  // Positive cushion: spot is on the safe side of the strike.
  const cushion = dir * (s.strike / s.spot - 1);
  const perOption = s.sold > 0 ? s.premium / s.sold : 0;
  const breakEven = s.sold > 0 ? (s.isCall ? s.strike + perOption : s.strike - perOption) : null;
  const breakEvenCushion = breakEven === null ? null : dir * (breakEven / s.spot - 1);
  const intrinsic = s.isCall ? Math.max(s.spot - s.strike, 0) : Math.max(s.strike - s.spot, 0);
  let oddsItm: number | null = null;
  if (s.sigma !== null && s.sigma > 0 && left > 0) {
    const vol = s.sigma * Math.sqrt(left / YEAR);
    const d2 = (Math.log(s.spot / s.strike) - (vol * vol) / 2) / vol;
    oddsItm = s.isCall ? normCdf(d2) : normCdf(-d2);
  }
  const feedAge = s.now - s.spotUpdatedAt;
  const state: HealthState =
    left <= 0
      ? "expired"
      : s.sold <= 0
        ? "unsold"
        : intrinsic > 0
          ? "in"
          : cushion < NEAR_SHARE
            ? "near"
            : "out";
  return {
    input: s,
    state,
    cushion,
    breakEven,
    breakEvenCushion,
    left,
    intrinsic,
    markNet: intrinsic * s.sold - s.premium,
    oddsItm,
    feedAge,
    feedStale: s.feedStatus !== 0 || feedAge > FEED_MAX_AGE,
  };
}

export const HEALTH_LABEL: Record<HealthState, string> = {
  out: "Out of the money",
  near: "Near the strike",
  in: "In the money",
  expired: "Expired, settling",
  unsold: "None sold yet",
};

/* ================================================================ alerts */

export type AlertLevel = "alert" | "watch" | "info";

export interface HealthAlert {
  level: AlertLevel;
  vault: string;
  symbol: string;
  text: string;
}

const usd = (x: number) =>
  `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (x: number) => `${(Math.abs(x) * 100).toFixed(1)}%`;

export function healthAlerts(list: SeriesHealth[], agents: AgentStanding[] = []): HealthAlert[] {
  const out: HealthAlert[] = [];
  for (const h of list) {
    const s = h.input;
    const base = { vault: s.vault, symbol: s.symbol };
    if (h.state === "in")
      out.push({
        ...base,
        level: h.breakEvenCushion !== null && h.breakEvenCushion < 0 ? "alert" : "watch",
        text:
          h.breakEvenCushion !== null && h.breakEvenCushion < 0
            ? `${s.underlying} at ${usd(s.spot)} is past the ${usd(h.breakEven!)} break-even: at this price holders could claim more than the premium they paid.`
            : `${s.underlying} at ${usd(s.spot)} is in the money against the ${usd(s.strike)} strike, but the premium still covers it (break-even ${usd(h.breakEven!)}).`,
      });
    else if (h.state === "near")
      out.push({
        ...base,
        level: "watch",
        text: `${s.underlying} at ${usd(s.spot)} is ${pct(h.cushion)} from the ${usd(s.strike)} strike.`,
      });
    if (h.state === "expired")
      out.push({
        ...base,
        level: "info",
        text: `Expired; it settles at the first mainnet price print at or after expiry. The last print, ${usd(s.spot)}, is ${
          h.intrinsic > 0 ? "in the money" : "out of the money"
        } against the ${usd(s.strike)} strike, but it is not the settlement price.`,
      });
    if (h.feedStale && h.state !== "expired")
      out.push({
        ...base,
        level: "watch",
        text:
          s.feedStatus !== 0
            ? `The ${s.underlying} feed is not usable right now (status ${s.feedStatus}), so buys revert until it is.`
            : `The ${s.underlying} price is ${Math.floor(h.feedAge / 3600)} h old, past the ${FEED_MAX_AGE / 3600} h limit, so buys revert until the keeper mirrors a fresh print.`,
      });
  }
  for (const a of agents) {
    if (a.status !== 1 && a.status !== 0)
      out.push({
        level: "alert",
        vault: "",
        symbol: `Agent #${a.id}`,
        text: `Suspended after ${a.strikes} strikes.`,
      });
    else if (a.maxStrikes > 0 && a.strikes === a.maxStrikes - 1)
      out.push({
        level: "watch",
        vault: "",
        symbol: `Agent #${a.id}`,
        text: `${a.strikes} of ${a.maxStrikes} strikes: one more rejected proposal suspends it.`,
      });
  }
  const order: Record<AlertLevel, number> = { alert: 0, watch: 1, info: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
}

/* ================================================================ performance */

export interface AgentStanding {
  id: number;
  label: string;
  status: number;
  strikes: number;
  maxStrikes: number;
  accepted: number;
  rejected: number;
  settledEpochs: number;
  /** Cumulative depositor PnL in USDG (AgentRegistry.track). */
  pnl: number;
}

/** What a sample of settled epochs can and cannot say. */
export function sampleVerdict(settled: number): {
  level: "none" | "anecdote" | "preliminary" | "small";
  text: string;
} {
  if (settled === 0) return { level: "none", text: "No settled epochs yet, so there is no result to judge." };
  if (settled < 5)
    return {
      level: "anecdote",
      text: `${settled} settled epoch${settled === 1 ? "" : "s"}: an anecdote, too few to tell skill from luck.`,
    };
  if (settled < 20)
    return {
      level: "preliminary",
      text: `${settled} settled epochs: preliminary; one bad week can still swing it.`,
    };
  return {
    level: "small",
    text: `${settled} settled epochs: a small sample of weekly options; read with care.`,
  };
}

/** Ranks agents: those with settled epochs by PnL first, then by accepted proposals and fewest rejections. */
export function rankStanding(a: AgentStanding, b: AgentStanding): number {
  const sa = a.settledEpochs > 0 ? 1 : 0;
  const sb = b.settledEpochs > 0 ? 1 : 0;
  return (
    sb - sa ||
    (sa && sb ? b.pnl - a.pnl : 0) ||
    b.accepted - a.accepted ||
    a.rejected - b.rejected ||
    a.id - b.id
  );
}

/* ================================================================ decisions that sold nothing */

export type NoTradeKind = "rejected" | "not-sent" | "skipped" | "failed";

export const NO_TRADE_LABEL: Record<NoTradeKind, string> = {
  rejected: "Rejected by the contract",
  "not-sent": "Not sent by the agent",
  skipped: "Nothing to do",
  failed: "Run stopped",
};

export interface NoTrade {
  entry: LogEntry;
  kind: NoTradeKind;
  why: string;
}

const NO_TRADE: ReadonlySet<LogStatus> = new Set(["rejected", "not-sent", "skipped", "failed"]);

/** Every record whose run sold nothing, newest first, with the record's own summary of why. */
export function noTrades(entries: LogEntry[]): NoTrade[] {
  return entries
    .filter((e) => NO_TRADE.has(e.record.result.status))
    .map((e) => ({ entry: e, kind: e.record.result.status as NoTradeKind, why: e.record.result.summary }));
}

export function noTradeCounts(list: NoTrade[]): Record<NoTradeKind, number> {
  const c: Record<NoTradeKind, number> = { rejected: 0, "not-sent": 0, skipped: 0, failed: 0 };
  for (const n of list) c[n.kind]++;
  return c;
}

/* ================================================================ decision log filter */

export type LogFilter = "all" | "proposals" | "settlements" | "nothing";

export const LOG_FILTER_LABEL: Record<LogFilter, string> = {
  all: "All",
  proposals: "Proposals",
  settlements: "Settlements",
  nothing: "Sold nothing",
};

function matchesFilter(e: LogEntry, f: LogFilter): boolean {
  if (f === "all") return true;
  if (f === "proposals") return e.record.action !== "settle";
  if (f === "settlements") return e.record.action === "settle";
  return NO_TRADE.has(e.record.result.status);
}

/** The log narrowed to one kind of run and, optionally, to records whose vault, date, status or summary hold `text`. */
export function filterLog(entries: LogEntry[], f: LogFilter, text = ""): LogEntry[] {
  const needle = text.trim().toLowerCase();
  return entries.filter(
    (e) =>
      matchesFilter(e, f) &&
      (!needle ||
        [
          e.name,
          e.record.vault.symbol,
          e.record.date,
          e.record.result.status,
          e.record.result.summary,
          e.record.action,
        ]
          .join(" ")
          .toLowerCase()
          .includes(needle)),
  );
}

export function logFilterCounts(entries: LogEntry[]): Record<LogFilter, number> {
  return {
    all: entries.length,
    proposals: entries.filter((e) => matchesFilter(e, "proposals")).length,
    settlements: entries.filter((e) => matchesFilter(e, "settlements")).length,
    nothing: entries.filter((e) => matchesFilter(e, "nothing")).length,
  };
}
