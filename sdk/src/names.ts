import type { Mandate } from "./types.js";
import { BPS } from "./units.js";

/** `MandateGuard.Reason`, in on-chain enum order (index = uint8 value). */
export const MANDATE_REASONS = [
  "None",
  "ZeroSize",
  "TenorOutOfRange",
  "InvalidExpiry",
  "StrikeWrongSide",
  "SizeTooLarge",
  "PremiumBelowFair",
  "PremiumAboveCap",
  "DeltaOutOfBand",
  "PremiumTooSmall",
] as const;
export type MandateReason = (typeof MANDATE_REASONS)[number];

/** `SafeStockFeed.Status`, in on-chain enum order. */
export const FEED_STATUSES = [
  "Ok",
  "InvalidPrice",
  "StalePrice",
  "TokenPaused",
  "FeedPaused",
  "CorporateActionPending",
] as const;
export type FeedStatus = (typeof FEED_STATUSES)[number];

/** `EpochManager.EpochState`, in on-chain enum order. */
export const EPOCH_STATES = ["Idle", "Open", "Selling"] as const;
export type EpochState = (typeof EPOCH_STATES)[number];

/** `AgentRegistry.Status`, in on-chain enum order. */
export const AGENT_STATUSES = ["None", "Active", "Suspended", "Retired"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

function nameOf<T extends readonly string[]>(names: T, code: number | bigint, what: string): T[number] {
  const name = names[Number(code)];
  if (name === undefined) throw new RangeError(`unknown ${what} code ${code}`);
  return name;
}

/** The `MandateGuard.Reason` name for an on-chain code (0 → "None", 8 → "DeltaOutOfBand"). */
export function mandateReasonName(code: number | bigint): MandateReason {
  return nameOf(MANDATE_REASONS, code, "mandate reason");
}

/** The on-chain code for a `MandateGuard.Reason` name. */
export function mandateReasonCode(reason: MandateReason): number {
  return MANDATE_REASONS.indexOf(reason);
}

/** The `SafeStockFeed.Status` name for an on-chain code. */
export function feedStatusName(code: number | bigint): FeedStatus {
  return nameOf(FEED_STATUSES, code, "feed status");
}

/** The `EpochManager.EpochState` name for an on-chain code. */
export function epochStateName(code: number | bigint): EpochState {
  return nameOf(EPOCH_STATES, code, "epoch state");
}

/** The `AgentRegistry.Status` name for an on-chain code. */
export function agentStatusName(code: number | bigint): AgentStatus {
  return nameOf(AGENT_STATUSES, code, "agent status");
}

/** One-line meaning of each mandate verdict. */
export const MANDATE_REASON_DESCRIPTIONS: Record<MandateReason, string> = {
  None: "Inside the mandate: the contract would accept this proposal.",
  ZeroSize: "The size is zero: propose at least some options.",
  TenorOutOfRange: "The time to expiry is outside the mandate's tenor limits (or the expiry is in the past).",
  InvalidExpiry: "The expiry is not an NYSE session close (16:00 New York on a trading day).",
  StrikeWrongSide:
    "The strike is in the money: covered calls must strike above spot and cash-secured puts below spot.",
  SizeTooLarge: "The size is larger than the share of vault capacity the mandate lets the agent sell.",
  PremiumBelowFair: "The asked premium is below the mandate's minimum share of Black-Scholes fair value.",
  PremiumAboveCap: "The asked premium is above the 3x fair-value cap.",
  DeltaOutOfBand: "The option's |delta| is outside the mandate's delta band.",
  PremiumTooSmall: "The premium is too small relative to the collateral one option locks (minimum yield).",
};

/** Plain-word meaning of each oracle status. */
export const FEED_STATUS_DESCRIPTIONS: Record<FeedStatus, string> = {
  Ok: "The price is fresh and safe to use.",
  InvalidPrice: "The feed returned a non-positive price or a timestamp in the future.",
  StalePrice: "The latest price is older than the feed's maximum age (weekend, holiday or a stalled feed).",
  TokenPaused: "The stock token is paused.",
  FeedPaused: "The stock token's oracle is paused by its issuer.",
  CorporateActionPending:
    "A split or dividend (ERC-8056 multiplier change) is in progress; prices are blocked.",
};

/** Numbers that make an explanation concrete. All optional; missing ones are left out of the sentence. */
export interface ReasonContext {
  mandate?: Mandate;
  isCall?: boolean;
  /** Spot and strike in USD per token. */
  spot?: number;
  strike?: number;
  /** |delta| as a fraction (0.2). */
  delta?: number;
  tenorSeconds?: number;
  /** Size and capacity in options (whole tokens). */
  size?: number;
  capacity?: number;
  premiumBps?: number;
  /** Premium per option as a fraction of the collateral it locks. */
  yieldFraction?: number;
}

const pct = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
const days = (s: number) => `${(s / 86_400).toFixed(2).replace(/\.?0+$/, "")} days`;
const usd = (x: number) => `$${x.toFixed(2)}`;

/**
 * Explain a mandate verdict in plain words, with the numbers that caused it when `ctx` provides them.
 * Used by the MCP `risk_check` tool and the example agent.
 */
export function explainMandateReason(reason: MandateReason, ctx: ReasonContext = {}): string {
  const m = ctx.mandate;
  const base = MANDATE_REASON_DESCRIPTIONS[reason];
  switch (reason) {
    case "TenorOutOfRange":
      if (m && ctx.tenorSeconds !== undefined) {
        return `${base} Tenor is ${days(ctx.tenorSeconds)}; the mandate allows ${days(m.minTenor)} to ${days(m.maxTenor)}.`;
      }
      return base;
    case "StrikeWrongSide":
      if (ctx.spot !== undefined && ctx.strike !== undefined && ctx.isCall !== undefined) {
        return `${base} Strike ${usd(ctx.strike)} vs spot ${usd(ctx.spot)}: a ${ctx.isCall ? "call" : "put"} needs a strike ${ctx.isCall ? "above" : "below"} spot.`;
      }
      return base;
    case "SizeTooLarge":
      if (m && ctx.size !== undefined && ctx.capacity !== undefined) {
        const max = (ctx.capacity * m.maxShareSoldBps) / BPS;
        return `${base} Size ${ctx.size} > ${pct(m.maxShareSoldBps)} of capacity ${ctx.capacity} = ${max}.`;
      }
      return base;
    case "PremiumBelowFair":
      if (m && ctx.premiumBps !== undefined) {
        return `${base} Asked ${pct(ctx.premiumBps)} of fair value; the mandate requires at least ${pct(m.minPremiumBps)}.`;
      }
      return base;
    case "PremiumAboveCap":
      if (ctx.premiumBps !== undefined)
        return `${base} Asked ${pct(ctx.premiumBps)} of fair value (max 300%).`;
      return base;
    case "DeltaOutOfBand":
      if (m && ctx.delta !== undefined) {
        return `${base} |delta| is ${ctx.delta.toFixed(4)}; the band is ${(m.minDeltaBps / BPS).toFixed(2)} to ${(m.maxDeltaBps / BPS).toFixed(2)}. ${
          ctx.delta > m.maxDeltaBps / BPS
            ? `Move the strike further out of the money.`
            : `Move the strike closer to spot.`
        }`;
      }
      return base;
    case "PremiumTooSmall":
      if (m && ctx.yieldFraction !== undefined) {
        return `${base} Premium is ${pct(ctx.yieldFraction * BPS)} of collateral; the mandate requires ${pct(m.minYieldBps)}.`;
      }
      return base;
    default:
      return base;
  }
}
