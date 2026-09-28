// Mock events, mocked contract calls and fixtures shared by the matchstick suites.
import { Address, BigInt, ethereum } from "@graphprotocol/graph-ts";
import { createMockedFunction, newMockEvent } from "matchstick-as/assembly/index";
import {
  AgentRegistered,
  BondPosted,
  EpochResultRecorded,
  ParamsSet,
  PayoutSet,
  ProposalRecorded,
  ReputationFeedback,
  SignerSet,
  Slashed,
  StatusSet,
  UnbondRequested,
  Unbonded,
} from "../generated/AgentRegistry/AgentRegistry";
import {
  EpochAborted,
  EpochOpened,
  EpochSettled,
  OptionsBought,
  OptionsRedeemed,
  ProposalRejected,
  SeriesProposed,
  UnderlyingSet,
  VaultRegistered,
} from "../generated/EpochManager/EpochManager";
import { FeesCredited, FeesSet } from "../generated/FeeManager/FeeManager";
import { FeedSet, SettlementPriceRecorded } from "../generated/StockOracle/StockOracle";
import {
  Deposit,
  DepositClaimed,
  DepositRequested,
  EpochLocked,
  EpochSettled as VaultEpochSettled,
  RedeemClaimed,
  RedeemRequested,
} from "../generated/templates/StrikeVault/StrikeVault";
import { VaultCreated } from "../generated/VaultFactory/VaultFactory";
import { handleAgentRegistered, handleBondPosted, handleParamsSet } from "../src/agent-registry";
import { handleUnderlyingSet, handleVaultRegistered } from "../src/epoch-manager";
import { handleFeesSet } from "../src/fee-manager";
import { handleFeedSet } from "../src/stock-oracle";
import { handleVaultCreated } from "../src/vault-factory";

// ------------------------------------------------------------------ addresses

export const EPOCH_MANAGER = Address.fromString("0x00000000000000000000000000000000000000e1");
export const FACTORY = Address.fromString("0x00000000000000000000000000000000000000f1");
export const REGISTRY = Address.fromString("0x00000000000000000000000000000000000000a1");
export const ORACLE = Address.fromString("0x00000000000000000000000000000000000000c1");
export const FEE_MANAGER = Address.fromString("0x00000000000000000000000000000000000000d1");
export const VAULT = Address.fromString("0x1000000000000000000000000000000000000001");
export const PUT_VAULT = Address.fromString("0x1000000000000000000000000000000000000002");
export const TSLA = Address.fromString("0x2000000000000000000000000000000000000001");
export const TSLA_FEED = Address.fromString("0x2000000000000000000000000000000000000002");
export const USDG = Address.fromString("0x3000000000000000000000000000000000000001");
export const CURATOR = Address.fromString("0x4000000000000000000000000000000000000001");
export const AGENT_OWNER = Address.fromString("0x5000000000000000000000000000000000000001");
export const AGENT_SIGNER = Address.fromString("0x5000000000000000000000000000000000000002");
export const AGENT_PAYOUT = Address.fromString("0x5000000000000000000000000000000000000003");
export const BUYER = Address.fromString("0x6000000000000000000000000000000000000001");
export const ALICE = Address.fromString("0x7000000000000000000000000000000000000001");
export const BOB = Address.fromString("0x7000000000000000000000000000000000000002");
export const TREASURY = Address.fromString("0x8000000000000000000000000000000000000001");

// ------------------------------------------------------------------ amounts

export const AGENT_ID = BigInt.fromI32(1);
export const EPOCH_1 = BigInt.fromI32(1);
/// 2026-09-21 16:53:20 UTC (a Monday)
export const T0: i64 = 1_790_009_600;
export const DAY: i64 = 86_400;

export function wad(n: i32): BigInt {
  return BigInt.fromI32(n).times(BigInt.fromString("1000000000000000000"));
}

export function usdg(n: i32): BigInt {
  return BigInt.fromI32(n).times(BigInt.fromI32(1_000_000));
}

// ------------------------------------------------------------------ event plumbing

let nextLogIndex: i32 = 0;

function mockEvent(address: Address, params: Array<ethereum.EventParam>, timestamp: i64): ethereum.Event {
  const event = newMockEvent();
  event.address = address;
  event.parameters = params;
  event.logIndex = BigInt.fromI32(nextLogIndex++);
  event.block.timestamp = BigInt.fromI64(timestamp);
  event.block.number = BigInt.fromI64(timestamp / 12);
  return event;
}

