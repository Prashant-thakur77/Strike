// EpochManager: vault registration, the epoch state machine, option sales, settlement and redemptions.
import { Address, BigInt } from "@graphprotocol/graph-ts";
import {
  EpochAborted,
  EpochOpened,
  EpochSettled,
  OptionsBought,
  OptionsRedeemed,
  Paused,
  ProposalRejected,
  SeriesCancelled,
  SeriesProposed,
  SigmaSet,
  UnderlyingSet,
  Unpaused,
  VaultAgentSet,
  VaultRegistered,
} from "../generated/EpochManager/EpochManager";
import { Agent, ProposalRejection, Purchase, Redemption, Series, Vault } from "../generated/schema";
import {
  BD_ZERO,
  BPS,
  EpochState,
  SECONDS_PER_YEAR,
  WAD,
  ZERO,
  assetsValueInUsdg,
  closeEpoch,
  eventId,
  getOrCreateEpoch,
  getOrCreateUnderlying,
  getOrCreateVault,
  getProtocol,
  mulDiv,
  refreshTvl,
  rejectionReasonName,
  safeDiv,
  settlementPriceId,
  toDecimal,
  uint256Id,
  valueInUsd,
  vaultDayData,
} from "./helpers";

// ------------------------------------------------------------------ configuration

export function handleUnderlyingSet(event: UnderlyingSet): void {
  const u = getOrCreateUnderlying(event.params.token);
  u.allowed = event.params.allowed;
  u.save();
}

export function handleSigmaSet(event: SigmaSet): void {
  const u = getOrCreateUnderlying(event.params.token);
  u.sigma = event.params.sigma;
  u.minSigma = event.params.minSigma;
  u.maxSigma = event.params.maxSigma;
  u.save();
}

export function handlePaused(event: Paused): void {
  const p = getProtocol();
  p.paused = true;
  p.updatedAt = event.block.timestamp;
  p.save();
}

export function handleUnpaused(event: Unpaused): void {
  const p = getProtocol();
  p.paused = false;
  p.updatedAt = event.block.timestamp;
  p.save();
}

// ------------------------------------------------------------------ vaults

export function handleVaultRegistered(event: VaultRegistered): void {
  // Emitted inside VaultFactory.createVault, just before VaultCreated (which starts the vault template).
  getOrCreateVault(
    event.params.vault,
    event.params.curator,
    event.params.underlying,
    event.params.isCall,
    event.params.agentId,
    event,
  );
}

export function handleVaultAgentSet(event: VaultAgentSet): void {
  const vault = Vault.load(event.params.vault);
  if (vault == null) return;
  vault.agent = uint256Id(event.params.agentId);
  vault.agentId = event.params.agentId;
  vault.save();
}

// ------------------------------------------------------------------ lifecycle

export function handleEpochOpened(event: EpochOpened): void {
  const vault = Vault.load(event.params.vault);
  if (vault == null) return;
  // The vault's EpochLocked (same call, earlier log) normally created the epoch already.
  const epoch = getOrCreateEpoch(vault, event.params.epoch, event);
  epoch.spotAtOpen = event.params.spot;
  epoch.agent = vault.agent;
  epoch.save();

  const u = getOrCreateUnderlying(Address.fromBytes(vault.underlying));
  u.lastPrice = event.params.spot;
  u.lastPriceAt = event.block.timestamp;
  u.save();

  refreshTvl(vault, event);
  vault.save();
  vaultDayData(vault, event).save();
}

export function handleSeriesProposed(event: SeriesProposed): void {
  const vault = Vault.load(event.params.vault);
  if (vault == null) return;
  const epoch = getOrCreateEpoch(vault, event.params.epoch, event);

  const series = new Series(uint256Id(event.params.seriesId));
  series.seriesId = event.params.seriesId;
  series.vault = vault.id;
  series.epoch = epoch.id;
  series.agent = vault.agent;
  series.agentId = vault.agentId;
  series.underlying = vault.underlying;
  series.isCall = vault.isCall;
  series.strike = event.params.strike;
  series.expiry = event.params.expiry;
  series.size = event.params.size;
  series.premiumBps = event.params.premiumBps;
  series.fairValue = event.params.fairValue;
  series.delta = event.params.delta;
  series.sold = ZERO;
  series.premium = ZERO;
  series.purchaseCount = 0;
  series.settled = false;
  series.cancelled = false;
  series.payout = ZERO;
  series.redeemed = ZERO;
  series.redeemedPaid = ZERO;
  series.proposedAt = event.block.timestamp;
  series.proposalTx = event.transaction.hash;
  series.save();

  epoch.series = series.id;
  epoch.state = EpochState.Selling;
  epoch.proposedAt = event.block.timestamp;
  epoch.save();
  vault.save();

  const p = getProtocol();
  p.proposalCount += 1;
  p.updatedAt = event.block.timestamp;
  p.save();
}

