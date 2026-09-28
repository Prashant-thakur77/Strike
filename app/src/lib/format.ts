import { formatUnits } from "viem";

const WAD = 10n ** 18n;

export function toNumber(value: bigint, decimals: number): number {
  return Number(formatUnits(value, decimals));
}

/** Token amount with thousands separators and at most `maxFrac` decimals. */
export function fmtAmount(value: bigint | undefined, decimals: number, maxFrac = 2): string {
  if (value === undefined) return "—";
  const n = toNumber(value, decimals);
  const frac = n !== 0 && Math.abs(n) < 1 ? Math.max(maxFrac, 4) : maxFrac;
  return n.toLocaleString("en-US", { maximumFractionDigits: frac });
}

export function fmtUsd(n: number | null | undefined, maxFrac = 0): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 })}M`;
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: maxFrac, minimumFractionDigits: 0 })}`;
}

/** A USD-stablecoin amount (base units) as dollars and cents: "$43,987.65", "−$12.00". */
export function fmtDollars(value: bigint | undefined, decimals: number): string {
  if (value === undefined) return "—";
  const n = toNumber(value < 0n ? -value : value, decimals);
  const abs = n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${value < 0n ? "−" : ""}$${abs}`;
}

/** A WAD dollar price (per raw token). */
export function fmtWadUsd(wad: bigint | undefined, maxFrac = 2): string {
  if (wad === undefined) return "—";
  return `$${toNumber(wad, 18).toLocaleString("en-US", { minimumFractionDigits: maxFrac, maximumFractionDigits: maxFrac })}`;
}

export function fmtPct(x: number | null | undefined, frac = 1): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  return `${(x * 100).toLocaleString("en-US", { minimumFractionDigits: frac, maximumFractionDigits: frac })}%`;
}

export function fmtBps(bps: number, frac = 0): string {
  return `${(bps / 100).toLocaleString("en-US", { maximumFractionDigits: frac })}%`;
}

export function fmtDelta(bps: number): string {
  return (bps / 10_000).toFixed(2);
}

export function shortAddr(addr: string | undefined): string {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

const nyFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** A unix timestamp in New York time (options expire at 16:00 New York). */
export function fmtNy(ts: bigint | number | undefined): string {
  if (ts === undefined || Number(ts) === 0) return "—";
  return `${nyFmt.format(new Date(Number(ts) * 1000))} ET`;
}

export function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function fmtSeconds(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400} day${seconds === 86400 ? "" : "s"}`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  return fmtDuration(seconds);
}

/** value × price / 10^decimals, as a float (for display only). */
export function usdValue(amount: bigint, decimals: number, priceWad: bigint): number {
  return toNumber((amount * priceWad) / WAD, decimals);
}

/** Parse a user-entered decimal into base units; null if invalid. */
export function parseAmount(text: string, decimals: number): bigint | null {
  const t = text.trim();
  if (!/^\d*\.?\d*$/.test(t) || t === "" || t === ".") return null;
  const [whole = "0", frac = ""] = t.split(".");
  if (frac.length > decimals) return null;
  return (
    BigInt(whole || "0") * 10n ** BigInt(decimals) +
    BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0")
  );
}
