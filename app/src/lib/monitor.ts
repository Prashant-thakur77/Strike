// Stock-token safety monitor: pure logic, no I/O. Mirrors contracts/src/libraries/SafeStockFeed.sol `status()` and
// contracts/src/libraries/NyseTime.sol + contracts/src/oracle/MarketCalendar.sol, so the page can judge Robinhood
// Chain mainnet tokens exactly the way the contracts would, without a Strike deployment on mainnet.

import type { Address } from "viem";
// Data, not code: the Playwright specs load this file as it is, so it reads strike.config.json directly rather than
// through the SDK (docs/configuration.md).
import strikeConfig from "../../../strike.config.json";

/** Robinhood Chain mainnet. The monitor always reads it, whatever network the app has selected. */
export const MONITOR_CHAIN_ID = 4663;
const mainnet = strikeConfig.chains["4663"];
export const MONITOR_RPC = mainnet.rpc.public;

/** Staleness limit on mainnet: Chainlink heartbeat 24 h + 1 h (contracts/script/Deploy.s.sol, chain 4663). */
export const MAX_PRICE_AGE = 25 * 3600;
/** Window around an ERC-8056 multiplier change (Deploy.s.sol `setFeed(..., maxPriceAge, 1 days)`). */
export const CORPORATE_ACTION_GRACE = 86_400;

export interface MonitorToken {
  symbol: string;
  name: string;
  token: Address;
  /** Chainlink Standard proxy (price per raw token, 8 decimals). */
  feed: Address;
}

/** Display names of the mainnet stock tokens. */
const TOKEN_NAMES: Readonly<Record<string, string>> = {
  TSLA: "Tesla",
  NVDA: "NVIDIA",
  AMZN: "Amazon",
  PLTR: "Palantir",
  AMD: "AMD",
  SPY: "SPDR S&P 500 ETF",
  AAPL: "Apple",
  QQQ: "Invesco QQQ",
};

/**
 * Every mainnet stock token with a Chainlink feed: strike.config.json's chains.4663.stocks, the same map the keeper
 * mirrors to the testnets (scripts/keeper.sh), from Deploy.s.sol (4663) and docs/research.md §3a; each token's
 * symbol and each feed's description were checked on-chain. NFLX is left out: Chainlink lists no feed for it on
 * Robinhood Chain.
 */
export const MONITOR_TOKENS: readonly MonitorToken[] = Object.entries(mainnet.stocks).map(
  ([symbol, { token, feed }]) => ({
    symbol,
    name: TOKEN_NAMES[symbol] ?? symbol,
    token: token as Address,
    feed: feed as Address,
  }),
);

// ------------------------------------------------------------------ SafeStockFeed.status()

/** Same order as `SafeStockFeed.Status`. */
export const STATUSES = [
  "Ok",
  "InvalidPrice",
  "StalePrice",
  "TokenPaused",
  "FeedPaused",
  "CorporateActionPending",
] as const;

/** A `SafeStockFeed.Status`, or `FeedUnreadable` where `status()` itself would revert (`latestRoundData` failed). */
export type Verdict = (typeof STATUSES)[number] | "FeedUnreadable";

export interface RoundData {
  roundId: bigint;
  answer: bigint;
  startedAt: bigint;
  updatedAt: bigint;
  answeredInRound: bigint;
}

/**
 * Raw reads for one token. `null` means the call reverted or returned too little data, exactly the case
 * SafeStockFeed's `_flag` / `_uint` treat as "not implemented".
 */
export interface TokenReads {
  paused: boolean | null;
  oraclePaused: boolean | null;
  uiMultiplier: bigint | null;
  newUIMultiplier: bigint | null;
  effectiveAt: bigint | null;
  round: RoundData | null;
  feedDecimals: number;
}

export interface FeedConfig {
  maxPriceAge: number;
  corporateActionGrace: number;
}

export const MAINNET_CONFIG: FeedConfig = {
  maxPriceAge: MAX_PRICE_AGE,
  corporateActionGrace: CORPORATE_ACTION_GRACE,
};

export interface CorporateAction {
  pending: boolean;
  effectiveAt: bigint;
}

/** `SafeStockFeed.corporateAction`: a change is scheduled, or took effect less than `grace` ago. */
export function corporateAction(r: TokenReads, now: bigint, grace: number): CorporateAction {
  const { uiMultiplier: current, newUIMultiplier: next, effectiveAt: at } = r;
  if (current === null || next === null || at === null) return { pending: false, effectiveAt: 0n };
  return { pending: current !== next || now < at + BigInt(grace), effectiveAt: at };
}

/** `SafeStockFeed.toWad`: the feed answer at 18 decimals, used as-is (never × multiplier). */
export function toWad(answer: bigint, feedDecimals: number): bigint {
  return feedDecimals <= 18
    ? answer * 10n ** BigInt(18 - feedDecimals)
    : answer / 10n ** BigInt(feedDecimals - 18);
}

