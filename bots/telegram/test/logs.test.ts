import { describe, expect, it, vi } from "vitest";
import {
  ALERT_EVENT_NAMES,
  AlertBuilder,
  type ChainReader,
  type DecodedLog,
  alertEventsAbi,
  isRangeLimitError,
  scanLogs,
} from "../src/logs.js";
import { CC_SERIES, CC_SERIES_STATE, CC_VAULT, CSP_VAULT, REAL_LOGS, vaultState } from "./fixtures.js";

function ranges() {
  const seen: [bigint, bigint][] = [];
  return { seen, record: (a: bigint, b: bigint) => seen.push([a, b]) };
}

describe("scanLogs", () => {
  it("walks the range in chunks of maxRange and reports each chunk end", async () => {
    const r = ranges();
    const ends: bigint[] = [];
    await scanLogs({
      from: 0n,
      to: 249n,
      maxRange: 100n,
      fetchLogs: async (a, b) => (r.record(a, b), []),
      onChunk: async (_logs, end) => void ends.push(end),
    });
    expect(r.seen).toEqual([
      [0n, 99n],
      [100n, 199n],
      [200n, 249n],
    ]);
    expect(ends).toEqual([99n, 199n, 249n]);
  });

  it("does nothing when from > to", async () => {
    const fetchLogs = vi.fn(async () => []);
    await scanLogs({ from: 10n, to: 9n, maxRange: 5n, fetchLogs, onChunk: async () => undefined });
    expect(fetchLogs).not.toHaveBeenCalled();
  });

  it("halves the range on an RPC range limit (no backoff) and grows it back", async () => {
    const r = ranges();
    const sleep = vi.fn(async () => undefined);
    await scanLogs({
      from: 0n,
      to: 199n,
      maxRange: 100n,
      sleep,
      fetchLogs: async (a, b) => {
        r.record(a, b);
        if (b - a + 1n > 50n) throw new Error("query exceeds max block range 50");
        return [];
      },
      onChunk: async () => undefined,
    });
    expect(sleep).not.toHaveBeenCalled();
    expect(r.seen).toEqual([
      [0n, 99n], // refused
      [0n, 49n],
      [50n, 149n], // grown back to 100, refused
      [50n, 99n],
      [100n, 199n], // refused
      [100n, 149n],
      [150n, 199n],
    ]);
  });

  it("retries transient errors with exponential backoff", async () => {
    const sleep = vi.fn(async () => undefined);
    let n = 0;
    const onChunk = vi.fn(async () => undefined);
    await scanLogs({
      from: 0n,
      to: 9n,
      maxRange: 10n,
      sleep,
      baseDelayMs: 500,
      fetchLogs: async () => {
        n += 1;
        if (n <= 2) throw new Error("HTTP request failed. Status: 503");
        return [];
      },
      onChunk,
    });
    expect(sleep.mock.calls).toEqual([[500], [1000]]);
    // Each failure also halves the range (10 -> 5 -> 2); successes grow it back: [0,1], [2,5], [6,9].
    expect(onChunk.mock.calls.map((c) => (c as unknown[])[1])).toEqual([1n, 5n, 9n]);
  });

  it("gives up after `retries` consecutive failures", async () => {
    const onChunk = vi.fn(async () => undefined);
    const fetchLogs = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    await expect(
      scanLogs({
        from: 0n,
        to: 9n,
        maxRange: 10n,
        retries: 3,
        sleep: async () => undefined,
        fetchLogs,
        onChunk,
      }),
    ).rejects.toThrow("socket hang up");
    expect(fetchLogs).toHaveBeenCalledTimes(4);
    expect(onChunk).not.toHaveBeenCalled();
  });

  it("recognises common range-limit messages", () => {
    expect(isRangeLimitError(new Error("block range is too wide"))).toBe(true);
    expect(isRangeLimitError(new Error("query returned more than 10000 results"))).toBe(true);
    expect(isRangeLimitError(new Error("eth_getLogs is limited to a 10,000 block range limit"))).toBe(true);
    expect(isRangeLimitError(new Error("HTTP request failed. Status: 503"))).toBe(false);
  });
});

describe("alert events", () => {
  it("covers exactly the seven EpochManager events", () => {
    expect(alertEventsAbi.map((e) => e.name).sort()).toEqual([...ALERT_EVENT_NAMES].sort());
  });
});

describe("AlertBuilder", () => {
  it("joins the real logs with vault and series data, caching reads", async () => {
    const reader: ChainReader = {
      getVault: vi.fn(async (a) => vaultState(a === CC_VAULT.address ? CC_VAULT : CSP_VAULT)),
      getSeries: vi.fn(async () => CC_SERIES_STATE),
    };
    const b = new AlertBuilder(reader);
    const alerts = await Promise.all(REAL_LOGS.map((l) => b.build(l)));
    expect(alerts.map((a) => [a.name, a.vault.symbol])).toEqual([
      ["EpochOpened", "sTSLA-CC"],
      ["SeriesProposed", "sTSLA-CC"],
      ["ProposalRejected", "sTSLA-CSP"],
      ["OptionsBought", "sTSLA-CC"],
    ]);
    const bought = alerts[3];
    expect(bought?.name === "OptionsBought" && bought.series).toEqual(CC_SERIES);
    expect(reader.getVault).toHaveBeenCalledTimes(2);
    expect(reader.getSeries).toHaveBeenCalledTimes(1);
    expect(alerts[2]).toMatchObject({
      name: "ProposalRejected",
      reason: 8,
      slashed: 10_000_000n,
      agentId: 1n,
    });
  });

  it("fails (and forgets the failure) when a series is missing", async () => {
    const getSeries = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(CC_SERIES_STATE);
    const b = new AlertBuilder({ getVault: async () => vaultState(CC_VAULT), getSeries });
    const log = REAL_LOGS[3] as DecodedLog;
    await expect(b.build(log)).rejects.toThrow(/not found/);
    await expect(b.build(log)).resolves.toMatchObject({ name: "OptionsBought" });
  });
});
