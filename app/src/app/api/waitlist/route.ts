import { blobStore } from "@/lib/waitlistBlob";
import { WAITLIST_PUBLIC_KEY_PEM } from "@/lib/waitlistKey";
import { MAX_BODY_BYTES, RateLimiter, clientIp, handleSignup } from "@/lib/waitlistServer";
import { readBodyLimited } from "@/lib/rpc/proxy";

// POST /api/waitlist: one mainnet waitlist sign-up (D46). Every field is checked again here (waitlistEntry.ts), a
// hidden honeypot field drops bots, and each IP gets 5 attempts per 10 minutes per server instance (keyed by an HMAC
// of the IP). The entry is encrypted with a fresh AES-256-GCM key wrapped by the team's RSA-OAEP-256 public key and
// stored in the private Vercel Blob store at waitlist/<HMAC-SHA256 of the lowercased email>.json, so a second sign-up
// with the same email overwrites the first ("updated"). Without WAITLIST_SALT or BLOB_READ_WRITE_TOKEN it answers 503.
// Nothing is logged but the failing stage and the error's name. No CORS headers, and POST only.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

const limiter = new RateLimiter();

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

export async function POST(request: Request): Promise<Response> {
  if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? ""))
    return json({ ok: false, error: "Send the sign-up as JSON." }, 415);
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES)
    return json({ ok: false, error: "That sign-up is too large. Shorten the note and try again." }, 413);
  const raw = await readBodyLimited(request.body, MAX_BODY_BYTES);
  const result = await handleSignup(raw, clientIp(request.headers), {
    salt: process.env.WAITLIST_SALT,
    publicKeyPem: WAITLIST_PUBLIC_KEY_PEM,
    store: blobStore(),
    limiter,
    onError: (stage, err) =>
      console.warn(`waitlist: ${stage} failed (${err instanceof Error ? err.name : "unknown error"})`),
  });
  return json(result.body, result.status, result.headers);
}
