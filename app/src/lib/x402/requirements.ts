import type { StrikeX402Asset, StrikeX402Config } from "@strike/sdk";
import type { PaymentRequirements } from "@x402/core/types";
import { getAddress, parseUnits } from "viem";

// x402 payment requirements for a paid route, from strike.config.json's `x402` section (docs/ENDPOINTS.md). Pure: the
// config is passed in, so the Playwright tests build requirements from fixtures. One entry per accepted token, the
// preferred first; each is the x402 "exact" scheme (an EIP-3009 transferWithAuthorization for exactly `amount`), with
// the token's EIP-712 domain in `extra` so a client can sign without reading the chain.

export const DEFAULT_MAX_TIMEOUT_SECONDS = 120;

/** A paid route's name, path, price and description; throws when the config does not define it. */
export function paidRoute(config: StrikeX402Config | undefined, name: string) {
  const route = config?.routes[name];
  if (!config || !route) throw new Error(`strike.config.json defines no x402 route "${name}"`);
  return { name, ...route };
}

/** CAIP-2 network id of an EVM chain: eip155:421614. */
export const caip2 = (chainId: number) => `eip155:${chainId}` as const;

/** The chain id of an eip155 CAIP-2 network, or null. */
export function chainIdOf(network: string): number | null {
  const m = /^eip155:([1-9]\d*)$/.exec(network);
  return m ? Number(m[1]) : null;
}

/** One requirement: `price` (token units, "0.01") of `asset`, paid to `payTo`. */
export function requirementFor(
  config: StrikeX402Config,
  asset: StrikeX402Asset,
  price: string,
): PaymentRequirements {
  return {
    scheme: config.scheme,
    network: caip2(asset.chainId),
    asset: getAddress(asset.address),
    amount: parseUnits(price, asset.decimals).toString(),
    payTo: getAddress(config.payTo),
    maxTimeoutSeconds: config.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS,
    extra: {
      name: asset.eip712Name,
      version: asset.eip712Version,
      symbol: asset.symbol,
      decimals: asset.decimals,
    },
  };
}

/** Every accepted token's requirement for the route, in the config's order. */
export function routeRequirements(config: StrikeX402Config, routeName: string): PaymentRequirements[] {
  const route = paidRoute(config, routeName);
  return config.assets.map((a) => requirementFor(config, a, route.price));
}

/** The price as a person reads it: "0.01 USDC on eip155:421614". */
export function priceText(r: PaymentRequirements): string {
  const decimals = Number(r.extra.decimals ?? 6);
  const units = Number(r.amount) / 10 ** decimals;
  return `${units} ${String(r.extra.symbol ?? r.asset)} on ${r.network}`;
}
