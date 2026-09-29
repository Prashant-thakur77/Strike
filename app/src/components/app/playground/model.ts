import type { AgentInfo, AgentRegistryParams, Mandate, MandateReason, ProposalPreview } from "@strike/sdk";
import {
  BaseError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  formatUnits,
  type Abi,
  type Hex,
} from "viem";

// Pure playground logic: no runtime import of the ESM-only SDK, so Playwright's CommonJS loader can test it.

const BPS = 10_000;
const WAD = 10n ** 18n;
/** MandateGuard.MAX_PREMIUM_BPS: no series may ask more than 3× fair value. */
const MAX_PREMIUM_BPS = 30_000;

/** Most options a proposal may sell (the SDK's `maxProposalSize`). */
export function maxShare(capacity: bigint, mandate: Pick<Mandate, "maxShareSoldBps">): bigint {
  return (capacity * BigInt(mandate.maxShareSoldBps)) / BigInt(BPS);
}

// ---------------------------------------------------------------------------------------------- reverts

export interface DecodedRevert {
  /** Custom error name ("StalePrice"), or "Reverted" when the revert carries no decodable data. */
  name: string;
  args: readonly unknown[];
  /** `Name(arg, …)` as the contract raised it. */
  signature: string;
}

function fmtArg(v: unknown): string {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return `[${v.map(fmtArg).join(", ")}]`;
  return String(v);
}

/** The contract revert inside a viem error, decoded against `abi` (errors viem could not); null when it isn't a revert. */
export function decodeRevertWith(err: unknown, abi: Abi): DecodedRevert | null {
  if (!(err instanceof BaseError)) return null;
  const found = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(found instanceof ContractFunctionRevertedError)) return null;
  const known = found.data;
  if (known?.errorName) {
    const args = known.args ?? [];
    return { name: known.errorName, args, signature: `${known.errorName}(${args.map(fmtArg).join(", ")})` };
  }
  const raw = (found as { raw?: Hex }).raw;
  if (raw && raw !== "0x") {
    try {
      const d = decodeErrorResult({ abi, data: raw });
      const args = (d.args ?? []) as readonly unknown[];
      return { name: d.errorName, args, signature: `${d.errorName}(${args.map(fmtArg).join(", ")})` };
    } catch {
      return { name: "Reverted", args: [], signature: `unknown error ${raw.slice(0, 10)}` };
    }
  }
  return { name: "Reverted", args: [], signature: found.reason ?? found.shortMessage };
}

/** What a revert means for a proposal, in plain words. */
export const REVERT_MEANINGS: Record<string, { title: string; text: string }> = {
  StalePrice: {
    title: "The price feed is stale",
    text: "The last TSLA print is older than the feed's maximum age (a weekend, a holiday or a stalled feed). The contract refuses to price an option on an old price, so the call reverts: no verdict, no series, no slash.",
  },
  FeedPaused: {
    title: "The feed is paused",
    text: "The stock token's oracle is paused by its issuer, so there is no safe price. Everything that needs spot reverts until it is lifted.",
  },
  TokenPaused: {
    title: "The stock token is paused",
    text: "A halted token has no tradable market, so no price for it is safe to act on. The call reverts.",
  },
  CorporateActionPending: {
    title: "A split or dividend is in flight",
    text: "An ERC-8056 multiplier change is scheduled or landed less than a day ago; the feed and the token can disagree, so prices are refused until it settles.",
  },
  InvalidPrice: {
    title: "The feed returned a bad price",
    text: "A zero, negative or future-dated answer is a malfunction, never a price. The call reverts.",
  },
  MarketClosed: {
    title: "The market is closed",
    text: "NYSE regular hours are 09:30–16:00 New York. Epochs open only while the market is open, so an Idle vault cannot get to the Open state where proposals count.",
  },
  WrongState: {
    title: "Wrong epoch state",
    text: "Proposals are only taken while the vault's epoch is Open.",
  },
  PricerInputOutOfRange: {
    title: "The pricer rejected an input",
    text: "Spot, strike, tenor, volatility or delta is outside the range the Black-Scholes pricer accepts (for example a strike far from spot). The view reverts before the mandate is checked.",
  },
  UnderlyingNotAllowed: {
    title: "Underlying not allowed",
    text: "The vault's stock token is not enabled on the EpochManager.",
  },
  VaultNotRegistered: {
    title: "Not a Strike vault",
    text: "The address is not registered with the EpochManager.",
  },
  SequencerDown: {
    title: "The sequencer is down",
    text: "The chain's sequencer uptime feed reports an outage, so prices are not trusted.",
  },
  SequencerGracePeriod: {
    title: "The sequencer just came back",
    text: "Prices are refused for a grace period after a sequencer outage.",
  },
  EnforcedPause: {
    title: "Protocol paused",
    text: "The guardian has paused the protocol.",
  },
};

