import { describe, expect, it } from "vitest";
import agentRegistrySol from "../../contracts/src/agents/AgentRegistry.sol?raw";
import epochManagerSol from "../../contracts/src/core/EpochManager.sol?raw";
import mandateGuardSol from "../../contracts/src/libraries/MandateGuard.sol?raw";
import safeStockFeedSol from "../../contracts/src/libraries/SafeStockFeed.sol?raw";
import {
  AGENT_STATUSES,
  EPOCH_STATES,
  FEED_STATUSES,
  MANDATE_REASONS,
  type Mandate,
  agentStatusName,
  epochStateName,
  explainMandateReason,
  feedStatusName,
  mandateReasonCode,
  mandateReasonName,
} from "../src/index.js";

/** Member names of `enum <name> { ... }` in a Solidity source, in declaration order. */
function solidityEnum(source: string, name: string): string[] {
  const body = new RegExp(`enum\\s+${name}\\s*\\{([^}]*)\\}`).exec(source)?.[1];
  if (!body) throw new Error(`enum ${name} not found`);
  return body
    .split(",")
    .map((s) => s.replace(/\/\/.*$/gm, "").trim())
    .filter(Boolean);
}

const mandate: Mandate = {
  minDeltaBps: 1000,
  maxDeltaBps: 3500,
  minPremiumBps: 9500,
  minYieldBps: 5,
  maxShareSoldBps: 8000,
  minTenor: 86_400,
  maxTenor: 8 * 86_400,
};

describe("enum names match the contracts", () => {
  it("MandateGuard.Reason", () => {
    expect([...MANDATE_REASONS]).toEqual(solidityEnum(mandateGuardSol, "Reason"));
  });

  it("SafeStockFeed.Status", () => {
    expect([...FEED_STATUSES]).toEqual(solidityEnum(safeStockFeedSol, "Status"));
  });

  it("EpochManager.EpochState", () => {
    expect([...EPOCH_STATES]).toEqual(solidityEnum(epochManagerSol, "EpochState"));
  });

  it("AgentRegistry.Status", () => {
    expect([...AGENT_STATUSES]).toEqual(solidityEnum(agentRegistrySol, "Status"));
  });
});

describe("name lookups", () => {
  it("maps codes to names and back", () => {
    expect(mandateReasonName(0)).toBe("None");
    expect(mandateReasonName(8n)).toBe("DeltaOutOfBand");
    expect(mandateReasonCode("PremiumTooSmall")).toBe(9);
    expect(feedStatusName(2)).toBe("StalePrice");
    expect(epochStateName(2)).toBe("Selling");
    expect(agentStatusName(2)).toBe("Suspended");
  });

  it("rejects unknown codes", () => {
    expect(() => mandateReasonName(10)).toThrow(RangeError);
    expect(() => feedStatusName(99)).toThrow(RangeError);
  });
});

describe("explainMandateReason", () => {
  it("adds the numbers behind a delta rejection and the fix", () => {
    const text = explainMandateReason("DeltaOutOfBand", { mandate, delta: 0.52 });
    expect(text).toMatch(/0\.5200/);
    expect(text).toMatch(/0\.10 to 0\.35/);
    expect(text).toMatch(/further out of the money/);
    expect(explainMandateReason("DeltaOutOfBand", { mandate, delta: 0.05 })).toMatch(/closer to spot/);
  });

  it("explains wrong-side strikes, size, premium and tenor", () => {
    expect(explainMandateReason("StrikeWrongSide", { isCall: true, spot: 369, strike: 360 })).toMatch(
      /above spot/,
    );
    expect(explainMandateReason("SizeTooLarge", { mandate, size: 9, capacity: 10 })).toMatch(
      /80% of capacity 10 = 8/,
    );
    expect(explainMandateReason("PremiumBelowFair", { mandate, premiumBps: 9000 })).toMatch(/90% .* 95%/);
    expect(explainMandateReason("TenorOutOfRange", { mandate, tenorSeconds: 3600 })).toMatch(/0\.04 days/);
    expect(explainMandateReason("PremiumTooSmall", { mandate, yieldFraction: 0.0001 })).toMatch(/0\.01%/);
  });

  it("falls back to the generic description", () => {
    expect(explainMandateReason("None")).toMatch(/Inside the mandate/);
    expect(explainMandateReason("InvalidExpiry", { mandate })).toMatch(/NYSE session close/);
  });
});
