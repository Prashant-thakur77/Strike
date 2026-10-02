// NYSE hours where they bite: `EpochManager.openEpoch` and `buy` revert with `MarketClosed` outside a regular session
// (`StockOracle.isMarketOpen` → `MarketCalendar.isMarketOpen`). This file turns the calendar's own answers (read in
// reads.ts `marketStatus`: `isTradingDay(day)` and `sessionOf(day)` for the days ahead) into "open until …" or
// "reopens …", in UTC and in the viewer's time zone. Pure, with no SDK import, so the Playwright specs load it as is.

export const DAY = 86_400;

/** How far ahead to look for the next session, in days: the same horizon as `MarketCalendar.nextSessionClose`. */
export const LOOKAHEAD_DAYS = 14;

/** One calendar day as `MarketCalendar` answers it. `open`/`close` are UTC seconds (meaningful on trading days only). */
export interface CalendarDay {
  day: number;
  trading: boolean;
  open: number;
  close: number;
}

export interface SessionChange {
  /** When open: this session's close. */
  closesAt: number | null;
  /** When closed: the next session's open (null when none within the days given). */
  opensAt: number | null;
  /** The next session's close when closed (the day the market reopens), for "sales run until …". */
  nextClose: number | null;
}

/**
 * The next change of state from `now`, given whether the market is open (the oracle's `isMarketOpen`) and the calendar's
 * days from today on. Open: the close of the session `now` is in. Closed: the first open after `now`.
 */
export function sessionChange(now: number, open: boolean, days: readonly CalendarDay[]): SessionChange {
  const sorted = [...days].sort((a, b) => a.day - b.day);
  for (const d of sorted) {
    if (!d.trading) continue;
    if (open && d.open <= now && now < d.close) return { closesAt: d.close, opensAt: null, nextClose: null };
    if (!open && d.open > now) return { closesAt: null, opensAt: d.open, nextClose: d.close };
  }
  return { closesAt: null, opensAt: null, nextClose: null };
}

/** The UTC day number of a timestamp (days since 1970-01-01, as `MarketCalendar` counts them). */
export const dayOf = (ts: number) => Math.floor(ts / DAY);

const utcFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** "Mon 5 Oct, 13:30 UTC". */
export function fmtUtc(ts: number): string {
  return `${parts(utcFmt, ts)} UTC`;
}

/**
 * The same moment in `timeZone` (default: the viewer's), with the zone's short name: "Mon 5 Oct, 21:30 GMT+8". Null
 * when the viewer is on UTC already, so the UTC text is not repeated.
 */
export function fmtLocal(ts: number, timeZone?: string): string | null {
  const tz = timeZone ?? viewerTimeZone();
  if (!tz || tz === "UTC" || tz === "Etc/UTC") return null;
  try {
    const f = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZoneName: "short",
    });
    const p = f.formatToParts(new Date(ts * 1000));
    const get = (t: Intl.DateTimeFormatPartTypes) => p.find((x) => x.type === t)?.value ?? "";
    return `${get("weekday")} ${get("day")} ${get("month")}, ${get("hour")}:${get("minute")} ${get("timeZoneName")}`;
  } catch {
    return null;
  }
}

function parts(f: Intl.DateTimeFormat, ts: number): string {
  const p = f.formatToParts(new Date(ts * 1000));
  const get = (t: Intl.DateTimeFormatPartTypes) => p.find((x) => x.type === t)?.value ?? "";
  return `${get("weekday")} ${get("day")} ${get("month")}, ${get("hour")}:${get("minute")}`;
}

/** The viewer's IANA time zone, or undefined where Intl cannot say. */
export function viewerTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

/** "2d 22h", "3h 05m", "12m", "under a minute". */
export function fmtCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return "under a minute";
  const d = Math.floor(s / DAY);
  const h = Math.floor((s % DAY) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m`;
}

/** What the market's state means for a surface: buying options or opening an epoch. */
export type MarketAction = "buy" | "open";

export interface MarketLine {
  open: boolean;
  /** One sentence: "NYSE open: sales close Fri 2 Oct, 20:00 UTC." / "NYSE closed: buying reopens Mon 5 Oct, 13:30 UTC." */
  headline: string;
  /** The same moment in the viewer's zone, or null (viewer on UTC, or no next session within the lookahead). */
  local: string | null;
  /** Time left until the change, "in 2d 22h", or null. */
  countdown: string | null;
  /** The UTC timestamp of the change, or null. */
  at: number | null;
}

/** The words for a surface. `now` is the chain's latest block time; `wallNow` the viewer's clock for the countdown. */
export function marketLine(
  m: { open: boolean; now: number } & SessionChange,
  action: MarketAction,
  opts: { timeZone?: string; wallNow?: number } = {},
): MarketLine {
  const ref = opts.wallNow ?? m.now;
  if (m.open) {
    const at = m.closesAt;
    return {
      open: true,
      headline: at ? `NYSE open until ${fmtUtc(at)}.` : "NYSE open.",
      local: at ? fmtLocal(at, opts.timeZone) : null,
      countdown: at ? `closes in ${fmtCountdown(at - ref)}` : null,
      at,
    };
  }
  const at = m.opensAt;
  const what = action === "buy" ? "Buying reopens" : "Epochs can open again";
  return {
    open: false,
    headline: at
      ? `NYSE closed. ${what} ${fmtUtc(at)}.`
      : `NYSE closed. The on-chain calendar has no session in the next ${LOOKAHEAD_DAYS} days.`,
    local: at ? fmtLocal(at, opts.timeZone) : null,
    countdown: at ? `in ${fmtCountdown(at - ref)}` : null,
    at,
  };
}

/** NYSE regular hours in UTC while US daylight saving lasts (to 1 November 2026), and in Singapore time. */
export const SESSION_UTC_DST = "13:30–20:00 UTC";
export const SESSION_SGT_DST = "21:30–04:00 Singapore time";
