import type { AgentStats } from "@strike/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  type CommandTarget,
  type Subscriptions,
  expiredLine,
  parseCommand,
  runCommand,
} from "../src/commands.js";
import { splitMessage } from "../src/format.js";
import {
  AFTER_EXPIRY,
  BEFORE_EXPIRY,
  CC_SERIES_STATE,
  CC_VAULT,
  CSP_VAULT,
  DEPLOYER,
  EXPIRY,
  SEPOLIA_CC_VAULT,
  V3_CC_VAULT,
  V3_CSP_VAULT,
  WAD,
  fakeTarget,
  selling,
  targetSepolia,
  targetV2,
  targetV3,
  vaultState,
} from "./fixtures.js";

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

const all = () => [targetV2(), targetV3(), targetSepolia()];

function memorySubs(): Subscriptions & { ids: number[] } {
  const ids: number[] = [];
  return {
    ids,
    cursor: 126_332_565n,
    cursorOf: (key) => (key.startsWith("421614") ? 315_000_000n : null),
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

const run = (text: string, targets: CommandTarget[] = all(), subscriptions = memorySubs(), chatId = 42) =>
  runCommand(parseCommand(text)!, { targets, subscriptions, chatId });

const EXPIRED_LINE =
  "Expired 2026-10-02 20:00 UTC, waiting for settlement: settles at the first mainnet Chainlink price at or after expiry";

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
    expect(await run("/subscribe", all(), subs)).toMatch(/^Subscribed/);
    expect(await run("/subscribe", all(), subs)).toMatch(/already subscribed/);
    expect(subs.ids).toEqual([42]);
    expect(await run("/unsubscribe", all(), subs)).toMatch(/^Unsubscribed/);
    expect(await run("/unsubscribe", all(), subs)).toMatch(/was not subscribed/);
    expect(subs.ids).toEqual([]);
  });
});

describe("/vaults across deployments", () => {
  it("lists every deployment grouped by chain, each vault labelled with chain and version", async () => {
    const text = await run("/vaults");
    expect(text).toBe(
      [
        "Robinhood Chain testnet (46630)",
        "",
        "sTSLA-CC, covered call on TSLA (0xADFF…1D4e)",
        "Robinhood Chain testnet · v2 · epoch 1: Expired, settling. TVL 5 TSLA.",
        "Series: call strike $369.86, 4 of 4 sold",
        EXPIRED_LINE,
        "",
        "sTSLA-CSP, cash-secured put on TSLA (0xE33E…67d7)",
        "Robinhood Chain testnet · v2 · epoch 1: Open. TVL 20 USDG.",
        "No live series yet: waiting for the agent's proposal.",
        "",
        "sTSLA-CC, covered call on TSLA (0x478E…6285)",
        "Robinhood Chain testnet · v3 · epoch 1: Expired, settling. TVL 5 TSLA.",
        "Series: call strike $369.36, 4 of 4 sold",
        EXPIRED_LINE,
        "",
        "sTSLA-CSP, cash-secured put on TSLA (0x1bc7…3690)",
        "Robinhood Chain testnet · v3 · epoch 1: Idle. TVL 20 USDG.",
        "No live series.",
        "",
        "Arbitrum Sepolia (421614)",
        "",
        "sTSLA-CC, covered call on TSLA (0x5655…7311)",
        "Arbitrum Sepolia · v3 · epoch 1: Expired, settling. TVL 5 TSLA.",
        "Series: call strike $364.29, 4 of 4 sold",
        EXPIRED_LINE,
        "",
        "sTSLA-CSP, cash-secured put on TSLA (0x02B7…9bbe)",
        "Arbitrum Sepolia · v3 · epoch 1: Idle. TVL 20 USDG.",
        "No live series.",
      ].join("\n"),
    );
  });

  it("takes an optional chain: an id, a name, or a version", async () => {
    const sepolia = await run("/vaults 421614");
    expect(sepolia.startsWith("Arbitrum Sepolia (421614)")).toBe(true);
    expect(sepolia).not.toContain("Robinhood");
    expect(await run("/vaults arbitrum")).toBe(sepolia);
    expect(await run("/vaults Arb")).toBe(sepolia);

    const rh = await run("/vaults 46630");
    expect(rh).toContain("Robinhood Chain testnet · v2");
    expect(rh).toContain("Robinhood Chain testnet · v3");
    expect(rh).not.toContain("Arbitrum Sepolia");

    const v3 = await run("/vaults v3");
    expect(v3).not.toContain("· v2");
    expect(v3).toContain("Arbitrum Sepolia · v3");
    expect(v3).toContain("Robinhood Chain testnet · v3");

    const rhV3 = await run("/vaults 46630 V3");
    expect(rhV3).toContain("Robinhood Chain testnet · v3");
    expect(rhV3).not.toContain("· v2");
    expect(rhV3).not.toContain("Arbitrum");
  });

  it("explains an unknown chain or version and lists what exists", async () => {
    const chain = await run("/vaults 999");
    expect(chain).toContain("No Strike deployment on chain 999.");
    expect(chain).toContain("Chains: 46630 (Robinhood Chain testnet), 421614 (Arbitrum Sepolia).");
    expect(chain).toContain("Usage: /vaults [chain] [version]");
    expect(await run("/vaults v9")).toMatch(/^No v9 deployment\. Versions: v2, v3\./);
    expect(await run("/vaults moon")).toMatch(/^"moon" is not a chain id/);
    expect(await run("/vaults 421614 v2")).toMatch(/^No Strike deployment matches that/);
  });

  it("keeps the other chains when one deployment cannot be read", async () => {
    const broken = targetV3({
      strike: {
        listVaults: vi.fn(async () => {
          throw new Error("connection refused");
        }),
      },
    });
    const text = await run("/vaults", [targetV2(), broken, targetSepolia()]);
    expect(text).toContain("Robinhood Chain testnet · v3: could not read (connection refused)");
    expect(text).toContain("sTSLA-CC, covered call on TSLA (0xADFF…1D4e)");
    expect(text).toContain("Arbitrum Sepolia · v3 · epoch 1");
  });

  it("splits a long list into Telegram-sized messages at vault boundaries", async () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      vaultState(
        { ...CSP_VAULT, symbol: `sTSLA-CSP-${i}` },
        { epoch: { state: "Open", openedAt: 0n, seriesId: 0n } },
      ),
    );
    const text = await run("/vaults 46630 v2", [targetV2({ vaults: many })]);
    expect(text.length).toBeGreaterThan(4096);
    const parts = splitMessage(text);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 4096)).toBe(true);
    // every piece starts at a vault (the first one at the chain heading)
    expect(parts.slice(1).every((p) => /^sTSLA-CSP-\d+, /.test(p))).toBe(true);
    expect(parts.join("\n\n")).toBe(text);
  });
});

