import type { Chain } from "viem";
import { arbitrum, arbitrumSepolia, robinhood, robinhoodTestnet } from "viem/chains";

/** Chains Strike deploys to. Robinhood Chain first: it is where the stock tokens live. */
export const strikeChains = {
  robinhood,
  robinhoodTestnet,
  arbitrum,
  arbitrumSepolia,
} as const satisfies Record<string, Chain>;

export type StrikeChainName = keyof typeof strikeChains;

export const strikeChainIds = Object.values(strikeChains).map((c) => c.id);

export function getStrikeChain(chainId: number): Chain {
  const chain = Object.values(strikeChains).find((c) => c.id === chainId);
  if (!chain) throw new Error(`Strike is not deployed on chain ${chainId}`);
  return chain;
}
