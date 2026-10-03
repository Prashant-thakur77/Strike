import { type Address, type Hex, getAddress } from "viem";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHOCKS,
  PRICER_INPUT_ERRORS,
  explainSeriesRisk,
  type StrikeAddresses,
  StrikeError,
  WAD,
  blackScholes,
  createStrikeClient,
  epochManagerAbi,
  mirrorFeedAbi,
  riskEngineAbi,
  riskEngineError,
  riskLensAbi,
  settlementPayout,
  shockedSpot,
  stockOracleAbi,
  strikeVaultAbi,
  vaultExposure,
  wadToNumber,
} from "../src/index.js";
import { type FakeContract, FakeRevert, eventLog, fakePublicClient } from "./fake-chain.js";

const addr = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const A: StrikeAddresses = {
  epochManager: addr(0xe1),
  agentRegistry: addr(0xa1),
  stockOracle: addr(0x0c),
  marketCalendar: addr(0xca),
  usdg: addr(0xd6),
  optionToken: addr(0x07),
  feeManager: addr(0xfe),
  vaultFactory: addr(0xfa),
};
const ENGINE = addr(0x5e);
const LENS = addr(0x1e);
/** The EpochManager's pricer, which RiskLens calls (a different address from ENGINE, to tell the paths apart). */
const PRICER = addr(0x9e);
const FEED = addr(0xf0);
const VAULT = getAddress("0xADFF7900dbe01E8170a750AB88e1f4eA8D9D1D4e");
const TSLA = getAddress("0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E");

/*
 * The live v2 TSLA covered-call series on Robinhood Chain testnet (46630), read on 2026-09-30, and what the v3
 * Stylus risk engine (0x61158d98…a4ec) returned for it. Independently, the same inputs through scipy's
 * Black-Scholes (r = 0, 365-day year) give the REFERENCE values below; the engine agrees to ~5e-15 relative.
 */
const SERIES_ID = 8614008145645214741184698995285385951692715470493509368088435356950067027964n;
const EXPIRY = 1_790_971_200n; // Fri 2026-10-02 20:00 UTC
const NOW = 1_790_779_412n; // chain time of the read: 191,788 s to expiry
const SPOT = 350_005_000_000_000_000_000n; // feed round 3
const STRIKE = 369_860_000_000_000_000_000n;
const SIGMA = 600_000_000_000_000_000n; // the epoch's openSigma and the current sigma
const BUY_BLOCK = 126_302_569n;
const BUY_TIME = 1_790_701_785n;
const BUY_TX: Hex = "0x425e5b63ddeb1fcff5d63aa9f5a9fd11f4d3c0f52facd05e0fb44096f2ede9f9";
const series = {
  vault: VAULT,
  underlying: TSLA,
  agentId: 1n,
  expiry: EXPIRY,
  premiumBps: 10_000,
  isCall: true,
  settled: false,
  cancelled: false,
  strike: STRIKE,
  size: 4n * WAD,
  sold: 4n * WAD,
  premium: 10_005_944n, // USDG, 6 decimals: one buy of 4 options
  collateral: 4n * WAD, // 4 TSLA
  settlementPrice: 0n,
  payoutPerOption: 0n,
  escrow: 0n,
};
const STYLUS = {
  greeks: [
    123_873_382_260_320_738n,
    12_490_389_829_484_384n,
    5_583_294_857_298_036_735n,
    -754_577_985_594_328_775n,
  ],
  worst: 340_585_999_999_999_999_374n,
  losses: [
    ...Array<bigint>(8).fill(0n),
    60_581_999_999_999_999_654n,
    130_582_999_999_999_999_374n,
    200_583_999_999_999_998_534n,
    270_584_999_999_999_999_794n,
    340_585_999_999_999_999_374n,
  ],
  impliedVol: 600_000_021_748_298_880n,
};
/** scipy.stats.norm, float64: research-independent Black-Scholes at spot 350.005, K 369.86, T 191,788 s, σ 0.60. */
const REFERENCE = {
  delta: 0.12387338226032,
  gamma: 0.012490389829484,
  vega: 5.583294857298023,
  theta: -0.754577985594327,
  impliedVol: 0.600000021748, // brentq on the call price 2.501486 at 352.453 × 1.005, 269,415 s
};