describe("series states", () => {
  it("a Selling series before expiry is a live series", async () => {
    const text = await run("/vaults 46630 v2", [targetV2({ now: BEFORE_EXPIRY })]);
    expect(text).toContain("epoch 1: Selling. TVL 5 TSLA.");
    expect(text).toContain("Live series: call strike $369.86, expiry 2026-10-02 20:00 UTC, 4 of 4 sold");
    expect(text).not.toContain("Expired");
  });

  it("a Selling series past expiry reads Expired, using chain time and not the machine clock", async () => {
    // The chain says one second before expiry: still Selling, whatever this machine's clock reads.
    const justBefore = await run("/vaults 46630 v2", [targetV2({ now: EXPIRY - 1n })]);
    expect(justBefore).toContain("Live series: call strike $369.86");
    // At expiry exactly (the first price at or after it settles the series) it is Expired.
    const atExpiry = await run("/vaults 46630 v2", [targetV2({ now: EXPIRY })]);
    expect(atExpiry).toContain("epoch 1: Expired, settling.");
    expect(atExpiry).toContain(EXPIRED_LINE);
    expect(atExpiry).not.toContain("Live series");
    expect(atExpiry).not.toContain(": Selling");
    expect(expiredLine(EXPIRY)).toBe(EXPIRED_LINE);
  });

  it("a settled epoch shows the settlement price and payout on an idle vault", async () => {
    const lastSettlement = vi.fn(async () => ({
      epoch: 1n,
      isCall: true,
      strike: 369_360_000_000_000_000_000n,
      expiry: EXPIRY,
      settlementPrice: 372_100_000_000_000_000_000n,
      payout: 7_372_000_000_000_000n, // 0.007372 TSLA
    }));
    const idle = vaultState(V3_CC_VAULT, {
      epoch: { state: "Idle", openedAt: 0n, seriesId: 0n },
      lastProcessedEpoch: 1n,
    });
    const text = await run("/vaults 46630 v3", [targetV3({ vaults: [idle], lastSettlement })]);
    expect(text).toContain("Robinhood Chain testnet · v3 · epoch 1: Idle. TVL 5 TSLA.");
    expect(text).toContain("No live series.");
    expect(text).toContain(
      "Last settled: epoch 1, call strike $369.36, expiry 2026-10-02 20:00 UTC, at $372.10: in the money, payout 0.007372 TSLA.",
    );
    expect(lastSettlement).toHaveBeenCalledTimes(1);

    const idlePut = vaultState(V3_CSP_VAULT, {
      epoch: { state: "Idle", openedAt: 0n, seriesId: 0n },
      lastProcessedEpoch: 2n,
    });
    const worthless = await run("/vaults 46630 v3", [
      targetV3({
        vaults: [idlePut],
        lastSettlement: async () => ({
          epoch: 2n,
          isCall: false,
          strike: 340_000_000_000_000_000_000n,
          expiry: EXPIRY,
          settlementPrice: 360_000_000_000_000_000_000n,
          payout: 0n,
        }),
      }),
    ]);
    expect(worthless).toContain(
      "Last settled: epoch 2, put strike $340.00, expiry 2026-10-02 20:00 UTC, at $360.00: out of the money, payout 0.",
    );
  });

  it("a failing settlement lookup does not hide the vault", async () => {
    const idle = vaultState(V3_CSP_VAULT, { epoch: { state: "Idle", openedAt: 0n, seriesId: 0n } });
    const text = await run("/vaults 46630 v3", [
      targetV3({
        vaults: [idle],
        lastSettlement: async () => {
          throw new Error("range too large");
        },
      }),
    ]);
    expect(text).toContain("epoch 1: Idle. TVL 20 USDG.\nNo live series.");
  });

  it("an open vault waits for the agent's proposal, an idle one has no live series", async () => {
    const open = vaultState(CSP_VAULT, { epoch: { state: "Open", openedAt: 1n, seriesId: 0n } });
    const idle = vaultState(SEPOLIA_CC_VAULT, { epoch: { state: "Idle", openedAt: 0n, seriesId: 0n } });
    const text = await run("/vaults", [targetV2({ vaults: [open] }), targetSepolia({ vaults: [idle] })]);
    expect(text).toContain(
      "epoch 1: Open. TVL 20 USDG.\nNo live series yet: waiting for the agent's proposal.",
    );
    expect(text).toContain("epoch 1: Idle. TVL 5 TSLA.\nNo live series.");
  });

  it("a chain with no vaults yet says so", async () => {
    expect(await run("/vaults 421614", [targetSepolia({ vaults: [] })])).toBe(
      "Arbitrum Sepolia (421614)\n\nArbitrum Sepolia · v3: no vaults registered yet.",
    );
  });
});

