import type { Mandate } from "@strike/sdk";
import { describe, expect, it } from "vitest";
import {
  type VaultChoice,
  atTheMoneyStrike,
  defaultPremiumBps,
  deterministicPlan,
  enforceMandate,
  pickVault,
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
