import { MANDATE_REASON_DESCRIPTIONS, formatAmount, mandateReasonName } from "@strike/sdk";
import type { Address, Hex } from "viem";

/** What a message needs to know about a vault. */
export interface VaultInfo {
  address: Address;
  symbol: string;
  isCall: boolean;
  underlyingSymbol: string;
  underlyingDecimals: number;
  /** Collateral token: the stock token (calls) or USDG (puts). */
  assetSymbol: string;
  assetDecimals: number;
}

/** What a message needs to know about a series (strike and expiry never change after the proposal). */
export interface SeriesInfo {
  strike: bigint;
  expiry: bigint;
  isCall: boolean;
}

interface Base {
  txHash: Hex;
  blockNumber: bigint;
  logIndex: number;
  vault: VaultInfo;
}

/** An EpochManager event, decoded and joined with its vault (and series, where the event only has an id). */
export type Alert =
  | (Base & { name: "EpochOpened"; epoch: bigint; spot: bigint })
  | (Base & {
      name: "SeriesProposed";
      epoch: bigint;
      seriesId: bigint;
      strike: bigint;
      expiry: bigint;
      size: bigint;
      premiumBps: number;
      fairValue: bigint;
      delta: bigint;
    })
  | (Base & {
      name: "ProposalRejected";
      epoch: bigint;
      agentId: bigint;
      reason: number;
      slashed: bigint;
      strike: bigint;
      expiry: bigint;
      size: bigint;
      premiumBps: number;
    })
  | (Base & {
      name: "OptionsBought";
      seriesId: bigint;
      series: SeriesInfo;
      buyer: Address;
      recipient: Address;
      amount: bigint;
      premium: bigint;
    })
  | (Base & {
      name: "EpochSettled";
      epoch: bigint;
      seriesId: bigint;
      series: SeriesInfo;
      settlementPrice: bigint;
      payout: bigint;
      premium: bigint;
      fee: bigint;
    })
  | (Base & { name: "EpochAborted"; epoch: bigint })
  | (Base & { name: "SeriesCancelled"; epoch: bigint; seriesId: bigint; series: SeriesInfo });

export type AlertName = Alert["name"];

/** Where links point and what USDG looks like on the chain. */
export interface FormatContext {
  /** Block explorer base URL, without a trailing slash. */
  explorerUrl: string;
  usdgDecimals: number;
  /** The deployment ("Robinhood Chain testnet · v3"): when set, each alert names it on the line above the link. */
  label?: string;
}

const WAD_DECIMALS = 18;

/** A WAD USD value: "$369.86", "$352.453", "$1,204.5" (up to 4 decimals, at least 2). */
export function usd(wad: bigint): string {
  const raw = formatAmount(wad, WAD_DECIMALS, 4);
  const negative = raw.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? raw.slice(1) : raw).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}$${grouped}.${fraction.padEnd(2, "0")}`;
}

/** Unix seconds as "2026-10-02 20:00 UTC". */
export function utc(seconds: bigint | number): string {
  const iso = new Date(Number(seconds) * 1000).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** Base units as a human amount, truncated to `digits` decimals ("4", "0.0453", "10.005944"). */
export function amount(value: bigint, decimals: number, digits = 4): string {
  return formatAmount(value, decimals, digits);
}

/** USDG base units with full precision ("10", "10.005944"). */
export function usdg(value: bigint, decimals: number): string {
  return formatAmount(value, decimals, decimals);
}

/** "0xADFF…1D4e". */
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function txLink(ctx: FormatContext, hash: Hex): string {
  return ctx.explorerUrl ? `${ctx.explorerUrl}/tx/${hash}` : hash;
}

const kindOf = (isCall: boolean) => (isCall ? "call" : "put");

/** "1 TSLA call", "4 TSLA calls", "0.0453 TSLA puts". */
function options(value: bigint, v: VaultInfo, isCall: boolean): string {
  const n = amount(value, v.underlyingDecimals, 6);
  return `${n} ${v.underlyingSymbol} ${kindOf(isCall)}${n === "1" ? "" : "s"}`;
}

const pct = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;

/** |delta| of a WAD delta with 2 decimals ("0.20"). */
function absDelta(delta: bigint): string {
  const abs = delta < 0n ? -delta : delta;
  const hundredths = (abs * 100n + 5n * 10n ** 15n) / 10n ** 18n; // rounded to 0.01
  return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, "0")}`;
}

/** One alert as a short plain-text Telegram message. */
export function formatAlert(a: Alert, ctx: FormatContext): string {
  const text = alertText(a, ctx);
  if (!ctx.label) return text;
  const lines = text.split("\n");
  lines.splice(lines.length - 1, 0, `Deployment: ${ctx.label}`); // the last line is always the Tx link
  return lines.join("\n");
}