export function handleProposalRejected(event: ProposalRejected): void {
  const vault = Vault.load(event.params.vault);
  if (vault == null) return;
  const epoch = getOrCreateEpoch(vault, event.params.epoch, event);
  const slashed = event.params.slashed;

  const r = new ProposalRejection(eventId(event));
  r.vault = vault.id;
  r.epoch = epoch.id;
  r.epochNumber = event.params.epoch;
  r.agent = uint256Id(event.params.agentId);
  r.agentId = event.params.agentId;
  r.reasonCode = event.params.reason;
  r.reason = rejectionReasonName(event.params.reason);
  r.slashed = slashed;
  r.strike = event.params.strike;
  r.expiry = event.params.expiry;
  r.size = event.params.size;
  r.premiumBps = event.params.premiumBps;
  r.timestamp = event.block.timestamp;
  r.blockNumber = event.block.number;
  r.transactionHash = event.transaction.hash;
  r.save();

  // The slashed bond is held by the manager and paid to the vault when the epoch closes.
  epoch.rejectionCount += 1;
  epoch.compensation = epoch.compensation.plus(slashed);
  epoch.save();
  vault.rejectionCount += 1;
  vault.cumulativeCompensation = vault.cumulativeCompensation.plus(slashed);
  vault.save();

  // Agent bond, strikes and `rejected` are updated by AgentRegistry.Slashed (emitted just before).
  const p = getProtocol();
  p.rejectionCount += 1;
  p.updatedAt = event.block.timestamp;
  p.save();
}

export function handleOptionsBought(event: OptionsBought): void {
  const series = Series.load(uint256Id(event.params.seriesId));
  if (series == null) return;
  const vault = Vault.load(series.vault);
  if (vault == null) return;
  const amount = event.params.amount;
  const premium = event.params.premium;

  const purchase = new Purchase(eventId(event));
  purchase.series = series.id;
  purchase.vault = series.vault;
  purchase.epoch = series.epoch;
  purchase.buyer = event.params.buyer;
  purchase.recipient = event.params.recipient;
  purchase.amount = amount;
  purchase.premium = premium;
  purchase.timestamp = event.block.timestamp;
  purchase.blockNumber = event.block.number;
  purchase.transactionHash = event.transaction.hash;
  purchase.save();

  series.sold = series.sold.plus(amount);
  series.premium = series.premium.plus(premium);
  series.purchaseCount += 1;
  series.save();

  const day = vaultDayData(vault, event);
  day.premiumSold = day.premiumSold.plus(premium);
  day.optionsSold = day.optionsSold.plus(amount);
  day.purchaseCount += 1;
  day.save();

  const p = getProtocol();
  p.purchaseCount += 1;
  p.updatedAt = event.block.timestamp;
  p.save();
}

/// Per-option payout, exactly as EpochManager._settleMath: calls pay a fraction of one token (WAD), puts pay USD
/// per token (WAD).
function payoutPerOption(isCall: boolean, strike: BigInt, price: BigInt): BigInt {
  if (isCall) return price.gt(strike) ? mulDiv(price.minus(strike), WAD, price) : ZERO;
  return strike.gt(price) ? strike.minus(price) : ZERO;
}

