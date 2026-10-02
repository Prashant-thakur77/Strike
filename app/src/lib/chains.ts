import { strikeChains } from "@strike/sdk";
import { defineChain, type Chain } from "viem";
import { STRIKE_CONFIG, chainConfig } from "./config";

/** Local anvil devnet (strike.config.json's 31337). Override the RPC with NEXT_PUBLIC_LOCAL_RPC. */
export const LOCAL_RPC = process.env.NEXT_PUBLIC_LOCAL_RPC || chainConfig(31337).rpc.public;

export const localChain = defineChain({
  id: 31337,
  name: chainConfig(31337).name,
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

/** Names and the testnet flag from strike.config.json (`name`, `shortName`, `testnet`). */
const meta = (id: AppChainId): ChainMeta => {
  const c = chainConfig(id);
  return { label: c.name, short: c.shortName, testnet: c.testnet };
};

export const CHAIN_META: Record<AppChainId, ChainMeta> = {
  46630: meta(46630),
  421614: meta(421614),
  4663: meta(4663),
  31337: meta(31337),
};

export function isAppChainId(id: unknown): id is AppChainId {
  return appChains.some((c) => c.id === id);
}

const envDefault = Number(process.env.NEXT_PUBLIC_DEFAULT_CHAIN_ID);
const configDefault = STRIKE_CONFIG.defaultChainId;
export const DEFAULT_CHAIN_ID: AppChainId = isAppChainId(envDefault)
  ? envDefault
  : isAppChainId(configDefault)
    ? configDefault
    : 46630;

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

/** An ERC-721 token instance on the chain's Blockscout explorer (ERC-8004 identities are ERC-721s). */
export function explorerNftUrl(id: AppChainId, contract: string, tokenId: bigint): string | null {
  const base = getAppChain(id).blockExplorers?.default.url;
  return base ? `${base}/token/${contract}/instance/${tokenId.toString()}` : null;
}
