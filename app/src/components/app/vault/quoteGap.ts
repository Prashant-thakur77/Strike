import { describeError } from "@strike/sdk";
import { fmtDuration } from "@/lib/format";
import type { VaultSummary } from "@/lib/reads";

/**
 * Why `EpochManager.quoteBuy` reverted, in words. The view does not check market hours: it reverts only when
 * SafeStockFeed refuses the live price, so the oracle's own `status()` (read with the vault) names the cause. The
 * price steps next to the buy panel keep showing the same formula at the last print, labelled as a model.
 */
export function noQuoteReason(vault: VaultSummary, now: number | undefined, err: unknown): string {
  const sym = vault.underlying.symbol;
  const age = now !== undefined && vault.spot.updatedAt > 0n ? now - Number(vault.spot.updatedAt) : null;
  switch (vault.spot.status) {
    case 2:
      return `No live quote: quoteBuy reverts with StalePrice. The last ${sym} price on this testnet is ${
        age !== null ? `${fmtDuration(age)} old` : "too old"
      }, past the oracle's limit (25 h on these deployments), so the contract refuses to price with it until the keeper mirrors a newer mainnet round. The price steps above apply the same formula to that last print, as a model only.`;
    case 3:
      return `No live quote: quoteBuy reverts because the ${sym} token is paused (TokenPaused).`;
    case 4:
      return `No live quote: quoteBuy reverts because the ${sym} feed is paused (FeedPaused).`;
    case 5:
      return `No live quote: quoteBuy reverts while a ${sym} corporate action is pending (CorporateActionPending).`;
    case 1:
      return `No live quote: quoteBuy reverts because the feed's last answer is invalid (InvalidPrice).`;
    default:
      return `No live quote: quoteBuy reverts (${describeError(err)}).`;
  }
}
