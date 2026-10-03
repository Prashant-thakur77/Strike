import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { StrikeX402Config } from "@strike/sdk";
import { x402Client } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme as ExactEvmClient } from "@x402/evm/exact/client";
import { ExactEvmScheme as ExactEvmFacilitator } from "@x402/evm/exact/facilitator";
import { getAddress, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { NonceLedger, handlePaidRequest, type Facilitator, type PaidResult } from "../src/lib/x402/paywall";
import { routeRequirements } from "../src/lib/x402/requirements";
import { FakeToken, signAuthorization } from "./fixtures/x402Token";

// The paid risk report's x402 flow (src/lib/x402/paywall.ts) with strike.config.json's real prices and tokens, and
// x402's real ExactEvmScheme facilitator over an in-memory EIP-3009 token (fixtures/x402Token.ts): the 402 shape, a
// payment made by x402's own client, and each refusal (a forged signature, a replayed nonce, the wrong amount, the
// wrong recipient, an expired authorization), a deployment without a relayer key, and a report that fails (not
// charged). Then the built route: 402 without a payment, 400 for a bad query. No chain, no browser.

const config = JSON.parse(readFileSync(join(__dirname, "../../strike.config.json"), "utf8"))
  .x402 as StrikeX402Config;
const requirements = routeRequirements(config, "riskReport");
const usdc = requirements[0] as PaymentRequirements;
const payer = privateKeyToAccount(generatePrivateKey());
const relayer = privateKeyToAccount(generatePrivateKey()).address;
const URL_ =
  "https://strike-options.vercel.app/api/agent/risk-report?chain=421614&vault=0x5655659E18bf54ee0EF8f6A816E2e18D000F7311";
const REPORT: PaidResult = {
  status: 200,
  body: { report: "strike.risk-report", vault: { symbol: "sTSLA-CC" } },
};

function setup(
  opts: { facilitator?: boolean; produce?: () => Promise<PaidResult>; nonces?: NonceLedger } = {},
) {
  const asset = config.assets[0]!;
  const token = new FakeToken({
    address: asset.address,
    chainId: asset.chainId,
    name: asset.eip712Name,
    version: asset.eip712Version,
    relayer,
    balances: { [payer.address]: 1_000_000n },
  });
  const facilitator = new x402Facilitator().register(
    `eip155:${asset.chainId}`,
    new ExactEvmFacilitator(token.signer() as never),
  );
  const nonces = opts.nonces ?? new NonceLedger();
  const call = (header?: string) =>
    handlePaidRequest(new Request(URL_, { headers: header ? { "PAYMENT-SIGNATURE": header } : {} }), {
      requirements,
      resource: { url: URL_, description: "risk report", mimeType: "application/json" },
      facilitator: opts.facilitator === false ? null : (facilitator as Facilitator),
      produce: opts.produce ?? (async () => REPORT),
      nonces,
    });
  return { token, call, nonces };
}

/** A payment header for `accepted`, signed over `message` (defaults: the exact price to the payee, valid now). */
async function header(
  accepted: PaymentRequirements,
  message: Partial<{ to: Address; value: bigint; validAfter: bigint; validBefore: bigint; nonce: Hex }> = {},
  signer = payer,
): Promise<string> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const m = {
    from: payer.address,
    to: getAddress(accepted.payTo),
    value: BigInt(accepted.amount),
    validAfter: now - 60n,
    validBefore: now + 120n,
    nonce: toHex(crypto.getRandomValues(new Uint8Array(32))),
    ...message,
  };
  const asset = config.assets[0]!;
  const signature = await signAuthorization(
    signer as never,
    {
      address: asset.address,
      chainId: asset.chainId,
      name: asset.eip712Name,
      version: asset.eip712Version,
      relayer,
      balances: {},
    },
    m,
  );
  const payload: PaymentPayload = {
    x402Version: 2,
    accepted,
    payload: {
      signature,
      authorization: {
        from: m.from,
        to: m.to,
        value: m.value.toString(),
        validAfter: m.validAfter.toString(),
        validBefore: m.validBefore.toString(),
        nonce: m.nonce,
      },
    },
  };
  return encodePaymentSignatureHeader(payload);
}

