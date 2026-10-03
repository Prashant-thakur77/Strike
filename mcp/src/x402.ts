import type { StrikeX402Config } from "@strike/sdk";
import { x402Client } from "@x402/core/client";
import { decodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { getAddress, parseUnits, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// The agent side of x402 (docs/STRIKE_SKILL.md): a fetch that pays Strike's paid routes by itself. On a 402 it signs
// an EIP-3009 transferWithAuthorization for the exact price with the payer's key (no gas: the server's relayer sends
// it), retries with PAYMENT-SIGNATURE and reads the settlement from PAYMENT-RESPONSE. It pays only what
// strike.config.json lists: a token in `x402.assets`, the configured `payTo`, at most one route's price per call,
// and never more than `capUnits` in total over the payer's life (one agent run: the MCP server is started per run).
// A payment the server did not settle is given back to the budget.

/** One settled payment, as the decision record stores it. */
export interface X402Payment {
  endpoint: string;
  network: string;
  chainId: number;
  asset: string;
  symbol: string;
  /** Token units, e.g. "0.01". */
  amount: string;
  /** Atomic units, e.g. "10000". */
  amountAtomic: string;
  payer: string;
  payTo: string;
  transaction: string;
  /** ISO-8601 UTC. */
  paidAt: string;
}

export interface X402PayerOptions {
  config: StrikeX402Config;
  privateKey: Hex;
  /** Total the payer may spend, in token units ("0.05"); default `config.agentRunCap`, else one call's price. */
  capUnits?: string;
  /** Pay on this chain when the route accepts it (else the first accepted token the payer can pay). */
  preferredChainId?: number;
  fetch?: typeof globalThis.fetch;
}

export interface X402Payer {
  address: string;
  /** fetch that pays a 402 within the rules above. */
  fetch: typeof globalThis.fetch;
  /** Settled payments, oldest first. */
  payments(): X402Payment[];
  /** Spent and remaining budget, in atomic units of a 6-decimal token. */
  budget(): { capAtomic: bigint; spentAtomic: bigint; remainingAtomic: bigint };
}

/** The payer's cap and the largest single price, in atomic units (all accepted tokens share decimals). */
export function x402Limits(config: StrikeX402Config, capUnits?: string) {
  const decimals = config.assets[0]?.decimals ?? 6;
  if (config.assets.some((a) => a.decimals !== decimals)) {
    throw new Error("x402: accepted tokens must share their decimals for one spending cap");
  }
  const prices = Object.values(config.routes).map((r) => parseUnits(r.price, decimals));
  const maxPrice = prices.reduce((a, b) => (b > a ? b : a), 0n);
  const cap = parseUnits(capUnits ?? config.agentRunCap ?? formatPrice(maxPrice, decimals), decimals);
  return { decimals, maxPrice, cap };
}

const formatPrice = (atomic: bigint, decimals: number) => (Number(atomic) / 10 ** decimals).toString();

/** Whether a requirement is one strike.config.json lets the payer pay: listed token, configured payee, scheme, price. */
export function allowedRequirement(
  config: StrikeX402Config,
  r: PaymentRequirements,
  maxPrice: bigint,
): boolean {
  const chainId = /^eip155:(\d+)$/.exec(r.network)?.[1];
  const asset = config.assets.find(
    (a) => String(a.chainId) === chainId && a.address.toLowerCase() === r.asset.toLowerCase(),
  );
  return (
    !!asset &&
    r.scheme === config.scheme &&
    r.payTo.toLowerCase() === config.payTo.toLowerCase() &&
    /^\d+$/.test(r.amount) &&
    BigInt(r.amount) <= maxPrice
  );
}

/** A paying fetch for one agent run. */
export function createX402Payer(options: X402PayerOptions): X402Payer {
  const { config } = options;
  const account = privateKeyToAccount(options.privateKey);
  const { decimals, maxPrice, cap } = x402Limits(config, options.capUnits);
  let spent = 0n;
  const settled: X402Payment[] = [];

  const client = new x402Client((_version, reqs) => {
    const preferred = reqs.find((r) => r.network === `eip155:${options.preferredChainId}`);
    return preferred ?? reqs[0]!;
  });
  const scheme = new ExactEvmScheme(account);
  for (const a of config.assets) client.register(`eip155:${a.chainId}`, scheme);
  client.setSpendControls({
    maxAmountPerPayment: false,
    allowedAssets: config.assets.map((a) => ({
      network: `eip155:${a.chainId}` as const,
      asset: getAddress(a.address),
      maxAmountPerPayment: maxPrice.toString(),
    })),
  });
  client.registerPolicy((_version, reqs) => reqs.filter((r) => allowedRequirement(config, r, maxPrice)));
  // The run's budget: refuse to sign past the cap; a signed payment counts until the server says it did not settle.
  let pending: { amount: bigint; req: PaymentRequirements } | null = null;
  client.onBeforePaymentCreation(async ({ selectedRequirements: r }) => {
    const amount = BigInt(r.amount);
    if (spent + amount > cap) {
      return {
        abort: true,
        reason: `x402 spending cap: ${formatPrice(spent, decimals)} of ${formatPrice(cap, decimals)} spent this run, ${formatPrice(amount, decimals)} more refused`,
      };
    }
  });
  client.onAfterPaymentCreation(async ({ selectedRequirements: r }) => {
    const amount = BigInt(r.amount);
    spent += amount;
    pending = { amount, req: r };
  });

  const paying = wrapFetchWithPayment(options.fetch ?? globalThis.fetch, client);
  const payingFetch: typeof globalThis.fetch = async (input, init) => {
    pending = null;
    const res = await paying(input, init);
    const p = pending as { amount: bigint; req: PaymentRequirements } | null;
    if (!p) return res;
    const header = res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
    let settlement: ReturnType<typeof decodePaymentResponseHeader> | null = null;
    try {
      settlement = header ? decodePaymentResponseHeader(header) : null;
    } catch {
      settlement = null;
    }
    if (!res.ok || !settlement?.success || !settlement.transaction) {
      spent -= p.amount; // not settled: nothing left the wallet
      return res;
    }
    const chainId = Number(/^eip155:(\d+)$/.exec(p.req.network)?.[1] ?? 0);
    const asset = config.assets.find((a) => a.chainId === chainId);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    settled.push({
      endpoint: url,
      network: p.req.network,
      chainId,
      asset: getAddress(p.req.asset),
      symbol: asset?.symbol ?? String(p.req.extra?.symbol ?? ""),
      amount: formatPrice(p.amount, decimals),
      amountAtomic: p.amount.toString(),
      payer: settlement.payer ?? account.address,
      payTo: getAddress(p.req.payTo),
      transaction: settlement.transaction,
      paidAt: new Date().toISOString(),
    });
    return res;
  };

  return {
    address: account.address,
    fetch: payingFetch,
    payments: () => [...settled],
    budget: () => ({ capAtomic: cap, spentAtomic: spent, remainingAtomic: cap - spent }),
  };
}
