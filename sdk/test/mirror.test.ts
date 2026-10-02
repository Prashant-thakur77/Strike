import {
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  getAddress,
  keccak256,
  multicall3Abi,
  toHex,
} from "viem";
import { describe, expect, it } from "vitest";
import {
  MULTICALL3,
  aggregatorProxyAbi,
  auditMirror,
  auditSettlement,
  classifyMirrorRounds,
  deploymentsFor,
  epochManagerAbi,
  fmtAnswer,
  largestPushGap,
  mirrorFeedAbi,
  mirrorFeedTargets,
  stockOracleAbi,
  strikeVaultAbi,
} from "../src/index.js";
import { type FakeContract, FakeRevert, type FakeLog, eventLog, fakeChain } from "./fake-chain.js";

// The price mirror audit against two fake chains: a testnet with a MirrorFeed (and Multicall3), and Robinhood Chain
// mainnet with a Chainlink aggregator proxy whose round ids are phase << 64 | aggregator round.

const addr = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const TFEED = addr(0xf00d);
const MFEED = addr(0xc11c);
const PHASE1 = 1n << 64n;
const PHASE2 = 2n << 64n;
const T0 = 1_790_700_000n;
const MIN = 60n;

interface Round {
  id: bigint;
  answer: bigint;
  at: bigint;
}

/** Multicall3's aggregate3, answered from the other fake contracts: each call decoded with its target's ABI. */
function withMulticall(contracts: Record<Address, FakeContract>): Record<Address, FakeContract> {
  const byAddress = new Map(Object.entries(contracts).map(([a, c]) => [a.toLowerCase(), c]));
  const aggregate3 = async (args: readonly unknown[]) => {
    const calls = args[0] as { target: Address; callData: Hex }[];
    const out: { success: boolean; returnData: Hex }[] = [];
    for (const c of calls) {
      const contract = byAddress.get(c.target.toLowerCase());
      try {
        if (!contract) throw new Error("no contract");
        const { functionName, args: a } = decodeFunctionData({ abi: contract.abi, data: c.callData });
        const fn = contract.fns[functionName];
        const result = typeof fn === "function" ? await fn(a ?? []) : fn;
        out.push({
          success: true,
          returnData: encodeFunctionResult({ abi: contract.abi, functionName, result } as never),
        });
      } catch {
        out.push({ success: false, returnData: "0x" });
      }
    }
    return out;
  };
  return { ...contracts, [MULTICALL3]: { abi: multicall3Abi as Abi, fns: { aggregate3 } } };
}

/** A testnet MirrorFeed holding `rounds` (ids 1..n), with an AnswerUpdated log per push. */
function testnetFeed(rounds: Round[], feed: Address = TFEED) {
  const get = (id: bigint) => {
    const r = rounds.find((x) => x.id === id);
    if (!r) throw new FakeRevert("NoDataPresent");
    return [r.id, r.answer, r.at, r.at, r.id] as const;
  };
  const contract: FakeContract = {
    abi: mirrorFeedAbi as Abi,
    fns: {
      latestRound: () => rounds[rounds.length - 1]?.id ?? 0n,
      decimals: 8,
      getRoundData: (args: readonly unknown[]) => get(args[0] as bigint),
      latestRoundData: () => get(rounds[rounds.length - 1]!.id),
    },
  };
  const logs = rounds.map((r, i) => ({
    ...eventLog(
      mirrorFeedAbi as Abi,
      "AnswerUpdated",
      { current: r.answer, roundId: r.id, updatedAt: r.at },
      feed,
    ),
    blockNumber: 1000n + BigInt(i),
    transactionHash: keccak256(toHex(`push-${feed}-${r.id}`)),
  }));
  return { contract, logs };
}

