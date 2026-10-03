import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";

// The x402 flow for one paid request (x402 v2, docs/ENDPOINTS.md). Pure apart from the facilitator it is given, so
// the Playwright tests drive it with a fake token. In order:
//
//   1. no payment header: 402 with the payment requirements, in the body and base64 in PAYMENT-REQUIRED;
//   2. a header that does not decode, or names no requirement this route offers: 402 with the reason;
//   3. the payment's nonce already seen by this instance: 402 (the token's authorizationState refuses a reuse
//      on-chain too, and the facilitator checks it before settling);
//   4. no facilitator configured (no relayer key): 503, nothing charged;
//   5. the facilitator verifies the signed authorization (signature, recipient, amount, validity window, balance,
//      nonce unused): invalid is a 402 with the facilitator's reason;
//   6. the resource is produced; if that fails, nothing is settled and the caller is not charged;
//   7. the facilitator settles (sends transferWithAuthorization); a failure is a 402;
//   8. 200 with the resource, a `payment` receipt and the settlement in PAYMENT-RESPONSE (and X-PAYMENT-RESPONSE).
//
// The request header is PAYMENT-SIGNATURE (v2); X-PAYMENT, its v1 name, is accepted for older clients.

export const PAYMENT_HEADERS = ["payment-signature", "x-payment"] as const;

/** The verify and settle half of a facilitator: x402's local x402Facilitator or an HTTPFacilitatorClient. */
export interface Facilitator {
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
}

/** What the paid resource returns: a JSON body and a status; a status of 400 or more is not charged. */
export interface PaidResult {
  status: number;
  body: Record<string, unknown>;
}

export interface PaidRequestOptions {
  requirements: PaymentRequirements[];
  resource: { url: string; description: string; mimeType: string };
  /** null when the deployment has no relayer key: requests with a payment get 503. */
  facilitator: Facilitator | null;
  produce: () => Promise<PaidResult>;
  /** Nonces this instance has accepted (shared across requests); see {@link NonceLedger}. */
  nonces: NonceLedger;
  /** Extra response headers (CORS). */
  headers?: Record<string, string>;
}

/**
 * Nonces of payments this instance has taken past verification. A second request with the same authorization is
 * refused here before any chain read; across instances the token's own authorizationState does the same.
 */
export class NonceLedger {
  private readonly seen = new Map<string, number>();
  constructor(private readonly ttlMs = 24 * 3600_000) {}
  private key(network: string, asset: string, from: string, nonce: string) {
    return `${network}:${asset}:${from}:${nonce}`.toLowerCase();
  }
  /** Claim a nonce; false when it was already claimed and not released. */
  claim(network: string, asset: string, from: string, nonce: string, now = Date.now()): boolean {
    for (const [k, t] of this.seen) if (now - t > this.ttlMs) this.seen.delete(k);
    const k = this.key(network, asset, from, nonce);
    if (this.seen.has(k)) return false;
    this.seen.set(k, now);
    return true;
  }
  /** Release a nonce whose payment was refused before settling, so the caller may retry it. */
  release(network: string, asset: string, from: string, nonce: string): void {
    this.seen.delete(this.key(network, asset, from, nonce));
  }
}

/** The authorization of an EIP-3009 payload, or null for any other payload. */
export function authorizationOf(payload: PaymentPayload): {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
} | null {
  const a = (payload.payload as { authorization?: Record<string, unknown> }).authorization;
  if (!a || typeof a !== "object") return null;
  const fields = ["from", "to", "value", "validAfter", "validBefore", "nonce"] as const;
  if (!fields.every((f) => typeof a[f] === "string")) return null;
  return a as ReturnType<typeof authorizationOf> & object;
}

/** The offered requirement a payload accepted: same scheme, network, asset, payee and amount. */
export function matchRequirement(
  offered: readonly PaymentRequirements[],
  accepted: PaymentRequirements | undefined,
): PaymentRequirements | undefined {
  if (!accepted) return undefined;
  const eq = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();
  return offered.find(
    (r) =>
      eq(r.scheme, accepted.scheme) &&
      eq(r.network, accepted.network) &&
      eq(r.asset, accepted.asset) &&
      eq(r.payTo, accepted.payTo) &&
      eq(r.amount, accepted.amount),
  );
}