export function revertMeaning(r: DecodedRevert): { title: string; text: string } {
  return (
    REVERT_MEANINGS[r.name] ?? {
      title: "The call reverted",
      text: "The contract refused to evaluate this proposal. A revert undoes the whole call, so nobody is slashed.",
    }
  );
}

// ---------------------------------------------------------------------------------------------- input

/** Strict decimal parse into base units; null when not a plain non-negative decimal with ≤ `decimals` places. */
export function parseDecimal(text: string, decimals: number): bigint | null {
  const t = text.trim();
  if (!/^\d*\.?\d*$/.test(t) || t === "" || t === ".") return null;
  const [whole = "", frac = ""] = t.split(".");
  if (frac.length > decimals) return null;
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/** Whole-token text for base units, rounded down to 4 significant decimals (never rounds a size up). */
export function sizeText(amount: bigint, decimals: number): string {
  if (amount <= 0n) return "0";
  const whole = 10n ** BigInt(decimals);
  // Keep 4 decimals for amounts ≥ 1; for small ones, 4 significant digits.
  let places = 4;
  if (amount < whole) {
    const digits = amount.toString().length; // significant position below 1
    places = Math.min(decimals, Math.max(4, decimals - digits + 4));
  }
  const unit = 10n ** BigInt(decimals - places);
  return trimDecimal(formatUnits((amount / unit) * unit, decimals));
}

export function trimDecimal(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

// ---------------------------------------------------------------------------------------------- the mandate, in words

export interface ProposalMeasures {
  isCall: boolean;
  spot: bigint | null;
  strike: bigint;
  expiry: bigint;
  now: bigint;
  size: bigint;
  premiumBps: number;
  preview: ProposalPreview | null;
  underlyingDecimals: number;
  symbol: string;
}

export type RuleMark = "pass" | "fail" | "skip" | "idle";

export interface MandateRule {
  reason: Exclude<MandateReason, "None">;
  title: string;
  rule: string;
  /** What this proposal measured against the rule, when known. */
  measured?: string;
  mark: RuleMark;
}

const num = (x: number, frac = 2) =>
  x.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: frac });
