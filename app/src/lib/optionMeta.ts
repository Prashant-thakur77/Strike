import { epochManagerAbi } from "@strike/sdk";
import { createPublicClient, erc20Abi, zeroAddress, type Address } from "viem";
import { DEFAULT_CHAIN_ID, getAppChain, isAppChainId, type AppChainId } from "./chains";
import { serverReadTransport } from "./rpc/server";
import { findDeployment } from "./deployment";
import { toNumber } from "./format";

export interface OptionMeta {
  chainId: AppChainId;
  hexId: string;
  vault: Address;
  symbol: string;
  decimals: number;
  isCall: boolean;
  strike: number;
  expiry: number;
  settled: boolean;
  cancelled: boolean;
  settlementPrice: number | null;
  premiumBps: number;
}

export class OptionMetaError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** ERC-1155 `{id}`: 64 lowercase hex chars without 0x (a ".json" suffix and a 0x prefix are tolerated). */
export function parseOptionId(raw: string): { id: bigint; hex: string } {
  const hex = decodeURIComponent(raw)
    .replace(/\.json$/i, "")
    .replace(/^0x/i, "")
    .toLowerCase();
  if (!/^[0-9a-f]{1,64}$/.test(hex)) throw new OptionMetaError("Invalid option id", 400);
  return { id: BigInt(`0x${hex}`), hex: hex.padStart(64, "0") };
}

export function parseChainId(raw: string | null): AppChainId {
  if (raw === null || raw === "") return DEFAULT_CHAIN_ID;
  const id = Number(raw);
  if (!isAppChainId(id)) throw new OptionMetaError(`Unsupported chain ${raw}`, 400);
  return id;
}

export async function loadOption(chainId: AppChainId, raw: string): Promise<OptionMeta> {
  const { id, hex } = parseOptionId(raw);
  const dep = findDeployment(chainId);
  if (!dep) throw new OptionMetaError(`Strike is not deployed on chain ${chainId}`, 404);
  const client = createPublicClient({ chain: getAppChain(chainId), transport: serverReadTransport(chainId) });
  let series;
  try {
    series = await client.readContract({
      address: dep.epochManager,
      abi: epochManagerAbi,
      functionName: "getSeries",
      args: [id],
    });
  } catch {
    throw new OptionMetaError("Could not read the series from the chain", 502);
  }
  if (series.vault === zeroAddress) throw new OptionMetaError("Unknown option series", 404);
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address: series.underlying, abi: erc20Abi, functionName: "symbol" }),
    client.readContract({ address: series.underlying, abi: erc20Abi, functionName: "decimals" }),
  ]);
  return {
    chainId,
    hexId: hex,
    vault: series.vault,
    symbol,
    decimals,
    isCall: series.isCall,
    strike: toNumber(series.strike, 18),
    expiry: Number(series.expiry),
    settled: series.settled,
    cancelled: series.cancelled,
    settlementPrice:
      series.settled && series.settlementPrice > 0n ? toNumber(series.settlementPrice, 18) : null,
    premiumBps: series.premiumBps,
  };
}

export function strikeLabel(strike: number): string {
  return Number.isInteger(strike)
    ? strike.toLocaleString("en-US")
    : strike.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function expiryLabel(expiry: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/New_York",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(expiry * 1000));
}

export function optionName(o: OptionMeta): string {
  return `${o.symbol} ${strikeLabel(o.strike)} ${o.isCall ? "Call" : "Put"} · ${expiryLabel(o.expiry)}`;
}

export function optionStatus(o: OptionMeta): "Live" | "Settled" | "Cancelled" {
  return o.cancelled ? "Cancelled" : o.settled ? "Settled" : "Live";
}

export function optionMetadata(o: OptionMeta, origin: string) {
  const kind = o.isCall ? "call" : "put";
  const pays = o.isCall
    ? `pays (S − K) / S ${o.symbol} per option when the settlement price S is above the strike`
    : "pays (K − S) USDG per option when the settlement price S is below the strike";
  return {
    name: optionName(o),
    description:
      `A Strike ${kind} option on the ${o.symbol} stock token, strike $${strikeLabel(o.strike)}, ` +
      `European and cash-settled at 16:00 New York on ${expiryLabel(o.expiry)}. It ${pays}. ` +
      `Written by Strike vault ${o.vault}. Unaudited testnet software.`,
    image: `${origin}/api/option/${o.hexId}/image?chainId=${o.chainId}`,
    external_url: `${origin}/app/vault/${o.vault}?chain=${o.chainId}`,
    decimals: o.decimals,
    attributes: [
      { trait_type: "Underlying", value: o.symbol },
      { trait_type: "Type", value: o.isCall ? "Call" : "Put" },
      { trait_type: "Strike (USD)", value: o.strike, display_type: "number" },
      { trait_type: "Expiry", value: new Date(o.expiry * 1000).toISOString() },
      { trait_type: "Expiry (unix)", value: o.expiry, display_type: "date" },
      { trait_type: "Vault", value: o.vault },
      { trait_type: "Status", value: optionStatus(o) },
      { trait_type: "Settled", value: o.settled },
      { trait_type: "Settlement price (USD)", value: o.settlementPrice },
      { trait_type: "Chain id", value: o.chainId },
    ],
  };
}

export const CACHE_HEADERS = {
  "Cache-Control": "public, max-age=60, s-maxage=60, stale-while-revalidate=300",
  "Access-Control-Allow-Origin": "*",
} as const;