function address(name: string, value: Address): ethereum.EventParam {
  return new ethereum.EventParam(name, ethereum.Value.fromAddress(value));
}

function uint(name: string, value: BigInt): ethereum.EventParam {
  return new ethereum.EventParam(name, ethereum.Value.fromUnsignedBigInt(value));
}

function small(name: string, value: i32): ethereum.EventParam {
  return new ethereum.EventParam(name, ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(value)));
}

function int(name: string, value: BigInt): ethereum.EventParam {
  return new ethereum.EventParam(name, ethereum.Value.fromSignedBigInt(value));
}

function bool(name: string, value: boolean): ethereum.EventParam {
  return new ethereum.EventParam(name, ethereum.Value.fromBoolean(value));
}

// ------------------------------------------------------------------ mocked calls

export function mockToken(token: Address, symbol: string, decimals: i32): void {
  createMockedFunction(token, "symbol", "symbol():(string)").returns([ethereum.Value.fromString(symbol)]);
  createMockedFunction(token, "decimals", "decimals():(uint8)").returns([
    ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(decimals)),
  ]);
}

export function mockVault(vault: Address, asset: Address, decimals: i32, name: string, symbol: string): void {
  createMockedFunction(vault, "name", "name():(string)").returns([ethereum.Value.fromString(name)]);
  createMockedFunction(vault, "symbol", "symbol():(string)").returns([ethereum.Value.fromString(symbol)]);
  createMockedFunction(vault, "asset", "asset():(address)").returns([ethereum.Value.fromAddress(asset)]);
  createMockedFunction(vault, "decimals", "decimals():(uint8)").returns([
    ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(decimals)),
  ]);
  createMockedFunction(vault, "depositCap", "depositCap():(uint256)").returns([
    ethereum.Value.fromUnsignedBigInt(wad(1_000_000)),
  ]);
  createMockedFunction(vault, "premiumToken", "premiumToken():(address)").returns([
    ethereum.Value.fromAddress(USDG),
  ]);
}

export function mockPayoutOf(agentId: BigInt, payout: Address): void {
  createMockedFunction(REGISTRY, "payoutOf", "payoutOf(uint256):(address)")
    .withArgs([ethereum.Value.fromUnsignedBigInt(agentId)])
    .returns([ethereum.Value.fromAddress(payout)]);
}

// ------------------------------------------------------------------ EpochManager events

export function underlyingSet(token: Address, allowed: boolean): UnderlyingSet {
  return changetype<UnderlyingSet>(
    mockEvent(EPOCH_MANAGER, [address("token", token), bool("allowed", allowed)], T0 - DAY),
  );
}

export function vaultRegistered(
  vault: Address,
  curator: Address,
  agentId: BigInt,
  underlying: Address,
  isCall: boolean,
  timestamp: i64,
): VaultRegistered {
  return changetype<VaultRegistered>(
    mockEvent(
      EPOCH_MANAGER,
      [
        address("vault", vault),
        address("curator", curator),
        uint("agentId", agentId),
        address("underlying", underlying),
        bool("isCall", isCall),
      ],
      timestamp,
    ),
  );
}

export function epochOpened(vault: Address, epoch: BigInt, spot: BigInt, timestamp: i64): EpochOpened {
  return changetype<EpochOpened>(
    mockEvent(EPOCH_MANAGER, [address("vault", vault), uint("epoch", epoch), uint("spot", spot)], timestamp),
  );
}

export function seriesProposed(
  vault: Address,
  epoch: BigInt,
  seriesId: BigInt,
  strike: BigInt,
  expiry: i64,
  size: BigInt,
  premiumBps: i32,
  fairValue: BigInt,
  delta: BigInt,
  timestamp: i64,
): SeriesProposed {
  return changetype<SeriesProposed>(
    mockEvent(
      EPOCH_MANAGER,
      [
        address("vault", vault),
        uint("epoch", epoch),
        uint("seriesId", seriesId),
        uint("strike", strike),
        uint("expiry", BigInt.fromI64(expiry)),
        uint("size", size),
        small("premiumBps", premiumBps),
        uint("fairValue", fairValue),
        int("delta", delta),
      ],
      timestamp,
    ),
  );
}

