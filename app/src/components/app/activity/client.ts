import { strikeChains } from "@strike/sdk";
import { createPublicClient, http, type PublicClient } from "viem";
import { ACTIVITY_CHAIN_ID, ActivityReader } from "@/lib/activity";
import { RPC_OVERRIDES } from "@/lib/chains";

// Own read-only client for Robinhood Chain testnet: the feed never follows the wallet or the app's selected
// network (wagmi), so it works for visitors without a wallet. NEXT_PUBLIC_RPC_46630 overrides the public RPC.
let client: PublicClient | null = null;
let reader: ActivityReader | null = null;

export function testnetClient(): PublicClient {
  client ??= createPublicClient({
    chain: strikeChains.robinhoodTestnet,
    transport: http(RPC_OVERRIDES[ACTIVITY_CHAIN_ID], {
      timeout: 20_000,
      retryCount: 1,
      batch: { wait: 16 },
    }),
  }) as PublicClient;
  return client;
}

/** One reader per page load, so every feed on the page shares the scanned logs and the caches. */
export function activityReader(): ActivityReader {
  reader ??= new ActivityReader(testnetClient());
  return reader;
}