/** The three deployments before expiry, each call series with all its options left (so each is buyable). */
function openForSale(): CommandTarget[] {
  const unsold = { sold: 0n };
  const now = BEFORE_EXPIRY;
  return [
    targetV2({ now, vaults: [selling(CC_VAULT, unsold), vaultState(CSP_VAULT)] }),
    targetV3({ now, vaults: [selling(V3_CC_VAULT, { ...unsold, strike: 369_360_000_000_000_000_000n })] }),
    targetSepolia({
      now,
      vaults: [selling(SEPOLIA_CC_VAULT, { ...unsold, strike: 364_290_000_000_000_000_000n })],
    }),
  ];
}

describe("/quote across deployments", () => {
  it("quotes every deployment that has the vault when the symbol is ambiguous", async () => {
    const targets = openForSale();
    const text = await run("/quote stsla-cc 2", targets);
    const quotes = text.split("\n\n");
    expect(quotes).toHaveLength(3);
    expect(quotes[0]).toContain("sTSLA-CC (Robinhood Chain testnet · v2): 2 TSLA calls, strike $369.86");
    expect(quotes[1]).toContain("sTSLA-CC (Robinhood Chain testnet · v3): 2 TSLA calls, strike $369.36");
    expect(quotes[2]).toContain("sTSLA-CC (Arbitrum Sepolia · v3): 2 TSLA calls, strike $364.29");
    expect(quotes.every((q) => q.includes("Premium 4.888872 USDG (2.444436 per option)"))).toBe(true);
    expect(quotes.every((q) => q.endsWith("Buyable now."))).toBe(true);
  });

  it("takes a chain and a version after the amount", async () => {
    const targets = openForSale();
    const v3 = await run("/quote sTSLA-CC 1 46630 v3", targets);
    expect(v3).toContain("sTSLA-CC (Robinhood Chain testnet · v3): 1 TSLA call,");
    expect(v3).not.toContain("Arbitrum");
    const sepolia = await run("/quote sTSLA-CC 1 421614", targets);
    expect(sepolia).toContain("(Arbitrum Sepolia · v3)");
    expect(sepolia).not.toContain("Robinhood");
  });

  it("finds a vault by address on its own deployment", async () => {
    const text = await run(`/quote ${SEPOLIA_CC_VAULT.address.toLowerCase()}`, openForSale());
    expect(text).toContain("sTSLA-CC (Arbitrum Sepolia · v3): 1 TSLA call,");
    expect(text).not.toContain("Robinhood");
  });

  it("does not quote an expired series: it says it is waiting for settlement", async () => {
    const t = targetV2();
    const text = await run("/quote sTSLA-CC", [t]);
    expect(text).toBe(
      [
        "sTSLA-CC (Robinhood Chain testnet · v2): call strike $369.86, expiry 2026-10-02 20:00 UTC",
        EXPIRED_LINE,
        "Not buyable now: the series is no longer on sale.",
      ].join("\n"),
    );
    expect(t.strike.quoteBuy).not.toHaveBeenCalled();
  });

  it("notes a sold-out series and closed sales before expiry", async () => {
    const t = targetV2({ now: EXPIRY - 1800n });
    const text = await run("/quote sTSLA-CC 2", [t]);
    expect(text).toContain(
      "Not buyable now: sales have closed for this series; the series is sold out (4 of 4 sold).",
    );
    expect(t.strike.quoteBuy).toHaveBeenCalledWith(CC_SERIES_STATE.id, 2n * WAD);
  });

  it("explains bad input", async () => {
    expect(await run("/quote")).toMatch(/^Usage: \/quote/);
    expect(await run("/quote sAAPL-CC")).toBe("No vault named sAAPL-CC. Vaults: sTSLA-CC, sTSLA-CSP.");
    const t = [targetV2({ now: BEFORE_EXPIRY })];
    expect(await run("/quote sTSLA-CC abc", t)).toMatch(/is not a number/);
    expect(await run("/quote sTSLA-CC 0", t)).toBe("The amount must be more than 0.");
    expect(await run("/quote sTSLA-CSP", t)).toBe(
      "sTSLA-CSP (Robinhood Chain testnet · v2) has no live series (epoch 1 is Open).",
    );
    expect(await run(`/quote ${DEPLOYER}`, t)).toMatch(/is not a registered Strike vault/);
    expect(await run("/quote sTSLA-CC 1 999", t)).toContain("No Strike deployment on chain 999.");
  });
});

