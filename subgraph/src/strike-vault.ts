// StrikeVault (template, one data source per clone): ERC-4626 flows, the epoch lock, settlement snapshots, the
// deposit/redemption queue and premium claims. Accounting mirrors StrikeVault exactly, so TVL needs no eth_calls.
import { Address, BigDecimal, BigInt, ethereum } from "@graphprotocol/graph-ts";
import {
  Deposit as DepositEvent,
  DepositClaimed,
  DepositRequestCancelled,
  DepositRequested,
  EpochLocked,
  EpochSettled,
  PremiumClaimed,
  RedeemClaimed,
  RedeemRequested,
  Withdraw,
} from "../generated/templates/StrikeVault/StrikeVault";
import {
  Deposit,
  DepositClaim,
  DepositRequest,
  PremiumClaim,
  RedeemClaim,
  RedeemRequest,
  SharePriceSnapshot,
  Vault,
  Withdrawal,
} from "../generated/schema";
import {
  BD_ONE,
  ONE,
  RequestStatus,
  ZERO,
  epochId,
  eventId,
  getOrCreateEpoch,
  getProtocol,
  minBigInt,
  mulDiv,
  refreshTvl,
  requestId,
  vaultDayData,
} from "./helpers";

function subFloor(a: BigInt, b: BigInt): BigInt {
  return a.minus(minBigInt(a, b));
}

function pricePerShare(assets: BigInt, supply: BigInt): BigDecimal {
  // Shares have the asset's decimals, so the raw ratio is assets per share.
  return supply.isZero() ? BD_ONE : assets.toBigDecimal().div(supply.toBigDecimal());
}

function getDepositRequest(
  vault: Vault,
  account: Address,
  epoch: BigInt,
  event: ethereum.Event,
): DepositRequest {
  const id = requestId(vault.id, account, epoch);
  let r = DepositRequest.load(id);
  if (r == null) {
    r = new DepositRequest(id);
    r.vault = vault.id;
    r.account = account;
    r.epoch = epochId(vault.id, epoch);
    r.epochNumber = epoch;
    r.assets = ZERO;
    r.status = RequestStatus.Pending;
    r.requestedAt = event.block.timestamp;
  }
  r.updatedAt = event.block.timestamp;
  return r;
}

function getRedeemRequest(
  vault: Vault,
  account: Address,
  epoch: BigInt,
  event: ethereum.Event,
): RedeemRequest {
  const id = requestId(vault.id, account, epoch);
  let r = RedeemRequest.load(id);
  if (r == null) {
    r = new RedeemRequest(id);
    r.vault = vault.id;
    r.account = account;
    r.epoch = epochId(vault.id, epoch);
    r.epochNumber = epoch;
    r.shares = ZERO;
    r.status = RequestStatus.Pending;
    r.requestedAt = event.block.timestamp;
  }
  r.updatedAt = event.block.timestamp;
  return r;
}

// ------------------------------------------------------------------ instant ERC-4626 (unlocked)

export function handleDeposit(event: DepositEvent): void {
  const vault = Vault.load(event.address);
  if (vault == null) return;

  const d = new Deposit(eventId(event));
  d.vault = vault.id;
  d.sender = event.params.sender;
  d.owner = event.params.owner;
  d.assets = event.params.assets;
  d.shares = event.params.shares;
  d.timestamp = event.block.timestamp;
  d.blockNumber = event.block.number;
  d.transactionHash = event.transaction.hash;
  d.save();

  vault.totalAssets = vault.totalAssets.plus(event.params.assets);
  vault.totalSupply = vault.totalSupply.plus(event.params.shares);
  refreshTvl(vault, event);
  vault.save();

  const day = vaultDayData(vault, event);
  day.depositedAssets = day.depositedAssets.plus(event.params.assets);
  day.save();
}

export function handleWithdraw(event: Withdraw): void {
  const vault = Vault.load(event.address);
  if (vault == null) return;

  const w = new Withdrawal(eventId(event));
  w.vault = vault.id;
  w.sender = event.params.sender;
  w.receiver = event.params.receiver;
  w.owner = event.params.owner;
  w.assets = event.params.assets;
  w.shares = event.params.shares;
  w.timestamp = event.block.timestamp;
  w.blockNumber = event.block.number;
  w.transactionHash = event.transaction.hash;
  w.save();

  vault.totalAssets = subFloor(vault.totalAssets, event.params.assets);
  vault.totalSupply = subFloor(vault.totalSupply, event.params.shares);
  refreshTvl(vault, event);
  vault.save();

  const day = vaultDayData(vault, event);
  day.withdrawnAssets = day.withdrawnAssets.plus(event.params.assets);
  day.save();
}