interface Setup {
  now?: bigint;
  spot?: () => bigint;
  status?: [number, bigint, bigint];
  currentSigma?: bigint;
  openSigma?: bigint;
  epochSeriesId?: bigint;
  sold?: bigint;
  logs?: boolean;
  impliedVol?: (args: readonly unknown[]) => bigint;
  scenarioLoss?: (args: readonly unknown[]) => unknown;
  /** Address of the EpochManager (default A.epochManager) and the chain id the client is created with. */
  em?: Address;
  chainId?: number;
  /** Deploy a RiskLens bound to `manager` (default: the series' EpochManager) and pass it to the client. */
  lens?: { manager?: Address };
  /** Replace the feed's rounds: its latest round and `getRoundData` by round id (records each id read). */
  feed?: { latest: readonly bigint[]; round: (id: bigint) => readonly bigint[]; read: bigint[] };
}

function setup(o: Setup = {}) {
  const seen = {
    greeks: [] as unknown[][],
    scenarioLoss: [] as unknown[][],
    impliedVol: [] as unknown[][],
    seriesRisk: [] as unknown[][],
    seriesRiskAt: [] as unknown[][],
    pricerImpliedVol: [] as unknown[][],
  };
  const record = (name: keyof typeof seen, args: readonly unknown[]) => seen[name].push([...args]);
  const s = { ...series, sold: o.sold ?? series.sold };
  const em = o.em ?? A.epochManager;
  /** RiskLens._risk: the engine's greeks (zero once expired) and scenarioLoss, the first worst shock's payout. */
  const lensRisk = (spot: bigint, sigma: bigint, shocks: readonly bigint[]) => {
    const now = o.now ?? NOW;
    const tenor = EXPIRY > now ? EXPIRY - now : 0n;
    const [delta, gamma, vega, theta] = tenor === 0n ? [0n, 0n, 0n, 0n] : STYLUS.greeks;
    const losses = STYLUS.losses.slice(0, shocks.length).map((l) => (l * s.sold) / (4n * WAD));
    const worstLoss = losses.reduce((m, x) => (x > m ? x : m), 0n);
    const i = losses.findIndex((l) => l === worstLoss);
    const worstPayout = settlementPayout(true, STRIKE, s.sold, shockedSpot(spot, shocks[i]!), 18, 6);
    return {
      spot,
      sigma,
      tenor,
      delta,
      gamma,
      vega,
      theta,
      sold: s.sold,
      collateral: s.collateral,
      worstShock: shocks[i]!,
      worstLoss,
      worstPayout,
      shocks,
      losses,
    };
  };
  const contracts: Record<Address, FakeContract> = {
    [VAULT]: { abi: strikeVaultAbi, fns: { manager: em } },
    [LENS]: {
      abi: riskLensAbi,
      fns: {
        manager: o.lens?.manager ?? em,
        seriesRisk: (args: readonly unknown[]) => {
          record("seriesRisk", args);
          return lensRisk(SPOT, o.currentSigma ?? SIGMA, DEFAULT_SHOCKS);
        },
        seriesRiskAt: (args: readonly unknown[]) => {
          record("seriesRiskAt", args);
          return lensRisk(args[1] as bigint, args[2] as bigint, args[3] as readonly bigint[]);
        },
      },
    },
    [PRICER]: {
      abi: riskEngineAbi,
      fns: {
        impliedVol: (args: readonly unknown[]) => {
          record("pricerImpliedVol", args);
          return STYLUS.impliedVol;
        },
      },
    },
    [em]: {
      abi: epochManagerAbi,
      fns: {
        getSeries: (args: readonly unknown[]) => (args[0] === SERIES_ID ? s : { ...s, vault: addr(0) }),
        underlyings: [18, true, o.currentSigma ?? SIGMA, 50_000_000_000_000_000n, 2n * WAD, 50, 0],
        epochs: [
          2,
          1_790_701_738,
          o.epochSeriesId ?? SERIES_ID,
          352_453_000_000_000_000_000n,
          o.openSigma ?? SIGMA,
        ],
        spot: o.spot ?? SPOT,
        usdgDecimals: 6,
        pricer: PRICER,
      },
    },
    [A.stockOracle]: {
      abi: stockOracleAbi,
      fns: {
        status: o.status ?? [0, SPOT, 1_790_777_939n],
        feedConfig: { feed: FEED, maxPriceAge: 90_000, corporateActionGrace: 3_600, feedDecimals: 8 },
      },
    },
    [FEED]: {
      abi: mirrorFeedAbi,
      fns: {
        latestRoundData: o.feed?.latest ?? [3n, 35_000_500_000n, 1_790_777_939n, 1_790_777_939n, 3n],
        getRoundData: (args: readonly unknown[]) => {
          if (o.feed) {
            o.feed.read.push(args[0] as bigint);
            return o.feed.round(args[0] as bigint);
          }
          return {
            2: [2n, 35_245_300_000n, 1_790_700_322n, 1_790_700_322n, 2n],
            1: [1n, 36_900_000_000n, 1_790_629_879n, 1_790_629_879n, 1n],
          }[String(args[0]) as "1" | "2"];
        },
      },
    },
    [ENGINE]: {
      abi: riskEngineAbi,
      fns: {
        greeks: (args: readonly unknown[]) => {
          record("greeks", args);
          return STYLUS.greeks;
        },
        scenarioLoss: (args: readonly unknown[]) => {
          record("scenarioLoss", args);
          if (o.scenarioLoss) return o.scenarioLoss(args);
          const sold = args[2] as bigint;
          const n = (args[4] as readonly bigint[]).length;
          const losses = STYLUS.losses.slice(0, n).map((l) => (l * sold) / (4n * WAD));
          return [losses.reduce((m, x) => (x > m ? x : m), 0n), losses];
        },
        impliedVol: (args: readonly unknown[]) => {
          record("impliedVol", args);
          return o.impliedVol ? o.impliedVol(args) : STYLUS.impliedVol;
        },
      },
    },
  };
  const logs =
    o.logs === false
      ? []
      : [
          {
            ...eventLog(
              epochManagerAbi,
              "OptionsBought",
              {
                seriesId: SERIES_ID,
                buyer: addr(0xb0b),
                recipient: addr(0xb0b),
                amount: 4n * WAD,
                premium: 10_005_944n,
              },
              em,
            ),
            blockNumber: BUY_BLOCK,
            transactionHash: BUY_TX,
          },
        ];
  const { client, calls } = fakePublicClient(contracts, {
    timestamp: o.now ?? NOW,
    logs,
    blockTimestamps: { [BUY_BLOCK.toString()]: BUY_TIME },
  });
  const strike = createStrikeClient({
    publicClient: client,
    chainId: o.chainId ?? 999,
    addresses: { ...A, epochManager: em },
    riskEngine: ENGINE,
    ...(o.lens ? { riskLens: LENS } : {}),
  });
  return { strike, calls, seen };
}

