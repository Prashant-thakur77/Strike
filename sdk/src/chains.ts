import type { Chain } from "viem";
import { anvil, arbitrum, arbitrumSepolia, robinhood, robinhoodTestnet } from "viem/chains";

/** Chains Strike deploys to. Robinhood Chain first: it is where the stock tokens live. */
export const strikeChains = {
  robinhood,
  robinhoodTestnet,
  arbitrum,
  arbitrumSepolia,
} as const satisfies Record<string, Chain>;

export type StrikeChainName = keyof typeof strikeChains;

export const strikeChainIds = Object.values(strikeChains).map((c) => c.id);

/** The local anvil devnet (chain 31337) used by `scripts/demo-local.sh` and the end-to-end tests. */
export const strikeLocalChain = anvil;

/** The viem chain for a Strike chain id (including the local devnet, 31337). */
export function getStrikeChain(chainId: number): Chain {
  if (chainId === strikeLocalChain.id) return strikeLocalChain;
  const chain = Object.values(strikeChains).find((c) => c.id === chainId);
  if (!chain) throw new Error(`Strike is not deployed on chain ${chainId}`);
  return chain;
}
