import { describe, expect, it, vi } from "vitest";
import { settlementLookup } from "../src/settlements.js";
import { CC_SERIES_STATE, CC_VAULT, SERIES_ID, V3_CC_VAULT, WAD, vaultState } from "./fixtures.js";

const EM = "0x256D4546486368dCb23E94758b4cb500c215929F";
const settledLog = {
  args: {
    vault: V3_CC_VAULT.address,
    epoch: 1n,
    seriesId: SERIES_ID,
    settlementPrice: 372_100_000_000_000_000_000n,
    payout: 7_372_000_000_000_000n,
    premium: 10_005_944n,
    fee: 0n,
  },
};

describe("settlementLookup", () => {
  const idle = vaultState(V3_CC_VAULT, {
    epoch: { state: "Idle", openedAt: 0n, seriesId: 0n },
    lastProcessedEpoch: 1n,
  });

  it("reads the vault's EpochSettled log for its last processed epoch and joins the series", async () => {
    const getContractEvents = vi.fn(async () => [settledLog]);
    const getSeries = vi.fn(async () => ({ ...CC_SERIES_STATE, size: 4n * WAD }));
    const lookup = settlementLookup({ getSeries }, { getContractEvents } as never, EM, 126_713_718n);
    expect(await lookup(idle)).toEqual({
      epoch: 1n,
      isCall: true,
      strike: CC_SERIES_STATE.strike,
      expiry: CC_SERIES_STATE.expiry,
      settlementPrice: 372_100_000_000_000_000_000n,
      payout: 7_372_000_000_000_000n,
    });
    expect(getContractEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        address: EM,
        eventName: "EpochSettled",
        args: { vault: V3_CC_VAULT.address, epoch: 1n },
        fromBlock: 126_713_718n,
      }),
    );
    expect(getSeries).toHaveBeenCalledWith(SERIES_ID);
  });

  it("asks the chain once per vault and epoch", async () => {
    const getContractEvents = vi.fn(async () => [settledLog]);
    const lookup = settlementLookup(
      { getSeries: async () => CC_SERIES_STATE },
      { getContractEvents } as never,
      EM,
      0n,
    );
    await lookup(idle);
    await lookup(idle);
    expect(getContractEvents).toHaveBeenCalledTimes(1);
    await lookup({ ...idle, lastProcessedEpoch: 2n });
    expect(getContractEvents).toHaveBeenCalledTimes(2);
  });

  it("is null for a vault that never ran an epoch or whose last epoch did not settle, and is not cached then", async () => {
    const getContractEvents = vi.fn(async () => []);
    const lookup = settlementLookup(
      { getSeries: async () => CC_SERIES_STATE },
      { getContractEvents } as never,
      EM,
      0n,
    );
    expect(await lookup(vaultState(CC_VAULT, { lastProcessedEpoch: 0n }))).toBeNull();
    expect(getContractEvents).not.toHaveBeenCalled();
    expect(await lookup(idle)).toBeNull();
    expect(await lookup(idle)).toBeNull();
    expect(getContractEvents).toHaveBeenCalledTimes(2);
  });
});
