// The waitlist's store (D46): the private Vercel Blob store "strike-waitlist", one JSON file per email at
// waitlist/<hmac>.json holding only the ciphertext and its timestamps (waitlistCrypto.ts StoredEntry). Server only:
// the read-write token is BLOB_READ_WRITE_TOKEN in the server environment and never reaches the browser.
import { get, list, put } from "@vercel/blob";
import { BLOB_PREFIX, type StoredEntry } from "./waitlistCrypto";
import type { WaitlistStore } from "./waitlistServer";

/** The Blob store, or null when the server has no token (the route then answers 503). */
export function blobStore(
  token: string | undefined = process.env.BLOB_READ_WRITE_TOKEN,
): WaitlistStore | null {
  if (!token?.trim()) return null;
  return {
    async read(path) {
      const res = await get(path, { access: "private", useCache: false, token });
      if (!res || res.statusCode !== 200) return null;
      return JSON.parse(await new Response(res.stream).text()) as StoredEntry;
    },
    async write(path, entry) {
      await put(path, JSON.stringify(entry), {
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "application/json",
        token,
      });
    },
    async count() {
      let n = 0;
      let cursor: string | undefined;
      do {
        const page = await list({ prefix: BLOB_PREFIX, cursor, limit: 1000, token });
        n += page.blobs.filter((b) => b.pathname.endsWith(".json")).length;
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      return n;
    },
  };
}
