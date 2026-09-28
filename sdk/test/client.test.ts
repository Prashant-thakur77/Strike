import { type Address, erc20Abi, getAddress } from "viem";
import { describe, expect, it } from "vitest";
import {
  type StrikeAddresses,
  StrikeError,
  WAD,
  agentRegistryAbi,
  blackScholesRefAbi,
  createStrikeClient,
  epochManagerAbi,
  feeManagerAbi,
  marketCalendarAbi,
  mirrorFeedAbi,
  stockOracleAbi,
  strikeVaultAbi,
} from "../src/index.js";
import { type FakeContract, fakePublicClient } from "./fake-chain.js";

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
const VAULT = addr(0x1001);
const TSLA = addr(0x51);
const FEED = addr(0xf0);
const PRICER = addr(0xbb);
const CURATOR = addr(0xc0);

const MONDAY = 1_791_212_400n; // Mon 2026-10-05 15:00 UTC
const FRIDAY = 1_791_576_000n; // Fri 2026-10-09 20:00 UTC (16:00 New York)
const WEEK = 604_800n;

const mandate = {
  minDeltaBps: 1000,
  maxDeltaBps: 3500,
  minPremiumBps: 9500,
  minYieldBps: 5,
  maxShareSoldBps: 8000,
  minTenor: 86_400,
  maxTenor: 691_200,
};
const zeroSeries = {
  vault: addr(0),
  underlying: addr(0),
  agentId: 0n,
  expiry: 0n,
  premiumBps: 0,
  isCall: false,
  settled: false,
  cancelled: false,
  strike: 0n,
  size: 0n,
  sold: 0n,
  premium: 0n,
  collateral: 0n,
  settlementPrice: 0n,
  payoutPerOption: 0n,
  escrow: 0n,
};
const series = {
  ...zeroSeries,
  vault: VAULT,
  underlying: TSLA,
  agentId: 1n,
  expiry: FRIDAY,
  premiumBps: 10_000,
  isCall: true,
  strike: 390n * WAD,
  size: 8n * WAD,
  sold: 2n * WAD,
  premium: 5_000_000n,
  collateral: 2n * WAD,
};

let pricerArgs: readonly unknown[] = [];

