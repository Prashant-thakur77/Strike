import { type Chain, defineChain } from "viem";
import { anvil, arbitrum, arbitrumSepolia, robinhood, robinhoodTestnet } from "viem/chains";
import { type StrikeChainConfig, loadStrikeConfig } from "./config.js";

// The chains come from strike.config.json: which chains Strike knows, their public RPC and their block explorer.
// viem's definitions supply the rest (name, native currency, multicall3, formatters): a chain viem knows keeps its
// viem shape with the config's endpoints in it; a chain viem does not know is defined from the config alone.

/** viem's definitions of the chains in strike.config.json, by id. */
const VIEM_CHAINS: Readonly<Record<number, Chain>> = {
  [robinhood.id]: robinhood,
  [robinhoodTestnet.id]: robinhoodTestnet,
  [arbitrum.id]: arbitrum,
  [arbitrumSepolia.id]: arbitrumSepolia,
  [anvil.id]: anvil,
};

/** `base` with the config's public RPC first and the config's explorer (viem's when the config has none). */
function withConfig<T extends Chain>(base: T, c: StrikeChainConfig | undefined): T {
  if (!c) return base;
  const http = [c.rpc.public, ...base.rpcUrls.default.http.filter((u) => u !== c.rpc.public)];
  const explorer = base.blockExplorers?.default;
  return defineChain({
    ...base,
    rpcUrls: { ...base.rpcUrls, default: { ...base.rpcUrls.default, http } },
    ...(c.explorer
      ? {
          blockExplorers: {
            ...base.blockExplorers,
            default: { ...explorer, name: explorer?.name ?? "Explorer", url: c.explorer },
          },
        }
      : {}),
  }) as unknown as T;
}

/** A chain in the config that viem does not define: ETH as gas, the config's RPC, explorer and testnet flag. */
function fromConfig(id: number, c: StrikeChainConfig): Chain {
  return defineChain({
    id,
    name: c.name,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [c.rpc.public] } },
    ...(c.explorer ? { blockExplorers: { default: { name: "Explorer", url: c.explorer } } } : {}),
    testnet: c.testnet,
  });
}

const config = loadStrikeConfig();
const chainConfig = (id: number) => config.chains[String(id)];

/** Chains Strike deploys to. Robinhood Chain first: it is where the stock tokens live. */
export const strikeChains = {
  robinhood: withConfig(robinhood, chainConfig(robinhood.id)),
  robinhoodTestnet: withConfig(robinhoodTestnet, chainConfig(robinhoodTestnet.id)),
  arbitrum: withConfig(arbitrum, chainConfig(arbitrum.id)),
  arbitrumSepolia: withConfig(arbitrumSepolia, chainConfig(arbitrumSepolia.id)),
} as const satisfies Record<string, Chain>;

export type StrikeChainName = keyof typeof strikeChains;

export const strikeChainIds = Object.values(strikeChains).map((c) => c.id);

/** The local anvil devnet (chain 31337) used by `scripts/demo-local.sh` and the end-to-end tests. */
export const strikeLocalChain = withConfig(anvil, chainConfig(anvil.id));

/** The viem chain for a Strike chain id: the four above, the local devnet (31337), or another chain of the config. */
export function getStrikeChain(chainId: number): Chain {
  if (chainId === strikeLocalChain.id) return strikeLocalChain;
  const chain = Object.values(strikeChains).find((c) => c.id === chainId);
  if (chain) return chain;
  const c = chainConfig(chainId);
  if (!c) throw new Error(`Strike is not deployed on chain ${chainId}`);
  const base = VIEM_CHAINS[chainId];
  return base ? withConfig(base, c) : fromConfig(chainId, c);
}
