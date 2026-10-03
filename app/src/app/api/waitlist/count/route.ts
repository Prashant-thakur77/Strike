import { blobStore } from "@/lib/waitlistBlob";
import { CountCache } from "@/lib/waitlistServer";

// GET /api/waitlist/count: how many people are on the mainnet waitlist ({ count }), from a listing of the private Blob
// store's waitlist/ folder. Cached for 60 s per instance and at the edge. Names no one: the listing is HMAC paths only.
// Without a Blob token, or when the listing fails, it answers { count: null } (200, so browsers log no error), and
// /waitlist then shows no count.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

const cache = new CountCache();

export async function GET(): Promise<Response> {
  const store = blobStore();
  let count: number | null = null;
  if (store) {
    try {
      count = await cache.get(store);
    } catch (err) {
      console.warn(`waitlist count: list failed (${err instanceof Error ? err.name : "unknown error"})`);
    }
  }
  return new Response(JSON.stringify({ count }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control":
        count === null ? "no-store" : "public, max-age=0, s-maxage=60, stale-while-revalidate=60",
    },
  });
}
