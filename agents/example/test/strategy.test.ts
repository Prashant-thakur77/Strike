import type { Mandate } from "@strike/sdk";
import { describe, expect, it } from "vitest";
import {
  PROFILES,
  type VaultChoice,
  atTheMoneyStrike,
  capSize,
  defaultPremiumBps,
  deterministicPlan,
  enforceMandate,
  parseProfile,
  pickVault,
  profileLabel,
  profilePlan,
  targetDeltaBps,
} from "../src/strategy.js";

const mandate: Mandate = {
  minDeltaBps: 1000,
  maxDeltaBps: 3500,
  minPremiumBps: 9500,
  minYieldBps: 5,
  maxShareSoldBps: 8000,
  minTenor: 86_400,
  maxTenor: 691_200,
};

describe("strategy", () => {
  it("targets 0.20 delta, clamped one point inside the band", () => {
    expect(targetDeltaBps(mandate)).toBe(2000);
    expect(targetDeltaBps(mandate, 0.5)).toBe(3400);
    expect(targetDeltaBps(mandate, 0.05)).toBe(1100);
  });

  it("sells at fair value or the mandate minimum, whichever is higher", () => {
    expect(defaultPremiumBps(mandate)).toBe(10_000);
    expect(defaultPremiumBps({ ...mandate, minPremiumBps: 12_000 })).toBe(12_000);
  });

  it("explains the deterministic plan", () => {
    const plan = deterministicPlan(mandate);
    expect(plan).toMatchObject({ targetDeltaBps: 2000, premiumBps: 10_000 });
    expect(plan.reasoning).toMatch(/0\.20 delta/);
    expect(deterministicPlan(mandate, 0.45).reasoning).toMatch(/clamped from 0\.45/);
  });

  it("enforces the mandate on a plan from any source", () => {
    const { plan, adjustments } = enforceMandate(
      { targetDeltaBps: 5000, premiumBps: 8000, reasoning: "aggressive" },
      mandate,
    );
    expect(plan).toMatchObject({ targetDeltaBps: 3400, premiumBps: 9500, reasoning: "aggressive" });
    expect(adjustments).toHaveLength(2);
    const ok = enforceMandate({ targetDeltaBps: 2000, premiumBps: 10_500, reasoning: "" }, mandate);
    expect(ok.adjustments).toEqual([]);
  });

  it("puts the reckless strike one cent out of the money", () => {
    expect(atTheMoneyStrike(369, true)).toBe("369.01");
    expect(atTheMoneyStrike(369, false)).toBe("368.99");
    expect(atTheMoneyStrike(224.126, true)).toBe("224.14");
  });

  it("picks this agent's first vault that can take a proposal, calls first", () => {
    const v = (
      symbol: string,
      kind: VaultChoice["kind"],
      epochState: VaultChoice["epochState"],
      agentId = "1",
    ) => ({
      address: `0x${symbol}`,
      symbol,
      kind,
      epochState,
      agentId,
    });
    const put = v("P", "cash-secured-put", "Idle");
    expect(pickVault([put, v("C", "covered-call", "Idle")], "1")?.symbol).toBe("C");
    expect(pickVault([put, v("C", "covered-call", "Selling")], "1")?.symbol).toBe("P");
    expect(pickVault([v("C", "covered-call", "Open", "2")], "1")).toBeNull();
  });
});

describe("profiles (--profile)", () => {
  it("parses a profile name, default when none", () => {
    expect(parseProfile(undefined)).toBe(PROFILES.default);
    expect(parseProfile(" Conservative ")).toBe(PROFILES.conservative);
    expect(() => parseProfile("yolo")).toThrow(/--profile must be one of default, conservative/);
  });

  it("conservative: 0.15 delta at 108% of fair value, half the capacity, named for the record", () => {
    const plan = profilePlan(PROFILES.conservative!, mandate);
    expect(plan).toMatchObject({ targetDeltaBps: 1500, premiumBps: 10_800 });
    expect(plan.reasoning).toMatch(/Profile "conservative": target 0\.15 delta/);
    expect(plan.reasoning).toMatch(/108% of Black-Scholes fair value/);
    expect(plan.reasoning).toMatch(/at most 50% of the vault's capacity/);
    expect(PROFILES.conservative!.sizeShare).toBe(0.5);
    expect(profileLabel(PROFILES.conservative!)).toBe("rule: conservative");
  });

  it("keeps the profile inside the mandate: the delta is clamped and the premium never below the floor", () => {
    const tight = { ...mandate, minDeltaBps: 2000, maxDeltaBps: 3500, minPremiumBps: 11_000 };
    expect(profilePlan(PROFILES.conservative!, tight)).toMatchObject({
      targetDeltaBps: 2100,
      premiumBps: 11_000,
    });
    expect(profilePlan(PROFILES.conservative!, tight).reasoning).toMatch(/clamped from 0\.15/);
  });

  it("the default profile is the deterministic plan", () => {
    expect(profilePlan(PROFILES.default!, mandate)).toEqual(deterministicPlan(mandate));
    expect(profileLabel(PROFILES.default!)).toBe("rule: default");
  });

  it("caps the offered size at the profile's share of capacity", () => {
    expect(capSize("4", "5", 0.5)).toBe("2.5");
    expect(capSize("0.419", "0.419", 0.5)).toBe("0.2095");
    expect(capSize("2", "5", 0.5)).toBe("2");
    expect(capSize("4", "5", 1)).toBe("4");
  });
});