/** A mainnet Chainlink proxy: getRoundData answers zeros for a round it never produced, as Chainlink's do. */
function mainnetProxy(rounds: Round[]): FakeContract {
  const sorted = [...rounds].sort((a, b) => (a.id < b.id ? -1 : 1));
  const get = (id: bigint) => {
    const r = sorted.find((x) => x.id === id);
    return r ? ([r.id, r.answer, r.at - 13n, r.at, r.id] as const) : ([id, 0n, 0n, 0n, id] as const);
  };
  return {
    abi: aggregatorProxyAbi as Abi,
    fns: {
      latestRoundData: () => get(sorted[sorted.length - 1]!.id),
      getRoundData: (args: readonly unknown[]) => get(args[0] as bigint),
      decimals: 8,
      description: "RHTSLA / USD",
    },
  };
}

/** Mainnet rounds 1..n of phase 1, one every 24 minutes from T0, answers 350.00 + i cents. */
function mainnetHistory(n: number, phase = PHASE1, start = T0): Round[] {
  return Array.from({ length: n }, (_, i) => ({
    id: phase + BigInt(i + 1),
    answer: 35_000_000_000n + BigInt(i) * 1_000_000n,
    at: start + BigInt(i) * 24n * MIN,
  }));
}

/** Testnet rounds copying the given mainnet rounds (ids 1..n), as the keeper does. */
const mirrorOf = (mainnet: Round[]): Round[] =>
  mainnet.map((m, i) => ({ id: BigInt(i + 1), answer: m.answer, at: m.at }));

function chains(
  testnet: Round[],
  mainnet: Round[],
  opts: { mainnetNow?: bigint; testnetNow?: bigint; multicall?: boolean } = {},
) {
  const t = testnetFeed(testnet);
  const tContracts = { [TFEED]: t.contract };
  const mContracts = { [MFEED]: mainnetProxy(mainnet) };
  const last = mainnet.reduce((a, r) => (r.at > a ? r.at : a), 0n);
  const testnetChain = fakeChain(opts.multicall === false ? tContracts : withMulticall(tContracts), {
    timestamp: opts.testnetNow ?? last + 600n,
    logs: t.logs,
  });
  const mainnetChain = fakeChain(opts.multicall === false ? mContracts : withMulticall(mContracts), {
    timestamp: opts.mainnetNow ?? last + 600n,
  });
  return { testnetClient: testnetChain.client, mainnetClient: mainnetChain.client, logs: t.logs };
}

const FEEDS = [{ symbol: "TSLA", testnetFeed: TFEED, mainnetFeed: MFEED }];
const fast = { attempts: 1, backoffMs: 0 };

