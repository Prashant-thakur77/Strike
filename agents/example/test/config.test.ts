import { loadStrikeConfig } from "@strike/sdk";
import { describe, expect, it } from "vitest";
import { DEFAULT_RECORD_BASE_URL, recordUrl } from "../src/anchor.js";
import { readClient } from "../src/chain.js";
import { explorerUrl, txUrl } from "../src/record.js";

// The agent's defaults come from strike.config.json; the values are the ones it had before (decision records and
// their anchors must not change).
describe("the example agent and strike.config.json", () => {
  const config = loadStrikeConfig();

  it("publishes records under the config's repository, as before", () => {
    expect(DEFAULT_RECORD_BASE_URL).toBe(
      "https://github.com/Prashant-thakur77/Strike/blob/main/docs/agent-log/",
    );
    expect(DEFAULT_RECORD_BASE_URL.startsWith(config.services.repository)).toBe(true);
    expect(recordUrl("2026-10-02-sTSLA-CC.json")).toBe(`${DEFAULT_RECORD_BASE_URL}2026-10-02-sTSLA-CC.json`);
  });

  it("links transactions to the config's explorer", () => {
    expect(explorerUrl(46630)).toBe(config.chains["46630"]!.explorer);
    expect(explorerUrl(46630)).toBe("https://explorer.testnet.chain.robinhood.com");
    expect(explorerUrl(421614)).toBe("https://sepolia.arbiscan.io");
    expect(explorerUrl(31337)).toBeNull();
    expect(explorerUrl(1)).toBeNull();
    expect(txUrl(421614, "0xab")).toBe("https://sepolia.arbiscan.io/tx/0xab");
  });

  it("reads the config's default chain when STRIKE_CHAIN_ID is unset", () => {
    expect(readClient({}).chainId).toBe(config.defaultChainId);
  });
});
