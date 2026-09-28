// StockOracle: feed configuration and the settlement price fixed once per (token, expiry).
import { FeedSet, SettlementPriceRecorded } from "../generated/StockOracle/StockOracle";
import { SettlementPrice } from "../generated/schema";
import { getOrCreateUnderlying, settlementPriceId } from "./helpers";

export function handleFeedSet(event: FeedSet): void {
  const u = getOrCreateUnderlying(event.params.token);
  u.feed = event.params.feed;
  u.maxPriceAge = event.params.maxPriceAge.toI32();
  u.corporateActionGrace = event.params.corporateActionGrace.toI32();
  u.save();
}

export function handleSettlementPriceRecorded(event: SettlementPriceRecorded): void {
  const id = settlementPriceId(event.params.token, event.params.expiry);
  // Recorded at most once on-chain (later calls return early without an event); guard anyway.
  if (SettlementPrice.load(id) != null) return;

  const u = getOrCreateUnderlying(event.params.token);
  const sp = new SettlementPrice(id);
  sp.token = u.id;
  sp.expiry = event.params.expiry;
  sp.roundId = event.params.roundId;
  sp.price = event.params.price;
  sp.recordedAt = event.block.timestamp;
  sp.blockNumber = event.block.number;
  sp.transactionHash = event.transaction.hash;
  sp.save();

  u.lastPrice = event.params.price;
  u.lastPriceAt = event.block.timestamp;
  u.save();
}
