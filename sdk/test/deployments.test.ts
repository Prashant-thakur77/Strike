import { describe, expect, it } from "vitest";
import type { PublicClient } from "viem";
import {
  createStrikeClient,
  deploymentForEpochManager,
  deploymentsFor,
  getDeployment,
  resolveAddresses,
  secondaryDeployments,
} from "../src/index.js";
import v3Robinhood from "../../contracts/deployments/46630-v3.json" with { type: "json" };
import v3RobinhoodVaults from "../../contracts/deployments/46630-v3-vaults.json" with { type: "json" };

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

describe("deploymentsFor", () => {
  it("lists v2 (the default) and v3 on Robinhood Chain testnet", () => {
    const list = deploymentsFor(46630);
    expect(list.map((d) => d.version)).toEqual(["v2", "v3"]);
    expect(list[0]).toBe(getDeployment(46630, {}));
    expect(list[1]!.epochManager).toBe(V3_EM);
    expect(list[1]!.agentRegistry).toBe(V3_REG);
    expect(list[1]!.decisionLog).toBe(v3Robinhood.decisionLog);
    expect(list[1]!.riskLens).toBe(v3Robinhood.riskLens);
    expect(list[1]!.optionToken).toBe(v3Robinhood.optionToken);
    // The vaults file of the version, not v2's.
    expect(list[1]!.vaults).toEqual(v3RobinhoodVaults);
  });

  it("lists one deployment where there is one, none where Strike is not deployed", () => {
    expect(deploymentsFor(421614).map((d) => d.version)).toEqual(["v3"]);
    expect(deploymentsFor(1)).toEqual([]);
    // v1 on 46630 is superseded history, not a secondary deployment.
    expect(secondaryDeployments["46630"]!.map((d) => d.version)).toEqual(["v3"]);
  });

  it("finds a vault's deployment by its EpochManager, case-insensitively", () => {
    expect(deploymentForEpochManager(46630, V3_EM.toLowerCase())?.version).toBe("v3");
    expect(deploymentForEpochManager(46630, getDeployment(46630, {}).epochManager)?.version).toBe("v2");
    expect(deploymentForEpochManager(421614, V3_EM)).toBeNull();
    expect(deploymentForEpochManager(1, V3_EM)).toBeNull();
  });

  it("gives the client a chosen deployment's addresses", () => {
    const publicClient = {} as PublicClient;
    const v3 = deploymentsFor(46630)[1]!;
    const strike = createStrikeClient({ publicClient, chainId: 46630, deployment: v3 });
    expect(strike.addresses.epochManager).toBe(V3_EM);
    expect(strike.addresses.agentRegistry).toBe(V3_REG);
    expect(strike.addresses.optionToken).toBe(v3Robinhood.optionToken);
    const v2 = createStrikeClient({ publicClient, chainId: 46630 });
    expect(v2.addresses.epochManager).toBe(getDeployment(46630, {}).epochManager);
  });
});
