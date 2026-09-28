// Shared constants, id helpers, unit conversions and get-or-create functions for every mapping.
import { Address, BigDecimal, BigInt, ByteArray, Bytes, ethereum } from "@graphprotocol/graph-ts";
import { Epoch, ProtocolStats, Underlying, Vault, VaultDayData } from "../generated/schema";
import { ERC20 } from "../generated/EpochManager/ERC20";
import { StrikeVault as StrikeVaultContract } from "../generated/EpochManager/StrikeVault";

export const ZERO = BigInt.zero();
export const ONE = BigInt.fromI32(1);
export const BD_ZERO = BigDecimal.zero();
export const BD_ONE = BigDecimal.fromString("1");
export const BPS = BigInt.fromI32(10_000);
export const WAD = BigInt.fromString("1000000000000000000");
export const SECONDS_PER_DAY = 86_400;
export const SECONDS_PER_YEAR = BigDecimal.fromString("31536000"); // 365 days, as the on-chain pricer
export const ZERO_ADDRESS = Address.zero();
export const PROTOCOL_ID = Bytes.fromUTF8("strike");

// ------------------------------------------------------------------ enums (order = Solidity enum order)

export namespace EpochState {
  export const Open = "Open";
  export const Selling = "Selling";
  export const Settled = "Settled";
  export const Aborted = "Aborted";
  export const Cancelled = "Cancelled";
}

export namespace RequestStatus {
  export const Pending = "Pending";
  export const Cancelled = "Cancelled";
  export const Claimed = "Claimed";
}

const AGENT_STATUS: string[] = ["None", "Active", "Suspended", "Retired"];

/// AgentRegistry.Status as the schema enum name.
export function agentStatusName(code: i32): string {
  return code >= 0 && code < AGENT_STATUS.length ? AGENT_STATUS[code] : "None";
}

const REJECTION_REASON: string[] = [
  "None",
  "ZeroSize",
  "TenorOutOfRange",
  "InvalidExpiry",
  "StrikeWrongSide",
  "SizeTooLarge",
  "PremiumBelowFair",
  "PremiumAboveCap",
  "DeltaOutOfBand",
  "PremiumTooSmall",
];

/// MandateGuard.Reason as the schema enum name ("Unknown" for codes added after this subgraph was built).
export function rejectionReasonName(code: i32): string {
  return code >= 0 && code < REJECTION_REASON.length ? REJECTION_REASON[code] : "Unknown";
}

// ------------------------------------------------------------------ ids

/// A uint256 as its 32-byte big-endian ABI word (same bytes as `abi.encode(n)`).
export function uint256Id(n: BigInt): Bytes {
  let hex = n.toHexString().slice(2);
  while (hex.length < 64) hex = "0" + hex;
  return Bytes.fromHexString("0x" + hex);
}

/// tx hash ++ log index: unique per event.
export function eventId(event: ethereum.Event): Bytes {
  return event.transaction.hash.concatI32(event.logIndex.toI32());
}

export function epochId(vault: Bytes, epoch: BigInt): Bytes {
  return vault.concatI32(epoch.toI32());
}

export function requestId(vault: Bytes, account: Bytes, epoch: BigInt): Bytes {
  return vault.concat(account).concatI32(epoch.toI32());
}

export function settlementPriceId(token: Bytes, expiry: BigInt): Bytes {
  return token.concat(Bytes.fromByteArray(ByteArray.fromI64(expiry.toI64())));
}

export function dayId(timestamp: BigInt): i32 {
  return (timestamp.toI64() / (SECONDS_PER_DAY as i64)) as i32;
}

// ------------------------------------------------------------------ math (mirrors the contracts, rounding down)

export function pow10(decimals: i32): BigInt {
  return BigInt.fromI32(10).pow(decimals as u8);
}

export function minBigInt(a: BigInt, b: BigInt): BigInt {
  return a.lt(b) ? a : b;
}

/// a * b / c, rounded down (c > 0).
export function mulDiv(a: BigInt, b: BigInt, c: BigInt): BigInt {
  return a.times(b).div(c);
}

/// Decimals.valueInUsd with Rounding.Floor: USD value of `amount` token base units at `priceWad`, in USDG units.
export function valueInUsd(amount: BigInt, priceWad: BigInt, tokenDecimals: i32, usdDecimals: i32): BigInt {
  return mulDiv(amount, priceWad.times(pow10(usdDecimals)), pow10(tokenDecimals).times(WAD));
}

export function toDecimal(amount: BigInt, decimals: i32): BigDecimal {
  return amount.toBigDecimal().div(pow10(decimals).toBigDecimal());
}

export function safeDiv(a: BigDecimal, b: BigDecimal): BigDecimal {
  return b.equals(BD_ZERO) ? BD_ZERO : a.div(b);
}

