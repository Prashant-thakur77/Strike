/**
 * Values from Robinhood Chain testnet (46630), EpochManager 0x5A3b58DF27e4DD5E0fa6493D90fF653e0E199C99.
 * EpochOpened, SeriesProposed, ProposalRejected and OptionsBought are the real 2026-09-29 logs. Nothing has
 * settled, aborted or been cancelled there yet, so those three use the same vaults and series with made-up
 * outcomes (marked below).
 */
import type { SeriesState, VaultState } from "@strike/sdk";
import type { Address, Hex } from "viem";
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