// ------------------------------------------------------------------ epoch hooks (called by the EpochManager)

export function handleEpochLocked(event: EpochLocked): void {
  const vault = Vault.load(event.address);
  if (vault == null) return;
  getOrCreateEpoch(vault, event.params.epoch, event);
  vault.locked = true;
  vault.save();
}

/// StrikeVault.settleEpoch: payout out, premium distributed, snapshot, then the queue at the snapshot price.
export function handleVaultEpochSettled(event: EpochSettled): void {
  const vault = Vault.load(event.address);
  if (vault == null) return;
  const number = event.params.epoch;
  const epoch = getOrCreateEpoch(vault, number, event);
  const assets = event.params.assets; // managed assets after the payout, before the queue
  const supply = event.params.supply; // total supply before the queue
  const ppsAtClose = pricePerShare(assets, supply);
  const premiumPerShare = subFloor(event.params.accPremium, vault.accPremiumPerShare);

  const snap = new SharePriceSnapshot(epochId(vault.id, number));
  snap.vault = vault.id;
  snap.epoch = epoch.id;
  snap.epochNumber = number;
  snap.assets = assets;
  snap.supply = supply;
  snap.pricePerShare = ppsAtClose;
  snap.accPremiumPerShare = event.params.accPremium;
  snap.premiumPerShare = premiumPerShare;
  snap.timestamp = event.block.timestamp;
  snap.blockNumber = event.block.number;
  snap.save();

  if (epoch.closedAt === null) {
    epoch.closedAt = event.block.timestamp;
    epoch.closedAtBlock = event.block.number;
    epoch.closeTx = event.transaction.hash;
  }
  epoch.payout = event.params.payout;
  epoch.premiumToDepositors = event.params.premium;
  epoch.assetsAtClose = assets;
  epoch.supplyAtClose = supply;
  epoch.pricePerShare = ppsAtClose;
  epoch.save();

  // Re-sync from the snapshot, then process the queue with the contract's exact rounding.
  let totalAssets = assets;
  let totalSupply = supply;
  let processedIn = ZERO;
  let processedOut = ZERO;
  const redeemShares = vault.pendingRedeemShares;
  if (!redeemShares.isZero()) {
    const redeemAssets = mulDiv(redeemShares, assets.plus(ONE), supply.plus(ONE));
    totalSupply = subFloor(totalSupply, redeemShares);
    totalAssets = subFloor(totalAssets, redeemAssets);
    vault.reservedRedeemAssets = vault.reservedRedeemAssets.plus(redeemAssets);
    vault.pendingRedeemShares = ZERO;
    processedOut = redeemAssets;
  }
  const depositAssets = vault.pendingDepositAssets;
  if (!depositAssets.isZero()) {
    const depositShares = mulDiv(depositAssets, supply.plus(ONE), assets.plus(ONE));
    totalAssets = totalAssets.plus(depositAssets);
    totalSupply = totalSupply.plus(depositShares);
    vault.pendingDepositAssets = ZERO;
    processedIn = depositAssets;
  }

  vault.totalAssets = totalAssets;
  vault.totalSupply = totalSupply;
  vault.accPremiumPerShare = event.params.accPremium;
  vault.pricePerShare = ppsAtClose;
  vault.locked = false;
  vault.cumulativePayout = vault.cumulativePayout.plus(event.params.payout);
  vault.cumulativePremiumToDepositors = vault.cumulativePremiumToDepositors.plus(event.params.premium);
  refreshTvl(vault, event);
  vault.save();

  const day = vaultDayData(vault, event);
  day.payout = day.payout.plus(event.params.payout);
  day.premiumToDepositors = day.premiumToDepositors.plus(event.params.premium);
  day.depositedAssets = day.depositedAssets.plus(processedIn);
  day.withdrawnAssets = day.withdrawnAssets.plus(processedOut);
  day.save();

  const p = getProtocol();
  p.totalPremiumToDepositors = p.totalPremiumToDepositors.plus(event.params.premium);
  p.updatedAt = event.block.timestamp;
  p.save();
}

