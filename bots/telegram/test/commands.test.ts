import type { AgentStats, OracleStatus } from "@strike/sdk";
import { describe, expect, it, vi } from "vitest";
import { type StrikeReader, type Subscriptions, parseCommand, runCommand } from "../src/commands.js";
import { CC_SERIES_STATE, CC_VAULT, CSP_VAULT, DEPLOYER, WAD, vaultState } from "./fixtures.js";

describe("parseCommand", () => {
  it("reads the name and arguments", () => {
    expect(parseCommand("/quote sTSLA-CC 2")).toEqual({ name: "quote", args: ["sTSLA-CC", "2"] });
    expect(parseCommand("/vaults")).toEqual({ name: "vaults", args: [] });
  });

  it("lower-cases the name, trims, and collapses whitespace", () => {
    expect(parseCommand("  /AGENT   1  ")).toEqual({ name: "agent", args: ["1"] });
    expect(parseCommand("/quote\tsTSLA-CC\n3")).toEqual({ name: "quote", args: ["sTSLA-CC", "3"] });
  });

  it("accepts /cmd@ThisBot and ignores commands for another bot", () => {
    expect(parseCommand("/status@StrikeAlertsBot", "strikealertsbot")).toEqual({ name: "status", args: [] });
    expect(parseCommand("/status@OtherBot", "StrikeAlertsBot")).toBeNull();
    expect(parseCommand("/status@AnyBot")).toEqual({ name: "status", args: [] });
  });

  it("returns null for plain text and empty input", () => {
    expect(parseCommand("hello")).toBeNull();
    expect(parseCommand("")).toBeNull();
    expect(parseCommand(undefined)).toBeNull();
    expect(parseCommand("/")).toBeNull();
    expect(parseCommand("a /quote x")).toBeNull();
  });
});

const oracle: OracleStatus = {
  status: "Ok",
  ok: true,
  price: 352_453_000_000_000_000_000n,
  updatedAt: 1_790_700_000n,
};

function fakeStrike(over: Partial<StrikeReader> = {}): StrikeReader {
  const cc = vaultState(CC_VAULT, {
    epoch: { state: "Selling", openedAt: 1_790_700_000n, seriesId: CC_SERIES_STATE.id },
    series: CC_SERIES_STATE,
  });
  const csp = vaultState(CSP_VAULT);
  return {
    chainId: 46630,
    listVaults: vi.fn(async () => [cc, csp]),
    getVault: vi.fn(),
    quoteBuy: vi.fn(async (_id: bigint, amount: bigint) => ({
      premium: (2_444_436n * amount) / WAD,
      collateral: amount,
    })),
    agentStats: vi.fn(),
    oracleStatus: vi.fn(async () => oracle),
    marketOpen: vi.fn(async () => true),
    saleCutoff: vi.fn(async () => 3600),
    blockTimestamp: vi.fn(async () => 1_790_720_000n),
    viem: {
      publicClient: {
        getBlock: vi.fn(async () => ({ number: 126_332_630n, timestamp: 1_790_720_000n })),
      },
    },
    ...over,
  } as unknown as StrikeReader;
}

function memorySubs(): Subscriptions & { ids: number[] } {
  const ids: number[] = [];
  return {
    ids,
    cursor: 126_332_565n,
    get subscribers() {
      return ids;
    },
    subscribe: async (id) => (ids.includes(id) ? false : (ids.push(id), true)),
    unsubscribe: async (id) => {
      const i = ids.indexOf(id);
      if (i < 0) return false;
      ids.splice(i, 1);
      return true;
    },
  };
}

const run = (text: string, strike = fakeStrike(), subscriptions = memorySubs(), chatId = 42) =>
  runCommand(parseCommand(text)!, { strike, subscriptions, chatId, usdgDecimals: 6 });