const near = (actual: number, expected: number, rel: number) =>
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.abs(expected) * rel);

describe("seriesRisk on the live TSLA covered call (fixed vector)", () => {
  it("passes the series to the engine the way RiskLens does and returns its greeks", async () => {
    const { strike, seen } = setup();
    const r = await strike.seriesRisk(SERIES_ID);

    expect(r.riskEngine).toBe(ENGINE);
    expect(r.tenor).toBe(EXPIRY - NOW);
    expect(r.spot).toBe(SPOT);
    expect(r.spotStatus).toBe("Ok");
    expect(r.sigma).toBe(SIGMA);
    expect(r.sigmaSource).toBe("epoch-open");
    expect(r.atCurrentSigma).toBeNull();
    expect(seen.greeks).toEqual([[SPOT, STRIKE, 191_788n, SIGMA, true]]);
    expect(seen.scenarioLoss).toEqual([[true, STRIKE, 4n * WAD, SPOT, [...DEFAULT_SHOCKS]]]);
    expect(r.greeks).toEqual({
      delta: STYLUS.greeks[0],
      gamma: STYLUS.greeks[1],
      vega: STYLUS.greeks[2],
      theta: STYLUS.greeks[3],
    });
  });

  it("agrees with an independent Black-Scholes computation", async () => {
    const { strike } = setup();
    const r = await strike.seriesRisk(SERIES_ID);
    near(wadToNumber(r.greeks.delta), REFERENCE.delta, 1e-12);
    near(wadToNumber(r.greeks.gamma), REFERENCE.gamma, 1e-12);
    near(wadToNumber(r.greeks.vega), REFERENCE.vega, 1e-12);
    near(wadToNumber(r.greeks.theta), REFERENCE.theta, 1e-12);
    // The SDK's own float model (a third implementation) lands on the same delta.
    near(blackScholes(350.005, 369.86, Number(r.tenor), 0.6, true).delta, REFERENCE.delta, 1e-6);
    // Scenario payouts: a call pays (S' − K) / S' tokens per option, worth S' − K each.
    for (const [i, sc] of r.scenarios.entries()) {
      const s = 350.005 * (1 + (i - 6) * 0.05);
      near(wadToNumber(sc.loss), 4 * Math.max(s - 369.86, 0), 1e-12);
    }
  });

  it("gives the depositors' side: minus the greeks times the 4 options sold", async () => {
    const { strike } = setup();
    const r = await strike.seriesRisk(SERIES_ID);
    expect(r.soldWad).toBe(4n * WAD);
    expect(r.exposure).toEqual({
      delta: -495_493_529_041_282_952n, // −0.4955: the vault loses about $0.50 per $1 TSLA rises
      gamma: -49_961_559_317_937_536n,
      vega: -22_333_179_429_192_146_940n, // −$0.22 per volatility point
      theta: 3_018_311_942_377_315_100n, // +$3.02 a day of time decay
    });
  });

  it("explains each greek for depositors in one line", async () => {
    const { strike } = setup();
    const r = await strike.seriesRisk(SERIES_ID, { impliedVol: false });
    const e = explainSeriesRisk(r, "TSLA");
    expect(e.delta).toBe(
      "Delta −0.50: the vault loses about $0.50 for every $1 TSLA rises, across the 4 options sold.",
    );
    expect(e.gamma).toMatch(/^Gamma −0\.0500: each \$1 TSLA rises adds about \$0\.05 to that loss per \$1/);
    expect(e.vega).toMatch(/^Vega −22\.33: .* about \$0\.22, a mark-to-market loss/);
    expect(e.theta).toBe(
      "Theta +3.02: with nothing else moving, time decay earns the vault about $3.02 a day.",
    );
    const put = explainSeriesRisk(
      { ...r, isCall: false, exposure: { ...r.exposure, delta: WAD / 4n } },
      "TSLA",
    );
    expect(put.delta).toMatch(/loses about \$0\.25 for every \$1 TSLA falls/);
    expect(put.gamma).toMatch(/drops past the strike/);
    expect(explainSeriesRisk({ ...r, tenor: 0n }, "TSLA").delta).toMatch(/expired/);
  });

  it("finds the worst case on the ±30% grid and sets it against the locked collateral", async () => {
    const { strike } = setup();
    const r = await strike.seriesRisk(SERIES_ID);
    expect(r.scenarios.map((s) => s.shock)).toEqual([...DEFAULT_SHOCKS]);
    expect(r.scenarios[12]?.spot).toBe(455_006_500_000_000_000_000n);
    expect(r.worstLoss).toBe(STYLUS.worst);
    expect(r.worstShock).toBe(300_000_000_000_000_000n);
    // (455.0065 − 369.86) / 455.0065 × 4 TSLA, rounded down as settle rounds it
    expect(r.worstPayout).toBe(748_529_966_055_429_976n);
    expect(r.collateral).toBe(4n * WAD);
    expect(r.collateralUnit).toBe("token");
    expect(r.worstShareOfCollateralBps).toBe(1871);
  });

  it("solves the last buy's implied volatility back to the sigma it was priced with", async () => {
    const { strike, seen } = setup();
    const r = await strike.seriesRisk(SERIES_ID);
    expect(r.impliedVol).not.toBeNull();
    const iv = r.impliedVol!;
    expect(iv.txHash).toBe(BUY_TX);
    expect(iv.spot).toBe(352_453_000_000_000_000_000n); // feed round 2, in force at the buy
    expect(iv.pricedSpot).toBe(354_215_265_000_000_000_000n); // + the 0.5% spot buffer
    expect(iv.pricePaid).toBe(2_501_486_000_000_000_000n); // 10.005944 USDG / 4
    expect(iv.fairValue).toBe(iv.pricePaid); // sold at 100% of fair value
    expect(iv.tenor).toBe(EXPIRY - BUY_TIME);
    expect(seen.impliedVol).toEqual([[iv.fairValue, iv.pricedSpot, STRIKE, 269_415n, true]]);
    expect(iv.sigma).toBe(STYLUS.impliedVol);
    near(wadToNumber(iv.sigma), REFERENCE.impliedVol, 1e-11);
    near(wadToNumber(iv.sigma), 0.6, 1e-7); // the epoch's sigma, up to the USDG rounding of the premium
  });

  // A feed in phase 2 at aggregator round 40, one round an hour; round 3 is the last one published before the buy.
  const PHASE = 2n << 64n;
  const hourly = (read: bigint[]) => ({
    latest: [PHASE + 40n, 35_000_500_000n, BUY_TIME + 37n * 3600n, BUY_TIME + 37n * 3600n, PHASE + 40n],
    round: (id: bigint) => {
      const r = id - PHASE;
      const at = BUY_TIME - 600n + (r - 3n) * 3600n;
      return [id, r === 3n ? 35_245_300_000n : 30_000_000_000n, at, at, id];
    },
    read,
  });

  it("walks back many feed rounds to the one in force at the buy, newest first", async () => {
    const read: bigint[] = [];
    const { strike } = setup({ feed: hourly(read) });
    const r = await strike.seriesRisk(SERIES_ID);
    expect(r.impliedVol!.spot).toBe(352_453_000_000_000_000_000n); // round 3's answer
    // Rounds 39 down to 1, in order: three reads of 16, 16 and the 7 left, so the chunk with round 3 is read whole.
    expect(read.map((id) => Number(id - PHASE))).toEqual(Array.from({ length: 39 }, (_, i) => 39 - i));
  });

  it("never reads below the phase's first round, and says so when no round is old enough", async () => {
    const read: bigint[] = [];
    const feed = hourly(read);
    const { strike } = setup({
      feed: { ...feed, round: (id) => [id, 30_000_000_000n, BUY_TIME + 60n, BUY_TIME + 60n, id] },
    });
    const r = await strike.seriesRisk(SERIES_ID);
    expect(r.impliedVol).toBeNull();
    expect(r.impliedVolNote).toBe("the feed round in force at the buy is not available");
    expect(read.length).toBe(39);
    expect(read.every((id) => id > PHASE)).toBe(true);
  });

  it("accepts a series object and skips the implied volatility on request", async () => {
    const { strike, calls } = setup();
    const r = await strike.seriesRisk({ id: SERIES_ID, ...series }, { impliedVol: false });
    expect(r.impliedVol).toBeNull();
    expect(r.impliedVolNote).toBe("not requested");
    expect(calls).not.toContain("getSeries");
    expect(calls).not.toContain("impliedVol");
  });
});