describe("auditMirror", () => {
  it("passes when every testnet round copies a mainnet round", async () => {
    const mainnet = mainnetHistory(40);
    const copied = mainnet.filter((_, i) => i % 3 === 0); // the keeper ran every third print
    const c = chains(mirrorOf(copied), mainnet);
    const audit = await auditMirror({ chainId: 46630, feeds: FEEDS, ...c, ...fast });
    expect(audit.ok).toBe(true);
    expect(audit.summary).toMatchObject({ rounds: copied.length, matched: copied.length, mismatched: 0 });
    const f = audit.feeds[0]!;
    expect(f.rounds.every((r) => r.status === "match")).toBe(true);
    // Proxy round ids decode to phase 1 and the aggregator round.
    expect(f.rounds[1]!.mainnet).toMatchObject({ roundId: PHASE1 + 4n, phase: 1, aggregatorRound: 4n });
    // Each push's transaction, from the AnswerUpdated logs.
    expect(f.rounds[0]!.pushTx).toBe(c.logs[0]!.transactionHash);
    expect(f.rounds[0]!.pushBlock).toBe(1000n);
    // Coverage: the keeper mirrored 14 of the 40 mainnet prints from its first push to its last.
    expect(f.mainnetRoundsInWindow).toBe(40);
    expect(f.mainnetRoundsAfterLastPush).toBe(0);
    expect(f.largestGap).toMatchObject({ seconds: 3n * 24n * MIN, mainnetRoundsBetween: 2 });
  });

  it("detects a tampered round: the answer off by one unit", async () => {
    const mainnet = mainnetHistory(10);
    const testnet = mirrorOf(mainnet);
    testnet[6] = { ...testnet[6]!, answer: testnet[6]!.answer + 1n };
    const audit = await auditMirror({ chainId: 46630, feeds: FEEDS, ...chains(testnet, mainnet), ...fast });
    expect(audit.ok).toBe(false);
    expect(audit.summary).toMatchObject({ rounds: 10, matched: 9, mismatched: 1 });
    expect(audit.summary.counts["answer-differs"]).toBe(1);
    const bad = audit.feeds[0]!.rounds.find((r) => r.status !== "match")!;
    expect(bad).toMatchObject({ roundId: 7n, status: "answer-differs" });
    expect(bad.mainnet).toMatchObject({ roundId: PHASE1 + 7n, answer: mainnet[6]!.answer });
    expect(bad.answer - bad.mainnet!.answer).toBe(1n);
  });

  it("detects a fabricated timestamp: a real mainnet answer at a time mainnet never printed", async () => {
    const mainnet = mainnetHistory(10);
    const testnet = mirrorOf(mainnet);
    testnet[4] = { ...testnet[4]!, at: testnet[4]!.at + 1n }; // same answer, one second later
    const audit = await auditMirror({ chainId: 46630, feeds: FEEDS, ...chains(testnet, mainnet), ...fast });
    expect(audit.ok).toBe(false);
    const bad = audit.feeds[0]!.rounds[4]!;
    expect(bad.status).toBe("no-mainnet-round");
    expect(bad.mainnet).toBeNull();
    expect(bad.nearest?.before?.roundId).toBe(PHASE1 + 5n);
    expect(bad.nearest?.after?.roundId).toBe(PHASE1 + 6n);
  });

  it("detects a round mainnet does not have", async () => {
    const mainnet = mainnetHistory(12);
    const testnet = mirrorOf(mainnet);
    // Mainnet's history without its round 8: the testnet round copying it has no counterpart.
    const withoutEight = mainnet.filter((r) => r.id !== PHASE1 + 8n).map((r) => r);
    // Keep round ids contiguous on mainnet (Chainlink's are): renumber the rounds after the gap.
    const renumbered = withoutEight.map((r, i) => ({ ...r, id: PHASE1 + BigInt(i + 1) }));
    const audit = await auditMirror({
      chainId: 46630,
      feeds: FEEDS,
      ...chains(testnet, renumbered),
      ...fast,
    });
    expect(audit.summary).toMatchObject({ rounds: 12, matched: 11, mismatched: 1 });
    expect(audit.feeds[0]!.rounds[7]).toMatchObject({
      roundId: 8n,
      status: "no-mainnet-round",
      mainnet: null,
    });
  });

  it("flags a timestamp later than mainnet's head", async () => {
    const mainnet = mainnetHistory(5);
    const testnet = mirrorOf(mainnet);
    const head = mainnet[4]!.at + 60n;
    testnet.push({ id: 6n, answer: 36_000_000_000n, at: head + 3600n });
    const audit = await auditMirror({
      chainId: 46630,
      feeds: FEEDS,
      ...chains(testnet, mainnet, { mainnetNow: head, testnetNow: head + 7200n }),
      ...fast,
    });
    expect(audit.ok).toBe(false);
    expect(audit.summary.counts["future-timestamp"]).toBe(1);
    expect(audit.feeds[0]!.rounds[5]!.status).toBe("future-timestamp");
  });

  it("finds rounds across a Chainlink phase change (proxy round id encoding)", async () => {
    const phase1 = mainnetHistory(6);
    const phase2 = mainnetHistory(4, PHASE2, phase1[5]!.at + 24n * MIN);
    const mainnet = [...phase1, ...phase2];
    const copied = [phase1[1]!, phase1[5]!, phase2[0]!, phase2[3]!];
    const audit = await auditMirror({
      chainId: 46630,
      feeds: FEEDS,
      ...chains(mirrorOf(copied), mainnet),
      ...fast,
    });
    expect(audit.ok).toBe(true);
    const ids = audit.feeds[0]!.rounds.map((r) => r.mainnet!.roundId);
    expect(ids).toEqual([PHASE1 + 2n, PHASE1 + 6n, PHASE2 + 1n, PHASE2 + 4n]);
    expect(audit.feeds[0]!.rounds[2]!.mainnet).toMatchObject({ phase: 2, aggregatorRound: 1n });
  });

  it("lists the deploy-time seed apart from the keeper's rounds", async () => {
    const mainnet = mainnetHistory(8);
    const testnet = [
      { id: 1n, answer: 369_00000000n, at: T0 - 3600n }, // Deploy.s.sol's TSLA seed on 46630
      ...mirrorOf(mainnet.slice(2)).map((r) => ({ ...r, id: r.id + 1n })),
    ];
    const audit = await auditMirror({ chainId: 46630, feeds: FEEDS, ...chains(testnet, mainnet), ...fast });
    expect(audit.ok).toBe(true);
    expect(audit.summary).toMatchObject({ rounds: 6, matched: 6 });
    expect(audit.summary.seeds).toEqual([
      { symbol: "TSLA", roundId: 1n, answer: 369_00000000n, updatedAt: T0 - 3600n },
    ]);
    expect(audit.feeds[0]!.rounds[0]!.status).toBe("deploy-seed");
    // The window and the gaps start at the keeper's first push, not at the seed.
    expect(audit.feeds[0]!.largestGap?.fromRound).toBe(2n);

    // Any other value in round 1 is a round mainnet never printed.
    testnet[0] = { ...testnet[0]!, answer: 368_00000000n };
    const tampered = await auditMirror({
      chainId: 46630,
      feeds: FEEDS,
      ...chains(testnet, mainnet),
      ...fast,
    });
    expect(tampered.ok).toBe(false);
    expect(tampered.feeds[0]!.rounds[0]!.status).toBe("no-mainnet-round");
  });

  it("selects rounds by range, by time and by count", async () => {
    const mainnet = mainnetHistory(20);
    const c = chains(mirrorOf(mainnet), mainnet);
    const range = await auditMirror({
      chainId: 46630,
      feeds: FEEDS,
      ...c,
      ...fast,
      fromRound: 5,
      toRound: 7,
    });
    expect(range.feeds[0]!.rounds.map((r) => r.roundId)).toEqual([5n, 6n, 7n]);
    const last = await auditMirror({ chainId: 46630, feeds: FEEDS, ...c, ...fast, lastRounds: 2 });
    expect(last.feeds[0]!.rounds.map((r) => r.roundId)).toEqual([19n, 20n]);
    const since = await auditMirror({ chainId: 46630, feeds: FEEDS, ...c, ...fast, since: mainnet[17]!.at });
    expect(since.feeds[0]!.rounds.map((r) => r.roundId)).toEqual([18n, 19n, 20n]);
    expect(since.ok).toBe(true);
  });

  it("reports a feed without a mainnet counterpart as unverifiable, not as a match", async () => {
    const mainnet = mainnetHistory(4);
    const c = chains(mirrorOf(mainnet), mainnet);
    const audit = await auditMirror({
      chainId: 46630,
      feeds: [{ symbol: "NFLX", testnetFeed: TFEED, mainnetFeed: null }],
      ...c,
      ...fast,
    });
    expect(audit.summary.rounds).toBe(0);
    expect(audit.summary.unverifiable).toEqual([
      { symbol: "NFLX", rounds: 4, reason: "Chainlink publishes no NFLX feed on Robinhood Chain mainnet" },
    ]);
    expect(audit.feeds[0]!.rounds.every((r) => r.status === "unchecked")).toBe(true);
  });

  it("reads one round at a time where there is no Multicall3", async () => {
    const mainnet = mainnetHistory(9);
    const testnet = mirrorOf(mainnet);
    testnet[2] = { ...testnet[2]!, answer: 1n };
    const audit = await auditMirror({
      chainId: 46630,
      feeds: FEEDS,
      ...chains(testnet, mainnet, { multicall: false }),
      ...fast,
    });
    expect(audit.summary).toMatchObject({ rounds: 9, matched: 8 });
    expect(audit.feeds[0]!.rounds[2]!.status).toBe("answer-differs");
  });

  it("retries through rate limits", async () => {
    const mainnet = mainnetHistory(6);
    const c = chains(mirrorOf(mainnet), mainnet);
    let failures = 0;
    // Every third mainnet request fails once with a 429, as a rate-limited public RPC does.
    let n = 0;
    const flaky: PublicClient = createPublicClient({
      transport: custom(
        {
          async request(args: { method: string; params?: unknown }) {
            if (++n % 3 === 0) {
              failures++;
              throw Object.assign(new Error("HTTP 429 Too Many Requests"), { status: 429 });
            }
            return c.mainnetClient.request(args as never);
          },
          // viem's own retries off: the audit's backoff is what is tested.
        },
        { retryCount: 0 },
      ),
    });
    const audit = await auditMirror({
      chainId: 46630,
      feeds: FEEDS,
      testnetClient: c.testnetClient,
      mainnetClient: flaky,
      attempts: 4,
      backoffMs: 1,
    });
    expect(failures).toBeGreaterThan(0);
    expect(audit.ok).toBe(true);
    expect(audit.summary.matched).toBe(6);
  });

  it("checks that each deployment's StockOracle reads the audited feeds", async () => {
    const d = deploymentsFor(421614)[0]!;
    const mainnet = mainnetHistory(6);
    const tsla = testnetFeed(mirrorOf(mainnet), d.stocks.TSLA!.feed);
    const nvda = testnetFeed(mirrorOf(mainnet), d.stocks.NVDA!.feed);
    const reads: Record<string, Address> = {
      [d.stocks.TSLA!.token.toLowerCase()]: d.stocks.TSLA!.feed,
      [d.stocks.NVDA!.token.toLowerCase()]: d.stocks.NVDA!.feed,
    };
    const oracle: FakeContract = {
      abi: stockOracleAbi as Abi,
      fns: {
        feedConfig: (args: readonly unknown[]) => ({
          feed: reads[(args[0] as string).toLowerCase()] ?? addr(0),
          maxPriceAge: 90_000,
          corporateActionGrace: 86_400,
          feedDecimals: 8,
        }),
      },
    };
    const run = () => {
      const testnet = fakeChain(
        withMulticall({
          [d.stocks.TSLA!.feed]: tsla.contract,
          [d.stocks.NVDA!.feed]: nvda.contract,
          [d.stockOracle]: oracle,
        }),
        { timestamp: mainnet[5]!.at + 600n, logs: [...tsla.logs, ...nvda.logs] },
      );
      const proxies = withMulticall({
        "0x4A1166a659A55625345e9515b32adECea5547C38": mainnetProxy(mainnet),
        "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15": mainnetProxy(mainnet),
      });
      const m = fakeChain(proxies, { timestamp: mainnet[5]!.at + 600n });
      return auditMirror({
        chainId: 421614,
        testnetClient: testnet.client,
        mainnetClient: m.client,
        ...fast,
      });
    };
    const good = await run();
    expect(good.ok).toBe(true);
    expect(good.summary.matched).toBe(12);
    expect(good.oracleFeeds.map((o) => [o.symbol, o.same])).toEqual([
      ["NVDA", true],
      ["TSLA", true],
    ]);

    // The admin points TSLA at another contract: every round still matches, but the audit no longer passes.
    reads[d.stocks.TSLA!.token.toLowerCase()] = addr(0xbad);
    const swapped = await run();
    expect(swapped.summary.matched).toBe(12);
    expect(swapped.ok).toBe(false);
    expect(swapped.oracleFeeds.find((o) => o.symbol === "TSLA")).toMatchObject({
      same: false,
      feed: addr(0xbad),
    });
  });

  it("covers every MirrorFeed of the chain's deployments once", () => {
    const targets = mirrorFeedTargets(46630);
    const feeds = new Set(deploymentsFor(46630).flatMap((d) => Object.values(d.stocks).map((s) => s.feed)));
    expect(targets.length).toBe(feeds.size);
    expect(targets.find((t) => t.symbol === "TSLA")?.mainnetFeed).toBe(
      "0x4A1166a659A55625345e9515b32adECea5547C38",
    );
    expect(targets.find((t) => t.symbol === "NFLX")?.mainnetFeed).toBeNull();
    expect(mirrorFeedTargets(421614, "nvda").map((t) => t.symbol)).toEqual(["NVDA"]);
  });
});