export function proposalRejected(
  vault: Address,
  epoch: BigInt,
  agentId: BigInt,
  reason: i32,
  slashed: BigInt,
  strike: BigInt,
  expiry: i64,
  size: BigInt,
  premiumBps: i32,
  timestamp: i64,
): ProposalRejected {
  return changetype<ProposalRejected>(
    mockEvent(
      EPOCH_MANAGER,
      [
        address("vault", vault),
        uint("epoch", epoch),
        uint("agentId", agentId),
        small("reason", reason),
        uint("slashed", slashed),
        uint("strike", strike),
        uint("expiry", BigInt.fromI64(expiry)),
        uint("size", size),
        small("premiumBps", premiumBps),
      ],
      timestamp,
    ),
  );
}

export function optionsBought(
  seriesId: BigInt,
  buyer: Address,
  recipient: Address,
  amount: BigInt,
  premium: BigInt,
  timestamp: i64,
): OptionsBought {
  return changetype<OptionsBought>(
    mockEvent(
      EPOCH_MANAGER,
      [
        uint("seriesId", seriesId),
        address("buyer", buyer),
        address("recipient", recipient),
        uint("amount", amount),
        uint("premium", premium),
      ],
      timestamp,
    ),
  );
}

export function epochSettled(
  vault: Address,
  epoch: BigInt,
  seriesId: BigInt,
  settlementPrice: BigInt,
  payout: BigInt,
  premium: BigInt,
  fee: BigInt,
  timestamp: i64,
): EpochSettled {
  return changetype<EpochSettled>(
    mockEvent(
      EPOCH_MANAGER,
      [
        address("vault", vault),
        uint("epoch", epoch),
        uint("seriesId", seriesId),
        uint("settlementPrice", settlementPrice),
        uint("payout", payout),
        uint("premium", premium),
        uint("fee", fee),
      ],
      timestamp,
    ),
  );
}

export function epochAborted(vault: Address, epoch: BigInt, timestamp: i64): EpochAborted {
  return changetype<EpochAborted>(
    mockEvent(EPOCH_MANAGER, [address("vault", vault), uint("epoch", epoch)], timestamp),
  );
}

export function optionsRedeemed(
  seriesId: BigInt,
  holder: Address,
  recipient: Address,
  amount: BigInt,
  paid: BigInt,
  timestamp: i64,
): OptionsRedeemed {
  return changetype<OptionsRedeemed>(
    mockEvent(
      EPOCH_MANAGER,
      [
        uint("seriesId", seriesId),
        address("holder", holder),
        address("recipient", recipient),
        uint("amount", amount),
        uint("paid", paid),
      ],
      timestamp,
    ),
  );
}

// ------------------------------------------------------------------ VaultFactory / StockOracle / FeeManager events

export function vaultCreated(
  vault: Address,
  curator: Address,
  underlying: Address,
  isCall: boolean,
  agentId: BigInt,
  timestamp: i64,
): VaultCreated {
  return changetype<VaultCreated>(
    mockEvent(
      FACTORY,
      [
        address("vault", vault),
        address("curator", curator),
        address("underlying", underlying),
        bool("isCall", isCall),
        uint("agentId", agentId),
      ],
      timestamp,
    ),
  );
}

export function feedSet(token: Address, feed: Address): FeedSet {
  return changetype<FeedSet>(
    mockEvent(
      ORACLE,
      [
        address("token", token),
        address("feed", feed),
        uint("maxPriceAge", BigInt.fromI32(3600)),
        uint("corporateActionGrace", BigInt.fromI32(86_400)),
      ],
      T0 - DAY,
    ),
  );
}

export function settlementPriceRecorded(
  token: Address,
  expiry: i64,
  roundId: BigInt,
  price: BigInt,
  timestamp: i64,
): SettlementPriceRecorded {
  return changetype<SettlementPriceRecorded>(
    mockEvent(
      ORACLE,
      [
        address("token", token),
        uint("expiry", BigInt.fromI64(expiry)),
        uint("roundId", roundId),
        uint("price", price),
      ],
      timestamp,
    ),
  );
}

export function feesSet(perfFeeBps: i32, agentShareBps: i32): FeesSet {
  return changetype<FeesSet>(
    mockEvent(
      FEE_MANAGER,
      [small("perfFeeBps", perfFeeBps), small("agentShareBps", agentShareBps)],
      T0 - DAY,
    ),
  );
}

