import { describe, expect, it } from "vitest";
import { getDeployment, resolveAddresses } from "../src/index.js";

const V3_EM = "0x256D4546486368dCb23E94758b4cb500c215929F";
const V3_REG = "0x1c42740145B245b2f894d8e989ca29dfd9A9052f";

describe("getDeployment env overrides", () => {
  it("returns the map entry without overrides", () => {
    const d = getDeployment(46630, {});
    expect(d.epochManager).toBe("0x5A3b58DF27e4DD5E0fa6493D90fF653e0E199C99");
  });

  it("replaces addresses and the scan block from STRIKE_* variables", () => {
    const env = {
      STRIKE_EPOCH_MANAGER: V3_EM,
      STRIKE_AGENT_REGISTRY: V3_REG,
      STRIKE_DEPLOY_BLOCK: "126713718",
    };
    const d = getDeployment(46630, env);
    expect(d.epochManager).toBe(V3_EM);
    expect(d.agentRegistry).toBe(V3_REG);
    expect(d.block).toBe(126713718);
    expect(d.usdg).toBe(getDeployment(46630, {}).usdg);
  });

  it("ignores overrides meant for another chain", () => {
    const d = getDeployment(46630, { STRIKE_CHAIN_ID: "421614", STRIKE_EPOCH_MANAGER: V3_EM });
    expect(d.epochManager).not.toBe(V3_EM);
  });

  it("rejects a malformed address", () => {
    expect(() => getDeployment(46630, { STRIKE_EPOCH_MANAGER: "0x1234" })).toThrow(/STRIKE_EPOCH_MANAGER/);
  });

  it("feeds resolveAddresses through process.env", () => {
    const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process
      .env;
    const prev = env.STRIKE_EPOCH_MANAGER;
    env.STRIKE_EPOCH_MANAGER = V3_EM;
    try {
      expect(resolveAddresses(46630).epochManager).toBe(V3_EM);
    } finally {
      if (prev === undefined) delete env.STRIKE_EPOCH_MANAGER;
      else env.STRIKE_EPOCH_MANAGER = prev;
    }
  });
});
