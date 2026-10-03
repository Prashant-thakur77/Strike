import { BPS, MAX_PREMIUM_BPS, type Mandate, clampDeltaToMandate } from "@strike/sdk";
import { formatUnits, parseUnits } from "viem";

/** The example agent's default: sell a 0.20-delta option each week. */
export const DEFAULT_TARGET_DELTA = 0.2;

/** A named rule-based profile: the target |delta|, the price in bps of fair value, and the share of capacity to offer. */
export interface Profile {
  name: string;
  targetDelta: number;
  premiumBps: number;
  /** Largest share of the vault's capacity to offer (1: whatever the mandate allows). */
  sizeShare: number;
  /** One-sigma moves the critic wants between spot and the break-even (default 0.5). */
  cushionSigmas?: number;
}

/** The rule-based profiles `--profile` selects. "default" is the 0.20-delta rule below. */
export const PROFILES: Record<string, Profile> = {
  default: { name: "default", targetDelta: DEFAULT_TARGET_DELTA, premiumBps: BPS, sizeShare: 1 },
  conservative: {
    name: "conservative",
    targetDelta: 0.15,
    premiumBps: 10_800,
    sizeShare: 0.5,
    cushionSigmas: 0.75,
  },
};

/** Parse `--profile` (default "default"). */
export function parseProfile(value: string | undefined): Profile {
  const name = (value ?? "default").trim().toLowerCase();
  const profile = PROFILES[name];
  if (!profile) {
    throw new Error(`--profile must be one of ${Object.keys(PROFILES).join(", ")}, got "${value}"`);
  }
  return profile;
}

/** How the decision record names a rule-based planner: "rule: conservative". */
export const profileLabel = (profile: Profile) => `rule: ${profile.name}`;

/** A proposal plan: what the agent (or Claude) decided, before the dry run. */
export interface Plan {
  targetDeltaBps: number;
  premiumBps: number;
  reasoning: string;
}

/** Target |delta| in bps, clamped into the mandate's band (one point of delta inside each edge). */
export function targetDeltaBps(mandate: Mandate, desired = DEFAULT_TARGET_DELTA): number {
  return Math.round(clampDeltaToMandate(desired, mandate) * BPS);
}

/** Sell at fair value, or at the mandate's minimum share of it if that is higher. */
export function defaultPremiumBps(mandate: Mandate): number {
  return Math.min(Math.max(mandate.minPremiumBps, BPS), MAX_PREMIUM_BPS);
}

/** The deterministic plan: 0.20 delta (or `desired`) at fair value. */
export function deterministicPlan(mandate: Mandate, desired = DEFAULT_TARGET_DELTA): Plan {
  const bps = targetDeltaBps(mandate, desired);
  const clamped = bps !== Math.round(desired * BPS);
  return {
    targetDeltaBps: bps,
    premiumBps: defaultPremiumBps(mandate),
    reasoning: `Target ${(bps / BPS).toFixed(2)} delta${clamped ? ` (clamped from ${desired.toFixed(2)} into the mandate band)` : ""}: far enough out of the money that the stock rarely gets called away, close enough to earn a meaningful premium. Price at ${(defaultPremiumBps(mandate) / 100).toFixed(0)}% of Black-Scholes fair value.`,
  };
}

/**
 * A profile's plan: its delta clamped into the mandate band, priced at its share of fair value or the mandate's
 * minimum, whichever is higher. The default profile is {@link deterministicPlan}.
 */
export function profilePlan(profile: Profile, mandate: Mandate): Plan {
  if (profile.name === "default") return deterministicPlan(mandate, profile.targetDelta);
  const bps = targetDeltaBps(mandate, profile.targetDelta);
  const clamped = bps !== Math.round(profile.targetDelta * BPS);
  const premiumBps = Math.min(Math.max(profile.premiumBps, mandate.minPremiumBps), MAX_PREMIUM_BPS);
  return {
    targetDeltaBps: bps,
    premiumBps,
    reasoning: `Profile "${profile.name}": target ${(bps / BPS).toFixed(2)} delta${clamped ? ` (clamped from ${profile.targetDelta.toFixed(2)} into the mandate band)` : ""}, further out of the money than the default ${DEFAULT_TARGET_DELTA.toFixed(2)}, so the option is exercised less often and the premium is smaller. Price at ${(premiumBps / 100).toFixed(0)}% of Black-Scholes fair value, and offer at most ${Math.round(profile.sizeShare * 100)}% of the vault's capacity, so a bad week costs depositors less.`,
  };
}

/**
 * Cap an offered size at `share` of the vault's capacity (both decimal strings of underlying tokens): the smaller of
 * the size and share × capacity.
 */
export function capSize(size: string, capacity: string, share: number): string {
  const offered = parseUnits(size, 18);
  const cap = (parseUnits(capacity, 18) * BigInt(Math.round(share * BPS))) / BigInt(BPS);
  return formatUnits(offered < cap ? offered : cap, 18);
}

/**
 * Enforce the mandate on a plan from any source (for example an LLM): clamp the delta into the band and the premium
 * factor into [minPremiumBps, 30000]. Returns the plan and a note for every adjustment.
 */
export function enforceMandate(plan: Plan, mandate: Mandate): { plan: Plan; adjustments: string[] } {
  const adjustments: string[] = [];
  const delta = targetDeltaBps(mandate, plan.targetDeltaBps / BPS);
  if (delta !== plan.targetDeltaBps) {
    adjustments.push(`target delta ${plan.targetDeltaBps} bps → ${delta} bps (inside the mandate band)`);
  }
  const premium = Math.min(Math.max(Math.round(plan.premiumBps), mandate.minPremiumBps), MAX_PREMIUM_BPS);
  if (premium !== plan.premiumBps) adjustments.push(`premium ${plan.premiumBps} bps → ${premium} bps`);
  return { plan: { ...plan, targetDeltaBps: delta, premiumBps: premium }, adjustments };
}

/**
 * An at-the-money strike for the reckless demo: spot rounded to the cent, nudged one cent out of the money so the
 * mandate's delta band (|delta| ≈ 0.5), not the wrong-side rule, is what rejects it.
 */
export function atTheMoneyStrike(spot: number, isCall: boolean): string {
  const cents = Math.round(spot * 100);
  return ((isCall ? cents + 1 : cents - 1) / 100).toFixed(2);
}

/** The subset of a list_vaults entry the agent needs to pick a vault. */
export interface VaultChoice {
  address: string;
  symbol: string;
  kind: "covered-call" | "cash-secured-put";
  epochState: "Idle" | "Open" | "Selling";
  agentId: string;
}

/**
 * The first vault this agent runs that can take a proposal now (Idle or Open), covered calls first. Null if none.
 */
export function pickVault(vaults: VaultChoice[], agentId: string): VaultChoice | null {
  const mine = vaults.filter((v) => v.agentId === agentId && v.epochState !== "Selling");
  return mine.find((v) => v.kind === "covered-call") ?? mine[0] ?? null;
}
