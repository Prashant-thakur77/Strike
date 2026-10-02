import { describe, expect, it } from "vitest";
import { configFromEnv } from "../src/config.js";

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
    const c = configFromEnv({ STRIKE_CHAIN_ID: "46630", ALCHEMY_API_KEY: "test_key_0123456789" });
    expect(c.rpcEndpoints.map((e) => e.provider)).toEqual(["alchemy", "public"]);
    expect(c.rpcEndpoints[0]?.headers).toEqual({ Authorization: "Bearer test_key_0123456789" });
    expect(c.rpcUrl).toBe("https://robinhood-testnet.g.alchemy.com/v2");
    expect(JSON.stringify(c.rpcEndpoints.map((e) => e.url))).not.toContain("test_key");
  });

  it("keeps a local devnet's RPC even with ALCHEMY_API_KEY set", () => {
    const c = configFromEnv({
      STRIKE_CHAIN_ID: "46630",
      STRIKE_RPC_URL: "http://127.0.0.1:8545",
      ALCHEMY_API_KEY: "test_key_0123456789",
    });
    expect(c.rpcEndpoints).toEqual([{ provider: "custom", url: "http://127.0.0.1:8545" }]);
  });
});