describe("seriesRisk edge cases", () => {
  it("has zero greeks once the series has expired, as RiskLens", async () => {
    const { strike, calls } = setup({ now: EXPIRY + 60n });
    const r = await strike.seriesRisk(SERIES_ID, { impliedVol: false });
    expect(r.tenor).toBe(0n);
    expect(r.greeks).toEqual({ delta: 0n, gamma: 0n, vega: 0n, theta: 0n });
    expect(r.exposure).toEqual({ delta: 0n, gamma: 0n, vega: 0n, theta: 0n });
    expect(calls).not.toContain("greeks");
    expect(r.worstLoss).toBe(STYLUS.worst); // the scenarios still apply at settlement
  });

  it("uses the last print, flagged, while the feed is unsafe", async () => {
    const { strike } = setup({
      spot: () => {
        throw new Error("StalePrice");
      },
      status: [2, SPOT, 1_790_777_939n],
    });
    const r = await strike.seriesRisk(SERIES_ID, { impliedVol: false });
    expect(r.spotStatus).toBe("StalePrice");
    expect(r.spot).toBe(SPOT);
  });

  it("fails clearly when there is no price at all", async () => {
    const { strike } = setup({
      spot: () => {
        throw new Error("InvalidPrice");
      },
      status: [1, 0n, 0n],
    });
    await expect(strike.seriesRisk(SERIES_ID)).rejects.toThrow(/no usable price .*InvalidPrice/);
  });

  it("uses the current sigma for a series that is not the vault's live one", async () => {
    const { strike, seen } = setup({ epochSeriesId: 7n, currentSigma: 450_000_000_000_000_000n });
    const r = await strike.seriesRisk(SERIES_ID, { impliedVol: false });
    expect(r.sigmaSource).toBe("current");
    expect(r.sigma).toBe(450_000_000_000_000_000n);
    expect(r.atCurrentSigma).toBeNull();
    expect(seen.greeks[0]?.[3]).toBe(450_000_000_000_000_000n);
  });

  it("adds greeks at the current sigma when the keeper moved it after the epoch opened", async () => {
    const { strike, seen } = setup({ currentSigma: 550_000_000_000_000_000n });
    const r = await strike.seriesRisk(SERIES_ID, { impliedVol: false });
    expect(r.sigma).toBe(SIGMA);
    expect(r.currentSigma).toBe(550_000_000_000_000_000n);
    expect(seen.greeks.map((a) => a[3])).toEqual([SIGMA, 550_000_000_000_000_000n]);
    expect(r.atCurrentSigma?.exposure.delta).toBe(-495_493_529_041_282_952n);
  });

  it("has no implied volatility before the first buy", async () => {
    const { strike } = setup({ sold: 0n, logs: false });
    const r = await strike.seriesRisk(SERIES_ID);
    expect(r.impliedVol).toBeNull();
    expect(r.impliedVolNote).toBe("no options bought yet");
    expect(r.worstLoss).toBe(0n);
    expect(r.worstPayout).toBe(0n);
    expect(r.worstShareOfCollateralBps).toBe(0);
  });

  it("reports an implied volatility the engine cannot solve instead of inventing one", async () => {
    const { strike } = setup({
      impliedVol: () => {
        throw new FakeRevert("PricerInputOutOfRange", [7]);
      },
    });
    const r = await strike.seriesRisk(SERIES_ID);
    expect(r.impliedVol).toBeNull();
    expect(r.impliedVolNote).toMatch(
      /not derivable: .*PricerInputOutOfRange\(7\).*implied volatility outside/,
    );
  });

  it("wraps an engine rejection with the engine's address", async () => {
    const { strike } = setup({
      scenarioLoss: () => {
        throw new FakeRevert("PricerInputOutOfRange", [8]);
      },
    });
    await expect(strike.seriesRisk(SERIES_ID)).rejects.toThrow(
      new RegExp(`risk engine at ${ENGINE} rejected series .*PricerInputOutOfRange\\(8\\).*spot shock`),
    );
  });

  it("rejects an unknown series and a chain without a risk engine", async () => {
    const { strike } = setup();
    await expect(strike.seriesRisk(1n)).rejects.toThrow(/series 1 does not exist/);
    const { client } = fakePublicClient({}, { timestamp: NOW });
    const bare = createStrikeClient({ publicClient: client, chainId: 999, addresses: A });
    await expect(bare.seriesRisk(SERIES_ID)).rejects.toBeInstanceOf(StrikeError);
    await expect(bare.seriesRisk(SERIES_ID)).rejects.toThrow(/no risk engine is deployed on chain 999/);
  });

  it("finds the testnet risk engine in the deployment map", async () => {
    const { deployments } = await import("../src/index.js");
    expect(deployments["46630"]?.riskEngine?.toLowerCase()).toBe(
      "0x61158d98c6c2b7ccb22755a098d0da2bbcf2a4ec",
    );
  });
});