function chain(timestamp = MONDAY) {
  const contracts: Record<Address, FakeContract> = {
    [VAULT]: {
      abi: strikeVaultAbi,
      fns: {
        name: "Strike TSLA Covered Call",
        symbol: "sTSLA-CC",
        decimals: 18,
        asset: TSLA,
        underlying: TSLA,
        isCall: true,
        premiumToken: A.usdg,
        totalAssets: 10n * WAD,
        totalSupply: 10n * WAD,
        depositCap: 10_000n * WAD,
        locked: true,
        currentEpoch: 1n,
        lastProcessedEpoch: 0n,
        pendingDepositAssets: 0n,
        pendingRedeemShares: 0n,
        convertToAssets: ([shares]: readonly unknown[]) => shares,
        pendingPremium: 1_234_567n,
        claimableDepositShares: 0n,
        claimableRedeemAssets: 0n,
        depositRequests: [0n, 0n],
        redeemRequests: [1n, 3n * WAD],
        balanceOf: 7n * WAD,
      },
    },
    [A.epochManager]: {
      abi: epochManagerAbi,
      fns: {
        vaultCount: 1n,
        allVaults: VAULT,
        vaultConfig: { curator: CURATOR, agentId: 1n, registered: true, mandate },
        epochs: [2, MONDAY, 42n],
        compensation: 0n,
        underlyings: [18, true, 600_000_000_000_000_000n, 200_000_000_000_000_000n, 2n * WAD],
        getSeries: ([id]: readonly unknown[]) => (id === 42n ? series : zeroSeries),
        previewProposal: [8, 9n * WAD, 520_000_000_000_000_000n, 10n * WAD],
        quoteBuy: [2_500_000n, WAD],
        usdgDecimals: 6,
        spot: 369n * WAD,
        pricer: PRICER,
      },
    },
    [PRICER]: {
      abi: blackScholesRefAbi,
      fns: {
        strikeForDelta: (args: readonly unknown[]) => {
          pricerArgs = args;
          return 389_799_384_972_574_400_000n;
        },
      },
    },
    [TSLA]: { abi: erc20Abi, fns: { symbol: "TSLA", decimals: 18 } },
    [A.usdg]: { abi: erc20Abi, fns: { symbol: "USDG", decimals: 6 } },
    [A.stockOracle]: {
      abi: stockOracleAbi,
      fns: {
        status: [2, 369n * WAD, MONDAY - 100_000n],
        isMarketOpen: true,
        feedConfig: { feed: FEED, maxPriceAge: 90_000, corporateActionGrace: 86_400, feedDecimals: 8 },
      },
    },
    [A.marketCalendar]: {
      abi: marketCalendarAbi,
      fns: { weeklyExpiry: ([at]: readonly unknown[]) => ((at as bigint) < FRIDAY ? FRIDAY : FRIDAY + WEEK) },
    },
    [A.agentRegistry]: {
      abi: agentRegistryAbi,
      fns: {
        getAgent: {
          owner: CURATOR,
          signer: CURATOR,
          payout: CURATOR,
          status: 1,
          strikes: 1,
          accepted: 3,
          rejected: 1,
          unbondAt: 0n,
          erc8004Id: 0n,
          bond: 70_000_000n,
          unbonding: 0n,
        },
        isActive: true,
        track: [4, -2_500_000n],
        identityRegistry: addr(0x8004),
        reputationRegistry: addr(0),
        minBond: 50_000_000n,
        slashAmount: 10_000_000n,
        maxStrikes: 3,
        unbondDelay: 691_200,
      },
    },
    [A.feeManager]: { abi: feeManagerAbi, fns: { claimable: 1_500_000n } },
    [FEED]: {
      abi: mirrorFeedAbi,
      fns: {
        latestRoundData: [4n, 40_000_000_000n, FRIDAY + 600n, FRIDAY + 600n, 4n],
        getRoundData: ([id]: readonly unknown[]) => {
          const t = [0n, MONDAY, FRIDAY - 60n, FRIDAY + 30n, FRIDAY + 600n][Number(id)] ?? 0n;
          return [id, 40_000_000_000n, t, t, id];
        },
      },
    },
  };
  const fake = fakePublicClient(contracts, { timestamp });
  const strike = createStrikeClient({ publicClient: fake.client, chainId: 999, addresses: A });
  return { strike, calls: fake.calls };
}

