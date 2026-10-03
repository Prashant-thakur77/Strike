/**
 * Values from Robinhood Chain testnet (46630), EpochManager 0x5A3b58DF27e4DD5E0fa6493D90fF653e0E199C99.
 * EpochOpened, SeriesProposed, ProposalRejected and OptionsBought are the real 2026-09-29 logs. Nothing has
 * settled, aborted or been cancelled there yet, so those three use the same vaults and series with made-up
 * outcomes (marked below).
 */
import type { SeriesState, VaultState } from "@strike/sdk";
import type { Address, Hex } from "viem";
import { vi } from "vitest";
import type { CommandTarget, StrikeReader } from "../src/commands.js";
import type { FormatContext, SeriesInfo, VaultInfo } from "../src/format.js";
import type { DecodedLog } from "../src/logs.js";

export const WAD = 10n ** 18n;
export const TSLA: Address = "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E";
export const USDG: Address = "0x7E955252E15c84f5768B83c41a71F9eba181802F";
export const DEPLOYER: Address = "0x26b277b434B1670f207Afd8946edA9AF78A613Ff";

export const CC_VAULT: VaultInfo = {
  address: "0xADFF7900dbe01E8170a750AB88e1f4eA8D9D1D4e",
  symbol: "sTSLA-CC",
  isCall: true,
  underlyingSymbol: "TSLA",
  underlyingDecimals: 18,
  assetSymbol: "TSLA",
  assetDecimals: 18,
};

export const CSP_VAULT: VaultInfo = {
  address: "0xE33EAD75Df1aF35cBA330f1fc7636926e31c67d7",
  symbol: "sTSLA-CSP",
  isCall: false,
  underlyingSymbol: "TSLA",
  underlyingDecimals: 18,
  assetSymbol: "USDG",
  assetDecimals: 6,
};

/** Friday 2026-10-02 16:00 New York. */
export const EXPIRY = 1_790_971_200n;
export const STRIKE_CC = 369_860_000_000_000_000_000n; // $369.86
export const SERIES_ID = 1179601826120097133700664825148441459568265797628n;
export const CC_SERIES: SeriesInfo = { strike: STRIKE_CC, expiry: EXPIRY, isCall: true };

export const TX = {
  epochOpened: "0x475be822c2a68c194999148e2c52d2ab134d74bb19fc235fe0b509a5333fc5a5",
  seriesProposed: "0x92169eac7bd2491d1f22f394e15643d5d54309c1e980683cf82a13088021a9d4",
  proposalRejected: "0x3df523aae815e10cba8f5f99076f9cb348745e7657dd1f1338820af0469dc6a0",
  optionsBought: "0x425e5b63ddeb1fcff5d63aa9f5a9fd11f4d3c0f52facd05e0fb44096f2ede9f9",
  // Made up (no such transactions yet):
  settled: `0x${"a1".repeat(32)}`,
  aborted: `0x${"b2".repeat(32)}`,
  cancelled: `0x${"c3".repeat(32)}`,
} as const satisfies Record<string, Hex>;

export const FORMAT: FormatContext = {
  explorerUrl: "https://explorer.testnet.chain.robinhood.com",
  usdgDecimals: 6,
};

/** The four real logs, as viem decodes them. */
export const REAL_LOGS: DecodedLog[] = [
  {
    eventName: "EpochOpened",
    args: { vault: CC_VAULT.address, epoch: 1n, spot: 352_453_000_000_000_000_000n },
    transactionHash: TX.epochOpened,
    blockNumber: 126_302_279n,
    logIndex: 3,
  },
  {
    eventName: "SeriesProposed",
    args: {
      vault: CC_VAULT.address,
      epoch: 1n,
      seriesId: SERIES_ID,
      strike: STRIKE_CC,
      expiry: EXPIRY,
      size: 4n * WAD,
      premiumBps: 10_000,
      fairValue: 2_126_678_382_777_417_825n,
      delta: 200_043_397_642_121_272n,
    },
    transactionHash: TX.seriesProposed,
    blockNumber: 126_302_301n,
    logIndex: 2,
  },
  {
    eventName: "ProposalRejected",
    args: {
      vault: CSP_VAULT.address,
      epoch: 1n,
      agentId: 1n,
      reason: 8, // DeltaOutOfBand
      slashed: 10_000_000n, // 10 USDG
      strike: 352_440_000_000_000_000_000n,
      expiry: EXPIRY,
      size: 45_397_798_206_786_970n,
      premiumBps: 10_000,
    },
    transactionHash: TX.proposalRejected,
    blockNumber: 126_302_448n,
    logIndex: 4,
  },
  {
    eventName: "OptionsBought",
    args: {
      seriesId: SERIES_ID,
      buyer: DEPLOYER,
      recipient: DEPLOYER,
      amount: 4n * WAD,
      premium: 10_005_944n, // 10.005944 USDG
    },
    transactionHash: TX.optionsBought,
    blockNumber: 126_302_569n,
    logIndex: 1,
  },
];

