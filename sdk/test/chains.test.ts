import { describe, expect, it } from "vitest";
import { getStrikeChain, strikeChainIds } from "../src/index.js";

describe("chains", () => {
  it("includes Robinhood Chain mainnet and testnet", () => {
    expect(strikeChainIds).toContain(4663);
    expect(strikeChainIds).toContain(46630);
  });

  it("resolves a chain by id", () => {
    expect(getStrikeChain(46630).name).toMatch(/Robinhood/);
  });

  it("rejects unknown chains", () => {
    expect(() => getStrikeChain(1)).toThrow(/not deployed/);
  });
});
