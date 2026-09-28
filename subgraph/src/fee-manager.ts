// FeeManager: performance-fee parameters and the pull-payment balances of agents and the treasury.
import { BigInt, Bytes } from "@graphprotocol/graph-ts";
import { Claimed, FeeManager, FeesCredited, FeesSet, TreasurySet } from "../generated/FeeManager/FeeManager";
import { FeeAccount } from "../generated/schema";
import { ZERO, getProtocol } from "./helpers";

function getFeeAccount(account: Bytes): FeeAccount {
  let a = FeeAccount.load(account);
  if (a == null) {
    a = new FeeAccount(account);
    a.claimable = ZERO;
    a.totalCredited = ZERO;
    a.totalClaimed = ZERO;
  }
  return a;
}

function credit(account: Bytes, amount: BigInt): void {
  if (amount.isZero()) return;
  const a = getFeeAccount(account);
  a.claimable = a.claimable.plus(amount);
  a.totalCredited = a.totalCredited.plus(amount);
  a.save();
}

export function handleFeesSet(event: FeesSet): void {
  const p = getProtocol();
  p.perfFeeBps = event.params.perfFeeBps;
  p.agentShareBps = event.params.agentShareBps;
  p.updatedAt = event.block.timestamp;
  p.save();
}

export function handleTreasurySet(event: TreasurySet): void {
  const p = getProtocol();
  p.treasury = event.params.treasury;
  p.updatedAt = event.block.timestamp;
  p.save();
}

export function handleFeesCredited(event: FeesCredited): void {
  const p = getProtocol();
  // The constructor sets the treasury without an event; read it once.
  let treasury = p.treasury;
  if (treasury === null) {
    const result = FeeManager.bind(event.address).try_treasury();
    if (!result.reverted) {
      treasury = result.value;
      p.treasury = treasury;
    }
  }
  p.totalAgentFees = p.totalAgentFees.plus(event.params.agentAmount);
  p.totalTreasuryFees = p.totalTreasuryFees.plus(event.params.treasuryAmount);
  p.updatedAt = event.block.timestamp;
  p.save();

  // `agent` is the agent's payout address (or the treasury if it had none).
  credit(event.params.agent, event.params.agentAmount);
  if (treasury !== null) credit(treasury, event.params.treasuryAmount);
}

export function handleClaimed(event: Claimed): void {
  const a = getFeeAccount(event.params.account);
  const amount = event.params.amount;
  a.claimable = a.claimable.gt(amount) ? a.claimable.minus(amount) : ZERO;
  a.totalClaimed = a.totalClaimed.plus(amount);
  a.save();

  const p = getProtocol();
  p.totalFeesClaimed = p.totalFeesClaimed.plus(amount);
  p.updatedAt = event.block.timestamp;
  p.save();
}