// ------------------------------------------------------------------ queue (locked)

export function handleDepositRequested(event: DepositRequested): void {
  const vault = Vault.load(event.address);
  if (vault == null) return;
  const r = getDepositRequest(vault, event.params.account, event.params.epoch, event);
  if (r.status != RequestStatus.Pending) {
    // A new request after a cancellation in the same epoch starts from zero.
    r.status = RequestStatus.Pending;
    r.assets = ZERO;
    r.requestedAt = event.block.timestamp;
    r.cancelledAt = null;
  }
  r.assets = r.assets.plus(event.params.assets);
  r.save();

  vault.pendingDepositAssets = vault.pendingDepositAssets.plus(event.params.assets);
  vault.save();
}

export function handleDepositRequestCancelled(event: DepositRequestCancelled): void {
  const vault = Vault.load(event.address);
  if (vault == null) return;
  const r = getDepositRequest(vault, event.params.account, event.params.epoch, event);
  r.status = RequestStatus.Cancelled;
  r.cancelledAt = event.block.timestamp;
  r.save();

  vault.pendingDepositAssets = subFloor(vault.pendingDepositAssets, event.params.assets);
  vault.save();
}

export function handleDepositClaimed(event: DepositClaimed): void {
  const vault = Vault.load(event.address);
  if (vault == null) return;
  const r = getDepositRequest(vault, event.params.account, event.params.epoch, event);
  if (r.assets.isZero()) r.assets = event.params.assets;
  r.status = RequestStatus.Claimed;
  r.shares = event.params.shares;
  r.claimedAt = event.block.timestamp;
  r.save();

  const c = new DepositClaim(eventId(event));
  c.request = r.id;
  c.vault = vault.id;
  c.account = event.params.account;
  c.epochNumber = event.params.epoch;
  c.assets = event.params.assets;
  c.shares = event.params.shares;
  c.timestamp = event.block.timestamp;
  c.blockNumber = event.block.number;
  c.transactionHash = event.transaction.hash;
  c.save();
}

export function handleRedeemRequested(event: RedeemRequested): void {
  const vault = Vault.load(event.address);
  if (vault == null) return;
  const r = getRedeemRequest(vault, event.params.account, event.params.epoch, event);
  r.shares = r.shares.plus(event.params.shares);
  r.save();

  vault.pendingRedeemShares = vault.pendingRedeemShares.plus(event.params.shares);
  vault.save();
}

export function handleRedeemClaimed(event: RedeemClaimed): void {
  const vault = Vault.load(event.address);
  if (vault == null) return;
  const r = getRedeemRequest(vault, event.params.account, event.params.epoch, event);
  if (r.shares.isZero()) r.shares = event.params.shares;
  r.status = RequestStatus.Claimed;
  r.assets = event.params.assets;
  r.claimedAt = event.block.timestamp;
  r.save();

  const c = new RedeemClaim(eventId(event));
  c.request = r.id;
  c.vault = vault.id;
  c.account = event.params.account;
  c.epochNumber = event.params.epoch;
  c.shares = event.params.shares;
  c.assets = event.params.assets;
  c.timestamp = event.block.timestamp;
  c.blockNumber = event.block.number;
  c.transactionHash = event.transaction.hash;
  c.save();

  vault.reservedRedeemAssets = subFloor(vault.reservedRedeemAssets, event.params.assets);
  vault.save();
}

export function handlePremiumClaimed(event: PremiumClaimed): void {
  const vault = Vault.load(event.address);
  if (vault == null) return;

  const c = new PremiumClaim(eventId(event));
  c.vault = vault.id;
  c.account = event.params.account;
  c.amount = event.params.amount;
  c.timestamp = event.block.timestamp;
  c.blockNumber = event.block.number;
  c.transactionHash = event.transaction.hash;
  c.save();

  vault.cumulativePremiumClaimed = vault.cumulativePremiumClaimed.plus(event.params.amount);
  vault.save();

  const p = getProtocol();
  p.totalPremiumClaimed = p.totalPremiumClaimed.plus(event.params.amount);
  p.updatedAt = event.block.timestamp;
  p.save();
}