export function feesCredited(
  agent: Address,
  agentAmount: BigInt,
  treasuryAmount: BigInt,
  timestamp: i64,
): FeesCredited {
  return changetype<FeesCredited>(
    mockEvent(
      FEE_MANAGER,
      [address("agent", agent), uint("agentAmount", agentAmount), uint("treasuryAmount", treasuryAmount)],
      timestamp,
    ),
  );
}

// ------------------------------------------------------------------ StrikeVault events

export function vaultDeposit(
  vault: Address,
  owner: Address,
  assets: BigInt,
  shares: BigInt,
  timestamp: i64,
): Deposit {
  return changetype<Deposit>(
    mockEvent(
      vault,
      [address("sender", owner), address("owner", owner), uint("assets", assets), uint("shares", shares)],
      timestamp,
    ),
  );
}

export function epochLocked(vault: Address, epoch: BigInt, timestamp: i64): EpochLocked {
  return changetype<EpochLocked>(mockEvent(vault, [uint("epoch", epoch)], timestamp));
}

export function vaultEpochSettled(
  vault: Address,
  epoch: BigInt,
  payout: BigInt,
  premium: BigInt,
  assets: BigInt,
  supply: BigInt,
  accPremium: BigInt,
  timestamp: i64,
): VaultEpochSettled {
  return changetype<VaultEpochSettled>(
    mockEvent(
      vault,
      [
        uint("epoch", epoch),
        uint("payout", payout),
        uint("premium", premium),
        uint("assets", assets),
        uint("supply", supply),
        uint("accPremium", accPremium),
      ],
      timestamp,
    ),
  );
}

export function depositRequested(
  vault: Address,
  account: Address,
  epoch: BigInt,
  assets: BigInt,
  timestamp: i64,
): DepositRequested {
  return changetype<DepositRequested>(
    mockEvent(vault, [address("account", account), uint("epoch", epoch), uint("assets", assets)], timestamp),
  );
}

export function depositClaimed(
  vault: Address,
  account: Address,
  epoch: BigInt,
  assets: BigInt,
  shares: BigInt,
  timestamp: i64,
): DepositClaimed {
  return changetype<DepositClaimed>(
    mockEvent(
      vault,
      [address("account", account), uint("epoch", epoch), uint("assets", assets), uint("shares", shares)],
      timestamp,
    ),
  );
}

export function redeemRequested(
  vault: Address,
  account: Address,
  epoch: BigInt,
  shares: BigInt,
  timestamp: i64,
): RedeemRequested {
  return changetype<RedeemRequested>(
    mockEvent(vault, [address("account", account), uint("epoch", epoch), uint("shares", shares)], timestamp),
  );
}

export function redeemClaimed(
  vault: Address,
  account: Address,
  epoch: BigInt,
  shares: BigInt,
  assets: BigInt,
  timestamp: i64,
): RedeemClaimed {
  return changetype<RedeemClaimed>(
    mockEvent(
      vault,
      [address("account", account), uint("epoch", epoch), uint("shares", shares), uint("assets", assets)],
      timestamp,
    ),
  );
}

// ------------------------------------------------------------------ AgentRegistry events

export function agentRegistered(
  agentId: BigInt,
  owner: Address,
  signer: Address,
  erc8004Id: BigInt,
  timestamp: i64,
): AgentRegistered {
  return changetype<AgentRegistered>(
    mockEvent(
      REGISTRY,
      [
        uint("agentId", agentId),
        address("owner", owner),
        address("signer", signer),
        uint("erc8004Id", erc8004Id),
      ],
      timestamp,
    ),
  );
}

export function signerSet(agentId: BigInt, signer: Address, timestamp: i64): SignerSet {
  return changetype<SignerSet>(
    mockEvent(REGISTRY, [uint("agentId", agentId), address("signer", signer)], timestamp),
  );
}

export function payoutSet(agentId: BigInt, payout: Address, timestamp: i64): PayoutSet {
  return changetype<PayoutSet>(
    mockEvent(REGISTRY, [uint("agentId", agentId), address("payout", payout)], timestamp),
  );
}

export function bondPosted(agentId: BigInt, from: Address, amount: BigInt, timestamp: i64): BondPosted {
  return changetype<BondPosted>(
    mockEvent(REGISTRY, [uint("agentId", agentId), address("from", from), uint("amount", amount)], timestamp),
  );
}

export function unbondRequested(
  agentId: BigInt,
  amount: BigInt,
  availableAt: i64,
  timestamp: i64,
): UnbondRequested {
  return changetype<UnbondRequested>(
    mockEvent(
      REGISTRY,
      [uint("agentId", agentId), uint("amount", amount), uint("availableAt", BigInt.fromI64(availableAt))],
      timestamp,
    ),
  );
}

