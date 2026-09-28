import { strikeChains } from "@strike/sdk";
import { defineChain, type Chain } from "viem";

/** Local anvil devnet. Override the RPC with NEXT_PUBLIC_LOCAL_RPC. */
export const LOCAL_RPC = process.env.NEXT_PUBLIC_LOCAL_RPC || "http://127.0.0.1:8545";

export const localChain = defineChain({
  id: 31337,
  name: "Local devnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [LOCAL_RPC] } },
  testnet: true,
});

/** Networks the app can switch between, in menu order. Robinhood Chain testnet is the default. */
export const appChains = [
  strikeChains.robinhoodTestnet,
  strikeChains.arbitrumSepolia,
  strikeChains.robinhood,
  localChain,
] as const;

export type AppChain = (typeof appChains)[number];
export type AppChainId = AppChain["id"];

interface ChainMeta {
  label: string;
  short: string;
  testnet: boolean;
}

export const CHAIN_META: Record<AppChainId, ChainMeta> = {
  46630: { label: "Robinhood Chain testnet", short: "RH testnet", testnet: true },
  421614: { label: "Arbitrum Sepolia", short: "Arb Sepolia", testnet: true },
  4663: { label: "Robinhood Chain", short: "Robinhood", testnet: false },
  31337: { label: "Local devnet", short: "Local", testnet: true },
};

export function isAppChainId(id: unknown): id is AppChainId {
  return appChains.some((c) => c.id === id);
}

const envDefault = Number(process.env.NEXT_PUBLIC_DEFAULT_CHAIN_ID);
export const DEFAULT_CHAIN_ID: AppChainId = isAppChainId(envDefault) ? envDefault : 46630;

export function getAppChain(id: AppChainId): Chain {
  return appChains.find((c) => c.id === id) ?? appChains[0];
}

export function explorerUrl(id: AppChainId, kind: "address" | "tx", value: string): string | null {
  const base = getAppChain(id).blockExplorers?.default.url;
  return base ? `${base}/${kind}/${value}` : null;
}

/** Optional per-chain RPC overrides (public RPCs are rate-limited). Literal env names so Next can inline them. */
export const RPC_OVERRIDES: Partial<Record<AppChainId, string>> = {
  46630: process.env.NEXT_PUBLIC_RPC_46630 || undefined,
  421614: process.env.NEXT_PUBLIC_RPC_421614 || undefined,
  4663: process.env.NEXT_PUBLIC_RPC_4663 || undefined,
};