describe("/agent across registries", () => {
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

  const withAgents = (byRegistry: Record<string, Partial<AgentStats> | undefined>) => {
    const reg = (t: CommandTarget) => byRegistry[t.registry];
    return [targetV2(), targetV3(), targetSepolia()].map((t) =>
      fakeTarget({
        chainId: t.chainId,
        chainName: t.chainName,
        shortName: t.shortName,
        version: t.version,
        registry: t.registry,
        vaults: [],
        strike: {
          agentStats: vi.fn(async () => ({ ...stats, ...(reg(t) ?? { status: "None" }) })),
        },
      }),
    );
  };
  const V2 = "0xE5b76249041e59C74Ee317fC2729f26249618D32";
  const V3 = "0x1c42740145B245b2f894d8e989ca29dfd9A9052f";
  const SEP = "0xAa3CA7847Af10d94CCD3eF09370Aab580A92341E";

  it("shows the agent on every registry where it exists", async () => {
    const targets = withAgents({
      [V2]: { bond: 50_000_000n },
      [V3]: { bond: 80_000_000n, strikes: 0 },
      [SEP]: undefined,
    });
    expect(await run("/agent 1", targets)).toBe(
      [
        "Agent 1 (Robinhood Chain testnet · v2): Active, can propose",
        "Bond 50 USDG (minimum 50 USDG), strikes 1 of 3",
        "Proposals: 1 accepted, 1 rejected",
        "Settled epochs: 0, cumulative depositor PnL 0 USDG",
        "Signer 0x26b2…13Ff",
        "",
        "Agent 1 (Robinhood Chain testnet · v3): Active, can propose",
        "Bond 80 USDG (minimum 50 USDG), strikes 0 of 3",
        "Proposals: 1 accepted, 1 rejected",
        "Settled epochs: 0, cumulative depositor PnL 0 USDG",
        "Signer 0x26b2…13Ff",
      ].join("\n"),
    );
  });

  it("takes a version or a chain", async () => {
    const targets = withAgents({ [V2]: {}, [V3]: {}, [SEP]: {} });
    const v3 = await run("/agent 1 v3", targets);
    expect(v3.match(/^Agent 1 \(/gm)).toHaveLength(2);
    expect(v3).not.toContain("· v2");
    const sepolia = await run("/agent 1 421614", targets);
    expect(sepolia.match(/^Agent 1 \(/gm)).toHaveLength(1);
    expect(sepolia).toContain("(Arbitrum Sepolia · v3)");
  });

  it("says where it looked when the agent is on no registry, and asks each registry once", async () => {
    const targets = withAgents({});
    const text = await run("/agent 9", targets);
    expect(text).toBe(
      "Agent 9 is not registered. Checked: Robinhood Chain testnet · v2; Robinhood Chain testnet · v3; Arbitrum Sepolia · v3.",
    );
    expect(await run("/agent 9 v2", targets)).toBe(
      "Agent 9 is not registered on Robinhood Chain testnet · v2.",
    );
    const twin = [targetV2(), { ...targetV2(), version: "v2b", label: "twin" }];
    await run("/agent 1", twin);
    expect(twin[0]!.strike.agentStats).toHaveBeenCalledTimes(1);
    expect(twin[1]!.strike.agentStats).not.toHaveBeenCalled();
    expect(await run("/agent x")).toMatch(/^Usage: \/agent <id> \[chain\] \[version\]/);
  });

  it("still shows the registries it could read when one fails", async () => {
    const targets = withAgents({ [V2]: {}, [V3]: {}, [SEP]: {} });
    targets[2] = targetSepolia({
      strike: {
        agentStats: vi.fn(async () => {
          throw new Error("timeout");
        }),
      },
    });
    const text = await run("/agent 1", targets);
    expect(text).toContain("Agent 1 (Robinhood Chain testnet · v2)");
    expect(text).toContain("Arbitrum Sepolia · v3: could not read (timeout)");
  });
});

describe("/status across chains", () => {
  it("shows each chain's head, session and feeds, with each deployment's alert cursor", async () => {
    const subs = memorySubs();
    subs.ids.push(1, 2);
    expect(await run("/status", all(), subs)).toBe(
      [
        "Robinhood Chain testnet (46630): head block 126332630, 2026-10-03 08:46 UTC",
        "NYSE session: open",
        "v2 TSLA feed: Ok, $352.453, updated 2026-09-29 16:40 UTC",
        "v2 Alerts: scanned to block 126332564",
        "v3 TSLA feed: Ok, $352.453, updated 2026-09-29 16:40 UTC",
        "v3 Alerts: scanned to block none yet",
        "",
        "Arbitrum Sepolia (421614): head block 126332630, 2026-10-03 08:46 UTC",
        "NYSE session: open",
        "TSLA feed: Ok, $352.453, updated 2026-09-29 16:40 UTC",
        "Alerts: scanned to block 314999999",
        "",
        "2 subscribed chat(s) get alerts from every deployment.",
      ].join("\n"),
    );
  });

  it("shows a stale feed and takes a chain", async () => {
    const stale = targetV2({
      strike: {
        oracleStatus: vi.fn(async () => ({
          status: "StalePrice",
          ok: false,
          price: 1n * WAD,
          updatedAt: 0n,
        })),
      },
    });
    const text = await run("/status 46630", [stale, targetSepolia()]);
    expect(text).toContain("TSLA feed: StalePrice, $1.00 (");
    expect(text).not.toContain("Arbitrum");
  });

  it("an RPC failure on one chain leaves the others", async () => {
    const down = targetSepolia({
      strike: {
        marketOpen: vi.fn(async () => {
          throw new Error("503");
        }),
      },
    });
    const text = await run("/status", [targetV2(), down]);
    expect(text).toContain("Arbitrum Sepolia (421614): could not read (503)");
    expect(text).toContain("Robinhood Chain testnet (46630): head block");
  });
});

describe("failures", () => {
  it("an RPC failure on every deployment becomes a plain reply, and unknown commands point to /help", async () => {
    const broken = fakeTarget({
      chainId: 46630,
      chainName: "Robinhood Chain testnet",
      shortName: "RH testnet",
      version: "v2",
      registry: "0xE5b76249041e59C74Ee317fC2729f26249618D32",
      vaults: [],
      strike: {
        agentStats: vi.fn(async () => {
          throw new Error("connection refused");
        }),
      },
    });
    expect(await run("/agent 1", [broken])).toBe(
      "Could not read that from the chain: Robinhood Chain testnet · v2: could not read (connection refused)",
    );
    expect(await run("/moon")).toBe("Unknown command /moon. Send /help for the list.");
    expect(await run("/vaults", [])).toBe("No Strike deployment is configured.");
  });
});