describe("seriesRisk: which contract, which chain, which version", () => {
  it("calls the engine directly and leaves the version unknown off the deployment map", async () => {
    const { strike, calls } = setup();
    const r = await strike.seriesRisk(SERIES_ID, { impliedVol: false });
    expect(r.source).toBe("riskEngine");
    expect(r.riskLens).toBeNull();
    expect(r.riskLensFunction).toBeNull();
    expect(r.riskEngine).toBe(ENGINE);
    expect(r.chainId).toBe(999);
    expect(r.epochManager).toBe(A.epochManager);
    expect(r.version).toBeNull();
    expect(calls).toContain("manager");
    expect(calls).not.toContain("seriesRisk");
  });

  it("names a v2 series when the vault's EpochManager is the map's v2 deployment (46630)", async () => {
    const { deployments } = await import("../src/index.js");
    const v2 = getAddress(deployments["46630"]!.epochManager);
    const { strike } = setup({ em: v2, chainId: 46630 });
    const r = await strike.seriesRisk(SERIES_ID, { impliedVol: false });
    expect(r.version).toBe("v2");
    expect(r.epochManager).toBe(v2);
    expect(r.source).toBe("riskEngine");
    expect(r.riskEngine).toBe(ENGINE);
  });

  it("reads a v3 series through RiskLens.seriesRisk, priced by the EpochManager's pricer", async () => {
    const { deployments } = await import("../src/index.js");
    const v3 = getAddress(deployments["421614"]!.epochManager);
    const { strike, seen } = setup({ em: v3, chainId: 421614, lens: {} });
    const r = await strike.seriesRisk(SERIES_ID);
    expect(r.source).toBe("riskLens");
    expect(r.riskLens).toBe(LENS);
    expect(r.riskLensFunction).toBe("seriesRisk");
    expect(r.riskEngine).toBe(PRICER);
    expect(r.version).toBe("v3");
    expect(r.chainId).toBe(421614);
    expect(seen.seriesRisk).toEqual([[SERIES_ID]]);
    expect(seen.greeks).toEqual([]);
    expect(seen.scenarioLoss).toEqual([]);
    // The same numbers as the direct path, and the implied volatility from the pricer RiskLens used.
    const direct = await setup().strike.seriesRisk(SERIES_ID);
    expect(r.greeks).toEqual(direct.greeks);
    expect(r.exposure).toEqual(direct.exposure);
    expect(r.scenarios).toEqual(direct.scenarios);
    expect(r.worstLoss).toBe(direct.worstLoss);
    expect(r.worstShock).toBe(direct.worstShock);
    expect(r.worstPayout).toBe(direct.worstPayout);
    expect(r.tenor).toBe(direct.tenor);
    expect(seen.pricerImpliedVol).toHaveLength(1);
    expect(r.impliedVol?.sigma).toBe(STYLUS.impliedVol);
  });

  it("uses RiskLens.seriesRiskAt for the epoch's opening sigma and for a last print", async () => {
    const moved = 550_000_000_000_000_000n;
    const { strike, seen } = setup({ lens: {}, currentSigma: moved });
    const r = await strike.seriesRisk(SERIES_ID, { impliedVol: false });
    expect(r.riskLensFunction).toBe("seriesRiskAt");
    expect(seen.seriesRisk).toEqual([]);
    expect(seen.seriesRiskAt.map((a) => [a[0], a[1], a[2]])).toEqual([
      [SERIES_ID, SPOT, SIGMA],
      [SERIES_ID, SPOT, moved],
    ]);
    expect(r.sigma).toBe(SIGMA);
    expect(r.atCurrentSigma).not.toBeNull();
    // A RiskLens bound to this EpochManager makes the series v3 even off the map.
    expect(r.version).toBe("v3");

    const stale = setup({
      lens: {},
      spot: () => {
        throw new Error("StalePrice");
      },
      status: [2, SPOT, 1_790_777_939n],
    });
    const rs = await stale.strike.seriesRisk(SERIES_ID, { impliedVol: false });
    expect(rs.spotStatus).toBe("StalePrice");
    expect(rs.riskLensFunction).toBe("seriesRiskAt");
    expect(stale.seen.seriesRiskAt[0]?.[1]).toBe(SPOT);
  });

  it("ignores a RiskLens bound to another EpochManager and calls the engine directly", async () => {
    const { strike, seen } = setup({ lens: { manager: addr(0xbad) } });
    const r = await strike.seriesRisk(SERIES_ID, { impliedVol: false });
    expect(r.source).toBe("riskEngine");
    expect(r.riskLens).toBeNull();
    expect(r.riskEngine).toBe(ENGINE);
    expect(r.version).toBeNull();
    expect(seen.seriesRisk).toEqual([]);
    expect(seen.greeks).toHaveLength(1);
  });

  it("finds RiskLens and the version in the Arbitrum Sepolia deployment map", async () => {
    const { deployments } = await import("../src/index.js");
    const d = deployments["421614"]!;
    expect(d.version).toBe("v3");
    expect(d.riskLens?.toLowerCase()).toBe("0x94ac10ff1a71cebfd825079aaf897858a9953ece");
    expect(deployments["46630"]?.version).toBe("v2");
    expect(deployments["46630"]?.riskLens).toBeUndefined();
  });
});

