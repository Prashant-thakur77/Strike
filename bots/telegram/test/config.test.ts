import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { configFromEnv, deploymentBlock } from "../src/config.js";

describe("configFromEnv", () => {
  it("defaults to Robinhood Chain testnet from its deploy block, with Blockscout links", () => {
    const c = configFromEnv({});
    expect(c).toMatchObject({
      token: undefined,
      chainId: 46630,
      rpcUrl: "https://rpc.testnet.chain.robinhood.com",
      dataDir: resolve("data"),
      pollIntervalMs: 15_000,
      logBlockRange: 50_000n,
      startBlock: 125_880_607n,
      explorerUrl: "https://explorer.testnet.chain.robinhood.com",
      telegramApiUrl: "https://api.telegram.org",
    });
  });

  it("reads overrides", () => {
    const c = configFromEnv({
      TELEGRAM_BOT_TOKEN: "123456:ABCdefGHIjklMNOpqrSTUvwxYZ_-12",
      STRIKE_RPC_URL: "https://rpc.example",
      DATA_DIR: "/var/lib/strike-bot",
      POLL_INTERVAL_SECONDS: "30",
      LOG_BLOCK_RANGE: "10000",
      TELEGRAM_API_URL: "http://localhost:8081/",
    });
    expect(c.token).toBe("123456:ABCdefGHIjklMNOpqrSTUvwxYZ_-12");
    expect(c.rpcUrl).toBe("https://rpc.example");
    expect(c.dataDir).toBe("/var/lib/strike-bot");
    expect(c.pollIntervalMs).toBe(30_000);
    expect(c.logBlockRange).toBe(10_000n);
    expect(c.telegramApiUrl).toBe("http://localhost:8081");
  });

  it("reads through Alchemy first when ALCHEMY_API_KEY is set, the key in a header only", () => {
    const c = configFromEnv({
      ALCHEMY_API_KEY: "test_key_0123456789",
      STRIKE_RPC_URL: "https://rpc.example",
    });
    expect(c.rpcEndpoints.map((e) => e.provider)).toEqual(["alchemy", "custom", "public"]);
    expect(c.rpcUrl).toBe("https://robinhood-testnet.g.alchemy.com/v2");
    expect(c.rpcEndpoints[0]?.headers).toEqual({ Authorization: "Bearer test_key_0123456789" });
  });

  it("rejects bad values without echoing a token", () => {
    expect(() => configFromEnv({ STRIKE_CHAIN_ID: "abc" })).toThrow(/STRIKE_CHAIN_ID/);
    expect(() => configFromEnv({ LOG_BLOCK_RANGE: "0" })).toThrow(/LOG_BLOCK_RANGE/);
    expect(() => configFromEnv({ STRIKE_CHAIN_ID: "1" })).toThrow(/not deployed/);
    let message = "";
    try {
      configFromEnv({ TELEGRAM_BOT_TOKEN: "secret-value-not-a-token" });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/does not look like a BotFather token/);
    expect(message).not.toContain("secret-value");
  });

  it("finds the deploy block in the SDK deployments", () => {
    expect(deploymentBlock(46630)).toBe(125_880_607n);
  });
});
