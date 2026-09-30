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
});
