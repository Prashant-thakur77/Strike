import { deploymentsFor } from "@strike/sdk";
import { describe, expect, it } from "vitest";
import { clientFromConfig, configFromEnv } from "../src/config.js";

const KEY = `0x${"11".repeat(32)}`;

describe("configFromEnv", () => {
  it("loads the agent key by default", () => {
    const c = configFromEnv({
      STRIKE_CHAIN_ID: "31337",
      STRIKE_RPC_URL: "http://x",
      STRIKE_AGENT_PRIVATE_KEY: KEY,
    });
    expect(c.readOnly).toBe(false);
    expect(c.privateKey).toBe(KEY);
  });

  it("STRIKE_MCP_READ_ONLY=1 registers read-only tools and ignores the key", () => {
    for (const flag of ["1", "true"]) {
      const c = configFromEnv({
        STRIKE_CHAIN_ID: "31337",
        STRIKE_RPC_URL: "http://x",
        STRIKE_AGENT_PRIVATE_KEY: KEY,
        STRIKE_MCP_READ_ONLY: flag,
      });
      expect(c.readOnly).toBe(true);
      expect(c.privateKey).toBeUndefined();
    }
  });

  it("reads through Alchemy when ALCHEMY_API_KEY is set, with the key in a header and the public RPC as fallback", () => {
    const c = configFromEnv({ STRIKE_CHAIN_ID: "46630", ALCHEMY_API_KEY: "test-alchemy-key" });
    expect(c.rpcEndpoints.map((e) => e.provider)).toEqual(["alchemy", "public"]);
    expect(c.rpcEndpoints[0]?.headers).toEqual({ Authorization: "Bearer test-alchemy-key" });
    expect(c.rpcUrl).toBe("https://robinhood-testnet.g.alchemy.com/v2");
    expect(JSON.stringify(c.rpcEndpoints.map((e) => e.url))).not.toContain("test-alchemy-key");
  });

  it("keeps a local devnet's RPC even with ALCHEMY_API_KEY set", () => {
    const c = configFromEnv({
      STRIKE_CHAIN_ID: "46630",
      STRIKE_RPC_URL: "http://127.0.0.1:8545",
      ALCHEMY_API_KEY: "test-alchemy-key",
    });
    expect(c.rpcEndpoints).toEqual([{ provider: "custom", url: "http://127.0.0.1:8545" }]);
  });
});

describe("configFromEnv and strike.config.json", () => {
  it("defaults to the config's defaultChainId and its public RPC", async () => {
    const { loadStrikeConfig } = await import("@strike/sdk");
    const strike = loadStrikeConfig();
    const c = configFromEnv({});
    expect(c.chainId).toBe(strike.defaultChainId);
    expect(c.rpcEndpoints).toEqual([
      { provider: "public", url: strike.chains[String(strike.defaultChainId)]!.rpc.public },
    ]);
  });

  it("reads the agent key from the variable the config names (secrets.agentKey)", async () => {
    const { strikeSecretName } = await import("@strike/sdk");
    expect(strikeSecretName("agentKey")).toBe("STRIKE_AGENT_PRIVATE_KEY");
    expect(() => configFromEnv({ STRIKE_AGENT_PRIVATE_KEY: "0x12" })).toThrow(
      /^STRIKE_AGENT_PRIVATE_KEY must be/,
    );
  });
});

describe("STRIKE_DEPLOYMENT_VERSION", () => {
  const em = (chainId: number, version: string) =>
    deploymentsFor(chainId).find((d) => d.version === version)!.epochManager;

  it("picks one of the chain's deployments (v3 next to v2 on 46630); unset keeps the SDK's default", () => {
    const v3 = configFromEnv({ STRIKE_CHAIN_ID: "46630", STRIKE_DEPLOYMENT_VERSION: "V3" });
    expect(v3.deploymentVersion).toBe("v3");
    expect(clientFromConfig(v3).addresses.epochManager).toBe(em(46630, "v3"));
    const v2 = configFromEnv({ STRIKE_CHAIN_ID: "46630", STRIKE_DEPLOYMENT_VERSION: "2" });
    expect(clientFromConfig(v2).addresses.epochManager).toBe(em(46630, "v2"));
    const unset = configFromEnv({ STRIKE_CHAIN_ID: "46630" });
    expect(unset.deploymentVersion).toBeUndefined();
    expect(clientFromConfig(unset).addresses.epochManager).toBe(deploymentsFor(46630)[0]!.epochManager);
  });

  it("refuses a version the chain does not have, or a malformed one, at startup", () => {
    expect(() => configFromEnv({ STRIKE_CHAIN_ID: "421614", STRIKE_DEPLOYMENT_VERSION: "v2" })).toThrow(
      /^STRIKE_DEPLOYMENT_VERSION: no v2 deployment on chain 421614; it has v3/,
    );
    expect(() => configFromEnv({ STRIKE_DEPLOYMENT_VERSION: "latest" })).toThrow(
      /invalid STRIKE_DEPLOYMENT_VERSION: latest/,
    );
  });
});