test.describe("x402 paid risk report: flow", () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "no browser needed"));

  test("402 names the price in each accepted token, in the body and in PAYMENT-REQUIRED", async () => {
    const { call } = setup();
    const res = await call();
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.x402Version).toBe(2);
    expect(body.resource.url).toBe(URL_);
    expect(body.accepts).toHaveLength(2);
    expect(body.accepts[0]).toMatchObject({
      scheme: "exact",
      network: "eip155:421614",
      asset: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
      amount: "10000",
      payTo: config.payTo,
      extra: { name: "USD Coin", version: "2", symbol: "USDC" },
    });
    expect(body.accepts[1]).toMatchObject({
      network: "eip155:46630",
      asset: "0x7E955252E15c84f5768B83c41a71F9eba181802F",
      amount: "10000",
      extra: { name: "Global Dollar", version: "1", symbol: "USDG" },
    });
    expect(decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED")!)).toEqual(body);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  test("x402's own client pays: verified, settled, report returned with PAYMENT-RESPONSE", async () => {
    const { call, token } = setup();
    const challenge = decodePaymentRequiredHeader((await call()).headers.get("PAYMENT-REQUIRED")!);
    const client = new x402Client().register("eip155:421614", new ExactEvmClient(payer));
    const payload = await client.createPaymentPayload(challenge);
    const res = await call(encodePaymentSignatureHeader(payload));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.vault.symbol).toBe("sTSLA-CC");
    expect(body.payment).toMatchObject({
      network: "eip155:421614",
      amount: "10000",
      symbol: "USDC",
      payer: payer.address,
      transaction: token.sent[0],
    });
    const settled = decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE")!);
    expect(settled).toMatchObject({ success: true, transaction: token.sent[0], network: "eip155:421614" });
    expect(res.headers.get("X-PAYMENT-RESPONSE")).toBe(res.headers.get("PAYMENT-RESPONSE"));
    expect(token.balanceOf(payer.address)).toBe(990_000n);
    expect(token.balanceOf(config.payTo)).toBe(10_000n);
  });

  test("the v1 header name X-PAYMENT is accepted", async () => {
    const { token, nonces } = setup();
    const facilitator = new x402Facilitator().register(
      "eip155:421614",
      new ExactEvmFacilitator(token.signer() as never),
    );
    const res = await handlePaidRequest(new Request(URL_, { headers: { "X-PAYMENT": await header(usdc) } }), {
      requirements,
      resource: { url: URL_, description: "risk report", mimeType: "application/json" },
      facilitator: facilitator as Facilitator,
      produce: async () => REPORT,
      nonces,
    });
    expect(res.status).toBe(200);
  });

  test("a signature by another key is refused, nothing moves", async () => {
    const { call, token } = setup();
    const res = await call(await header(usdc, {}, privateKeyToAccount(generatePrivateKey())));
    expect(res.status).toBe(402);
    expect((await res.json()).error).toContain("invalid_exact_evm_signature");
    expect(token.sent).toHaveLength(0);
  });

  test("a replayed authorization is refused: by this instance, and by the token's nonce on another", async () => {
    const { call, token } = setup();
    const h = await header(usdc);
    expect((await call(h)).status).toBe(200);
    const again = await call(h);
    expect(again.status).toBe(402);
    expect((await again.json()).error).toContain("nonce_already_used");
    // A fresh instance (empty ledger) over the same chain: the token's authorizationState refuses it.
    const other = await handlePaidRequest(new Request(URL_, { headers: { "PAYMENT-SIGNATURE": h } }), {
      requirements,
      resource: { url: URL_, description: "risk report", mimeType: "application/json" },
      facilitator: new x402Facilitator().register(
        "eip155:421614",
        new ExactEvmFacilitator(token.signer() as never),
      ) as Facilitator,
      produce: async () => REPORT,
      nonces: new NonceLedger(),
    });
    expect(other.status).toBe(402);
    expect((await other.json()).error).toContain("invalid_exact_evm_nonce_already_used");
    expect(token.sent).toHaveLength(1);
    expect(token.balanceOf(payer.address)).toBe(990_000n);
  });

  test("the wrong amount is refused: a smaller signed value, or a requirement this route does not offer", async () => {
    const { call, token } = setup();
    const less = await call(await header(usdc, { value: 5_000n }));
    expect(less.status).toBe(402);
    expect((await less.json()).error).toContain("invalid_exact_evm_payload_authorization_value_mismatch");
    const cheap = await call(await header({ ...usdc, amount: "5000" }, { value: 5_000n }));
    expect(cheap.status).toBe(402);
    expect((await cheap.json()).error).toContain("no_matching_requirement");
    expect(token.sent).toHaveLength(0);
  });

  test("the wrong recipient is refused", async () => {
    const { call, token } = setup();
    const attacker = privateKeyToAccount(generatePrivateKey()).address;
    const res = await call(await header(usdc, { to: attacker }));
    expect(res.status).toBe(402);
    expect((await res.json()).error).toContain("invalid_exact_evm_recipient_mismatch");
    const otherPayee = await call(await header({ ...usdc, payTo: attacker }, { to: attacker }));
    expect((await otherPayee.json()).error).toContain("no_matching_requirement");
    expect(token.sent).toHaveLength(0);
  });

  test("an expired authorization is refused", async () => {
    const { call, token } = setup();
    const now = BigInt(Math.floor(Date.now() / 1000));
    const res = await call(await header(usdc, { validAfter: now - 600n, validBefore: now - 10n }));
    expect(res.status).toBe(402);
    expect((await res.json()).error).toContain("invalid_exact_evm_payload_authorization_valid_before");
    expect(token.sent).toHaveLength(0);
  });

  test("a garbled header is a 402 with the reason", async () => {
    const { call } = setup();
    const res = await call("not-base64-json");
    expect(res.status).toBe(402);
    expect((await res.json()).error).toContain("invalid_payment_header");
  });

  test("without a relayer key a payment gets 503 and nothing is charged", async () => {
    const { call, token } = setup({ facilitator: false });
    expect((await call()).status).toBe(402);
    const res = await call(await header(usdc));
    expect(res.status).toBe(503);
    expect(token.sent).toHaveLength(0);
  });

  test("a report that cannot be built is not charged, and the same payment can be retried", async () => {
    const nonces = new NonceLedger();
    let fail = true;
    const { call, token } = setup({
      nonces,
      produce: async () => (fail ? { status: 502, body: { error: "rpc down" } } : REPORT),
    });
    const h = await header(usdc);
    const res = await call(h);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "rpc down", charged: false });
    expect(token.sent).toHaveLength(0);
    fail = false;
    expect((await call(h)).status).toBe(200);
    expect(token.sent).toHaveLength(1);
  });
});

test.describe("x402 paid risk report: route", () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "no browser needed"));

  test("GET without a payment is 402 with the configured price; a bad query is 400 before any payment", async ({
    request,
  }) => {
    const ok = await request.get(
      "/api/agent/risk-report?chain=421614&vault=0x5655659E18bf54ee0EF8f6A816E2e18D000F7311",
    );
    expect(ok.status()).toBe(402);
    const body = await ok.json();
    expect(body.accepts.map((a: PaymentRequirements) => a.network)).toEqual([
      "eip155:421614",
      "eip155:46630",
    ]);
    expect(body.accepts[0].amount).toBe("10000");
    expect(decodePaymentRequiredHeader(ok.headers()["payment-required"]!)).toEqual(body);
    const bad = await request.get("/api/agent/risk-report?chain=421614&vault=nope");
    expect(bad.status()).toBe(400);
    const chain = await request.get(
      "/api/agent/risk-report?chain=1&vault=0x5655659E18bf54ee0EF8f6A816E2e18D000F7311",
    );
    expect(chain.status()).toBe(400);
  });

  test("the free routes stay free", async ({ request }) => {
    expect((await request.get("/api/health")).status()).toBe(200);
  });
});