function alertText(a: Alert, ctx: FormatContext): string {
  const v = a.vault;
  const tx = `Tx: ${txLink(ctx, a.txHash)}`;
  const money = (x: bigint) => `${usdg(x, ctx.usdgDecimals)} USDG`;
  switch (a.name) {
    case "EpochOpened":
      return [
        `${v.symbol}: epoch ${a.epoch} opened`,
        `${v.underlyingSymbol} spot at open: ${usd(a.spot)}. The vault is locked until the epoch closes.`,
        tx,
      ].join("\n");
    case "SeriesProposed":
      return [
        `${v.symbol}: new ${kindOf(v.isCall)} series on sale (epoch ${a.epoch})`,
        `Strike ${usd(a.strike)}, expiry ${utc(a.expiry)}`,
        `Size ${options(a.size, v, v.isCall)} at ${pct(a.premiumBps)} of fair value (${usd(a.fairValue)} per option), |delta| ${absDelta(a.delta)}`,
        tx,
      ].join("\n");
    case "ProposalRejected": {
      const reason = safeReason(a.reason);
      const lines = [
        `${v.symbol}: agent ${a.agentId} proposal rejected, ${reason} (epoch ${a.epoch})`,
        a.slashed > 0n
          ? `Slashed ${money(a.slashed)} from the agent's bond; it goes to the vault's depositors at epoch close.`
          : `No bond was slashed.`,
        `Proposed ${options(a.size, v, v.isCall)}, strike ${usd(a.strike)}, expiry ${utc(a.expiry)}, ${pct(a.premiumBps)} of fair value`,
      ];
      const why = (MANDATE_REASON_DESCRIPTIONS as Record<string, string>)[reason];
      if (why) lines.push(`Why: ${why}`);
      lines.push(tx);
      return lines.join("\n");
    }
    case "OptionsBought": {
      const perOption = a.amount === 0n ? 0n : (a.premium * 10n ** BigInt(v.underlyingDecimals)) / a.amount;
      return [
        `${v.symbol}: ${options(a.amount, v, a.series.isCall)} bought for ${money(a.premium)}`,
        `Strike ${usd(a.series.strike)}, expiry ${utc(a.series.expiry)}, ${money(perOption)} per option`,
        `Buyer ${shortAddress(a.buyer)}${a.recipient.toLowerCase() === a.buyer.toLowerCase() ? "" : `, recipient ${shortAddress(a.recipient)}`}`,
        tx,
      ].join("\n");
    }
    case "EpochSettled": {
      const s = a.series;
      const head = `${v.symbol}: epoch ${a.epoch} settled`;
      const series = `${kindOf(s.isCall)} strike ${usd(s.strike)}, expiry ${utc(s.expiry)}`;
      if (a.settlementPrice === 0n) {
        return [`${head}, no options were sold`, `Series: ${series}`, tx].join("\n");
      }
      const outcome =
        a.payout > 0n
          ? `In the money: holders receive ${amount(a.payout, v.assetDecimals, 6)} ${v.assetSymbol}.`
          : `Out of the money: the options expired worthless.`;
      return [
        `${head} at ${usd(a.settlementPrice)}`,
        `Series: ${series}. ${outcome}`,
        `Premium ${money(a.premium)}, fee ${money(a.fee)}`,
        tx,
      ].join("\n");
    }
    case "EpochAborted":
      return [
        `${v.symbol}: epoch ${a.epoch} aborted`,
        `No series was accepted. The epoch closed without a sale and the vault is unlocked.`,
        tx,
      ].join("\n");
    case "SeriesCancelled":
      return [
        `${v.symbol}: series cancelled (epoch ${a.epoch})`,
        `${a.series.isCall ? "Call" : "Put"} strike ${usd(a.series.strike)}, expiry ${utc(a.series.expiry)}. No settlement price was recorded in time; holders can redeem their options for a premium refund.`,
        tx,
      ].join("\n");
  }
}

function safeReason(code: number): string {
  try {
    return mandateReasonName(code);
  } catch {
    return `reason ${code}`;
  }
}

/**
 * Split a long message into pieces Telegram accepts (4096 characters each). Pieces end at a blank line (between
 * two vaults, say) where they can, else at a line break, else mid-line.
 */
export function splitMessage(text: string, limit = 4096): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let current = "";
  const push = (piece: string, separator: string) => {
    const next = current ? `${current}${separator}${piece}` : piece;
    if (next.length > limit) {
      parts.push(current);
      current = piece;
    } else current = next;
  };
  for (const paragraph of text.split("\n\n")) {
    if (paragraph.length <= limit) {
      push(paragraph, "\n\n");
      continue;
    }
    // A paragraph longer than a message: its own lines, and lines longer than a message in pieces.
    for (const line of paragraph.split("\n")) {
      const pieces = line.length > limit ? (line.match(new RegExp(`.{1,${limit}}`, "gs")) ?? []) : [line];
      for (const piece of pieces) push(piece, "\n");
    }
  }
  if (current) parts.push(current);
  return parts;
}