const pct = (bps: number) => `${num(bps / 100, 2)}%`;
const band = (bps: number) => (bps / BPS).toFixed(2);
const wadUsd = (w: bigint) =>
  `$${Number(formatUnits(w, 18)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function fmtDays(seconds: number): string {
  const d = seconds / 86_400;
  if (d >= 1) return `${num(d, 2)} day${d === 1 ? "" : "s"}`;
  return `${num(seconds / 3600, 1)} h`;
}

export function fmtTokens(amount: bigint, decimals: number): string {
  const n = Number(formatUnits(amount, decimals));
  return n.toLocaleString("en-US", { maximumFractionDigits: n !== 0 && Math.abs(n) < 1 ? 6 : 4 });
}

/** |delta| as a decimal of 1 from the contract's WAD delta. */
export function absDelta(delta: bigint): number {
  return Number(formatUnits(delta < 0n ? -delta : delta, 18));
}

/** Premium per option over the collateral it locks (a token for calls, the strike for puts), as a fraction. */
export function yieldFraction(m: ProposalMeasures): number | null {
  if (!m.preview) return null;
  const collateral = m.isCall ? m.spot : m.strike;
  if (!collateral) return null;
  return Number(
    formatUnits((m.preview.fairValue * BigInt(m.premiumBps) * WAD) / (collateral * BigInt(BPS)), 18),
  );
}

/**
 * The mandate as plain rules, in the order `MandateGuard.check` runs them, marked against a verdict: rules before
 * the failing one passed, the failing one failed, the rest were never reached.
 */
export function mandateRules(
  mandate: Mandate,
  m: ProposalMeasures | null,
  reasonCode: number | null,
): MandateRule[] {
  const isCall = m?.isCall ?? true;
  const sym = m?.symbol ?? "token";
  const dec = m?.underlyingDecimals ?? 18;
  const pv = m?.preview ?? null;
  const max = pv ? maxShare(pv.capacity, mandate) : null;
  const y = m ? yieldFraction(m) : null;
  const tenor = m ? Number(m.expiry - m.now) : null;

  const rules: Omit<MandateRule, "mark">[] = [
    {
      reason: "ZeroSize",
      title: "Sell something",
      rule: "The size must be above zero.",
      measured: m ? `${fmtTokens(m.size, dec)} options` : undefined,
    },
    {
      reason: "TenorOutOfRange",
      title: "Tenor",
      rule: `Expiry between ${fmtDays(mandate.minTenor)} and ${fmtDays(mandate.maxTenor)} from now.`,
      measured: tenor !== null ? (tenor > 0 ? fmtDays(tenor) : "in the past") : undefined,
    },
    {
      reason: "InvalidExpiry",
      title: "NYSE close",
      rule: "Expiry must be an NYSE session close: 16:00 New York on a trading day (13:00 on half days).",
      measured: m ? nyTime(m.expiry) : undefined,
    },
    {
      reason: "StrikeWrongSide",
      title: "Out of the money",
      rule: isCall
        ? "A covered call strikes above spot: never sell in the money."
        : "A cash-secured put strikes below spot: never sell in the money.",
      measured: m && m.spot ? `strike ${wadUsd(m.strike)} vs spot ${wadUsd(m.spot)}` : undefined,
    },
    {
      reason: "SizeTooLarge",
      title: "Share of capacity",
      rule: `At most ${pct(mandate.maxShareSoldBps)} of what the vault's collateral can back.`,
      measured:
        m && pv && max !== null
          ? `${fmtTokens(m.size, dec)} of max ${fmtTokens(max, dec)} ${sym} (capacity ${fmtTokens(pv.capacity, dec)})`
          : undefined,
    },
    {
      reason: "PremiumBelowFair",
      title: "Premium floor",
      rule: `Premium at least ${pct(mandate.minPremiumBps)} of Black-Scholes fair value.`,
      measured: m ? `${pct(m.premiumBps)} of fair` : undefined,
    },
    {
      reason: "PremiumAboveCap",
      title: "Premium cap",
      rule: `Premium at most ${pct(MAX_PREMIUM_BPS)} of fair value (protocol-wide).`,
      measured: m ? `${pct(m.premiumBps)} of fair` : undefined,
    },
    {
      reason: "DeltaOutOfBand",
      title: "Delta band",
      rule: `|Δ| between ${band(mandate.minDeltaBps)} and ${band(mandate.maxDeltaBps)}.`,
      measured: pv ? `|Δ| ${absDelta(pv.delta).toFixed(4)}` : undefined,
    },
    {
      reason: "PremiumTooSmall",
      title: "Minimum yield",
      rule: `Premium per option at least ${pct(mandate.minYieldBps)} of the collateral it locks (${
        isCall ? `one ${sym}` : "the strike in USDG"
      }).`,
      measured: y !== null ? `${num(y * 100, 3)}% of collateral` : undefined,
    },
  ];
  return rules.map((r, i) => {
    const code = i + 1;
    let mark: RuleMark = "idle";
    if (reasonCode !== null) {
      mark = reasonCode === 0 || code < reasonCode ? "pass" : code === reasonCode ? "fail" : "skip";
    }
    return { ...r, mark, measured: mark === "skip" ? undefined : r.measured };
  });
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

export function nyTime(ts: bigint | number): string {
  return `${nyFmt.format(new Date(Number(ts) * 1000))} ET`;
}