const mandate = {
  minDeltaBps: 1000,
  maxDeltaBps: 3500,
  minPremiumBps: 9500,
  minYieldBps: 5,
  maxShareSoldBps: 8000,
  minTenor: 86_400,
  maxTenor: 691_200,
};

/** Full `VaultState`s, for fakes of the SDK client. */
export function vaultState(v: VaultInfo, over: Partial<VaultState> = {}): VaultState {
  return {
    address: v.address,
    name: v.isCall ? "Strike TSLA Covered Call" : "Strike TSLA Cash-Secured Put",
    symbol: v.symbol,
    decimals: v.assetDecimals,
    kind: v.isCall ? "covered-call" : "cash-secured-put",
    isCall: v.isCall,
    asset: v.isCall ? TSLA : USDG,
    assetSymbol: v.assetSymbol,
    assetDecimals: v.assetDecimals,
    underlying: TSLA,
    underlyingSymbol: v.underlyingSymbol,
    underlyingDecimals: v.underlyingDecimals,
    premiumToken: USDG,
    totalAssets: v.isCall ? 5n * WAD : 20_000_000n,
    totalSupply: v.isCall ? 5n * WAD : 20_000_000n,
    pricePerShare: v.isCall ? WAD : 1_000_000n,
    depositCap: 0n,
    locked: true,
    currentEpoch: 1n,
    lastProcessedEpoch: 0n,
    pendingDepositAssets: 0n,
    pendingRedeemShares: 0n,
    curator: DEPLOYER,
    agentId: 1n,
    mandate,
    sigma: 600_000_000_000_000_000n,
    compensation: 0n,
    epoch: { state: "Open", openedAt: 1_790_700_000n, seriesId: 0n },
    series: null,
    ...over,
  };
}

export const CC_SERIES_STATE: SeriesState = {
  id: SERIES_ID,
  vault: CC_VAULT.address,
  underlying: TSLA,
  agentId: 1n,
  expiry: EXPIRY,
  premiumBps: 10_000,
  isCall: true,
  settled: false,
  cancelled: false,
  strike: STRIKE_CC,
  size: 4n * WAD,
  sold: 4n * WAD,
  premium: 10_005_944n,
  collateral: 4n * WAD,
  settlementPrice: 0n,
  payoutPerOption: 0n,
  escrow: 0n,
};

// --- The other deployments (addresses from contracts/deployments), for the multi-deployment tests ---

export const V3_CC_VAULT: VaultInfo = {
  ...CC_VAULT,
  address: "0x478E7BC3C3aB07fdd104e4765F178977adEe6285",
};
export const V3_CSP_VAULT: VaultInfo = {
  ...CSP_VAULT,
  address: "0x1bc73c1B28F520E57982FAe6127477190FA53690",
};
export const SEPOLIA_CC_VAULT: VaultInfo = {
  ...CC_VAULT,
  address: "0x5655659E18bf54ee0EF8f6A816E2e18D000F7311",
};
export const SEPOLIA_CSP_VAULT: VaultInfo = {
  ...CSP_VAULT,
  address: "0x02B701210aA006CEAbd389dBc32af0047B1B9bbe",
};

/** Chain time well after `EXPIRY`: a Selling series is expired and unsettled. */
export const AFTER_EXPIRY = EXPIRY + 46_000n;
/** Chain time before `EXPIRY`. */
export const BEFORE_EXPIRY = EXPIRY - 40_000n;