export function unbonded(agentId: BigInt, to: Address, amount: BigInt, timestamp: i64): Unbonded {
  return changetype<Unbonded>(
    mockEvent(REGISTRY, [uint("agentId", agentId), address("to", to), uint("amount", amount)], timestamp),
  );
}

export function slashed(agentId: BigInt, amount: BigInt, strikes: i32, timestamp: i64): Slashed {
  return changetype<Slashed>(
    mockEvent(
      REGISTRY,
      [
        uint("agentId", agentId),
        address("recipient", EPOCH_MANAGER),
        uint("amount", amount),
        small("strikes", strikes),
      ],
      timestamp,
    ),
  );
}

export function statusSet(agentId: BigInt, status: i32, timestamp: i64): StatusSet {
  return changetype<StatusSet>(
    mockEvent(REGISTRY, [uint("agentId", agentId), small("status", status)], timestamp),
  );
}

export function proposalRecorded(agentId: BigInt, timestamp: i64): ProposalRecorded {
  return changetype<ProposalRecorded>(
    mockEvent(REGISTRY, [uint("agentId", agentId), bool("accepted", true)], timestamp),
  );
}

export function paramsSet(
  minBond: BigInt,
  slashAmount: BigInt,
  maxStrikes: i32,
  unbondDelay: i32,
): ParamsSet {
  return changetype<ParamsSet>(
    mockEvent(
      REGISTRY,
      [
        uint("minBond", minBond),
        uint("slashAmount", slashAmount),
        small("maxStrikes", maxStrikes),
        small("unbondDelay", unbondDelay),
      ],
      T0 - DAY,
    ),
  );
}

export function epochResultRecorded(
  agentId: BigInt,
  pnl: BigInt,
  settledEpochs: i32,
  cumulativePnl: BigInt,
  timestamp: i64,
): EpochResultRecorded {
  return changetype<EpochResultRecorded>(
    mockEvent(
      REGISTRY,
      [
        uint("agentId", agentId),
        int("pnl", pnl),
        small("settledEpochs", settledEpochs),
        int("cumulativePnl", cumulativePnl),
      ],
      timestamp,
    ),
  );
}

export function reputationFeedback(
  agentId: BigInt,
  erc8004Id: BigInt,
  value: BigInt,
  tag: string,
  posted: boolean,
  timestamp: i64,
): ReputationFeedback {
  return changetype<ReputationFeedback>(
    mockEvent(
      REGISTRY,
      [
        uint("agentId", agentId),
        uint("erc8004Id", erc8004Id),
        int("value", value),
        new ethereum.EventParam("tag", ethereum.Value.fromString(tag)),
        bool("posted", posted),
      ],
      timestamp,
    ),
  );
}

// ------------------------------------------------------------------ fixtures

/// Protocol config as deployed (10% performance fee, half to the agent), an allowed TSLA with its feed, and a
/// covered-call vault created through the factory (VaultRegistered, then VaultCreated, as on-chain).
export function setupCallVault(): void {
  mockToken(TSLA, "TSLA", 18);
  mockToken(USDG, "USDG", 6);
  mockVault(VAULT, TSLA, 18, "Strike TSLA Covered Call", "sTSLA-CC");
  handleFeesSet(feesSet(1000, 5000));
  handleParamsSet(paramsSet(usdg(50), usdg(10), 3, 14 * 86_400));
  handleFeedSet(feedSet(TSLA, TSLA_FEED));
  handleUnderlyingSet(underlyingSet(TSLA, true));
  handleVaultRegistered(vaultRegistered(VAULT, CURATOR, AGENT_ID, TSLA, true, T0 - DAY));
  handleVaultCreated(vaultCreated(VAULT, CURATOR, TSLA, true, AGENT_ID, T0 - DAY));
}

/// Agent #1 registered with a 100 USDG bond.
export function setupAgent(): void {
  mockPayoutOf(AGENT_ID, AGENT_PAYOUT);
  handleAgentRegistered(agentRegistered(AGENT_ID, AGENT_OWNER, AGENT_SIGNER, BigInt.fromI32(7), T0 - DAY));
  handleBondPosted(bondPosted(AGENT_ID, AGENT_OWNER, usdg(100), T0 - DAY));
}
