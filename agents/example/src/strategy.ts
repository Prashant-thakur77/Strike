import { BPS, MAX_PREMIUM_BPS, type Mandate, clampDeltaToMandate } from "@strike/sdk";

/** The example agent's default: sell a 0.20-delta option each week. */
export const DEFAULT_TARGET_DELTA = 0.2;

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
