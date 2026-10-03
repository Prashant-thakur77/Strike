import "server-only";
import { strikeSecretName, type StrikeX402Config } from "@strike/sdk";
import { x402Facilitator } from "@x402/core/facilitator";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { createWalletClient, publicActions, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getAppChain, isAppChainId } from "../chains";
import { serverReadTransport } from "../rpc/server";
import type { Facilitator } from "./paywall";
import { caip2 } from "./requirements";

// The facilitator behind the paid routes. With `x402.facilitator: "self"` (the default) the app is its own x402
// facilitator: x402's ExactEvmScheme verifies each signed EIP-3009 authorization against the chain and settles it by
// sending the token's transferWithAuthorization from a relayer key (X402_RELAYER_KEY, a testnet-only wallet that only
// pays gas; it never holds the payments, which go straight from the payer to `payTo`). No hosted facilitator covers
// Robinhood Chain testnet, so self-hosting is what lets USDG on 46630 work beside USDC on Arbitrum Sepolia (D48).
// With a URL instead, verify and settle go to that facilitator over HTTP.

/** Receipt waits stay under the route's 60 s budget, so a slow chain reports a pending settlement instead. */
const CONFIRMATION_TIMEOUT_MS = 30_000;

let cached: { key: string; facilitator: Facilitator | null } | null = null;

/** The relayer key's environment variable name (strike.config.json secrets.x402RelayerKey). */
export const RELAYER_KEY_ENV = strikeSecretName("x402RelayerKey");

/**
 * The configured facilitator, or null when the app is its own facilitator but has no relayer key (the paid route
 * then still answers 402 with its price, and 503 to a payment). One instance per server process.
 */
export function getFacilitator(
  config: StrikeX402Config,
  env: NodeJS.ProcessEnv = process.env,
): Facilitator | null {
  if (config.facilitator !== "self") {
    const key = `url:${config.facilitator}`;
    if (cached?.key !== key) {
      cached = { key, facilitator: new HTTPFacilitatorClient({ url: config.facilitator }) };
    }
    return cached.facilitator;
  }
  const raw = env[RELAYER_KEY_ENV]?.trim();
  if (!raw || !/^0x[0-9a-fA-F]{64}$/.test(raw)) return null;
  const account = privateKeyToAccount(raw as Hex);
  const key = `self:${account.address}`;
  if (cached?.key === key) return cached.facilitator;

  const facilitator = new x402Facilitator();
  for (const asset of config.assets) {
    if (!isAppChainId(asset.chainId)) continue;
    const client = createWalletClient({
      account,
      chain: getAppChain(asset.chainId),
      transport: serverReadTransport(asset.chainId, { retryCount: 1 }),
    }).extend(publicActions);
    const signer = toFacilitatorEvmSigner(
      Object.assign(client, { address: account.address }) as unknown as Parameters<
        typeof toFacilitatorEvmSigner
      >[0],
      { confirmationTimeoutMs: CONFIRMATION_TIMEOUT_MS },
    );
    facilitator.register(caip2(asset.chainId), new ExactEvmScheme(signer));
  }
  cached = { key, facilitator };
  return facilitator;
}