describe("classifyMirrorRounds and largestPushGap", () => {
  const m = (agg: bigint, answer: bigint, at: bigint) => ({
    roundId: PHASE1 + agg,
    phase: 1,
    aggregatorRound: agg,
    answer,
    updatedAt: at,
  });
  it("classifies each case", () => {
    const mainnet = [m(1n, 100n, 10n), m(2n, 101n, 20n), m(3n, 102n, 30n)];
    const out = classifyMirrorRounds(
      [
        { roundId: 1n, answer: 100n, updatedAt: 10n },
        { roundId: 2n, answer: 999n, updatedAt: 20n },
        { roundId: 3n, answer: 102n, updatedAt: 25n },
        { roundId: 4n, answer: 103n, updatedAt: 50n },
      ],
      mainnet,
      40n,
    );
    expect(out.map((x) => x.status)).toEqual([
      "match",
      "answer-differs",
      "no-mainnet-round",
      "future-timestamp",
    ]);
    expect(out[2]!.nearest).toEqual({ before: mainnet[1], after: mainnet[2] });
  });
  it("finds the longest gap and the mainnet prints inside it", () => {
    const gap = largestPushGap(
      [
        { roundId: 1n, updatedAt: 10n },
        { roundId: 2n, updatedAt: 20n },
        { roundId: 3n, updatedAt: 60n },
      ],
      [{ updatedAt: 30n }, { updatedAt: 40n }, { updatedAt: 60n }],
    );
    expect(gap).toEqual({
      fromRound: 2n,
      toRound: 3n,
      from: 20n,
      to: 60n,
      seconds: 40n,
      mainnetRoundsBetween: 2,
    });
    expect(largestPushGap([{ roundId: 1n, updatedAt: 1n }], [])).toBeNull();
  });
  it("formats answers with the feed's decimals", () => {
    expect(fmtAnswer(35_668_000_000n, 8)).toBe("356.68");
    expect(fmtAnswer(36_900_000_000n, 8)).toBe("369");
    expect(fmtAnswer(35_766_999_999n, 8)).toBe("357.66999999");
  });
});