/** The 402 body: x402's PaymentRequired. */
export function paymentRequired(
  opts: Pick<PaidRequestOptions, "requirements" | "resource">,
  error?: string,
): PaymentRequired {
  return {
    x402Version: 2,
    ...(error ? { error } : {}),
    resource: opts.resource,
    accepts: opts.requirements,
  };
}

const EXPOSE = "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE";

function respond(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
  extra: Record<string, string> = {},
): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Access-Control-Expose-Headers": EXPOSE,
      ...headers,
      ...extra,
    },
  });
}

function required(opts: PaidRequestOptions, error: string, payer?: string): Response {
  const body = paymentRequired(opts, error);
  return respond(402, payer ? { ...body, payer } : body, opts.headers, {
    "PAYMENT-REQUIRED": encodePaymentRequiredHeader(body),
  });
}

/** The payment header of a request (PAYMENT-SIGNATURE, else X-PAYMENT), or null. */
export function paymentHeader(request: Request): string | null {
  for (const h of PAYMENT_HEADERS) {
    const v = request.headers.get(h);
    if (v) return v;
  }
  return null;
}

/** Run the x402 flow for one request (the steps above). */
export async function handlePaidRequest(request: Request, opts: PaidRequestOptions): Promise<Response> {
  const header = paymentHeader(request);
  if (!header) return required(opts, "Payment required: send PAYMENT-SIGNATURE (x402 v2)");

  let payload: PaymentPayload;
  try {
    payload = decodePaymentSignatureHeader(header);
  } catch {
    return required(opts, "invalid_payment_header: not a base64 x402 payment payload");
  }
  if (payload.x402Version !== 2) return required(opts, `unsupported_x402_version: ${payload.x402Version}`);
  const requirement = matchRequirement(opts.requirements, payload.accepted);
  if (!requirement) {
    return required(opts, "no_matching_requirement: the payment accepted no requirement this route offers");
  }
  const auth = authorizationOf(payload);
  if (!auth) return required(opts, "invalid_payload: expected an EIP-3009 authorization");
  if (!opts.facilitator) {
    return respond(
      503,
      { error: "x402 settlement is not configured on this deployment (no relayer key); nothing was charged" },
      opts.headers,
    );
  }
  const ledger = [requirement.network, requirement.asset, auth.from, auth.nonce] as const;
  if (!opts.nonces.claim(...ledger)) {
    return required(opts, "nonce_already_used: this authorization was already presented", auth.from);
  }

  let verified: VerifyResponse;
  try {
    verified = await opts.facilitator.verify(payload, requirement);
  } catch (err) {
    opts.nonces.release(...ledger);
    return respond(502, { error: `could not verify the payment: ${message(err)}` }, opts.headers);
  }
  if (!verified.isValid) {
    // A nonce the chain already marks used stays claimed; anything else may be fixed and retried.
    if (!/nonce/i.test(verified.invalidReason ?? "")) opts.nonces.release(...ledger);
    const reason = [verified.invalidReason, verified.invalidMessage].filter(Boolean).join(": ");
    return required(opts, reason || "invalid_payment", verified.payer ?? auth.from);
  }

  let result: PaidResult;
  try {
    result = await opts.produce();
  } catch (err) {
    result = { status: 502, body: { error: message(err) } };
  }
  if (result.status >= 400) {
    opts.nonces.release(...ledger);
    return respond(result.status, { ...result.body, charged: false }, opts.headers);
  }

  let settled: SettleResponse;
  try {
    settled = await opts.facilitator.settle(payload, requirement);
  } catch (err) {
    return respond(
      502,
      { error: `could not settle the payment: ${message(err)}`, charged: false },
      opts.headers,
    );
  }
  if (!settled.success) {
    const reason = [settled.errorReason, settled.errorMessage].filter(Boolean).join(": ");
    return required(opts, reason || "settlement_failed", settled.payer ?? auth.from);
  }
  const encoded = encodePaymentResponseHeader(settled);
  return respond(
    200,
    {
      ...result.body,
      payment: {
        network: settled.network,
        asset: requirement.asset,
        amount: requirement.amount,
        symbol: requirement.extra.symbol ?? null,
        payer: settled.payer ?? auth.from,
        payTo: requirement.payTo,
        transaction: settled.transaction,
      },
    },
    opts.headers,
    { "PAYMENT-RESPONSE": encoded, "X-PAYMENT-RESPONSE": encoded },
  );
}

const message = (err: unknown) => (err instanceof Error ? err.message.split("\n")[0] : String(err));
