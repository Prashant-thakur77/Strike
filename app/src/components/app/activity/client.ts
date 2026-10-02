import { strikeChains } from "@strike/sdk";
import { createPublicClient, type PublicClient } from "viem";
import { ACTIVITY_CHAIN_ID, ActivityReader } from "@/lib/activity";
import { readTransport } from "@/lib/rpc/client";

// Own read-only client for Robinhood Chain testnet: the feed never follows the wallet or the app's selected
// network (wagmi), so it works for visitors without a wallet. Reads go through the /api/rpc proxy when the build has
// it; NEXT_PUBLIC_RPC_46630 overrides the public RPC.
let client: PublicClient | null = null;
let reader: ActivityReader | null = null;

//
// Contract reads go through Multicall3 (one eth_call per tick), like wagmi's and the playground's clients. With plain
// JSON-RPC batching each read is a call of its own: the feed's first load sent batches of 33 to 61 calls (each row's
// vault, series and block), and the public RPC answers a burst like that with HTTP 429. Its 429 carries
// "Access-Control-Allow-Origin: *,*", which the browser rejects as a CORS error, so the page logged errors and the
// feed failed until the limit cleared (CI runs 37055228383 and 37068333653). The block reads stay JSON-RPC batched.
export function testnetClient(): PublicClient {
  client ??= createPublicClient({
    chain: strikeChains.robinhoodTestnet,
    transport: readTransport(ACTIVITY_CHAIN_ID, {
      timeout: 20_000,
      retryCount: 1,
      batch: { wait: 16 },
    }),
    batch: { multicall: { wait: 16 } },
  }) as PublicClient;
  return client;
}

/** One reader per page load, so every feed on the page shares the scanned logs and the caches. */
export function activityReader(): ActivityReader {
  reader ??= new ActivityReader(testnetClient());
  return reader;
}