/// Value of `amount` vault assets in USDG base units: the stock price for call vaults, 1:1 for put vaults.
export function assetsValueInUsdg(vault: Vault, amount: BigInt, priceWad: BigInt | null): BigInt {
  if (!vault.isCall) return amount;
  if (priceWad === null) return ZERO;
  return valueInUsd(amount, priceWad, vault.assetDecimals, vault.premiumDecimals);
}

// ------------------------------------------------------------------ protocol

export function getProtocol(): ProtocolStats {
  let p = ProtocolStats.load(PROTOCOL_ID);
  if (p == null) {
    p = new ProtocolStats(PROTOCOL_ID);
    p.vaultCount = 0;
    p.callVaultCount = 0;
    p.putVaultCount = 0;
    p.agentCount = 0;
    p.epochCount = 0;
    p.settledEpochCount = 0;
    p.abortedEpochCount = 0;
    p.cancelledEpochCount = 0;
    p.proposalCount = 0;
    p.rejectionCount = 0;
    p.purchaseCount = 0;
    p.totalPremium = ZERO;
    p.totalPremiumToDepositors = ZERO;
    p.totalPayoutValue = ZERO;
    p.totalFees = ZERO;
    p.totalAgentFees = ZERO;
    p.totalTreasuryFees = ZERO;
    p.totalFeesClaimed = ZERO;
    p.totalPremiumClaimed = ZERO;
    p.totalSlashed = ZERO;
    p.totalBonded = ZERO;
    p.tvlUsd = BD_ZERO;
    p.paused = false;
    p.perfFeeBps = 0;
    p.agentShareBps = 0;
    p.minBond = ZERO;
    p.slashAmount = ZERO;
    p.maxStrikes = 0;
    p.unbondDelay = 0;
    p.updatedAt = ZERO;
  }
  return p;
}

// ------------------------------------------------------------------ underlying

/// The stock token entity, created with its ERC-20 metadata on first sight.
/// Needs the `ERC20` ABI in the calling data source.
export function getOrCreateUnderlying(token: Address): Underlying {
  let u = Underlying.load(token);
  if (u == null) {
    u = new Underlying(token);
    const erc20 = ERC20.bind(token);
    const symbol = erc20.try_symbol();
    const decimals = erc20.try_decimals();
    u.symbol = symbol.reverted ? "" : symbol.value;
    u.decimals = decimals.reverted ? 18 : decimals.value;
    u.allowed = false;
    u.save();
  }
  return u;
}

// ------------------------------------------------------------------ vault

/// The vault entity. The EpochManager's `VaultRegistered` and the factory's `VaultCreated` are emitted in the same
/// transaction (in that order); whichever handler runs first creates it, with its ERC-4626 metadata read on-chain.
/// Needs the `StrikeVault` and `ERC20` ABIs in the calling data source.
export function getOrCreateVault(
  address: Address,
  curator: Address,
  underlying: Address,
  isCall: boolean,
  agentId: BigInt,
  event: ethereum.Event,
): Vault {
  let vault = Vault.load(address);
  if (vault != null) return vault;

  const u = getOrCreateUnderlying(underlying);
  const contract = StrikeVaultContract.bind(address);
  const name = contract.try_name();
  const symbol = contract.try_symbol();
  const asset = contract.try_asset();
  const decimals = contract.try_decimals();
  const depositCap = contract.try_depositCap();
  const premiumToken = contract.try_premiumToken();

  vault = new Vault(address);
  vault.underlying = u.id;
  vault.isCall = isCall;
  vault.name = name.reverted ? "" : name.value;
  vault.symbol = symbol.reverted ? "" : symbol.value;
  vault.asset = asset.reverted ? (isCall ? underlying : ZERO_ADDRESS) : asset.value;
  vault.assetDecimals = decimals.reverted ? u.decimals : decimals.value;
  vault.premiumToken = premiumToken.reverted ? ZERO_ADDRESS : premiumToken.value;
  vault.premiumDecimals = 6;
  if (!premiumToken.reverted) {
    const usdgDecimals = ERC20.bind(premiumToken.value).try_decimals();
    if (!usdgDecimals.reverted) vault.premiumDecimals = usdgDecimals.value;
  }
  vault.curator = curator;
  vault.agent = uint256Id(agentId);
  vault.agentId = agentId;
  vault.depositCap = depositCap.reverted ? ZERO : depositCap.value;
  vault.locked = false;
  vault.currentEpochNumber = ZERO;
  vault.totalAssets = ZERO;
  vault.totalSupply = ZERO;
  vault.pendingDepositAssets = ZERO;
  vault.pendingRedeemShares = ZERO;
  vault.reservedRedeemAssets = ZERO;
  vault.tvlUsd = BD_ZERO;
  vault.pricePerShare = BD_ONE;
  vault.accPremiumPerShare = ZERO;
  vault.cumulativePremium = ZERO;
  vault.cumulativePremiumToDepositors = ZERO;
  vault.cumulativeFees = ZERO;
  vault.cumulativePayout = ZERO;
  vault.cumulativePayoutValue = ZERO;
  vault.cumulativeCompensation = ZERO;
  vault.cumulativePremiumClaimed = ZERO;
  vault.lastPremiumApr = BD_ZERO;
  vault.epochCount = 0;
  vault.settledEpochCount = 0;
  vault.rejectionCount = 0;
  vault.createdAt = event.block.timestamp;
  vault.createdAtBlock = event.block.number;
  vault.createdTx = event.transaction.hash;
  vault.save();

  const p = getProtocol();
  p.vaultCount += 1;
  if (isCall) p.callVaultCount += 1;
  else p.putVaultCount += 1;
  p.updatedAt = event.block.timestamp;
  p.save();
  return vault;
}