/** Plain-English headline and explanation of a rejection, with the numbers that caused it. */
export function explainReason(
  reason: MandateReason,
  mandate: Mandate,
  m: ProposalMeasures,
): { headline: string; text: string } {
  const pv = m.preview;
  const dec = m.underlyingDecimals;
  switch (reason) {
    case "None":
      return {
        headline: "Inside every rule of the mandate",
        text: "Size, tenor, expiry, strike side, share of capacity, premium and delta all pass.",
      };
    case "ZeroSize":
      return {
        headline: "Proposes zero options",
        text: "A proposal must sell something. An empty proposal is still a proposal the agent is accountable for.",
      };
    case "TenorOutOfRange": {
      const t = Number(m.expiry - m.now);
      return {
        headline: "Expiry too near or too far",
        text: `${t > 0 ? `The option would run ${fmtDays(t)}` : "The expiry is in the past"}; this vault only sells options that expire ${fmtDays(mandate.minTenor)} to ${fmtDays(mandate.maxTenor)} out.`,
      };
    }
    case "InvalidExpiry":
      return {
        headline: "Expiry is not an NYSE close",
        text: `${nyTime(m.expiry)} is not a session close. Options settle on the closing print, so the expiry must be 16:00 New York on a trading day.`,
      };
    case "StrikeWrongSide":
      return {
        headline: "Strike on the wrong side of spot",
        text: m.spot
          ? `Strike ${wadUsd(m.strike)} vs spot ${wadUsd(m.spot)}: a ${m.isCall ? "covered call must strike above" : "put must strike below"} spot, or the vault sells an option that is already in the money.`
          : "The vault would sell an option that is already in the money.",
      };
    case "SizeTooLarge": {
      const max = pv ? maxShare(pv.capacity, mandate) : null;
      return {
        headline: "Sells more of the vault than allowed",
        text:
          pv && max !== null
            ? `${fmtTokens(m.size, dec)} options is more than ${pct(mandate.maxShareSoldBps)} of the ${fmtTokens(pv.capacity, dec)} the vault can back (max ${fmtTokens(max, dec)}). Depositors keep a buffer the agent cannot sell.`
            : `More than ${pct(mandate.maxShareSoldBps)} of the vault's capacity.`,
      };
    }
    case "PremiumBelowFair":
      return {
        headline: "Priced below the fair-value floor",
        text: `Asked ${pct(m.premiumBps)} of fair value; the mandate requires at least ${pct(mandate.minPremiumBps)}. Selling cheap hands depositors' value to the buyer${pv ? ` (fair value ${wadUsd(pv.fairValue)} per option)` : ""}.`,
      };
    case "PremiumAboveCap":
      return {
        headline: "Priced above 3× fair value",
        text: `Asked ${pct(m.premiumBps)} of fair value; no series may ask more than ${pct(MAX_PREMIUM_BPS)}. An absurd price is a series nobody buys, which wastes the epoch.`,
      };
    case "DeltaOutOfBand": {
      const d = pv ? absDelta(pv.delta) : null;
      const high = d !== null && d > mandate.maxDeltaBps / BPS;
      return {
        headline: "Delta outside the mandate band",
        text:
          d !== null
            ? `|Δ| is ${d.toFixed(4)}; the band is ${band(mandate.minDeltaBps)}–${band(mandate.maxDeltaBps)}. ${
                high
                  ? `That is roughly a ${Math.round(d * 100)}% chance of being exercised: too much risk for this vault. Move the strike further out of the money.`
                  : "Too far out of the money to earn a meaningful premium. Move the strike closer to spot."
              }`
            : "The option's |delta| is outside the mandate's band.",
      };
    }
    case "PremiumTooSmall": {
      const y = yieldFraction(m);
      return {
        headline: "Premium too small for the collateral",
        text: `${y !== null ? `The premium is ${num(y * 100, 3)}% of the collateral one option locks` : "The premium is too small"}; the mandate asks for at least ${pct(mandate.minYieldBps)}. Locking collateral for almost nothing is not worth the risk.`,
      };
    }
  }
}

/** What a rejection costs the agent: min(slashAmount, bond + unbonding), and whether it can still propose after. */
export function slashConsequence(registry: AgentRegistryParams, agent: AgentInfo) {
  const available = agent.bond + agent.unbonding;
  const slashed = registry.slashAmount < available ? registry.slashAmount : available;
  const fromBond = registry.slashAmount < agent.bond ? registry.slashAmount : agent.bond;
  const bondAfter = agent.bond - fromBond;
  const strikesAfter = agent.strikes + 1;
  const suspended = strikesAfter >= registry.maxStrikes;
  const underBond = bondAfter < registry.minBond;
  return { slashed, bondAfter, strikesAfter, suspended, underBond };
}