describe("risk helpers", () => {
  it("DEFAULT_SHOCKS is RiskLens.defaultShocks: −30% to +30% in 5% steps", () => {
    expect(DEFAULT_SHOCKS.length).toBe(13);
    expect(DEFAULT_SHOCKS[0]).toBe(-300_000_000_000_000_000n);
    expect(DEFAULT_SHOCKS[6]).toBe(0n);
    expect(DEFAULT_SHOCKS[12]).toBe(300_000_000_000_000_000n);
  });

  it("shockedSpot rounds down and rejects shocks outside (−100%, +1000%]", () => {
    expect(shockedSpot(3n, -500_000_000_000_000_000n)).toBe(1n);
    expect(shockedSpot(SPOT, 0n)).toBe(SPOT);
    expect(() => shockedSpot(SPOT, -WAD)).toThrow(StrikeError);
    expect(() => shockedSpot(SPOT, 10n * WAD + 1n)).toThrow(StrikeError);
  });

  it("settlementPayout rounds like settle: tokens for a call, USDG for a put", () => {
    expect(settlementPayout(true, 100n * WAD, 2n * WAD, 125n * WAD, 18, 6)).toBe(400_000_000_000_000_000n);
    expect(settlementPayout(true, 100n * WAD, 2n * WAD, 90n * WAD, 18, 6)).toBe(0n);
    // 3 puts at K 330, S 300.1234567: 29.8765433 × 3 = 89.6296299 → 89.629629 USDG (floor)
    expect(settlementPayout(false, 330n * WAD, 3n * WAD, 300_123_456_700_000_000_000n, 18, 6)).toBe(
      89_629_629n,
    );
  });

  it("vaultExposure is minus the greeks times the options sold", () => {
    expect(vaultExposure({ delta: WAD / 2n, gamma: 1n, vega: 2n * WAD, theta: -WAD }, 3n * WAD)).toEqual({
      delta: -1_500_000_000_000_000_000n,
      gamma: -3n,
      vega: -6n * WAD,
      theta: 3n * WAD,
    });
  });

  it("riskEngineError spells out the pricer's input codes", () => {
    expect(riskEngineError(new Error("PricerInputOutOfRange(6)"))).toMatch(/no-arbitrage bounds/);
    expect(riskEngineError(new Error("boom"))).toBe("boom");
    expect(Object.keys(PRICER_INPUT_ERRORS)).toHaveLength(8);
  });

  it("ships the IRiskEngine and RiskLens ABIs", () => {
    const names = (abi: readonly { type: string; name?: string }[]) => abi.map((x) => x.name);
    expect(names(riskEngineAbi)).toEqual(
      expect.arrayContaining(["greeks", "impliedVol", "scenarioLoss", "quote", "PricerInputOutOfRange"]),
    );
    expect(names(riskLensAbi)).toEqual(
      expect.arrayContaining(["seriesRisk", "seriesRiskAt", "defaultShocks"]),
    );
  });
});