/// Recompute the vault's USD TVL at the underlying's last seen price and keep the protocol total in step.
/// Saves the protocol entity; the caller saves the vault.
export function refreshTvl(vault: Vault, event: ethereum.Event): void {
  let tvl = BD_ZERO;
  if (vault.isCall) {
    const u = Underlying.load(vault.underlying);
    if (u != null) {
      const price = u.lastPrice;
      if (price !== null) tvl = toDecimal(vault.totalAssets, vault.assetDecimals).times(toDecimal(price, 18));
    }
  } else {
    tvl = toDecimal(vault.totalAssets, vault.assetDecimals);
  }
  const p = getProtocol();
  p.tvlUsd = p.tvlUsd.minus(vault.tvlUsd).plus(tvl);
  p.updatedAt = event.block.timestamp;
  p.save();
  vault.tvlUsd = tvl;
}

/// Today's VaultDayData with close values copied from the vault. The caller adds flows and saves it.
export function vaultDayData(vault: Vault, event: ethereum.Event): VaultDayData {
  const day = dayId(event.block.timestamp);
  const id = vault.id.concatI32(day);
  let d = VaultDayData.load(id);
  if (d == null) {
    d = new VaultDayData(id);
    d.vault = vault.id;
    d.date = day * SECONDS_PER_DAY;
    d.premiumSold = ZERO;
    d.optionsSold = ZERO;
    d.purchaseCount = 0;
    d.premiumSettled = ZERO;
    d.premiumToDepositors = ZERO;
    d.fees = ZERO;
    d.payout = ZERO;
    d.payoutValue = ZERO;
    d.depositedAssets = ZERO;
    d.withdrawnAssets = ZERO;
    d.epochsSettled = 0;
  }
  d.totalAssets = vault.totalAssets;
  d.totalSupply = vault.totalSupply;
  d.tvlUsd = vault.tvlUsd;
  d.pricePerShare = vault.pricePerShare;
  d.accPremiumPerShare = vault.accPremiumPerShare;
  d.premiumApr = vault.lastPremiumApr;
  return d;
}

// ------------------------------------------------------------------ epoch

/// The epoch entity. The vault's `EpochLocked` and the manager's `EpochOpened` are emitted by the same
/// `openEpoch` call (in that order); whichever handler runs first creates it. The caller saves the vault.
export function getOrCreateEpoch(vault: Vault, number: BigInt, event: ethereum.Event): Epoch {
  const id = epochId(vault.id, number);
  let epoch = Epoch.load(id);
  if (epoch != null) return epoch;

  epoch = new Epoch(id);
  epoch.vault = vault.id;
  epoch.number = number;
  epoch.state = EpochState.Open;
  epoch.agent = vault.agent;
  epoch.openedAt = event.block.timestamp;
  epoch.openedAtBlock = event.block.number;
  epoch.openTx = event.transaction.hash;
  epoch.assetsAtOpen = vault.totalAssets;
  epoch.payout = ZERO;
  epoch.payoutValue = ZERO;
  epoch.premium = ZERO;
  epoch.fee = ZERO;
  epoch.agentFee = ZERO;
  epoch.compensation = ZERO;
  epoch.premiumToDepositors = ZERO;
  epoch.pnl = ZERO;
  epoch.aborted = false;
  epoch.cancelled = false;
  epoch.premiumYield = BD_ZERO;
  epoch.premiumApr = BD_ZERO;
  epoch.rejectionCount = 0;
  epoch.save();

  vault.locked = true;
  vault.currentEpoch = id;
  vault.currentEpochNumber = number;
  vault.epochCount += 1;

  const p = getProtocol();
  p.epochCount += 1;
  p.updatedAt = event.block.timestamp;
  p.save();
  return epoch;
}

/// Mark the epoch closed (state + timestamps).
export function closeEpoch(epoch: Epoch, state: string, event: ethereum.Event): void {
  epoch.state = state;
  if (epoch.closedAt === null) {
    epoch.closedAt = event.block.timestamp;
    epoch.closedAtBlock = event.block.number;
    epoch.closeTx = event.transaction.hash;
  }
}