describe("runCommand", () => {
  it("/start and /help list the commands", async () => {
    for (const cmd of ["/start", "/help"]) {
      const text = await run(cmd);
      for (const c of ["/subscribe", "/unsubscribe", "/vaults", "/quote", "/agent", "/status"]) {
        expect(text).toContain(c);
      }
    }
  });

  it("/subscribe and /unsubscribe update the subscriptions once", async () => {
    const subs = memorySubs();
    expect(await run("/subscribe", undefined, subs)).toMatch(/^Subscribed/);
    expect(await run("/subscribe", undefined, subs)).toMatch(/already subscribed/);
    expect(subs.ids).toEqual([42]);
    expect(await run("/unsubscribe", undefined, subs)).toMatch(/^Unsubscribed/);
    expect(await run("/unsubscribe", undefined, subs)).toMatch(/was not subscribed/);
    expect(subs.ids).toEqual([]);
  });

  it("/vaults shows state, TVL and the live series", async () => {
    expect(await run("/vaults")).toBe(
      [
        "sTSLA-CC, covered call on TSLA (0xADFF…1D4e)",
        "Epoch 1: Selling. TVL 5 TSLA.",
        "Live series: call strike $369.86, expiry 2026-10-02 20:00 UTC, 4 of 4 sold",
        "",
        "sTSLA-CSP, cash-secured put on TSLA (0xE33E…67d7)",
        "Epoch 1: Open. TVL 20 USDG.",
        "No live series yet: waiting for the agent's proposal.",
      ].join("\n"),
    );
  });

  it("/quote finds the vault by symbol or address and quotes the premium", async () => {
    const strike = fakeStrike();
    const bySymbol = await run("/quote stsla-cc 2", strike);
    expect(bySymbol).toContain("sTSLA-CC: 2 TSLA calls, strike $369.86, expiry 2026-10-02 20:00 UTC");
    expect(bySymbol).toContain("Premium 4.888872 USDG (2.444436 per option)");
    expect(bySymbol).toContain("Not buyable now: the series is sold out (4 of 4 sold).");
    expect(strike.quoteBuy).toHaveBeenCalledWith(CC_SERIES_STATE.id, 2n * WAD);
    const byAddress = await run(`/quote ${CC_VAULT.address.toLowerCase()}`, strike);
    expect(byAddress).toContain("1 TSLA call,");
  });

  it("/quote says when it is buyable and when options are short", async () => {
    const open = fakeStrike({
      listVaults: vi.fn(async () => [
        vaultState(CC_VAULT, {
          epoch: { state: "Selling", openedAt: 0n, seriesId: CC_SERIES_STATE.id },
          series: { ...CC_SERIES_STATE, sold: 0n },
        }),
      ]),
    } as Partial<StrikeReader>);
    expect(await run("/quote sTSLA-CC 1", open)).toContain("Buyable now.");
    expect(await run("/quote sTSLA-CC 5", open)).toContain("only 4 of 4 options are left");
  });

  it("/quote explains bad input", async () => {
    expect(await run("/quote")).toMatch(/^Usage: \/quote/);
    expect(await run("/quote sAAPL-CC")).toBe("No vault named sAAPL-CC. Vaults: sTSLA-CC, sTSLA-CSP.");
    expect(await run("/quote sTSLA-CC abc")).toMatch(/is not a number/);
    expect(await run("/quote sTSLA-CC 0")).toBe("The amount must be more than 0.");
    expect(await run("/quote sTSLA-CSP")).toBe("sTSLA-CSP has no live series (epoch 1 is Open).");
    expect(await run(`/quote ${DEPLOYER}`)).toMatch(/is not a registered Strike vault/);
  });

  it("/agent shows bond, strikes, counts and status", async () => {
    const stats = {
      agentId: 1n,
      owner: DEPLOYER,
      signer: DEPLOYER,
      payout: DEPLOYER,
      status: "Active",
      strikes: 1,
      accepted: 1,
      rejected: 1,
      unbondAt: 0n,
      erc8004Id: 0n,
      bond: 50_000_000n,
      unbonding: 0n,
      active: true,
      settledEpochs: 0,
      cumulativePnl: 0n,
      params: {
        minBond: 50_000_000n,
        slashAmount: 10_000_000n,
        maxStrikes: 3,
        unbondDelay: 604_800,
        identityRegistry: DEPLOYER,
        reputationRegistry: DEPLOYER,
      },
      proposals: 2,
      acceptanceRate: 0.5,
      strikesLeft: 2,
      rejectionsUntilInactive: 1,
      claimableFees: 0n,
    } satisfies AgentStats;
    const strike = fakeStrike({ agentStats: vi.fn(async () => stats) } as Partial<StrikeReader>);
    expect(await run("/agent 1", strike)).toBe(
      [
        "Agent 1: Active, can propose",
        "Bond 50 USDG (minimum 50 USDG), strikes 1 of 3",
        "Proposals: 1 accepted, 1 rejected",
        "Settled epochs: 0, cumulative depositor PnL 0 USDG",
        "Signer 0x26b2…13Ff",
      ].join("\n"),
    );
    const none = fakeStrike({
      agentStats: vi.fn(async () => ({ ...stats, status: "None" })),
    } as Partial<StrikeReader>);
    expect(await run("/agent 9", none)).toBe("Agent 9 is not registered.");
    expect(await run("/agent x")).toMatch(/^Usage: \/agent/);
  });

  it("/status shows the head, market and each underlying's feed", async () => {
    expect(await run("/status")).toBe(
      [
        "Robinhood Chain Testnet (46630): head block 126332630, 2026-09-29 22:13 UTC",
        "NYSE session: open",
        "TSLA feed: Ok, $352.453, updated 2026-09-29 16:40 UTC",
        "Alerts: scanned to block 126332564, 0 subscribed chat(s)",
      ].join("\n"),
    );
    const stale = fakeStrike({
      oracleStatus: vi.fn(async () => ({ ...oracle, status: "StalePrice", ok: false })),
    } as Partial<StrikeReader>);
    expect(await run("/status", stale)).toContain("TSLA feed: StalePrice, $352.453");
  });

  it("an RPC failure becomes a plain reply, and unknown commands point to /help", async () => {
    const broken = fakeStrike({
      listVaults: vi.fn(async () => {
        throw new Error("connection refused");
      }),
    } as Partial<StrikeReader>);
    expect(await run("/vaults", broken)).toBe("Could not read that from the chain: connection refused");
    expect(await run("/moon")).toBe("Unknown command /moon. Send /help for the list.");
  });
});