export interface StatusResult {
  verdict: Verdict;
  /** WAD price per raw token; 0 unless the price passed the validity check (as in Solidity). */
  priceWad: bigint;
  updatedAt: bigint;
}

/**
 * `SafeStockFeed.status(c, token)` evaluated at `now` (the block timestamp). Same checks, same order:
 * token pause, oracle pause, corporate action, invalid price, staleness.
 */
export function safeStockStatus(r: TokenReads, now: bigint, c: FeedConfig = MAINNET_CONFIG): StatusResult {
  if (r.paused === true) return { verdict: "TokenPaused", priceWad: 0n, updatedAt: 0n };
  if (r.oraclePaused === true) return { verdict: "FeedPaused", priceWad: 0n, updatedAt: 0n };
  if (corporateAction(r, now, c.corporateActionGrace).pending) {
    return { verdict: "CorporateActionPending", priceWad: 0n, updatedAt: 0n };
  }
  if (!r.round) return { verdict: "FeedUnreadable", priceWad: 0n, updatedAt: 0n };
  const { answer, updatedAt } = r.round;
  if (answer <= 0n || updatedAt > now) return { verdict: "InvalidPrice", priceWad: 0n, updatedAt };
  const priceWad = toWad(answer, r.feedDecimals);
  if (now - updatedAt > BigInt(c.maxPriceAge)) return { verdict: "StalePrice", priceWad, updatedAt };
  return { verdict: "Ok", priceWad, updatedAt };
}

/** A multiplier change is scheduled but not yet in force (`newUIMultiplier` differs and `effectiveAt` is ahead). */
export function multiplierChangeScheduled(r: TokenReads): boolean {
  return r.uiMultiplier !== null && r.newUIMultiplier !== null && r.uiMultiplier !== r.newUIMultiplier;
}

// ------------------------------------------------------------------ NYSE hours (NyseTime + MarketCalendar)

export const DAY = 86_400;
const OPEN_EDT = 13 * 3600 + 30 * 60;
const CLOSE_EDT = 20 * 3600;
const EARLY_CLOSE_EDT = 17 * 3600;

/** NYSE full-day closures 2026–2027, day numbers since 1970-01-01 (Deploy.s.sol `_holidays`). */
export const NYSE_HOLIDAYS: ReadonlySet<number> = new Set([
  20_454, 20_472, 20_500, 20_546, 20_598, 20_623, 20_637, 20_703, 20_783, 20_812, 20_819, 20_836, 20_864,
  20_903, 20_969, 20_987, 21_004, 21_067, 21_147, 21_176,
]);

/** 13:00 New York closes: 2026-11-27, 2026-12-24, 2027-11-26 (Deploy.s.sol `_earlyCloses`). */
export const NYSE_EARLY_CLOSES: ReadonlySet<number> = new Set([20_784, 20_811, 21_148]);

/** Days since 1970-01-01 for a civil date (Howard Hinnant's algorithm, as in NyseTime). */
export function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = m > 2 ? m - 3 : m + 9;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(day: number): number {
  return (day + 4) % 7;
}

/** US daylight saving: second Sunday of March to first Sunday of November. */
export function isDst(day: number): boolean {
  const y = new Date(day * DAY * 1000).getUTCFullYear();
  const march1 = daysFromCivil(y, 3, 1);
  const secondSundayMarch = march1 + ((7 - weekday(march1)) % 7) + 7;
  const nov1 = daysFromCivil(y, 11, 1);
  const firstSundayNov = nov1 + ((7 - weekday(nov1)) % 7);
  return day >= secondSundayMarch && day < firstSundayNov;
}

export function isTradingDay(day: number): boolean {
  const w = weekday(day);
  return w !== 0 && w !== 6 && !NYSE_HOLIDAYS.has(day);
}

/** Regular-session open and close (UTC seconds) on `day`. */
export function sessionOf(day: number): { open: number; close: number } {
  const base = day * DAY + (isDst(day) ? 0 : 3600);
  return { open: base + OPEN_EDT, close: base + (NYSE_EARLY_CLOSES.has(day) ? EARLY_CLOSE_EDT : CLOSE_EDT) };
}

/** `MarketCalendar.isMarketOpen`. */
export function isMarketOpen(ts: number): boolean {
  const day = Math.floor(ts / DAY);
  if (!isTradingDay(day)) return false;
  const { open, close } = sessionOf(day);
  return ts >= open && ts < close;
}

export interface MarketState {
  open: boolean;
  /** The close of the current session when open, otherwise the next open (0 if none within 14 days). */
  nextChange: number;
}

export function marketState(ts: number): MarketState {
  const open = isMarketOpen(ts);
  const day = Math.floor(ts / DAY);
  for (let i = 0; i < 14; i++) {
    if (!isTradingDay(day + i)) continue;
    const s = sessionOf(day + i);
    if (open && s.close > ts) return { open, nextChange: s.close };
    if (!open && s.open > ts) return { open, nextChange: s.open };
  }
  return { open, nextChange: 0 };
}