// ------------------------------------------------------------------ settlement rounds

/** v2 on Robinhood Chain testnet: the audit finds the deployment from the vault's manager(). */
const V2 = deploymentsFor(46630)[0]!;
const VAULT = addr(0x7a017);
const TOKEN = V2.stocks.TSLA!.token;
const EXPIRY = 1_790_971_200n; // Fri 2026-10-02 20:00 UTC
const SERIES = 8614n;
const WAD_PER_8 = 10n ** 10n;
const MAINNET_TSLA = getAddress("0x4A1166a659A55625345e9515b32adECea5547C38");

function settlementChains(opts: {
  testnet: Round[];
  mainnet: Round[];
  now: bigint;
  settled?: { round: bigint; price: bigint };
  sold?: bigint;
}) {
  const t = testnetFeed(opts.testnet, V2.stocks.TSLA!.feed);
  const series = {
    vault: VAULT,
    underlying: TOKEN,
    agentId: 1n,
    expiry: EXPIRY,
    premiumBps: 300,
    isCall: true,
    settled: opts.settled !== undefined,
    cancelled: false,
    strike: 369_860_000_000_000_000_000n,
    size: 4n * 10n ** 18n,
    sold: opts.sold ?? 4n * 10n ** 18n,
    premium: 10_005_944n,
    collateral: 4n * 10n ** 18n,
    settlementPrice: opts.settled?.price ?? 0n,
    payoutPerOption: 0n,
    escrow: 0n,
  };
  const contracts: Record<Address, FakeContract> = {
    [V2.stocks.TSLA!.feed]: t.contract,
    [VAULT]: { abi: strikeVaultAbi as Abi, fns: { manager: V2.epochManager } },
    [V2.epochManager]: {
      abi: epochManagerAbi as Abi,
      fns: {
        epochs: [opts.settled ? 0 : 2, EXPIRY - 4n * 86_400n, opts.settled ? 0n : SERIES, 0n, 0n],
        getSeries: () => series,
      },
    },
    [V2.stockOracle]: {
      abi: stockOracleAbi as Abi,
      fns: {
        feedConfig: () => ({
          feed: V2.stocks.TSLA!.feed,
          maxPriceAge: 90_000,
          corporateActionGrace: 86_400,
          feedDecimals: 8,
        }),
      },
    },
    // The test token has no effectiveAt: a plain ERC-20, no corporate actions.
    [TOKEN]: { abi: [] as Abi, fns: {} },
  };
  const logs: (FakeLog & { blockNumber: bigint; transactionHash?: Hex })[] = [
    ...t.logs,
    {
      ...eventLog(
        epochManagerAbi as Abi,
        "SeriesProposed",
        {
          vault: VAULT,
          epoch: 1n,
          seriesId: SERIES,
          strike: series.strike,
          expiry: EXPIRY,
          size: series.size,
          premiumBps: 300,
          fairValue: 0n,
          delta: 0n,
        },
        V2.epochManager,
      ),
      blockNumber: 900n,
    },
  ];
  if (opts.settled) {
    logs.push({
      ...eventLog(
        stockOracleAbi as Abi,
        "SettlementPriceRecorded",
        { token: TOKEN, expiry: EXPIRY, roundId: opts.settled.round, price: opts.settled.price },
        V2.stockOracle,
      ),
      blockNumber: 2000n,
      transactionHash: keccak256(toHex("settle-tx")),
    });
  }
  const testnetChain = fakeChain(withMulticall(contracts), { timestamp: opts.now, logs });
  const mainnetChain = fakeChain(withMulticall({ [MAINNET_TSLA]: mainnetProxy(opts.mainnet) }), {
    timestamp: opts.now,
  });
  return { testnetClient: testnetChain.client, mainnetClient: mainnetChain.client };
}
/** Mainnet prints every 24 minutes around expiry: 18:48, 19:12, 19:36, 20:00:13, 20:24:13, ... */
const aroundExpiry = mainnetHistory(10, PHASE1, EXPIRY - 72n * MIN + 13n);