export function handleEpochSettled(event: EpochSettled): void {
  // The vault's own EpochSettled (snapshot, queue, net premium) was handled just before this log.
  const vault = Vault.load(event.params.vault);
  if (vault == null) return;
  const epoch = getOrCreateEpoch(vault, event.params.epoch, event);
  const price = event.params.settlementPrice;
  const payout = event.params.payout;
  const premium = event.params.premium;
  const fee = event.params.fee;
  // FeeManager.computeFee: agentCut = fee × agentShareBps / 10_000 (FeesSet is emitted in its constructor).
  const agentFee = fee.times(BigInt.fromI32(getProtocol().agentShareBps)).div(BPS);

  // EpochManager._settleMath: a call payout (tokens) is valued at the settlement price; a put payout is USDG.
  let payoutValue = ZERO;
  if (!price.isZero()) {
    payoutValue = vault.isCall
      ? valueInUsd(payout, price, vault.assetDecimals, vault.premiumDecimals)
      : payout;
  }

  const series = Series.load(uint256Id(event.params.seriesId));
  if (series != null) {
    series.settled = true;
    series.settledAt = event.block.timestamp;
    series.payout = payout;
    if (!price.isZero()) {
      series.settlementPrice = price;
      series.settlement = settlementPriceId(series.underlying, series.expiry);
      series.payoutPerOption = payoutPerOption(series.isCall, series.strike, price);
    }
    series.save();

    const agent = Agent.load(uint256Id(series.agentId));
    if (agent != null) {
      // cumulativePnl / settledEpochs come from AgentRegistry.EpochResultRecorded (emitted just before).
      agent.totalPremiumGenerated = agent.totalPremiumGenerated.plus(premium);
      agent.totalPayoutValue = agent.totalPayoutValue.plus(payoutValue);
      agent.totalFeesEarned = agent.totalFeesEarned.plus(agentFee);
      agent.updatedAt = event.block.timestamp;
      agent.save();
    }
  }

  closeEpoch(epoch, EpochState.Settled, event);
  if (!price.isZero()) epoch.settlementPrice = price;
  epoch.payout = payout;
  epoch.payoutValue = payoutValue;
  epoch.premium = premium;
  epoch.fee = fee;
  epoch.agentFee = agentFee;
  epoch.pnl = premium.minus(payoutValue);

  // Net premium yield on the collateral the epoch locked, annualised over the epoch's actual duration.
  const collateralValue = assetsValueInUsdg(vault, epoch.assetsAtOpen, epoch.spotAtOpen);
  const premiumYield = safeDiv(
    toDecimal(premium.minus(fee), vault.premiumDecimals),
    toDecimal(collateralValue, vault.premiumDecimals),
  );
  const duration = event.block.timestamp.minus(epoch.openedAt);
  epoch.premiumYield = premiumYield;
  epoch.premiumApr = duration.gt(ZERO)
    ? premiumYield.times(SECONDS_PER_YEAR).div(duration.toBigDecimal())
    : BD_ZERO;
  epoch.save();

  vault.cumulativePremium = vault.cumulativePremium.plus(premium);
  vault.cumulativeFees = vault.cumulativeFees.plus(fee);
  vault.cumulativePayoutValue = vault.cumulativePayoutValue.plus(payoutValue);
  vault.settledEpochCount += 1;
  vault.lastPremiumApr = epoch.premiumApr;
  vault.save();

  const day = vaultDayData(vault, event);
  day.premiumSettled = day.premiumSettled.plus(premium);
  day.fees = day.fees.plus(fee);
  day.payoutValue = day.payoutValue.plus(payoutValue);
  day.epochsSettled += 1;
  day.save();

  const p = getProtocol();
  p.settledEpochCount += 1;
  p.totalPremium = p.totalPremium.plus(premium);
  p.totalFees = p.totalFees.plus(fee);
  p.totalPayoutValue = p.totalPayoutValue.plus(payoutValue);
  p.updatedAt = event.block.timestamp;
  p.save();
}

export function handleEpochAborted(event: EpochAborted): void {
  const vault = Vault.load(event.params.vault);
  if (vault == null) return;
  const epoch = getOrCreateEpoch(vault, event.params.epoch, event);
  closeEpoch(epoch, EpochState.Aborted, event);
  epoch.aborted = true;
  epoch.save();
  vault.save();

  const p = getProtocol();
  p.abortedEpochCount += 1;
  p.updatedAt = event.block.timestamp;
  p.save();
}

export function handleSeriesCancelled(event: SeriesCancelled): void {
  const vault = Vault.load(event.params.vault);
  if (vault == null) return;
  const epoch = getOrCreateEpoch(vault, event.params.epoch, event);
  closeEpoch(epoch, EpochState.Cancelled, event);
  epoch.cancelled = true;
  epoch.save();
  vault.save();

  const series = Series.load(uint256Id(event.params.seriesId));
  if (series != null) {
    series.cancelled = true;
    series.save();
  }

  const p = getProtocol();
  p.cancelledEpochCount += 1;
  p.updatedAt = event.block.timestamp;
  p.save();
}

export function handleOptionsRedeemed(event: OptionsRedeemed): void {
  const series = Series.load(uint256Id(event.params.seriesId));
  if (series == null) return;

  const r = new Redemption(eventId(event));
  r.series = series.id;
  r.vault = series.vault;
  r.holder = event.params.holder;
  r.recipient = event.params.recipient;
  r.amount = event.params.amount;
  r.paid = event.params.paid;
  r.refund = series.cancelled;
  r.timestamp = event.block.timestamp;
  r.blockNumber = event.block.number;
  r.transactionHash = event.transaction.hash;
  r.save();

  series.redeemed = series.redeemed.plus(event.params.amount);
  series.redeemedPaid = series.redeemedPaid.plus(event.params.paid);
  series.save();
}