describe("createStrikeClient (reads over a fake chain)", () => {
  it("needs addresses for chains without a deployment", () => {
    const { client } = fakePublicClient({}, { timestamp: MONDAY });
    expect(() => createStrikeClient({ publicClient: client, chainId: 999 })).toThrow(/No Strike deployment/);
  });

  it("uses the deployments map for known chains", () => {
    const { client } = fakePublicClient({}, { timestamp: MONDAY });
    const strike = createStrikeClient({ publicClient: client, chainId: 31337 });
    expect(strike.addresses.epochManager).toBe("0xa513E6E4b8f2a923D98304ec87F64353C4D5C853");
  });

  it("reads a vault's full state", async () => {
    const { strike } = chain();
    const v = await strike.getVault(VAULT);
    expect(v).toMatchObject({
      symbol: "sTSLA-CC",
      kind: "covered-call",
      assetSymbol: "TSLA",
      underlyingSymbol: "TSLA",
      totalAssets: 10n * WAD,
      pricePerShare: WAD,
      locked: true,
      curator: CURATOR,
      agentId: 1n,
      mandate,
      sigma: 600_000_000_000_000_000n,
      epoch: { state: "Selling", openedAt: MONDAY, seriesId: 42n },
    });
    expect(v.series).toMatchObject({ id: 42n, strike: 390n * WAD, sold: 2n * WAD, expiry: FRIDAY });
  });

  it("lists vaults", async () => {
    const { strike } = chain();
    const vaults = await strike.listVaults();
    expect(vaults.map((v) => v.address)).toEqual([VAULT]);
  });

  it("returns null for an unknown series", async () => {
    const { strike } = chain();
    expect(await strike.getSeries(7n)).toBeNull();
  });

  it("names the mandate verdict of a preview", async () => {
    const { strike } = chain();
    const p = await strike.previewProposal(VAULT, {
      strike: 370n * WAD,
      expiry: FRIDAY,
      size: WAD,
      premiumBps: 10_000,
    });
    expect(p).toEqual({
      reason: "DeltaOutOfBand",
      reasonCode: 8,
      accepted: false,
      fairValue: 9n * WAD,
      delta: 520_000_000_000_000_000n,
      capacity: 10n * WAD,
    });
  });

  it("solves a delta strike on the pricer, floored to a cent", async () => {
    const { strike } = chain();
    const k = await strike.solveStrike(VAULT, { targetDeltaBps: 2000, expiry: FRIDAY });
    expect(k).toBe(389_790_000_000_000_000_000n);
    expect(pricerArgs).toEqual([
      369n * WAD,
      200_000_000_000_000_000n,
      FRIDAY - MONDAY,
      600_000_000_000_000_000n,
      true,
    ]);
    const preview = await strike.previewProposeByDelta(VAULT, {
      targetDeltaBps: 2000,
      expiry: FRIDAY,
      size: WAD,
      premiumBps: 10_000,
    });
    expect(preview.strike).toBe(k);
    await expect(strike.solveStrike(VAULT, { targetDeltaBps: 0.2, expiry: FRIDAY })).rejects.toThrow(
      /integer/,
    );
  });

  it("reports the oracle status by name", async () => {
    const { strike } = chain();
    expect(await strike.oracleStatus(TSLA)).toEqual({
      status: "StalePrice",
      ok: false,
      price: 369n * WAD,
      updatedAt: MONDAY - 100_000n,
    });
    expect(await strike.marketOpen()).toBe(true);
  });

  it("quotes a purchase", async () => {
    const { strike } = chain();
    expect(await strike.quoteBuy(42n, WAD)).toEqual({ premium: 2_500_000n, collateral: WAD });
  });

  it("picks the next expiry inside the mandate's tenor", async () => {
    expect(await chain(MONDAY).strike.nextExpiry(mandate)).toBe(FRIDAY);
    // One hour before Friday's close is below the one-day minimum tenor: roll to next week.
    expect(await chain(FRIDAY - 3600n).strike.nextExpiry(mandate)).toBe(FRIDAY + WEEK);
    expect(await chain(FRIDAY - 3600n).strike.nextExpiry()).toBe(FRIDAY);
    expect(await chain(FRIDAY - 3600n).strike.nextExpiry({ ...mandate, maxTenor: 86_400 })).toBeNull();
    expect(await chain().strike.weeklyExpiry()).toBe(FRIDAY);
  });

  it("computes agent stats", async () => {
    const { strike } = chain();
    const s = await strike.agentStats(1n);
    expect(s).toMatchObject({
      status: "Active",
      active: true,
      proposals: 4,
      acceptanceRate: 0.75,
      strikesLeft: 2,
      rejectionsUntilInactive: 2,
      claimableFees: 1_500_000n,
      settledEpochs: 4,
      cumulativePnl: -2_500_000n,
      params: {
        minBond: 50_000_000n,
        slashAmount: 10_000_000n,
        maxStrikes: 3,
        unbondDelay: 691_200,
        identityRegistry: addr(0x8004),
        reputationRegistry: addr(0),
      },
    });
  });

  it("reads an account's claimables", async () => {
    const { strike } = chain();
    expect(await strike.claimables(VAULT, CURATOR)).toEqual({
      premium: 1_234_567n,
      depositShares: 0n,
      redeemAssets: 0n,
      depositRequest: { epoch: 0n, amount: 0n },
      redeemRequest: { epoch: 1n, amount: 3n * WAD },
      shares: 7n * WAD,
    });
    expect(await strike.pendingPremium(VAULT, CURATOR)).toBe(1_234_567n);
  });

  it("finds the settlement round on the token's feed", async () => {
    const { strike } = chain(FRIDAY + 700n);
    expect(await strike.findSettlementRound(TSLA, FRIDAY)).toBe(3n);
  });

  it("refuses writes without a wallet", async () => {
    const { strike } = chain();
    await expect(strike.openEpoch(VAULT)).rejects.toThrow(StrikeError);
    await expect(strike.claimables(VAULT)).rejects.toThrow(/read-only/);
  });
});