describe("auditSettlement", () => {
  it("before expiry: not settled yet, candidate round not yet printed", async () => {
    const pre = aroundExpiry.slice(0, 3);
    const c = settlementChains({ testnet: mirrorOf(pre), mainnet: pre, now: EXPIRY - 7n * 3600n });
    const a = await auditSettlement({ chainId: 46630, vault: VAULT, ...c, ...fast });
    expect(a.ok).toBe(true);
    expect(a.series).toHaveLength(1);
    expect(a.series[0]).toMatchObject({ seriesId: SERIES, epoch: 1n, symbol: "TSLA", status: "not-printed" });
    expect(a.series[0]!.message).toMatch(
      /^Not settled yet; candidate round not yet printed \(expires 2026-10-02 20:00 UTC, in 7h 0m\)/,
    );
  });

  it("after expiry, before the keeper mirrored a post-expiry print: says what mainnet printed", async () => {
    const c = settlementChains({
      testnet: mirrorOf(aroundExpiry.slice(0, 3)),
      mainnet: aroundExpiry.slice(0, 5),
      now: EXPIRY + 3600n,
    });
    const a = await auditSettlement({ chainId: 46630, vault: VAULT, ...c, ...fast });
    expect(a.series[0]!.status).toBe("not-printed");
    expect(a.series[0]!.firstMainnetAtOrAfterExpiry?.roundId).toBe(PHASE1 + 4n);
    expect(a.series[0]!.message).toMatch(
      /candidate round not yet printed .*Mainnet printed 350\.03 at 2026-10-02 20:00 UTC; the keeper has not mirrored it yet/,
    );
  });

  it("expired, not settled: checks the candidate round (the first at or after expiry)", async () => {
    const c = settlementChains({
      testnet: mirrorOf(aroundExpiry.slice(0, 6)),
      mainnet: aroundExpiry,
      now: EXPIRY + 7200n,
    });
    const a = await auditSettlement({ chainId: 46630, vault: VAULT, ...c, ...fast });
    const s = a.series[0]!;
    expect(s).toMatchObject({
      status: "candidate-verified",
      roundSource: "candidate",
      sameAsMainnetSettlement: true,
    });
    expect(s.round).toMatchObject({ roundId: 4n, status: "match" });
    expect(s.round!.mainnet!.roundId).toBe(PHASE1 + 4n);
  });

  it("settled: verifies the recorded round and price, and that it is mainnet's first print after expiry", async () => {
    const testnet = mirrorOf(aroundExpiry.slice(0, 6));
    const price = testnet[3]!.answer * WAD_PER_8;
    const c = settlementChains({
      testnet,
      mainnet: aroundExpiry,
      now: EXPIRY + 7200n,
      settled: { round: 4n, price },
    });
    const a = await auditSettlement({ chainId: 46630, vault: VAULT, ...c, ...fast });
    const s = a.series[0]!;
    expect(a.ok).toBe(true);
    expect(s).toMatchObject({
      status: "verified",
      roundSource: "recorded",
      priceMatchesRound: true,
      sameAsMainnetSettlement: true,
      skippedMainnetRounds: 0,
      recordTx: keccak256(toHex("settle-tx")),
    });
    expect(s.message).toMatch(
      /^Settled at round 4 \(350\.03 at 2026-10-02 20:00 UTC\): equals mainnet Chainlink round/,
    );
  });

  it("settled at a tampered round: mismatch", async () => {
    const testnet = mirrorOf(aroundExpiry.slice(0, 6));
    testnet[3] = { ...testnet[3]!, answer: testnet[3]!.answer + 5_00000000n };
    const price = testnet[3]!.answer * WAD_PER_8;
    const c = settlementChains({
      testnet,
      mainnet: aroundExpiry,
      now: EXPIRY + 7200n,
      settled: { round: 4n, price },
    });
    const a = await auditSettlement({ chainId: 46630, vault: VAULT, ...c, ...fast });
    expect(a.ok).toBe(false);
    expect(a.series[0]!.status).toBe("mismatch");
    expect(a.series[0]!.message).toMatch(/MISMATCH, mainnet round .* printed 350\.03/);
  });

  it("says when the keeper skipped the first mainnet print after expiry", async () => {
    // The keeper missed 20:00:13 and pushed 20:24:13 first: genuine, but not what mainnet settlement would use.
    const copied = [...aroundExpiry.slice(0, 3), aroundExpiry[4]!, aroundExpiry[5]!];
    const testnet = mirrorOf(copied);
    const price = testnet[3]!.answer * WAD_PER_8;
    const c = settlementChains({
      testnet,
      mainnet: aroundExpiry,
      now: EXPIRY + 7200n,
      settled: { round: 4n, price },
    });
    const a = await auditSettlement({ chainId: 46630, vault: VAULT, ...c, ...fast });
    const s = a.series[0]!;
    expect(s.status).toBe("verified");
    expect(s.sameAsMainnetSettlement).toBe(false);
    expect(s.skippedMainnetRounds).toBe(1);
    expect(s.message).toMatch(/Not the first mainnet print after expiry: mainnet printed 1 earlier round/);
  });

  it("a series with no options sold settles without a price", async () => {
    const c = settlementChains({
      testnet: mirrorOf(aroundExpiry.slice(0, 6)),
      mainnet: aroundExpiry,
      now: EXPIRY + 7200n,
      settled: { round: 0n, price: 0n },
      sold: 0n,
    });
    const a = await auditSettlement({ chainId: 46630, vault: VAULT, ...c, ...fast });
    expect(a.series[0]!.status).toBe("no-price");
  });
});