const oracle = {
  status: "Ok" as const,
  ok: true,
  price: 352_453_000_000_000_000_000n,
  updatedAt: 1_790_700_000n,
};

export interface FakeTargetOptions {
  chainId: number;
  chainName: string;
  shortName: string;
  version: string | null;
  registry: string;
  vaults: VaultState[];
  /** Chain time. */
  now?: bigint;
  primary?: boolean;
  /** Overrides on the fake Strike reads. */
  strike?: Record<string, unknown>;
  lastSettlement?: CommandTarget["lastSettlement"];
}

/** A `CommandTarget` over a fake Strike client: Robinhood Chain testnet v2/v3, Arbitrum Sepolia v3 are built from it. */
export function fakeTarget(o: FakeTargetOptions): CommandTarget {
  const now = o.now ?? AFTER_EXPIRY;
  const label = o.version ? `${o.chainName} · ${o.version}` : o.chainName;
  const strike = {
    chainId: o.chainId,
    listVaults: vi.fn(async () => o.vaults),
    quoteBuy: vi.fn(async (_id: bigint, amount: bigint) => ({
      premium: (2_444_436n * amount) / WAD,
      collateral: amount,
    })),
    agentStats: vi.fn(),
    oracleStatus: vi.fn(async () => oracle),
    marketOpen: vi.fn(async () => true),
    saleCutoff: vi.fn(async () => 3600),
    blockTimestamp: vi.fn(async () => now),
    viem: { publicClient: { getBlock: vi.fn(async () => ({ number: 126_332_630n, timestamp: now })) } },
    ...o.strike,
  } as unknown as StrikeReader;
  return {
    key: `${o.chainId}:${o.registry.toLowerCase()}`,
    chainId: o.chainId,
    chainName: o.chainName,
    shortName: o.shortName,
    version: o.version,
    label,
    registry: o.registry,
    usdgDecimals: 6,
    primary: o.primary,
    strike,
    lastSettlement: o.lastSettlement,
  };
}

export const selling = (v: VaultInfo, over: Partial<SeriesState> = {}) =>
  vaultState(v, {
    epoch: { state: "Selling", openedAt: 1_790_700_000n, seriesId: CC_SERIES_STATE.id },
    series: { ...CC_SERIES_STATE, vault: v.address, ...over },
  });

/** Robinhood Chain testnet v2: the call series is Selling, the put vault is Open. */
export const targetV2 = (over: Partial<FakeTargetOptions> = {}) =>
  fakeTarget({
    chainId: 46630,
    chainName: "Robinhood Chain testnet",
    shortName: "RH testnet",
    version: "v2",
    registry: "0xE5b76249041e59C74Ee317fC2729f26249618D32",
    primary: true,
    vaults: [selling(CC_VAULT), vaultState(CSP_VAULT)],
    ...over,
  });

/** Robinhood Chain testnet v3: a Selling call series and an idle put vault. */
export const targetV3 = (over: Partial<FakeTargetOptions> = {}) =>
  fakeTarget({
    chainId: 46630,
    chainName: "Robinhood Chain testnet",
    shortName: "RH testnet",
    version: "v3",
    registry: "0x1c42740145B245b2f894d8e989ca29dfd9A9052f",
    vaults: [
      selling(V3_CC_VAULT, { strike: 369_360_000_000_000_000_000n }),
      vaultState(V3_CSP_VAULT, {
        epoch: { state: "Idle", openedAt: 0n, seriesId: 0n },
        lastProcessedEpoch: 1n,
      }),
    ],
    ...over,
  });

/** Arbitrum Sepolia v3. */
export const targetSepolia = (over: Partial<FakeTargetOptions> = {}) =>
  fakeTarget({
    chainId: 421614,
    chainName: "Arbitrum Sepolia",
    shortName: "Arb Sepolia",
    version: "v3",
    registry: "0xAa3CA7847Af10d94CCD3eF09370Aab580A92341E",
    vaults: [
      selling(SEPOLIA_CC_VAULT, { strike: 364_290_000_000_000_000_000n }),
      vaultState(SEPOLIA_CSP_VAULT, { epoch: { state: "Idle", openedAt: 0n, seriesId: 0n } }),
    ],
    ...over,
  });
