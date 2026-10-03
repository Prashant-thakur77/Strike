import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { StrikeX402Config } from "@strike/sdk";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { verifyTypedData, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { allowedRequirement, createX402Payer, x402Limits } from "../src/x402.js";

// The agent's paying fetch (src/x402.ts) against a stub paid route: it pays a 402 with a valid EIP-3009 signature for
// the exact price, records the settlement, keeps to the run's spending cap, refuses a payee or token that
// strike.config.json does not list, and gives back the budget of a payment the server did not settle.

const config = JSON.parse(readFileSync(join(import.meta.dirname, "../../strike.config.json"), "utf8"))
  .x402 as StrikeX402Config;
const usdc = config.assets[0]!;
const req = (over: Partial<PaymentRequirements> = {}): PaymentRequirements => ({
  scheme: "exact",
  network: `eip155:${usdc.chainId}`,
  asset: usdc.address,
  amount: "10000",
  payTo: config.payTo,
  maxTimeoutSeconds: 120,
  extra: { name: usdc.eip712Name, version: usdc.eip712Version },
  ...over,
});
const URL_ =
  "https://strike.test/api/agent/risk-report?chain=421614&vault=0x5655659E18bf54ee0EF8f6A816E2e18D000F7311";

/** A stub paid route: 402 with `accepts`; with a valid signature for the price, 200 and a settlement (or a failure). */
function stub(accepts: PaymentRequirements[], settle = true) {
  let n = 0;
  const seen: Hex[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const sig = h.get("PAYMENT-SIGNATURE");
    const required: PaymentRequired = {
      x402Version: 2,
      resource: { url: URL_, description: "risk report", mimeType: "application/json" },
      accepts,
    };
    if (!sig) {
      return new Response(JSON.stringify(required), {
        status: 402,
        headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required) },
      });
    }
    const p = decodePaymentSignatureHeader(sig);
    const a = p.payload.authorization as Record<string, string>;
    const ok = await verifyTypedData({
      address: a.from as Address,
      domain: {
        name: String(p.accepted.extra.name),
        version: String(p.accepted.extra.version),
        chainId: Number(p.accepted.network.split(":")[1]),
        verifyingContract: p.accepted.asset as Address,
      },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: {
        from: a.from as Address,
        to: a.to as Address,
        value: BigInt(a.value!),
        validAfter: BigInt(a.validAfter!),
        validBefore: BigInt(a.validBefore!),
        nonce: a.nonce as Hex,
      },
      signature: p.payload.signature as Hex,
    });
    expect(ok).toBe(true);
    expect(a.value).toBe(p.accepted.amount);
    expect(a.to!.toLowerCase()).toBe(p.accepted.payTo.toLowerCase());
    seen.push(a.nonce as Hex);
    const tx = `0x${(++n).toString(16).padStart(64, "0")}`;
    const res = settle
      ? { success: true, transaction: tx, network: p.accepted.network, payer: a.from }
      : { success: false, errorReason: "settlement_failed", transaction: "", network: p.accepted.network };
    return new Response(JSON.stringify({ report: "strike.risk-report" }), {
      status: settle ? 200 : 402,
      headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader(res as never) },
    });
  };
  return { fetch, seen };
}

const key = generatePrivateKey();

describe("x402 payer", () => {
  it("pays a 402 with a signed authorization for the exact price and records the settlement", async () => {
    const { fetch, seen } = stub([req()]);
    const payer = createX402Payer({ config, privateKey: key, fetch });
    const res = await payer.fetch(URL_);
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    const [p] = payer.payments();
    expect(p).toMatchObject({
      endpoint: URL_,
      network: "eip155:421614",
      chainId: 421614,
      symbol: "USDC",
      amount: "0.01",
      amountAtomic: "10000",
      payer: privateKeyToAccount(key).address,
      transaction: `0x${"1".padStart(64, "0")}`,
    });
    expect(payer.budget().spentAtomic).toBe(10_000n);
  });

  it("keeps to the run's spending cap", async () => {
    const { fetch, seen } = stub([req()]);
    const payer = createX402Payer({ config, privateKey: key, fetch, capUnits: "0.02" });
    expect((await payer.fetch(URL_)).status).toBe(200);
    expect((await payer.fetch(URL_)).status).toBe(200);
    await expect(payer.fetch(URL_)).rejects.toThrow(/spending cap/);
    expect(seen).toHaveLength(2);
    expect(payer.payments()).toHaveLength(2);
    expect(payer.budget()).toMatchObject({ capAtomic: 20_000n, spentAtomic: 20_000n, remainingAtomic: 0n });
  });

  it("defaults the cap to strike.config.json's agentRunCap", () => {
    expect(x402Limits(config).cap).toBe(50_000n);
    expect(x402Limits(config).maxPrice).toBe(10_000n);
  });

  it("refuses a payee, token or price strike.config.json does not list", async () => {
    const other = privateKeyToAccount(generatePrivateKey()).address;
    const { maxPrice } = x402Limits(config);
    expect(allowedRequirement(config, req(), maxPrice)).toBe(true);
    expect(allowedRequirement(config, req({ payTo: other }), maxPrice)).toBe(false);
    expect(allowedRequirement(config, req({ asset: other }), maxPrice)).toBe(false);
    expect(allowedRequirement(config, req({ amount: "10001" }), maxPrice)).toBe(false);
    const { fetch, seen } = stub([req({ payTo: other })]);
    const payer = createX402Payer({ config, privateKey: key, fetch });
    await expect(payer.fetch(URL_)).rejects.toThrow();
    expect(seen).toHaveLength(0);
  });

  it("prefers the configured chain when the route accepts several", async () => {
    const usdg = config.assets[1]!;
    const g = req({
      network: `eip155:${usdg.chainId}`,
      asset: usdg.address,
      extra: { name: usdg.eip712Name, version: usdg.eip712Version },
    });
    const { fetch } = stub([req(), g]);
    const payer = createX402Payer({ config, privateKey: key, fetch, preferredChainId: 46630 });
    await payer.fetch(URL_);
    expect(payer.payments()[0]).toMatchObject({ chainId: 46630, symbol: "USDG" });
  });

  it("gives back the budget of a payment the server did not settle", async () => {
    const { fetch } = stub([req()], false);
    const payer = createX402Payer({ config, privateKey: key, fetch, capUnits: "0.01" });
    const res = await payer.fetch(URL_);
    expect(res.status).toBe(402);
    expect(payer.payments()).toHaveLength(0);
    expect(payer.budget().spentAtomic).toBe(0n);
  });
});
