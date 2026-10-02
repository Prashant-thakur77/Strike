import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  type Mandate,
  type SeriesState,
  type VaultState,
  formatAmount,
  formatWad,
  wadToNumber,
} from "@strike/sdk";

/** USD price (WAD) as a decimal string with cents precision kept. */
export const usd = (wad: bigint) => formatWad(wad, 4);
/** USDG base units as a decimal string (signed values keep their sign). */
export const usdg = (amount: bigint, decimals = 6) => formatAmount(amount, decimals, 6);
/** Unix seconds as ISO-8601 UTC. */
export const iso = (seconds: bigint | number) => new Date(Number(seconds) * 1000).toISOString();
/** |delta| of a WAD delta, as a number. */
export const absDelta = (delta: bigint) => Math.abs(wadToNumber(delta));

/** A successful tool result: structured content plus the same object as pretty JSON text. */
export function result<T extends Record<string, unknown>>(structured: T): CallToolResult {
  return {
    structuredContent: structured,
    content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
  };
}

/** A failed tool result with a plain-words message. */
export function failure(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** The mandate as numbers plus a one-line summary. */
export function mandateView(m: Mandate) {
  const pct = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
  const days = (s: number) => (s / 86_400).toFixed(2).replace(/\.?0+$/, "");
  return {
    ...m,
    summary:
      `|delta| ${(m.minDeltaBps / 10_000).toFixed(2)}-${(m.maxDeltaBps / 10_000).toFixed(2)}, ` +
      `premium >= ${pct(m.minPremiumBps)} of fair value, yield >= ${pct(m.minYieldBps)} of collateral, ` +
      `size <= ${pct(m.maxShareSoldBps)} of capacity, tenor ${days(m.minTenor)}-${days(m.maxTenor)} days`,
  };
}

/** A series in human units. */
export function seriesView(s: SeriesState, underlyingDecimals: number) {
  return {
    id: s.id.toString(),
    strike: usd(s.strike),
    expiry: Number(s.expiry),
    expiryIso: iso(s.expiry),
    premiumBps: s.premiumBps,
    size: formatAmount(s.size, underlyingDecimals),
    sold: formatAmount(s.sold, underlyingDecimals),
    remaining: formatAmount(s.size - s.sold, underlyingDecimals),
    premiumCollected: usdg(s.premium),
    settled: s.settled,
    cancelled: s.cancelled,
    settlementPrice: s.settlementPrice === 0n ? null : usd(s.settlementPrice),
  };
}

/** Which deployment a vault belongs to: its chain and protocol version (null when the SDK's map names none). */
export interface DeploymentLabel {
  chainId: number;
  version: string | null;
}

/** A vault in human units (used by list_vaults and vault_state), labelled with its chain and deployment version. */
export function vaultView(v: VaultState, label: DeploymentLabel) {
  return {
    address: v.address,
    chainId: label.chainId,
    version: label.version,
    name: v.name,
    symbol: v.symbol,
    kind: v.kind,
    underlying: { address: v.underlying, symbol: v.underlyingSymbol, decimals: v.underlyingDecimals },
    asset: { address: v.asset, symbol: v.assetSymbol, decimals: v.assetDecimals },
    totalAssets: formatAmount(v.totalAssets, v.assetDecimals),
    depositCap: formatAmount(v.depositCap, v.assetDecimals),
    pricePerShare: formatAmount(v.pricePerShare, v.assetDecimals),
    locked: v.locked,
    currentEpoch: Number(v.currentEpoch),
    epochState: v.epoch.state,
    agentId: v.agentId.toString(),
    curator: v.curator,
    sigma: wadToNumber(v.sigma),
    compensation: usdg(v.compensation),
    mandate: mandateView(v.mandate),
    series: v.series ? seriesView(v.series, v.underlyingDecimals) : null,
  };
}
